<?php
/**
 * api/extract.php — bill extraction endpoint (hardened pipeline).
 *
 * See extraction_hardening.md for the design this file implements, and
 * SPEC.md for the field-name contract. Summary:
 *
 * The client ALWAYS sends one or more images (`bill_image[]`) — a single
 * downscaled photo, or one rendered image PER PAGE of a PDF via pdf.js in
 * the browser (MSEDCL bills spread billing details/ToD/history across
 * several pages, not just page 1). When the original upload was a PDF, the
 * client ALSO sends the original file (`bill_pdf`) so this endpoint can try
 * a free text-layer fast-path before paying for a vision call.
 *
 * Response contract (always JSON):
 *   {"success": true,
 *    "data": <extraction JSON per SPEC.md>,
 *    "needs_review": {"<dotted.path>": true|false, ...},
 *    "suggested_corrections": {"<dotted.path>": <number>, ...},
 *    "quality": "ok" | "poor",
 *    "source": "text" | "vision"}
 * or
 *   {"success": false, "error": "<message the front-end can show as-is>"}
 */

header('Content-Type: application/json');

error_reporting(E_ALL);
ini_set('display_errors', '0');

function respond($payload, $httpCode = 200) {
    http_response_code($httpCode);
    echo json_encode($payload);
    exit;
}

function respond_error($message, $httpCode = 200) {
    respond(array('success' => false, 'error' => $message), $httpCode);
}

set_exception_handler(function ($e) {
    respond_error('Server error while reading the bill: ' . $e->getMessage());
});
register_shutdown_function(function () {
    $err = error_get_last();
    if ($err && in_array($err['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)) {
        respond_error('Server error while reading the bill.');
    }
});

$configPath = __DIR__ . '/config.php';
if (!file_exists($configPath)) {
    respond_error('Server is not configured yet (missing api/config.php). Please contact us directly.');
}
require $configPath;

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;  // bill_image, PER IMAGE (always at least one)
const MAX_PDF_BYTES = 10 * 1024 * 1024;   // bill_pdf (optional, original file)
const MAX_IMAGE_COUNT = 8;                // sanity cap, matches the client's PDF_MAX_PAGES
const ALLOWED_IMAGE_EXT = array('jpg', 'jpeg', 'png');
const ALLOWED_IMAGE_MIME = array('image/jpeg', 'image/png');

function detect_mime($path) {
    if (!function_exists('finfo_open')) return null;
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    if (!$finfo) return null;
    $mime = finfo_file($finfo, $path);
    // No finfo_close() — see api/upload_bill.php's comment on this.
    return $mime;
}

/** The client always posts the field as "bill_image[]", so PHP gives us
 *  parallel arrays under $_FILES['bill_image'] (name[], tmp_name[], ...) —
 *  even for a single photo upload. Returns a flat list of per-file arrays;
 *  falls back to treating $_FILES['bill_image'] as one file if it somehow
 *  arrives without the array-notation shape. */
function collect_uploaded_images() {
    if (!isset($_FILES['bill_image']) || !isset($_FILES['bill_image']['tmp_name'])) {
        return array();
    }
    $f = $_FILES['bill_image'];
    if (!is_array($f['tmp_name'])) {
        return array($f);
    }
    $out = array();
    foreach ($f['tmp_name'] as $i => $tmp) {
        $out[] = array(
            'name' => isset($f['name'][$i]) ? $f['name'][$i] : '',
            'error' => isset($f['error'][$i]) ? $f['error'][$i] : UPLOAD_ERR_NO_FILE,
            'size' => isset($f['size'][$i]) ? $f['size'][$i] : 0,
            'tmp_name' => $tmp,
        );
    }
    return $out;
}

// -----------------------------------------------------------------------
// 1. Validate the required image upload(s)
// -----------------------------------------------------------------------
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond_error('No bill image was received. Please choose a file and try again.');
}

$collectedImages = collect_uploaded_images();
error_log('[extract.php debug] collect_uploaded_images() returned ' . count($collectedImages) . ' image(s)');
$imageEntries = array_slice($collectedImages, 0, MAX_IMAGE_COUNT);
if (empty($imageEntries)) {
    respond_error('No bill image was received. Please choose a file and try again.');
}

// One curl call sends every page in one message, so every page must be a
// valid image before we spend the API call — a bad entry here means our own
// client-side rendering broke, not a user data problem.
$images = array(); // list of ['tmp_name' => ..., 'media_type' => ...]
foreach ($imageEntries as $entry) {
    if (!isset($entry['error']) || $entry['error'] !== UPLOAD_ERR_OK) {
        respond_error('The upload failed (error code ' . (isset($entry['error']) ? $entry['error'] : '?') . '). Please try again.');
    }
    if (!isset($entry['size']) || $entry['size'] <= 0 || $entry['size'] > MAX_IMAGE_BYTES) {
        respond_error('One of the bill page images is too large. Please try again.');
    }
    $ext = strtolower(pathinfo($entry['name'], PATHINFO_EXTENSION));
    $mime = detect_mime($entry['tmp_name']);
    $extOk = in_array($ext, ALLOWED_IMAGE_EXT, true);
    $mimeOk = $mime === null ? true : in_array($mime, ALLOWED_IMAGE_MIME, true);
    if (!$extOk || !$mimeOk) {
        respond_error('Please upload JPG or PNG images.');
    }
    $images[] = array(
        'tmp_name' => $entry['tmp_name'],
        'media_type' => ($ext === 'png' || $mime === 'image/png') ? 'image/png' : 'image/jpeg',
    );
}

// -----------------------------------------------------------------------
// 2. Schema + shared helpers
// -----------------------------------------------------------------------

function blank_extraction() {
    return array(
        'consumer_number' => null,
        'consumer_name' => null,
        'tariff_category' => null,
        'tariff_code' => null,
        'contract_demand_kva' => null,
        'sanctioned_load_kw' => null,
        'current_month' => array(
            'total_units' => null,
            'energy_rate' => null,
            'demand_charge_per_unit' => null,
            'fac' => null,
            'electricity_duty' => null,
            'tax_on_sale' => null,
            'tod' => array(
                't00_06' => array('units' => null, 'rate' => null),
                't06_09' => array('units' => null, 'rate' => null),
                't09_17' => array('units' => null, 'rate' => null),
                't17_24' => array('units' => null, 'rate' => null),
            ),
        ),
        'billing_history_units' => array(),
    );
}

const TOD_SLOT_KEYS = array('t00_06', 't06_09', 't09_17', 't17_24');

// Canonical field paths that count toward the "quality" percentage (this is
// the fixed set from extraction_hardening.md — per-entry billing-history
// anomalies are tracked separately and don't skew this denominator).
function canonical_field_paths() {
    $paths = array(
        'consumer_number', 'consumer_name', 'tariff_category', 'tariff_code',
        'contract_demand_kva', 'sanctioned_load_kw',
        'current_month.total_units', 'current_month.energy_rate',
        'current_month.demand_charge_per_unit', 'current_month.fac',
        'current_month.electricity_duty', 'current_month.tax_on_sale',
    );
    foreach (TOD_SLOT_KEYS as $slot) {
        $paths[] = "current_month.tod.$slot.units";
        $paths[] = "current_month.tod.$slot.rate";
    }
    $paths[] = 'billing_history_units';
    return $paths; // 21 entries
}

/** Fuzzy-matches a model-supplied low_confidence_fields entry (which may use
 *  an abbreviated dotted path, e.g. "tod.t09_17.rate" or just "fac") against
 *  our canonical path. Best-effort — the model isn't given a strict path
 *  grammar, just an example. */
function model_flagged($canonicalPath, $modelFlags) {
    if (empty($modelFlags)) return false;
    $cp = strtolower($canonicalPath);
    $segs = explode('.', $cp);
    $tail1 = end($segs);
    $tail2 = count($segs) >= 2 ? $segs[count($segs) - 2] . '.' . $tail1 : $tail1;
    foreach ($modelFlags as $flag) {
        if (!is_string($flag) || $flag === '') continue;
        $f = strtolower(trim($flag));
        if ($f === $cp || $f === $tail1 || $f === $tail2) return true;
        if (strlen($f) >= 4 && strpos($cp, $f) !== false) return true;
    }
    return false;
}

function in_range($v, $lo, $hi) {
    return $v !== null && is_numeric($v) && $v >= $lo && $v <= $hi;
}

function suggest_paise_correction($v) {
    return $v === null ? null : round($v / 100.0, 4);
}

/**
 * Applies every rule in extraction_hardening.md's "VALIDATION RULES"
 * section. Returns:
 *   needs_review           dotted-path => bool (canonical fields + the
 *                           per-entry billing_history_units[i] fields)
 *   suggested_corrections  dotted-path => number (only the ÷100 paise fix)
 *   quality                'ok' | 'poor'
 *   all_pass                true iff NOTHING in needs_review is true — the
 *                           bar the free text-path fast-path must clear
 */
function validate_extraction($data, $modelFlags = array()) {
    $nr = array();
    $sugg = array();
    $cm = $data['current_month'];
    $tod = $cm['tod'];

    $flag = function ($path, $failedCheck, $value) use (&$nr, $modelFlags) {
        $nr[$path] = ($value === null) || $failedCheck || model_flagged($path, $modelFlags);
    };

    // Fields with no range check of their own — flagged only if null or the
    // model itself said it was unsure.
    foreach (array('consumer_number', 'consumer_name', 'tariff_category', 'tariff_code', 'sanctioned_load_kw') as $k) {
        $flag($k, false, $data[$k]);
    }

    $flag('contract_demand_kva', !in_range($data['contract_demand_kva'], 1, 5000) && $data['contract_demand_kva'] !== null, $data['contract_demand_kva']);
    $flag('current_month.total_units', !in_range($cm['total_units'], 100, 1000000) && $cm['total_units'] !== null, $cm['total_units']);
    $flag('current_month.energy_rate', !in_range($cm['energy_rate'], 3, 12) && $cm['energy_rate'] !== null, $cm['energy_rate']);

    // The four small rate fields also get the paise-not-converted detector:
    // if the value is > 5 it was almost certainly left in paise (SPEC.md /
    // extraction_hardening.md). Offer the ÷100 value as a one-tap fix rather
    // than silently rewriting what the user sees.
    $paiseRanges = array(
        'current_month.demand_charge_per_unit' => array(0, 3),
        'current_month.fac' => array(0, 2),
        'current_month.electricity_duty' => array(0, 2),
        'current_month.tax_on_sale' => array(0, 2),
    );
    foreach ($paiseRanges as $path => $range) {
        $segs = explode('.', $path);
        $v = $cm[$segs[1]];
        $failed = ($v !== null && !in_range($v, $range[0], $range[1]));
        $flag($path, $failed, $v);
        if ($v !== null && $v > 5) {
            $sugg[$path] = suggest_paise_correction($v);
        }
    }

    foreach (TOD_SLOT_KEYS as $slot) {
        $u = $tod[$slot]['units'];
        $r = $tod[$slot]['rate'];
        $flag("current_month.tod.$slot.units", false, $u);
        $flag("current_month.tod.$slot.rate", ($r !== null && !in_range($r, -5, 5)), $r);
    }

    // Daytime rate sign: a positive, non-trivial 09:00-17:00 rate is
    // suspicious (that slot is normally a rebate) — flag for a look, per
    // extraction_hardening.md we do NOT auto-change it.
    $daytimeRate = $tod['t09_17']['rate'];
    if ($daytimeRate !== null && $daytimeRate > 0.5) {
        $nr['current_month.tod.t09_17.rate'] = true;
    }

    // TOD units reconcile: the four slot units should sum to within ±3% of
    // total_units. Only checkable when all five values are present.
    $u00 = $tod['t00_06']['units']; $u06 = $tod['t06_09']['units'];
    $u09 = $tod['t09_17']['units']; $u17 = $tod['t17_24']['units'];
    $totalUnits = $cm['total_units'];
    if ($u00 !== null && $u06 !== null && $u09 !== null && $u17 !== null && $totalUnits !== null && $totalUnits > 0) {
        $sum4 = $u00 + $u06 + $u09 + $u17;
        if (abs($sum4 - $totalUnits) > 0.03 * $totalUnits) {
            $nr['current_month.total_units'] = true;
            foreach (TOD_SLOT_KEYS as $slot) {
                $nr["current_month.tod.$slot.units"] = true;
            }
            // The four slot units are the more granular reading, so their
            // sum is a reasonable one-tap fix for total_units — offered,
            // never applied automatically.
            $sugg['current_month.total_units'] = round($sum4, 2);
        }
    }

    // Billing history plausibility.
    $hist = is_array($data['billing_history_units']) ? $data['billing_history_units'] : array();
    $count = count($hist);
    $histFailed = ($count > 0 && ($count < 4 || $count > 12));
    $nr['billing_history_units'] = ($count === 0) || $histFailed || model_flagged('billing_history_units', $modelFlags);
    if ($count > 0) {
        $sorted = $hist;
        sort($sorted);
        $mid = intdiv($count, 2);
        $median = ($count % 2 === 0) ? (($sorted[$mid - 1] + $sorted[$mid]) / 2) : $sorted[$mid];
        foreach ($hist as $i => $val) {
            $bad = ($val <= 0) || ($median > 0 && abs($val - $median) > 3 * $median);
            $nr["billing_history_units[$i]"] = $bad;
        }
    }

    // Overall quality: > ~40% of the fixed canonical field set needs review,
    // or total_units couldn't be read at all.
    $canonical = canonical_field_paths();
    $flaggedCount = 0;
    foreach ($canonical as $p) {
        if (!empty($nr[$p])) $flaggedCount++;
    }
    $quality = ($totalUnits === null || ($flaggedCount / count($canonical)) > 0.40) ? 'poor' : 'ok';

    $allPass = !in_array(true, $nr, true);

    return array(
        'needs_review' => $nr,
        'suggested_corrections' => $sugg,
        'quality' => $quality,
        'all_pass' => $allPass,
    );
}

// -----------------------------------------------------------------------
// 3. Free fast-path: PDF with a real text layer (smalot/pdfparser)
// -----------------------------------------------------------------------

function extract_pdf_text($path) {
    $autoload = __DIR__ . '/../vendor/autoload.php';
    if (!file_exists($autoload)) return null; // composer install hasn't been run
    require_once $autoload;
    if (!class_exists('Smalot\\PdfParser\\Parser')) return null;
    try {
        $parser = new \Smalot\PdfParser\Parser();
        $pdf = $parser->parseFile($path);
        $text = $pdf->getText();
        return (is_string($text) && trim($text) !== '') ? $text : null;
    } catch (\Throwable $e) {
        return null;
    }
}

function find_value($text, $labelPattern, $valueRegex, $window = 150) {
    if (preg_match('/' . $labelPattern . '/i', $text, $m, PREG_OFFSET_CAPTURE)) {
        $start = $m[0][1] + strlen($m[0][0]);
        $snippet = substr($text, $start, $window);
        if (preg_match('/' . $valueRegex . '/i', $snippet, $vm)) {
            return isset($vm[1]) ? trim($vm[1]) : trim($vm[0]);
        }
    }
    return null;
}

function find_number($text, $labelPattern, $window = 150) {
    $raw = find_value($text, $labelPattern, '(-?[\d,]+\.?\d*)', $window);
    if ($raw === null) return null;
    $clean = str_replace(',', '', $raw);
    return is_numeric($clean) ? (float) $clean : null;
}

function find_two_numbers($text, $labelPattern, $window = 250) {
    if (!preg_match('/' . $labelPattern . '/i', $text, $m, PREG_OFFSET_CAPTURE)) {
        return array(null, null);
    }
    $start = $m[0][1] + strlen($m[0][0]);
    $snippet = substr($text, $start, $window);
    preg_match_all('/-?[\d,]+\.?\d*/', $snippet, $nm);
    $nums = array();
    foreach ($nm[0] as $tok) {
        $clean = str_replace(',', '', $tok);
        if (is_numeric($clean)) $nums[] = (float) $clean;
    }
    return array(isset($nums[0]) ? $nums[0] : null, isset($nums[1]) ? $nums[1] : null);
}

function parse_billing_history($text) {
    $pos = stripos($text, 'Billing History');
    if ($pos === false) return array();
    $chunk = substr($text, $pos, 900);
    preg_match_all('/\b\d{1,3}(?:,\d{3})*\b/', $chunk, $matches);
    $nums = array();
    foreach ($matches[0] as $tok) {
        $val = (float) str_replace(',', '', $tok);
        if ($val >= 50 && $val <= 999999) $nums[] = $val;
    }
    return array_slice($nums, 0, 12);
}

/** Anchored "find the label, read the nearby value" regex parsing — not
 *  fixed offsets. Raw values are returned as printed; validate_extraction()
 *  (same function used for the vision path) is what flags a paise mistake
 *  and offers the ÷100 fix, rather than silently guessing here. */
function parse_bill_text($text) {
    $data = blank_extraction();

    $data['consumer_number'] = find_value($text, 'Consumer\s*(?:No\.?|Number)\s*[:\-]?\s*', '([A-Za-z0-9]{6,20})');
    $data['consumer_name'] = find_value($text, '(?:Consumer\s*Name|Name\s*of\s*Consumer)\s*[:\-]?\s*', "([A-Za-z0-9 .,&'\\-]{3,60})");
    $data['tariff_code'] = find_value($text, 'Tariff\s*(?:Category|Code)?\s*[:\-]?\s*', '([A-Z]{1,4}[-\s][A-Za-z0-9 ]{1,15})');

    if (preg_match('/industrial/i', $text)) {
        $data['tariff_category'] = 'Industrial';
    } elseif (preg_match('/commercial/i', $text)) {
        $data['tariff_category'] = 'Commercial';
    }

    $data['contract_demand_kva'] = find_number($text, 'Contract\s*Demand\s*[:\-]?\s*');
    $data['sanctioned_load_kw'] = find_number($text, 'Sanctioned\s*Load\s*[:\-]?\s*');

    $cm = &$data['current_month'];
    $cm['total_units'] = find_number($text, 'Total\s*(?:Units|Consumption)\s*[:\-]?\s*');
    $cm['energy_rate'] = find_number($text, 'Energy\s*Charg(?:es|e)\s*(?:@|Rate)?\s*[:\-]?\s*');

    $cm['demand_charge_per_unit'] = find_number($text, 'Demand\s*Charg(?:es|e)\s*(?:@|Rate|per\s*unit)\s*[:\-]?\s*');
    if ($cm['demand_charge_per_unit'] === null) {
        $demandTotal = find_number($text, 'Demand\s*Charg(?:es|e)\s*(?:Amount)?\s*[:\-]?\s*(?:Rs\.?|₹)?\s*');
        if ($demandTotal !== null && $cm['total_units']) {
            $cm['demand_charge_per_unit'] = round($demandTotal / $cm['total_units'], 4);
        }
    }

    $cm['fac'] = find_number($text, 'FAC\s*(?:@|Rate)?\s*[:\-]?\s*');
    $cm['electricity_duty'] = find_number($text, 'Electricity\s*Duty\s*[:\-]?\s*');
    $cm['tax_on_sale'] = find_number($text, 'Tax\s*on\s*Sale\s*[:\-]?\s*');

    $todLabels = array(
        't00_06' => '00[:.]?00\s*(?:to|-|–|hrs?)?\s*06[:.]?00',
        't06_09' => '06[:.]?00\s*(?:to|-|–|hrs?)?\s*09[:.]?00',
        't09_17' => '09[:.]?00\s*(?:to|-|–|hrs?)?\s*17[:.]?00',
        't17_24' => '17[:.]?00\s*(?:to|-|–|hrs?)?\s*(?:24[:.]?00|00[:.]?00)',
    );
    foreach ($todLabels as $key => $labelPattern) {
        list($units, $rate) = find_two_numbers($text, $labelPattern);
        $cm['tod'][$key]['units'] = $units;
        $cm['tod'][$key]['rate'] = $rate;
    }

    $data['billing_history_units'] = parse_billing_history($text);

    return $data;
}

// -----------------------------------------------------------------------
// 4. Vision path (exact prompt from extraction_hardening.md)
// -----------------------------------------------------------------------

function tod_slot_schema() {
    return array(
        'type' => 'object',
        'properties' => array(
            'units' => array('type' => array('number', 'null')),
            'rate' => array('type' => array('number', 'null')),
        ),
        'required' => array('units', 'rate'),
        'additionalProperties' => false,
    );
}

function vision_output_schema() {
    return array(
        'type' => 'object',
        'properties' => array(
            'consumer_number' => array('type' => array('string', 'null')),
            'consumer_name' => array('type' => array('string', 'null')),
            'tariff_category' => array('type' => array('string', 'null')),
            'tariff_code' => array('type' => array('string', 'null')),
            'contract_demand_kva' => array('type' => array('number', 'null')),
            'sanctioned_load_kw' => array('type' => array('number', 'null')),
            'current_month' => array(
                'type' => 'object',
                'properties' => array(
                    'total_units' => array('type' => array('number', 'null')),
                    'energy_rate' => array('type' => array('number', 'null')),
                    'demand_charge_per_unit' => array('type' => array('number', 'null')),
                    'fac' => array('type' => array('number', 'null')),
                    'electricity_duty' => array('type' => array('number', 'null')),
                    'tax_on_sale' => array('type' => array('number', 'null')),
                    'tod' => array(
                        'type' => 'object',
                        'properties' => array(
                            't00_06' => tod_slot_schema(),
                            't06_09' => tod_slot_schema(),
                            't09_17' => tod_slot_schema(),
                            't17_24' => tod_slot_schema(),
                        ),
                        'required' => array('t00_06', 't06_09', 't09_17', 't17_24'),
                        'additionalProperties' => false,
                    ),
                ),
                'required' => array('total_units', 'energy_rate', 'demand_charge_per_unit', 'fac', 'electricity_duty', 'tax_on_sale', 'tod'),
                'additionalProperties' => false,
            ),
            'billing_history_units' => array('type' => 'array', 'items' => array('type' => 'number')),
            'low_confidence_fields' => array('type' => 'array', 'items' => array('type' => 'string')),
        ),
        'required' => array(
            'consumer_number', 'consumer_name', 'tariff_category', 'tariff_code',
            'contract_demand_kva', 'sanctioned_load_kw', 'current_month',
            'billing_history_units', 'low_confidence_fields',
        ),
        'additionalProperties' => false,
    );
}

/** Verbatim from extraction_hardening.md, "THE VISION PROMPT". */
function vision_prompt() {
    return <<<'EOT'
You are extracting billing data from a photograph or scan of an Indian
electricity bill issued by MSEDCL / Mahavitaran (Maharashtra State Electricity
Distribution Co. Ltd.). The image may be skewed, low-contrast, stamped, or have
values misaligned from their labels. Read the whole bill spatially, the way a
person would — do not read strictly line by line.

Return ONLY a single JSON object, no prose, no markdown fences, exactly this shape:

{
  "consumer_number": string|null,
  "consumer_name": string|null,
  "tariff_category": "Industrial"|"Commercial"|null,
  "tariff_code": string|null,
  "contract_demand_kva": number|null,
  "sanctioned_load_kw": number|null,
  "current_month": {
    "total_units": number|null,
    "energy_rate": number|null,
    "demand_charge_per_unit": number|null,
    "fac": number|null,
    "electricity_duty": number|null,
    "tax_on_sale": number|null,
    "tod": {
      "t00_06": {"units": number|null, "rate": number|null},
      "t06_09": {"units": number|null, "rate": number|null},
      "t09_17": {"units": number|null, "rate": number|null},
      "t17_24": {"units": number|null, "rate": number|null}
    }
  },
  "billing_history_units": [number],
  "low_confidence_fields": [string]
}

Rules:
- All rate fields (energy_rate, demand_charge_per_unit, fac, electricity_duty,
  tax_on_sale, and every tod rate) MUST be in RUPEES PER UNIT. MSEDCL prints some
  of these in "Ps/U" (paise per unit). If a value is labelled Ps/U or paise,
  DIVIDE BY 100. Example: "Tax on Sale @ 28.94 Ps/U" -> 0.2894. "FAC @ 20 Ps/U"
  -> 0.20. Sanity: energy_rate is normally 5–10; fac/duty/tax/demand-per-unit are
  normally well below 1.
- energy_rate is the base energy charge rate for the current month's units (the
  "Energy Charges" rate, or the industrial/commercial consumption rate).
- demand_charge_per_unit: if only a total "Demand Charges" amount is printed,
  divide it by total_units to get a per-unit figure; otherwise use the printed
  per-unit rate.
- The four TOD (Time of Day) slots are 00:00–06:00, 06:00–09:00, 09:00–17:00,
  17:00–24:00. Each has its own units and its own rate. RATES CAN BE NEGATIVE
  (the daytime 09:00–17:00 slot is usually a rebate, e.g. -1.149). Preserve the
  sign exactly.
- billing_history_units: the bill has a "Billing History" table listing months
  and their units. Return the UNITS values, MOST RECENT FIRST, up to 12 numbers.
  Strip commas.
- If any value is unclear, illegible, or you are guessing, put null for that field
  and add its dotted path (e.g. "current_month.fac" or "tod.t09_17.rate") to
  low_confidence_fields. DO NOT invent numbers — a null the user can fill in is
  far better than a wrong value.
- Strip thousands separators from all numbers. Return numbers as numbers, not
  strings.
EOT;
}

/** Defensive type coercion only — no unit "correction" here, that's
 *  validate_extraction()'s job (flag + suggest, never silently rewrite). */
function sanitize_extraction($data) {
    $out = blank_extraction();

    foreach (array('consumer_number', 'consumer_name', 'tariff_code') as $k) {
        if (isset($data[$k]) && is_string($data[$k]) && trim($data[$k]) !== '') {
            $out[$k] = trim($data[$k]);
        }
    }
    if (isset($data['tariff_category']) && in_array($data['tariff_category'], array('Industrial', 'Commercial'), true)) {
        $out['tariff_category'] = $data['tariff_category'];
    }
    foreach (array('contract_demand_kva', 'sanctioned_load_kw') as $k) {
        if (isset($data[$k]) && is_numeric($data[$k])) $out[$k] = (float) $data[$k];
    }

    $cmIn = isset($data['current_month']) && is_array($data['current_month']) ? $data['current_month'] : array();
    $cm = &$out['current_month'];
    foreach (array('total_units', 'energy_rate', 'demand_charge_per_unit', 'fac', 'electricity_duty', 'tax_on_sale') as $k) {
        if (isset($cmIn[$k]) && is_numeric($cmIn[$k])) $cm[$k] = (float) $cmIn[$k];
    }

    $todIn = isset($cmIn['tod']) && is_array($cmIn['tod']) ? $cmIn['tod'] : array();
    foreach (TOD_SLOT_KEYS as $slot) {
        if (isset($todIn[$slot]) && is_array($todIn[$slot])) {
            if (isset($todIn[$slot]['units']) && is_numeric($todIn[$slot]['units'])) $cm['tod'][$slot]['units'] = (float) $todIn[$slot]['units'];
            if (isset($todIn[$slot]['rate']) && is_numeric($todIn[$slot]['rate'])) $cm['tod'][$slot]['rate'] = (float) $todIn[$slot]['rate']; // sign preserved
        }
    }

    if (isset($data['billing_history_units']) && is_array($data['billing_history_units'])) {
        $hist = array();
        foreach ($data['billing_history_units'] as $v) {
            if (is_numeric($v)) $hist[] = (float) $v;
        }
        $out['billing_history_units'] = array_slice($hist, 0, 12);
    }

    return $out;
}

/** $images is a list of ['tmp_name' => ..., 'media_type' => ...] — one entry
 *  per bill page (or a single entry for a photo upload). Every page goes
 *  into the SAME user message, image blocks first, so the model sees the
 *  whole bill at once and can pull values from whichever page they're on. */
function call_vision_api_attempt($images) {
    if (!defined('ANTHROPIC_API_KEY') || ANTHROPIC_API_KEY === '' || strpos(ANTHROPIC_API_KEY, 'REPLACE_ME') === 0) {
        throw new \Exception('the vision API key has not been configured yet (api/config.php)');
    }

    $content = array();
    foreach ($images as $image) {
        $bytes = file_get_contents($image['tmp_name']);
        if ($bytes === false) throw new \Exception('could not read the uploaded file');
        $content[] = array(
            'type' => 'image',
            'source' => array('type' => 'base64', 'media_type' => $image['media_type'], 'data' => base64_encode($bytes)),
        );
    }
    error_log('[extract.php debug] image blocks attached to vision message: ' . count($content));
    $content[] = array('type' => 'text', 'text' => vision_prompt());

    $body = array(
        'model' => defined('ANTHROPIC_MODEL') ? ANTHROPIC_MODEL : 'claude-opus-4-8',
        'max_tokens' => 2048,
        'messages' => array(array(
            'role' => 'user',
            'content' => $content,
        )),
        // Tool use, not output_config.format: our schema has ~20 nullable
        // (type|null) fields, and structured outputs rejects anything past
        // 16 union-typed parameters ("too many parameters with union
        // types"). Tool input_schema has no such ceiling. Forcing the one
        // tool via tool_choice gets us the same "always structured, never
        // markdown-fenced prose" guarantee the prompt already asks for.
        'tools' => array(array(
            'name' => 'extract_bill',
            'description' => 'Return the extracted MSEDCL bill fields',
            'input_schema' => vision_output_schema(),
        )),
        'tool_choice' => array('type' => 'tool', 'name' => 'extract_bill'),
    );

    $ch = curl_init('https://api.anthropic.com/v1/messages');
    curl_setopt_array($ch, array(
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => array(
            'Content-Type: application/json',
            'x-api-key: ' . ANTHROPIC_API_KEY,
            'anthropic-version: 2023-06-01',
        ),
        CURLOPT_POSTFIELDS => json_encode($body),
        CURLOPT_TIMEOUT => 60,
    ));
    $raw = curl_exec($ch);
    $curlErr = curl_error($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    // No curl_close() — see api/supabase.php's comment on this.

    if ($raw === false) throw new \Exception('could not reach the vision service (' . $curlErr . ')');
    $resp = json_decode($raw, true);
    if ($httpCode !== 200) {
        $msg = (is_array($resp) && isset($resp['error']['message'])) ? $resp['error']['message'] : ('HTTP ' . $httpCode);
        throw new \Exception('vision service error: ' . $msg);
    }
    if (!is_array($resp) || !isset($resp['content']) || !is_array($resp['content'])) {
        throw new \Exception('vision service returned an unexpected response');
    }

    $toolInput = null;
    foreach ($resp['content'] as $block) {
        if (isset($block['type']) && $block['type'] === 'tool_use' && isset($block['name']) && $block['name'] === 'extract_bill') {
            $toolInput = isset($block['input']) ? $block['input'] : null;
            break;
        }
    }
    if (!is_array($toolInput)) throw new \Exception('vision service did not return any extracted data');

    error_log('[extract.php debug] raw tool_use input: ' . json_encode($toolInput, JSON_PRETTY_PRINT));

    $modelFlags = (isset($toolInput['low_confidence_fields']) && is_array($toolInput['low_confidence_fields']))
        ? array_values(array_filter($toolInput['low_confidence_fields'], 'is_string'))
        : array();

    return array('data' => sanitize_extraction($toolInput), 'model_flags' => $modelFlags);
}

/** "Parse the returned JSON strictly; if it isn't valid JSON, retry once,
 *  then return a clean error" — also covers transient network failures and
 *  a missing/malformed tool_use block, not just JSON parsing, since the
 *  forced tool_choice already makes a missing tool call very unlikely. */
function call_vision_api($images) {
    try {
        return call_vision_api_attempt($images);
    } catch (\Exception $e1) {
        return call_vision_api_attempt($images);
    }
}

// -----------------------------------------------------------------------
// 5. Dispatch
// -----------------------------------------------------------------------

// Optional free fast-path: only if the client also sent the original PDF.
if (isset($_FILES['bill_pdf']) && $_FILES['bill_pdf']['error'] === UPLOAD_ERR_OK) {
    $pf = $_FILES['bill_pdf'];
    $pExt = strtolower(pathinfo($pf['name'], PATHINFO_EXTENSION));
    $pMime = detect_mime($pf['tmp_name']);
    $pdfLooksOk = ($pExt === 'pdf' || $pMime === 'application/pdf') && $pf['size'] > 0 && $pf['size'] <= MAX_PDF_BYTES;

    if ($pdfLooksOk) {
        $text = extract_pdf_text($pf['tmp_name']);
        if ($text !== null && strlen(trim($text)) > 100) {
            $textData = parse_bill_text($text);
            $val = validate_extraction($textData, array());
            if ($val['all_pass']) {
                respond(array(
                    'success' => true,
                    'data' => $textData,
                    'needs_review' => $val['needs_review'],
                    'suggested_corrections' => $val['suggested_corrections'],
                    'quality' => $val['quality'],
                    'source' => 'text',
                ));
            }
            // Any single field failing validation falls through to vision —
            // extraction_hardening.md: "only if the parsed result passes ALL
            // validation checks... otherwise fall through to vision."
        }
    }
}

try {
    $vision = call_vision_api($images);
} catch (\Exception $e) {
    respond_error("We couldn't read this bill (" . $e->getMessage() . "). Please fill in the values yourself below.");
}

$val = validate_extraction($vision['data'], $vision['model_flags']);
respond(array(
    'success' => true,
    'data' => $vision['data'],
    'needs_review' => $val['needs_review'],
    'suggested_corrections' => $val['suggested_corrections'],
    'quality' => $val['quality'],
    'source' => 'vision',
));
