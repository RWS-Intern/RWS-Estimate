# Extraction Hardening — robust reading of messy MSEDCL bills

**Supersedes the `api/extract.php` / OCR section of the earlier prompts.**
Everything else (formulation, engine, Supabase, deploy) is unchanged.

## Why not classic OCR
Tested on a real photographed bill, line-based OCR (Tesseract) recovered ~98
characters from the entire billing-details page and zero usable values. These
bills defeat it: faint dot-matrix print, coloured stamps, and values that sit in
columns away from their labels. Reading top-to-bottom destroys the label→value
relationship.

**Use a layout-aware vision model instead.** It reads the whole image at once and
returns structured JSON, so misalignment, skew, and wrapping don't break it. Then
validate and flag. That is the only reliable path for a public tool taking phone
photos.

## The robust pipeline
1. **Get an image, always.** In the browser:
   - Image upload → downscale long edge to ~1600px, JPEG ~0.85, send as image.
   - PDF upload → render the relevant page(s) to a **high-DPI canvas via pdf.js
     (~200–300 dpi equivalent)** and send that image. (This avoids depending on a
     PDF rasteriser binary that shared hosting may not have.)
2. **Free fast-path for clean portal PDFs (optional):** if the PDF has a real
   text layer, try parsing the text first (smalot/pdfparser). If — and only if —
   the parsed result passes ALL validation checks below, use it and skip the API
   call. Otherwise fall through to vision. This keeps clean downloads free while
   guaranteeing messy ones still work.
3. **Vision extraction:** POST the image (base64) to the vision API from PHP via
   curl, using the prompt in the next section. Key lives server-side only.
4. **Validate** every field (rules below). Compute a per-field `needs_review`
   flag = (model marked it low-confidence) OR (it failed a sanity check) OR (it is
   null).
5. **Quality gate:** if the image is too poor to read (model returns mostly nulls
   / overall low confidence, or > ~40% of fields need review), don't dump a broken
   form on the user — ask them to re-upload a clearer photo, or offer manual entry.
6. **Confirm screen:** render all fields editable; render `needs_review` fields in
   **amber** with a short note ("please check this value"), and put empty/null
   fields at the top. The user fixes the few weak spots; then compute runs.
7. **Optional second pass:** if a small number of specific fields failed, re-call
   the vision model with a targeted prompt naming just those fields and the table
   they live in, before showing the confirm screen.

---

## THE VISION PROMPT (drop this into the endpoint, verbatim)

Send this as the instruction alongside the bill image. Ask for JSON only.

```
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
```

---

## VALIDATION RULES (run after extraction; set needs_review per field)

Ranges (flag if outside):
- `energy_rate`            : 3 – 12
- `demand_charge_per_unit` : 0 – 3
- `fac`                    : 0 – 2
- `electricity_duty`       : 0 – 2
- `tax_on_sale`            : 0 – 2
- each `tod.*.rate`        : -5 – 5
- `total_units`            : 100 – 1,000,000
- `contract_demand_kva`    : 1 – 5,000

Cross-checks (flag the involved fields if they fail):
- **Paise-not-converted detector:** if any of fac / duty / tax_on_sale /
  demand_charge_per_unit is > 5, it was almost certainly left in paise. Flag it,
  and offer the ÷100 value as a suggested correction on the confirm screen.
- **TOD units reconcile:** sum(tod.t00_06.units, t06_09, t09_17, t17_24) should be
  within ±3% of total_units. If not, flag total_units and all four slot units.
- **History plausibility:** billing_history_units should be 4–12 entries, all
  positive, none absurd; flag any entry that deviates > 3× from the median.
- **Daytime rate sign:** tod.t09_17.rate positive and large is suspicious for a
  daytime slot; flag for a look (do not auto-change).

needs_review(field) = model listed it in low_confidence_fields
                     OR it failed a range/cross-check
                     OR it is null

If needs_review count > ~40% of fields OR total_units is null → trigger the
quality gate (ask for a clearer image / offer manual entry) instead of showing a
half-empty confirm form.

---

## CLAUDE CODE PROMPT — implement the hardened extractor

```
Read SPEC.md and the file extraction_hardening.md in the repo. Replace/extend the
extraction so it is robust to messy, misaligned, photographed MSEDCL bills. We are
NOT using line-based OCR (it fails on these bills). Use a layout-aware vision model.

Implement the pipeline exactly as described in extraction_hardening.md:

1. Client (index.html/js):
   - Image uploads: downscale long edge to ~1600px, JPEG ~0.85.
   - PDF uploads: render the relevant page(s) to a high-DPI image using pdf.js in
     the browser (load pdf.js from a CDN or bundle it), then send that image.
   - Always end up sending an IMAGE to the endpoint. Show a loading state.

2. api/extract.php:
   - Optional free fast-path: if the original upload was a PDF WITH a text layer,
     first try smalot/pdfparser text parsing into the schema. Run the SAME
     validation as below on that result; use it only if everything passes,
     otherwise fall through to vision.
   - Vision path: base64 the image and POST to the vision API via curl using the
     EXACT prompt quoted in extraction_hardening.md ("THE VISION PROMPT"). API key
     in git-ignored api/config.php; use a clearly-marked PLACEHOLDER for now.
     Parse the returned JSON strictly; if it isn't valid JSON, retry once, then
     return a clean error.
   - Apply ALL validation rules from extraction_hardening.md. Attach to each field
     a needs_review boolean and, where relevant, a suggested_correction (e.g. the
     ÷100 value for a paise mistake). Return the schema plus a parallel
     needs_review map and an overall quality flag.

3. Confirm screen (index.html):
   - Editable form for every field. Fields with needs_review=true render in amber
     with a short "please check" note; null/empty fields sorted to the top. If a
     suggested_correction exists, show it as a one-tap "use 0.2894?" fix.
   - If the endpoint's quality flag says the image was too poor (or total_units is
     null, or >40% fields need review), show a "we couldn't read this clearly —
     upload a clearer photo, or enter the values yourself" state instead of the
     normal confirm form. Always allow full manual entry as a fallback.

4. Keep the JSON schema and field names identical to SPEC.md so the later
   formulation/engine steps are unaffected.

Test against reference/sample_bills/ (both the portal PDF and the phone photo).
The photo path must go through the vision route and produce a mostly-correct
confirm form with the genuinely unreadable fields flagged rather than guessed.
Do not implement the financial dashboard or Supabase in this task.
```

---

### Notes
- The vision route has a small per-bill cost; the clean-PDF fast-path stays free.
  Given accuracy is the priority on a mix of uploads, this is the right trade.
- `tod.t09_17.rate` (the daytime rebate) feeds the effective-tariff formula
  directly, so it is one of the most important fields to get right — it is covered
  by both the sign check and confirm-screen review.
- Everything the model is unsure about surfaces in amber on the confirm screen; a
  wrong number never reaches the 25-year model silently.
