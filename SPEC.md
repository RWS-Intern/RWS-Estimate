# SPEC — Rite Solar Rooftop Estimate Tool

Domain-logic spec for `estimate.ritesolar.in`. This is the source of truth for
field names, units, and formulas. Code should match this document; if they
ever disagree, fix the code (or update this file deliberately and say why).

## Pipeline (per customer)

1. **Entry form**: Company Name, Mobile, Category (Commercial | Industrial),
   Bill upload (PDF or image).
2. **Extract**: PHP endpoint reads the bill and returns the JSON schema below.
   - If the uploaded PDF has a real text layer (portal download), parse the
     text for free (PHP: `smalot/pdfparser`). No API cost.
   - If there is NO usable text layer (photo/scan/image file), fall back to a
     vision LLM call via curl. Same JSON schema out either way.
3. **Confirm**: show extracted values in an EDITABLE form for the user to
   verify / correct before any calculation runs. This is mandatory —
   extraction is never assumed perfect.
4. **Compute**: formulation -> 25-year engine — see "Formulas" and
   "Dashboard implementation" below.
5. **Render dashboard**: headed by KPI/comparison metrics, rendered in place
   directly below the confirm form on "Confirm & see my estimate" — no
   navigation to a new step. A later task will head it **"Prepared for
   {Company Name}"**; that heading isn't wired up yet (see Owner notes).
6. **Persist to Supabase** — submission details + the uploaded bill file, one
   row per customer.

There is no user-facing history or login anywhere in this tool. The backend
stores each customer's submission and bill file so the owner can review them
afterward; the customer never logs in to see past submissions.

Steps 1–6 are implemented (see "Persistence" below). A password-protected
admin page at `/admin/` (Supabase Auth + RLS, no service role key) edits the
`app_config` constants the engine reads on every estimate — see "Config
wiring" and "Admin page" below.

## Extraction JSON schema (the contract every path must return)

```json
{
  "consumer_number": "string",
  "consumer_name": "string",
  "tariff_category": "Industrial | Commercial",
  "tariff_code": "string",
  "contract_demand_kva": 0,
  "sanctioned_load_kw": 0,
  "current_month": {
    "total_units": 0,
    "energy_rate": 0,
    "demand_charge_per_unit": 0,
    "fac": 0,
    "electricity_duty": 0,
    "tax_on_sale": 0,
    "tod": {
      "t00_06": { "units": 0, "rate": 0 },
      "t06_09": { "units": 0, "rate": 0 },
      "t09_17": { "units": 0, "rate": 0 },
      "t17_24": { "units": 0, "rate": 0 }
    }
  },
  "commercial": {
    "current_month_units": 0,
    "energy_rate": 0,
    "wheeling": 0,
    "fac": 0,
    "electricity_duty_pct": 0,
    "tax_on_sale": 0,
    "tod_rebate_pct": 0,
    "grid_support_charge": 0
  },
  "billing_history_units": [0]
}
```

Notes:

- `tariff_category`: `"Industrial"` or `"Commercial"` — decides which of
  `current_month` (industrial) or `commercial` (commercial) is actually
  populated; the other sits at its blank/null shape and is ignored. Both
  keys are always present so downstream code never has to special-case a
  missing key, only null values within whichever one is live.
- `tariff_code`: e.g. `"LT-V B II"`.
- `current_month.total_units`: e.g. `5703`.
- `current_month.energy_rate`: base energy Rs/unit, e.g. `7.66`.
- `current_month.demand_charge_per_unit`: Rs/unit, e.g. `1.52`.
- `current_month.fac`: Rs/unit, e.g. `0.20`.
- `current_month.electricity_duty`: Rs/unit, e.g. `0`.
- `current_month.tax_on_sale`: Rs/unit, e.g. `0.2894`.
- `tod.t09_17.rate` can be negative — a daytime rebate, e.g. `-1.149`.
- `tod.t17_24.rate` e.g. `1.915`.
- `commercial.current_month_units`: e.g. `4000` — commercial's total-units
  equivalent; no ToD-slot units table.
- `commercial.energy_rate`/`wheeling`/`fac`/`tax_on_sale`/`grid_support_charge`:
  all Rs/unit, e.g. `8.51`/`1.60`/`0.65`/`0.279`/`1.96`. Unlike industrial,
  `grid_support_charge` is READ OFF THE BILL for commercial, not a fixed
  `gsc` config constant. `wheeling` is the bill's "Wheeling Charges" line,
  already Rs/unit as printed — used directly, no unit conversion. (A field
  named `demand_charge` briefly existed here for the same bill line, under
  the wrong label and the wrong unit treatment — real-bill testing found it
  was actually wheeling, already Rs/unit, not a Rs/month total needing
  division. Removed; `wheeling` is now the only field for this line — see
  "Commercial formulation" below for the correction.)
- `commercial.electricity_duty_pct`/`tod_rebate_pct`: PERCENTAGES (e.g. `21`
  meaning 21%, `15` meaning 15%) — commercial bills print these as a rate
  applied to the tariff, not as their own Rs/unit line, unlike industrial's
  per-unit `electricity_duty` and per-slot ToD rates.
- `billing_history_units`: most recent up to 12 months of units, most-recent
  FIRST — same field, shared by both categories.
- Any field that could not be read may be `null` — the confirm screen is the
  backstop, never invent a number.

## CRITICAL extraction gotchas

- **Units of rate.** MSEDCL prints some charges in "Ps/U" (paise per unit) and
  some in Rs/unit. `tax_on_sale` often shows as "28.94 Ps/U" = Rs `0.2894`.
  `fac` may show as paise too. ALWAYS normalise every rate to Rs/unit before
  returning JSON. When in doubt, prefer the interpretation that keeps the
  value in a sane Rs/unit range (`energy_rate` ~6–9; `fac` / `electricity_duty`
  / `tax_on_sale` / `demand_charge_per_unit` < 1). Concretely: if one of those
  four small-rate fields comes out > 5, it was almost certainly left in
  paise — divide by 100. The confirm screen is the backstop for anything this
  heuristic gets wrong.
- **`demand_charge_per_unit`.** If the bill shows a total "Demand Charges"
  amount and a billed demand in kVA (not a per-unit rate), derive per-unit as
  `demand_charges_total / total_units`. Prefer a directly-printed per-unit
  rate if present.
- **TOD slot rates can be negative** (daytime rebate). Preserve the sign —
  never take an absolute value.
- **`billing_history_units`.** The MSEDCL bill has a "Billing History" table
  on page 1 with ~12 rows of month + units. Return the units column,
  most-recent-first. Strip thousands separators (commas).

## Extraction implementation notes (hardened pipeline)

We do NOT use line-based OCR — tested on a real photographed bill it recovers
essentially nothing usable (faint dot-matrix print, stamps, values that sit
in columns away from their labels). The whole pipeline below exists to avoid
it, per `extraction_hardening.md`.

**Client always ends up sending one or more images** (`index.html` /
`assets/js/app.js`):

- Photo upload (JPG/PNG): two upload slots in `index.html` — "Bill – Front"
  (required) and "Bill – Back" (optional, for bills whose billing
  details/ToD/history spill onto a second photographed page). Each is
  independently downscaled so the long edge is ~1600px, re-encoded as JPEG
  ~0.85 quality, with its own client-side type/size validation and a small
  preview thumbnail + clear button (`assets/js/app.js`:
  `showFrontPreview()`/`showBackPreview()`/`clearFrontPreview()`/
  `clearBackPreview()`). Selecting a PDF in the front slot hides and clears
  the back slot (`setBackSlotEnabled()`) — a PDF already covers every page,
  a second loose photo makes no sense alongside it. One or two images
  result, front first.
- PDF upload: **every page** rendered client-side to its own high-DPI image
  (~200–220dpi, capped at `PDF_MAX_PAGES = 8`) via `pdf.js` loaded from a
  CDN, rendered sequentially to bound peak memory on phones. MSEDCL bills
  spread the billing-details/ToD/history tables across multiple pages — page
  1 alone is mostly header/summary and extracting from it only returns
  nulls. Rendering every page also means even a scanned/photographed PDF (no
  text layer, no way to rasterise it server-side on shared hosting) still
  reaches the vision path. The ORIGINAL PDF is also sent alongside (see
  below), so a clean text-layer PDF can still take the free path.
- Every rendered/downscaled image falls back to `canvasToJpegFile()`
  stepping down the JPEG quality if it would exceed the 6 MB per-image
  server limit.
- If pdf.js itself fails to load or render (corrupt/encrypted PDF, no
  connection to the CDN), the user is bounced back to the entry step with an
  inline error rather than silently submitting nothing.

**Upload payload** (`multipart/form-data` to `api/extract.php`):

- `bill_image[]` — always present, one or more (one for a single photo or
  front-only upload, two for a front+back photo pair, or one per PDF page).
  The array field name means PHP always gives `$_FILES['bill_image']` the
  parallel-arrays shape (even for a single photo), which
  `collect_uploaded_images()` normalises into a flat list.
- `bill_pdf` — present only when the original upload was a PDF. The
  *original, unmodified* file, so `smalot/pdfparser` can attempt the free
  text-layer path.

**Server dispatch** (`api/extract.php`):

1. **Free fast-path** (only runs if `bill_pdf` was sent): `smalot/pdfparser`
   pulls raw text, then anchored "find the label, read the nearby value"
   regex parsing (not fixed byte/line offsets — bills vary in layout). The
   parsed result is run through the SAME validation function used for the
   vision path (see below). It is used **only if every single field passes
   validation** (`all_pass` — zero `needs_review` flags anywhere); otherwise
   the request falls through to vision. This path has not been validated
   against a live MSEDCL portal export (only a scanned sample bill was
   available while building this), so treat it as best-effort — the strict
   all-or-nothing gate is exactly what makes that safe to ship anyway.
2. **Vision path**: every page image in `bill_image[]` is base64-encoded and
   sent as its own `image` content block in ONE user message — all images
   first, then the text prompt — POSTed to the Claude API
   (`POST /v1/messages`, model in `api/config.php`) using the *exact*
   prompt from `extraction_hardening.md`'s "THE VISION PROMPT" (a PHP
   nowdoc in `vision_prompt()` — verbatim, not paraphrased). Sending every
   page in one message (rather than one call per page) lets the model
   reconcile values that reference each other across pages (e.g. total units
   on one page, the ToD breakdown on another). The response is forced into
   shape via a single **tool** (`extract_bill`, forced with `tool_choice`)
   whose `input_schema` mirrors the prompt's JSON shape, including
   `low_confidence_fields` — NOT `output_config.format` (structured
   outputs): our schema has ~20 nullable (`type|null`) fields, and
   `output_config.format` rejects anything past 16 union-typed parameters
   ("too many parameters with union types"); tool `input_schema` has no such
   ceiling. The result is read from the `tool_use` content block's `input`
   (already a parsed object, not a JSON string to decode). If the call or
   the tool_use block is missing/malformed, it retries once, then returns a
   clean `{"success": false, "error": ...}`.
3. **Validation** (`validate_extraction()`, used by BOTH paths): implements
   every rule in `extraction_hardening.md`'s "VALIDATION RULES" —
   range checks (`energy_rate` 3–12, the four small rate fields 0–2/0–3, each
   ToD rate -5–5, `total_units` 100–1,000,000, `contract_demand_kva` 1–5,000),
   the paise-not-converted cross-check (any of `fac` / `electricity_duty` /
   `tax_on_sale` / `demand_charge_per_unit` > 5 → flag it and offer the ÷100
   value as `suggested_corrections`), the ToD-units-reconcile cross-check
   (±3% of `total_units`), billing-history plausibility (4–12 entries, each
   within 3× the median), and the daytime-rate-sign check (`t09_17.rate`
   positive & > 0.5 is flagged, never auto-changed). A field is
   `needs_review` if it's `null`, fails a check above, or the vision model
   itself listed it in `low_confidence_fields` (fuzzy-matched — the model
   isn't given a strict path grammar). Overall `quality` is `"poor"` when
   `total_units` is null or more than ~40% of the fixed 21-field canonical
   set needs review (per-entry billing-history flags don't count toward that
   denominator — see code comment).
4. **Response contract** (every success response, either path):
   `{"success": true, "data": {...SPEC schema...}, "needs_review": {"<dotted.path>": bool}, "suggested_corrections": {"<dotted.path>": number}, "quality": "ok"|"poor", "source": "text"|"vision"}`.
   Dotted paths use the schema's own field names, e.g.
   `"current_month.fac"`, `"current_month.tod.t09_17.rate"`,
   `"billing_history_units"` (aggregate) and `"billing_history_units[3]"`
   (per-entry anomaly).

**Confirm screen** (`index.html` / `assets/js/app.js`): every field stays
editable. A field with `needs_review=true` gets an amber border; the flat
field groups (customer/tariff, current-month rates) and the ToD table rows
and billing-history items additionally get a short "Please check this
value." note with a one-tap "Use 0.2894?" button when a
`suggested_correction` exists (paise-mistake fields only, per
`extraction_hardening.md`). Within each of those four groups, `null`/empty
fields are sorted to the top — each item carries its own label with it, so a
row moving up doesn't lose its meaning (e.g. a null "3 months ago" history
box still says "3 months ago" wherever it lands). When `quality` is `"poor"`
(including the total-failure case, where the front-end treats a network/API
error as `quality:"poor"` with a blank form), the confirm screen leads with
a warning banner and a "Upload a clearer photo instead" button that returns
to the entry step — the normal editable form (i.e. full manual entry) is
still right below it, never blocked.

Not implemented (explicitly out of scope for this task, marked "optional" in
`extraction_hardening.md`): the second-pass targeted re-call that re-prompts
the vision model naming only the specific fields that still need review.

**Sample bill on hand** (`reference/sample_bills/1st bill Unit_3.pdf`) is a
scanned/photographed PDF with no extractable text (`pdftotext` on it returns
only page-number artifacts). With this pipeline it now exercises pdf.js
rendering + the vision path end-to-end (previously, before this task, a
textless PDF with no accompanying image had no way to proceed — that gap is
closed now that the client always produces an image itself).

## Configuration (`app_config`) — seed defaults, not hardcoded

Constants are **no longer hardcoded** in the engine. Every tunable value
below lives in a single-row Supabase `app_config` table (a JSONB blob) and
is read at runtime — the values that used to sit directly in this file are
now the *seed defaults* for that row (and the fallback if the DB is briefly
unreachable — see "Config wiring" below). The 25-year engine consumes these
from config, not from an inlined `K` object. (SQL to create and seed
`app_config`, plus the `submissions` table and `bills` storage bucket, lives
in `backend_and_admin.md`.)

**Access pattern:**

- The **public** page reads config **server-side, via PHP**
  (`api/get_config.php`), using the Supabase **service role** key. The
  `app_config` table is NEVER exposed to the anon/browser client — it holds
  the ₹/kWp cost basis, which is commercially sensitive.
- The **admin** page (`/admin/`) reads and writes config directly from the
  browser via Supabase Auth + RLS (anon key + a signed-in admin session).
  The service role key never appears in admin-page JS.

**Seed values:**

```
rate_per_kwp=51000, gst_rate=0.089, gen_per_kwp_day=4, amc_rate_per_kwp=1200,
amc_esc=0.01, deg_y1=0.03, deg_yr=0.0071, spares_on=true,
spares_rate_per_kwp=2800, spares_base_rate=2000, discount=0.12,
int_surplus=0.045, days=365, dep_rate=0.40, dep_years=9, proc_fee_pct=0.01,
tariff_esc=0.03, gsc=1.96, daytime_window="06-17", years=25,
// scenario defaults (starting slider positions on the dashboard):
dep_default=true, tax_default=25.18, loan_default=false, dp_default=20,
loan_rate_default=9, tenure_months_default=60, fd_rate_default=7,
// comparison rates on the "vs deposit/bond" chart:
bond_rate=0.08, savings_rate=0.035, equity_rate=0.12,
// commercial-only formulation constants (see "Commercial formulation" below):
solar_hour_share_pct=75, gst_pct_commercial=8.9, dep_default_commercial=false,
commercial_rate_table=[{"kwp":0,"rate":58000},{"kwp":10,"rate":54000},
  {"kwp":25,"rate":52000},{"kwp":50,"rate":50000},{"kwp":100,"rate":48000}]
```

`years` (the engine's fixed 25-year horizon) was added to this list in the
engine-integration task — it wasn't in the original app_config plan from
`backend_and_admin.md`, but the engine needs it as a config value like
everything else, so treat it as part of the seed set too (update that SQL
when Supabase wiring happens).

**Where this actually lives right now:** the single `app_config` row in
Supabase is the source of truth. `assets/config-defaults.js` holds this same
seed object as a `DEFAULTS` fallback and exposes `RiteConfig.load()`
(returns a Promise either way) — see "Config wiring" below.

`gsc` = Grid Support Charge, Rs/unit — NOT on a non-solar customer's own
bill; always use this fixed config value regardless of what their bill
shows.

The formulas below use UPPER_SNAKE shorthand (`GSC`, `RATE_PER_KWP`,
`GEN_PER_KWP_DAY`, `DAYS`, `TARIFF_ESC`, `DEP_RATE`, `DEP_YEARS`,
`PROC_FEE_PCT`, `GST_RATE`, …) as a 1:1 alias for the matching `app_config`
key (`gsc`, `rate_per_kwp`, `gen_per_kwp_day`, …) — that's a readability
convention for this document, not a separate hardcoded set; the engine
reads every one of them from config.

## Formulas (implemented in `assets/formulation.js`)

```
EFFECTIVE_TARIFF (Rs/unit) =
    energy_rate + demand_charge_per_unit + fac + electricity_duty + tax_on_sale
    - GSC + tod.t09_17.rate

  // Worked example from the reference customer:
  // 7.66 + 1.52 + 0.20 + 0 + 0.2894 - 1.96 + (-1.149) = 6.5604

DAYTIME_FRACTION = (tod.t06_09.units + tod.t09_17.units) / current_month.total_units

  // NOTE / OPEN CHOICE: the source Excel used the 06:00-17:00 window
  // (t06_09 + t09_17) giving ~0.8187 for the reference customer. The demo's
  // prose text instead cited the 09:00-17:00 window only (~0.81). Default to
  // the Excel definition (06-17) and expose DAYTIME_WINDOW = "06-17" as a
  // documented config flag so it can be switched to "09-17" easily.

ANNUAL_UNITS       = sum(billing_history_units)   // use available months; if
                                                    // fewer than 12, note it
REQUIRED_KWP_EXACT = (ANNUAL_UNITS * DAYTIME_FRACTION) / (GEN_PER_KWP_DAY * DAYS)
OFFERED_KWP        = ceil(REQUIRED_KWP_EXACT)      // round UP to next whole kWp
  // e.g. 46.38 -> 47, 23.4 -> 24. Show the exact required value next to the
  // offered whole number on the confirm screen; OFFERED_KWP stays
  // user-editable.

ANNUAL_GENERATION = OFFERED_KWP * GEN_PER_KWP_DAY * DAYS   // Year-1, before degradation
GROSS_COST        = OFFERED_KWP * RATE_PER_KWP
GST_AMOUNT        = GROSS_COST * GST_RATE
NET_COST_INC_GST  = GROSS_COST + GST_AMOUNT
EX_GST_CAPITAL    = GROSS_COST   // returns are computed on ex-GST (ITC
                                  // recoverable for C&I)
```

**Defensive guard** (`assets/formulation.js`): `derive()` throws rather than
returning a garbage system size or tariff if:
- `total_units` is missing/zero,
- any of the five tariff-rate components (`energy_rate`,
  `demand_charge_per_unit`, `fac`, `electricity_duty`, `tax_on_sale`) is
  missing,
- `tod.t09_17.rate` or `tod.t09_17.units` is missing, or (when
  `daytime_window` is the default `"06-17"`) `tod.t06_09.units` is missing,
- `daytime_fraction` comes out `> 1`, or
- `required_kwp_exact` is non-finite or `<= 0`.

The middle two bullets were added after a "graceful degradation" review
found a real gap: after a total extraction failure, the confirm form is
blank and fully manual — if the customer filled in `total_units` and the
ToD units/rates but skipped a tariff-rate field, JS's `null + number`
arithmetic silently treats the missing field as **zero** rather than
failing, which would have produced a plausible-looking but wrong
`effective_tariff` (or `daytime_fraction`) with no warning at all —
exactly the "invented number" this file's Extraction section says to never
produce. Explicit `isMissing()` checks close that gap. All of these
conditions almost always mean a field is still blank after manual entry, or
`total_units`/a TOD slot's units are wrong on the bill itself. The confirm
screen shows the thrown message verbatim: *"Your bill values look
inconsistent, please recheck total units and TOD slots."* and does NOT
render the dashboard.

## Commercial formulation (implemented in `assets/formulation.js`)

A second, independent derivation for `tariff_category === "Commercial"` —
`deriveCommercial()`, dispatched from the same `RiteFormulation.derive()`
entry point industrial always used (`deriveIndustrial()` now, byte-for-byte
the original `derive()` body — see that function's own comment). Commercial
MSEDCL bills itemise wheeling/duty/ToD-rebate/GSC as their own lines instead
of a per-slot ToD table, and size against an assumed solar-hour-share of
usage (there's no measured daytime fraction to read off a commercial meter)
capped by sanctioned load rather than rounded up unconditionally.

```
// wheeling is the bill's "Wheeling Charges" line, ALREADY Rs/unit as
// printed — used directly. (An earlier version of this formula had a
// separate DEMAND_PER_UNIT = commercial.demand_charge / current_month_units
// term, added into both DUTY_PER_UNIT's base and EFFECTIVE_TARIFF — real-
// bill testing found "demand_charge" was actually the SAME wheeling line
// under the wrong label, so that field double-counted wheeling AND divided
// an already-per-unit figure by units again. Removed; wheeling is the only
// term for this line now.)
DUTY_PER_UNIT       = (commercial.electricity_duty_pct / 100) *
                        (energy_rate + wheeling + fac)
TOD_REBATE_PER_UNIT = (commercial.tod_rebate_pct / 100) * energy_rate
EFFECTIVE_TARIFF    = energy_rate + wheeling + fac + DUTY_PER_UNIT
                        + tax_on_sale - TOD_REBATE_PER_UNIT - grid_support_charge

  // Worked example (the reference bill used to verify this formulation):
  // duty_per_unit = 0.21*(8.51+1.60+0.65) = 2.2596
  // tod_rebate_per_unit = 0.15*8.51 = 1.2765
  // effective_tariff = 8.51+1.60+0.65+2.2596+0.279-1.2765-1.96 = 10.0621
  //
  // (Previous version of this doc had effective_tariff = 10.22545, which
  // included the erroneous demand_per_unit component above — delta from
  // removing it: -0.16335 Rs/unit. Sizing/pricing below are UNCHANGED by
  // this fix — they don't depend on effective_tariff.)

ANNUAL_UNITS       = sum(billing_history_units)          // same as industrial
REQUIRED_KWP_EXACT = (ANNUAL_UNITS * SOLAR_HOUR_SHARE_PCT/100) / (GEN_PER_KWP_DAY * DAYS)

  // e.g. 32157 * 0.75 / (4*365) = 16.519 kWp

// MIN(required, sanctioned) decides which constraint binds. Only when
// consumption is the binding constraint do we round UP like industrial —
// a sanctioned-load cap is used exactly as printed (no ceiling: a fixed
// grid connection limit isn't something you round up).
SIZED_BY_SANCTIONED_LOAD = sanctioned_load_kw <= REQUIRED_KWP_EXACT
OFFERED_KWP = SIZED_BY_SANCTIONED_LOAD ? sanctioned_load_kw : ceil(REQUIRED_KWP_EXACT)

  // e.g. sanctioned 7.49 <= required 16.519 -> sanctioned binds -> 7.49 kWp
  // (kept as printed, not rounded, since it's a grid connection limit)

RATE_PER_KWP = floor-lookup(OFFERED_KWP, COMMERCIAL_RATE_TABLE)  // highest
                // table threshold <= OFFERED_KWP wins; see config below

  // e.g. 7.49 kWp -> the "0 kWp" bracket -> 58000 Rs/kWp

GROSS_COST       = OFFERED_KWP * RATE_PER_KWP
GST_AMOUNT       = GROSS_COST * (GST_PCT_COMMERCIAL / 100)
NET_COST_INC_GST = GROSS_COST + GST_AMOUNT
EX_GST_CAPITAL   = GROSS_COST

  // e.g. 7.49*58000 = 434420; *1.089 = 473083.38
```

**Config additions** (seed defaults in `assets/config-defaults.js`, admin-
editable under the "Commercial" group — see "Configuration" above):
- `solar_hour_share_pct` (default `75`) — replaces industrial's measured
  `daytime_fraction`.
- `gst_pct_commercial` (default `8.9`) — a PERCENT NUMBER like `tax_default`,
  not a `0-1` fraction like industrial's `gst_rate`.
- `commercial_rate_table` — a JSON array of `{kwp, rate}` floor-lookup
  thresholds (small commercial systems cost more per kWp than large
  industrial ones, hence a table instead of one flat `rate_per_kwp`).
- `dep_default_commercial` (default `false`) — the depreciation-toggle
  starting position for a commercial customer's dashboard, separate from
  industrial's `dep_default` (`true`). See "Downstream engine" below for why
  this exists.

**Downstream engine (`assets/engine.js`) — parameterized, not duplicated:**
`compute()`'s only two category-dependent reads were `config.rate_per_kwp`/
`config.gst_rate` (used to independently re-derive gross/net cost from
`lock.size`, since `compute()` never took formulation's own gross/net cost as
an input). Both now prefer `lock.ratePerKwp`/`lock.gstRate` when the caller
supplies them, falling back to the global config values otherwise —
`deriveIndustrial()` sets those two `lock` fields to exactly
`config.rate_per_kwp`/`config.gst_rate`, so industrial's computed numbers are
bit-identical to before this change; `deriveCommercial()` sets them to the
looked-up table rate and `gst_pct_commercial/100`. Every other downstream
constant (AMC, spares, degradation, depreciation rate/years, tariff
escalation, discount rate, surplus interest) is genuinely shared between
categories — no "commercial equivalent" needed for any of those.

**`dep_default_commercial` exists because of one verification finding:**
sizing/pricing (`effective_tariff`, `offered_kwp`, `rate_per_kwp`,
`gross_cost`, `net_cost_inc_gst`) all matched the reference bill's expected
values EXACTLY once the formulas above were implemented (this was BEFORE
the wheeling/demand_charge fix below — `effective_tariff` matched an
expected value that, per that fix, included an erroneous demand component;
see that section for the corrected `10.0621`). IRR/payback did NOT match,
though — reusing industrial's scenario defaults verbatim (`dep_default` ON,
`tax_default` 25.18%) gave IRR ≈44.4%/payback ≈3.32yr against an expected
≈34.25%/≈4.275yr (4yr 3.3mo). Turning depreciation OFF by default for
commercial (tax rate then becomes irrelevant, since no depreciation benefit
is claimed) closed almost all of the gap: ≈34.86%/≈4.14yr, using the
(un-corrected) `10.22545` tariff. **Re-run after the wheeling fix, with the
corrected `10.0621` tariff, the same `dep_default_commercial=false`
assumption lands even closer: IRR ≈34.13%/payback ≈4.21yr** — within
≈0.1 percentage points of IRR and ≈1 month of payback against the
≈34.25%/≈4.275yr target. Still not confirmed as an exact match (no exact
target was ever given, only "≈" figures), but close enough that
`dep_default_commercial=false` looks like the right call, and the wheeling
fix happened to close most of the remaining gap the original investigation
couldn't explain. See Owner notes for the recommended next step if
exact parity matters.

## Dashboard implementation

The 25-year engine, chart rendering, and metric/table wiring were lifted out
of `reference/estimate.html` into four new files, kept deliberately
separate by responsibility:

- **`assets/config-defaults.js`** — the seed values above, exposed as
  `RiteConfig.load()` returning `Promise<config>`. This is a stand-in for
  Supabase: a later task swaps the function body for
  `fetch('api/get_config.php').then(r => r.json())` and nothing that calls
  `RiteConfig.load()` needs to change, since every caller already treats it
  as async.
- **`assets/formulation.js`** — `RiteFormulation.derive(confirmed, config)`,
  the Formulas section above. Pure function, no DOM.
- **`assets/engine.js`** — `RiteEngine.compute(lock, config, scenario)` plus
  `irr`/`npv`/`pmt`/`inr`/`inrShort`. `lock` is `{size: offered_kwp, gen:
  gen_per_kwp_day, flatRate: effective_tariff, ratePerKwp, gstRate}` — the
  three per-customer values that used to be estimate.html's hardcoded `LOCK`
  block, now derived by formulation.js instead, plus `ratePerKwp`/`gstRate`
  (added for the commercial formulation — see that section — so `compute()`
  can price a category whose rate isn't a flat global constant; industrial
  sets these to exactly `config.rate_per_kwp`/`config.gst_rate`, so its
  numbers are unaffected). `scenario` is the slider state (`{dep, tax,
  loan, dp, rate, ten, fd}` — `S` in the original demo). Two fields from the
  original `compute()` were dropped as genuinely dead code (verified nothing
  reads them): `co2PerUnit`/`ppaEsc`/`LOCK.ppa` (fed an unused
  `opexArr`/`opexTotal`) and the `gsc:0` per-row placeholder. The `fin:0`
  placeholder was KEPT — the 25-year table's "Short-Term Finance Cost"
  column reads it and always renders "—", matching the original exactly.
- **`assets/charts.js`** — the Chart.js builders (compare bar chart, lump
  and leveraged line charts) and the 25-year table renderer, each taking a
  canvas/table element and returning/updating a Chart instance so the caller
  can hold onto it for next time (destroy-then-recreate on every re-render,
  same as the original's module-level `chCmp`/`chLump`/`chLev`). Includes
  the same Chart-undefined fallback the original had, so a blocked Chart.js
  CDN degrades to no-op stub charts instead of crashing the whole page —
  every text metric and the table still render.

**Wiring** (`assets/js/app.js`): "Confirm & see my estimate" collects the
confirmed JSON, loads config, runs `RiteFormulation.derive()`, and — on
success — builds `lock`, seeds `scenario` from the config's `*_default`
keys, and calls the engine + chart builders. The dashboard renders **in
place directly below the confirm form**, inside the same `#step-confirm`
step (not a new step) — exactly what the task asked for. The down
payment/loan rate/tenure/tax rate/FD rate sliders and the depreciation/loan
toggles are bound once at page load (not re-bound per confirm) and mutate a
shared `scenario` object, re-rendering the whole dashboard on every change,
matching the original's live-slider behavior.

**Narrative** (`renderNarrative()` in `assets/js/app.js`): the "How we sized
your plant & priced each unit" cards are templated per customer from
`formulation`'s own return value — never hardcoded. The system-size card
states the daytime window actually used (`formulation.daytime_window`, so
prose and math can't drift apart), the required-vs-offered kWp transparently
(`"required X.XX kWp -> offered Y kWp"`), and a note when fewer than 12
months of billing history were available. The per-unit-value card renders
the itemised build-up (`energy + demand + FAC + duty + tax-on-sale −
GSC + daytime-ToD = effective`) using `formulation.tariff_breakdown`, with
the ToD term's sign driving whether it reads as "rebate" or "charge".

**Layout adaptation:** `reference/estimate.html` uses a sticky two-column
layout (330px sidebar + flexible content) inside a 1180px-wide page. This
project's `.wrap` is 900px (single column, matching the entry/confirm
steps already built). Rather than cram the two-column layout into a
narrower page, the dashboard cards stack vertically — same cards, same
data, same charts, just one column. The slider fields use a new `.sfield`
class instead of reusing the confirm-form's `.field` (same visual result)
specifically so a future change to one can't accidentally restyle the
other via a shared selector.

## Config wiring (`api/get_config.php`, `assets/config-defaults.js`)

The engine's constants are read from the live `app_config` row, not from an
inlined object:

- **`api/get_config.php`** — `GET`, reads `app_config` (`id=1`, `select=config`)
  via `api/supabase.php`'s `supabase_rest()` helper using the **service
  role** key. Responds `{"success": true, "config": {...}}` on success, or
  `{"success": false}` on any failure (missing config, Supabase down,
  malformed row) — always HTTP 200, same fail-soft convention as
  `lead.php`/`complete.php`/`upload_bill.php`. The `app_config` table itself
  is never queried from the browser.
- **`assets/config-defaults.js`**'s `RiteConfig.load()` calls
  `fetch('api/get_config.php')`, and on success merges the returned config
  **onto** `DEFAULTS` (`Object.assign({}, DEFAULTS, json.config)`) — so a
  config row saved before a new key existed (like `years` today) doesn't
  produce `undefined` for that key, it just falls back to the default. On
  any failure (network error, `success:false`, malformed `config`), `load()`
  resolves to `DEFAULTS` outright — the public tool degrades to the last
  known-good seed values rather than breaking. The result is cached in
  memory per page load (`_cachedPromise`) so re-confirming on the same page
  doesn't re-fetch; a fresh page load always re-fetches, so an admin save
  takes effect for the very next customer. **Callers are unchanged** —
  `formulation.js`, `engine.js`, and `assets/js/app.js` still just call
  `RiteConfig.load().then(function(config) {...})`.

## Admin page (`/admin/`)

A small, separate static page — Supabase Auth + RLS directly from the
browser, using the **anon/public** key (safe to expose; RLS is what
actually protects `app_config` — see `backend_and_admin.md`'s policies).
**No service role key anywhere under `/admin/`.**

- **`admin/config.js`** — the only file with Supabase project details in
  it: `SUPABASE_URL` (same value as `api/config.php`'s, which is not
  secret) and `SUPABASE_ANON_KEY` (a `REPLACE_ME_...` placeholder — fill in
  from Supabase dashboard > Project Settings > API before the page can sign
  anyone in). Unlike `api/config.php`, this file is **not** git-ignored —
  everything in it is meant to be public.
- **`admin/index.html`** — reuses `assets/css/style.css`'s existing
  components (`.card`, `.field`/`.hint`, `.section-label`, `.grid2`,
  `.toggle-row`/`.switch`, `.note`, `.btn`, the `.step`/`.step.active`
  show/hide pattern) so the page matches the public tool's look without a
  parallel design system. `assets/css/admin.css` holds the handful of
  admin-only additions (topbar, login-card width, two-line toggle rows) —
  kept out of `style.css` so the public page never loads admin-only CSS.
  Loads Supabase JS v2 from jsdelivr, pinned to the **major** version only
  (`@2`, not an exact patch like pdf.js/Chart.js elsewhere in this project)
  — the v2 auth/query API used here is stable across patches, and `@2`
  always resolves to a real published build, which a guessed exact patch
  version might not.
- **`admin/admin.js`** — one `FIELD_GROUPS` array (key, label, hint, type —
  `number`/`fraction`/`bool`/`select`) is the single source of truth for
  building the form, populating it from the loaded config, validating it,
  and collecting it back into a config object. The six groups and every
  field in them match `backend_and_admin.md`'s admin-page spec exactly,
  plus `years` under "Generation & sizing" (added to the seed set in the
  engine-integration task). All 30 `app_config` keys are covered 1:1, so
  Save does a full replace of the config object with no risk of silently
  dropping a key the form doesn't show.
  - **Auth**: email+password only via `sb.auth.signInWithPassword()`; no
    sign-up UI (`backend_and_admin.md`: admin accounts are created manually
    in the Supabase dashboard). `sb.auth.getSession()` on load
    auto-restores an already-signed-in session (supabase-js persists it in
    `localStorage`) so a refresh doesn't force re-login. "Log out" calls
    `sb.auth.signOut()`.
  - **Load**: `sb.from('app_config').select('config, updated_at').eq('id',
    1).single()` — RLS's `admin_read_config` policy (`for select to
    authenticated using (true)`) is what allows this once signed in.
  - **Validate**: every field is checked before Save — numbers parse as
    finite numbers, `integer: true` fields must be whole numbers,
    `fraction` fields must fall in `[0, 1]`, `daytime_window` must be
    `"06-17"` or `"09-17"`. All errors collect and display together rather
    than stopping at the first one.
  - **Save**: `sb.from('app_config').update({config, updated_at:
    <ISO timestamp>}).eq('id', 1).select().single()` — RLS's
    `admin_write_config` policy is what allows this. Shows a success note
    (green, via the shared `.note` styling) or an error note with Supabase's
    message on failure.

### Admin Leads view (`admin/admin.js`, `admin/index.html`)

A second tab, "Leads", sits alongside "Constants" behind the same login —
added without touching the config editor at all (same `enterPanel()` /
`sb` client, an entirely separate set of functions). The two tabs reuse
`style.css`'s existing `.tabs`/`.tab`/`.tab.active` bar and `.tabpane`/
`.tabpane.active` show-hide pattern verbatim (the same classes the public
dashboard's Lump-sum/Leveraged tabs use) — `admin.css` only needed a
`data-admintab` attribute selector for the click handler, no new tab CSS.

**Read-only, via a new RLS policy** — `admin_read_submissions` (`for select
to authenticated using (true)`, see `backend_and_admin.md`) is the *only*
new access this task grants: authenticated admins can now `SELECT` from
`submissions`, and only select — there is still no insert/update/delete
policy for that role, so this view cannot accidentally modify a row.
Writes remain exactly as before, PHP + the service role key only
(`api/lead.php`/`api/complete.php`/`api/upload_bill.php`/
`api/upload_report.php`). The anon/public role still has zero access to
`submissions` — an unauthenticated visitor to `/admin/` never gets past the
login screen, and the public estimate tool never queries this table
directly either way.

**Data flow — one flatten step, two presentations:**
- `loadLeads()` fetches `company_name, mobile, category, stage, computed,
  bill_path, bill_path_back, report_path, created_at` for every row, most-recent-first
  (`.order('created_at', {ascending: false})`), fired once, lazily, the
  first time the Leads tab is clicked (not on every click — `leadsLoadedOnce`
  guards against re-fetching every time the admin switches tabs; reload the
  page for a fresh pull).
- `flattenLead(row)` pulls the scalar fields the brief asked for out of the
  nested `computed` jsonb (`offered_kwp`, `effective_tariff`, `irr`,
  `payback_years`, `ex_gst_capital` → labelled "Net capital") into one flat
  object holding RAW values (e.g. `irr` stays a `0–1` fraction here, not
  `"28.9%"`) — this is the single source of truth both outputs below read
  from, so the on-screen table and the Excel export can never disagree.
  `bill_path`/`report_path` are kept as their full raw path (not reduced to
  a filename here) — the on-screen table needs the full path to ask
  `sign_url.php` for a signed URL; the Excel export derives just the
  filename from it at export time instead (see below). A `stage='entered'`
  row (bounced lead, never reached a result) has `computed = null`, so
  every one of those fields comes out `null` the same way any other
  missing value would — no special casing needed, `displayCell()`/the
  export both already treat `null` as "blank", not an error.
- **On-screen table** (`displayCell()`): formats each raw value into a
  short human string — `irr` becomes `"28.9%"`, `effective_tariff`/
  `net_capital` get a `₹` prefix (Indian grouping via `.toLocaleString
  ("en-IN")`, matching the rest of the tool), missing values render as
  `"—"`. Reused `.tbl-scroll` (the public dashboard's 25-year-table
  scroll container, just given a taller `480px` cap via `.leads-scroll`)
  for a capped-height, horizontally-scrollable table as the row count
  grows; `#leadsTable`'s alignment is overridden to left-align by default
  (`.tbl-scroll`'s own rule right-aligns everything, tuned for an
  all-numeric table) with `.num` marking the five numeric columns back to
  right-aligned.
- **Bill file (front) / Bill file (back) / Report file are live "Download"
  buttons** (`.leads-dl-btn`, styled as a plain underlined link since it
  sits inline in a table cell), shown when `bill_path`/`bill_path_back`/
  `report_path` is present, "—" when it's `null` (`bill_path_back` is
  `null` for every submission that uploaded a PDF or a front-only photo —
  see "Bill upload: front/back photo slots" above). Clicking one calls
  `downloadSignedFile(bucket, path, btn)` — see
  "Signed downloads" below for how that actually reaches a private file
  without exposing the service role key or making the buckets public.

### Signed downloads (`api/sign_url.php`)

`bills`/`reports` are private Storage buckets — a raw object URL 403s.
Rather than making them public or handing the service role key to the
browser, `admin/admin.js`'s `downloadSignedFile(bucket, path, btn)` asks a
new server-side endpoint to mint a short-lived **signed URL** instead:

1. `sb.auth.getSession()` gets the admin's own current Supabase Auth
   session (already established by the existing login flow — nothing new
   here), specifically its `access_token`.
2. `fetch('/api/sign_url.php', {..., body: JSON.stringify({bucket, path,
   access_token})})` — bucket/path/token all travel in the JSON body (not
   an `Authorization` header) deliberately, since some shared hosts
   including Hostinger are known to strip the `Authorization` header from
   `$_SERVER` before PHP ever sees it unless a specific `.htaccess`
   passthrough rule is added; putting the token in the body sidesteps that
   whole class of hosting quirk.
3. **`api/sign_url.php`** (server-side, `SUPABASE_URL` + the SERVICE ROLE
   key from `api/config.php`, never sent to the client):
   - Rejects anything but `POST`.
   - **Verifies the access token before doing anything else** —
     `supabase_auth_user_valid($accessToken)` (new in `api/supabase.php`)
     calls Supabase's own Auth API (`GET /auth/v1/user` with that token as
     the Bearer) and only proceeds if it comes back `200` with a user id.
     This is deliberately NOT a manual JWT-signature check (that would need
     the project's separate JWT secret, not one of the keys already in
     `api/config.php`, plus a JWT library) — asking Supabase's own Auth
     server "is this currently valid?" is simpler and equally
     authoritative. No valid, non-expired admin session, no signature —
     this is what keeps the endpoint from being an open "sign anything in
     these buckets" oracle, per the brief's explicit requirement.
   - Validates `bucket` is exactly `"bills"` or `"reports"` (`in_array(...,
     true)`, strict) and `path` is non-empty; rejects anything else.
   - Strips a leading `"{bucket}/"` prefix from `path` if present —
     `bill_path`/`report_path` are stored bucket-prefixed (e.g.
     `"bills/{id}/{filename}"`, see "Persistence" above), but Supabase's
     sign-URL API takes a bucket-*relative* path (the bucket is already its
     own URL segment: `/object/sign/{bucket}/{path}`). Harmless no-op if a
     caller ever sends an already-relative path.
   - `supabase_storage_sign_url($bucket, $path, 300)` (new in
     `api/supabase.php`) calls Supabase Storage's
     `POST /object/sign/{bucket}/{path}` with `{"expiresIn": 300}`, then
     stitches `SUPABASE_URL . '/storage/v1'` onto the relative `signedURL`
     Supabase returns so the caller gets a real, directly-usable absolute
     URL. Same verbose failure logging as `supabase_storage_upload()`
     (HTTP status, response body) on any failure.
   - Responds `{"success": true, "url": "...", "expiresIn": 300}` or
     `{"success": false, "error": "..."}` — always HTTP 200, same
     fail-soft convention as every other `api/*.php` endpoint.
4. Back in `admin.js`: on success, `window.open(json.url, "_blank",
   "noopener")` — the browser downloads/displays the file directly from
   Supabase Storage using the signed URL; the PHP endpoint is never in the
   actual file-transfer path, only the signing step. On failure (expired
   session, wrong bucket, Storage error), a red note appears above the
   table (`leadsError`, the same banner `loadLeads()` uses for load
   failures) instead of a silent no-op.

No RLS was loosened and no bucket was made public to enable this — the
signing step is still 100% server-side and still requires a live admin
session; a stolen signed URL is only useful for 300 seconds. The Excel
export intentionally does NOT embed these links (a signed URL saved into a
spreadsheet would be a dead link within 5 minutes of export) — it keeps
showing just the filename, per "Excel export" below.

**Excel export (`downloadLeadsExcel()`, SheetJS/`xlsx`):** bundled locally
at `assets/vendor/xlsx.full.min.js` (npm `xlsx@0.18.5`'s UMD build,
downloaded once and committed — not loaded from a CDN at runtime, same
discipline as the PDF fonts under `assets/fonts/`), loaded via a plain
`<script>` tag before `admin.js`, exposing `window.XLSX`. Unlike the
on-screen table, the export writes `flattenLead()`'s RAW values into cells
and applies native Excel number formats (`ws[addr].z`) after building the
sheet with `XLSX.utils.aoa_to_sheet()` — `irr` gets `"0.0%"` (a true
percentage cell, not a pre-formatted string) per the brief's "IRR as %",
kWp/tariff/payback/net-capital get plain numeric formats (`"0.00"`/`"0.0"`/
`"#,##0"`) per "currency as numbers" — so every number stays usable for
further calculation in Excel rather than being a display-only string.
Bill/Report columns go through a small local `filenameFromPath()` (export-
only now — the on-screen table needs the full path for the signed-download
button, so `flattenLead()` no longer pre-reduces it) to get just the
filename, since a signed URL would be dead within 5 minutes of being
exported into a spreadsheet. Column widths are set via `ws['!cols']` from
each column's label length.
Filename: `rite-solar-leads-YYYY-MM-DD.xlsx` (today's date, zero-padded).
The button is `disabled` until a successful `loadLeads()` populates at
least one row (and re-disabled if the table turns out empty), so it can
never try to export nothing.

Nothing about the customer-facing flow changes because of this — the public
page still just calls `RiteConfig.load()`; it's `api/get_config.php` that
now returns live data instead of `assets/config-defaults.js` returning it
directly.

## Persistence (`api/lead.php`, `api/complete.php`, `api/upload_bill.php`, `api/upload_report.php`)

Every write goes through PHP, server-side, using the Supabase **service
role** key from `api/config.php` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
— git-ignored, never sent to the client). The `app_config`/`submissions`
tables and the private `bills`/`reports` storage buckets already exist (SQL
in `backend_and_admin.md`). `api/supabase.php` is a small shared helper
(`supabase_rest()` for PostgREST, `supabase_storage_upload()` for Storage)
used by all four endpoints below — every function in it returns
`null`/`false` on any failure (bad config, network error, non-2xx) instead
of throwing, and every endpoint's own exception/fatal handlers respond
`{"success": false}` with HTTP 200 rather than erroring, so a Supabase
outage can never turn into a broken fetch on the client. Reading config from
Supabase (`api/get_config.php`) is documented separately under "Config
wiring" above — unrelated to persisting submissions.

**Two-stage write, so bounced leads are still captured:**

1. **`api/lead.php`** — called from `assets/js/app.js`'s entry-form submit
   handler, fired in parallel with extraction (not awaited before the
   extraction request goes out). Inserts a `submissions` row
   (`company_name`, `mobile`, `category`, `stage='entered'`) and returns its
   `id`. The front end holds this as `currentSubmission.idPromise` — every
   later persistence call awaits it and treats a `null` id (Supabase
   down/misconfigured, or the insert failed) as "nothing to attach this to,
   skip silently."
   - `company_name` is filled from the entry form's Name field
     (`nameInput`/`in-name`) — that field is already conceptually "Company
     Name" per this spec's Pipeline section; the visible label/id hasn't
     been renamed (still a follow-up, see Owner notes).
2. **`api/upload_bill.php`** — called right after extraction succeeds
   (`json.success === true`), with the ORIGINAL file(s) the customer picked
   (`frontFile`/`backFile` — not the downscaled photos or the per-page PDF
   renders sent to `api/extract.php`). `bill_file_front` is required;
   `bill_file_back` is only sent when the customer uploaded a loose
   back-of-bill photo (never for a PDF upload — the front slot going PDF
   hides/clears the back slot client-side, see "Bill upload: front/back
   photo slots" below). Each is uploaded to the private `bills` bucket at
   `{submission_id}/{submission_id}_front.{ext}` /
   `{submission_id}_back.{ext}` via the Storage REST API, then `PATCH`es the
   row's `bill_path` (front/only page) and, if present, `bill_path_back`.
3. **`api/complete.php`** — called after `RiteFormulation.derive()` +
   `RiteEngine.compute()` + `renderDashboard()` have already run and the
   dashboard is on screen (`confirmBtn`'s click handler, after
   `dashboardSection.style.display = "block"`). `PATCH`es the row with the
   confirmed `extracted` JSON (the same object `collectConfirmedData()`
   returns) and a `computed` summary (`offered_kwp`, `effective_tariff`,
   `annual_generation`, `ex_gst_capital` from `formulation`; `irr`
   (`m.irrV`), `payback_years` (`m.payback`), `npv` (`m.npvV`), `lcoe`
   (`m.lcoe`) from a fresh `RiteEngine.compute()` call against
   `dashState`), plus `stage='completed'` and `completed_at`. Only touches
   those fields — a PostgREST `PATCH` is partial, so it never clobbers the
   `bill_path`/`report_path` `upload_bill.php`/`upload_report.php` may have
   already set.
4. **`api/upload_report.php`** — called right after the branded PDF has
   already started downloading (`downloadPdfBtn`'s click handler). See "PDF
   report" below for the full design; in short, it mirrors
   `upload_bill.php`'s shape exactly but uploads to the private `reports`
   bucket and sets `report_path` instead of `bill_path`.

**Resilience:** all four calls are fire-and-forget from the UI's
perspective — `createLead()`/`uploadBillFile()`/`persistCompletedSubmission()`/
`uploadReportFile()` in `assets/js/app.js` never block `showStep()`,
`renderDashboard()`, or the PDF download, and every promise chain ends in a
`.catch()` that just `console.warn`s. The customer's dashboard (and PDF
download) render identically whether Supabase is configured, down, or slow.
`currentSubmission.idPromise` is reset to `null` on "Start over" so a second
customer's confirm doesn't accidentally patch the first customer's row.

## Branding

`assets/img/rite-solar-logo.png` is the real Rite Solar logo (a wordmark on
a near-white background — not the palette's dark navy). It appears in two
places, both wrapped in a small white rounded "chip" so it never floats as
a pale rectangle on a dark background:

- **`index.html`'s hero header** — replaces the earlier text-only `Rite
  Solar` wordmark (`.logo` / `.r` / `.s` / `.dot`, still used as-is by
  `admin/index.html`'s header, which no task has touched) with
  `.logo-chip > img.logo-img` on the dark-navy `.hero` background.
- **The PDF report's header bands** (`assets/report.js`'s `drawHeroBand()`
  on page 1, `drawTopBand()` on pages 2–3) — same logo, same white-chip
  treatment, on the PDF's own dark-navy band background (see "PDF report"
  below for that palette, which is a separate set of RGB constants from
  the CSS variables here — jsPDF has no CSS access).
- `assets/img/advisor.png` (a separate, later addition — see "PDF report")
  is a photo, not a logo, and is NOT chip-wrapped; it bleeds off the right
  edge of the PDF's page-1 hero band per that design.

The rest of the palette (`--rs-blue`/`--rs-gold`/`--rs-navy`/`--rs-green`/
`--rs-red`/`--rs-muted`) is what the on-screen dashboard uses; the PDF
report has its own, deliberately distinct palette matching the reference
memorandum it's designed after — see "PDF report" below.

## PDF report (`assets/report.js`, `api/upload_report.php`)

"Download my report (PDF)" is the first thing inside `#dashboardSection`,
above the compare card — visible immediately once the dashboard renders.

**Why it's built from primitives, not a screenshot:** a screenshot would
capture whatever the interactive page happens to look like at that instant
— sliders, toggles, tab bar, "Start over" button and all — and would be at
the mercy of the viewport's width/scroll position. Instead
`RiteReport.buildAndDownload(ctx)` draws the PDF from scratch with jsPDF +
jspdf-autotable (loaded from cdnjs, pinned to `2.5.1`/`3.8.2` respectively —
verified those exact versions resolve to real UMD builds before pinning
them, same discipline as `pdf.js`/`Chart.js`). Interactive controls simply
never enter the picture — there was never any DOM to scrape.

**Visual design — "Investment Ka Dhurandhar" memorandum layout.** The PDF
was redesigned to match `reference/Rite_Solar_Investment_Safal_50kw.pdf` (a
sample memorandum copied into the repo for this purpose) rather than the
generic report layout built in the previous task. Palette (distinct from
the on-screen dashboard's `--rs-*` CSS variables, defined as RGB triplets in
`report.js` since jsPDF has no CSS access): navy `#0B3A53`, dark navy
`#072A3D` (band backgrounds), yellow `#F5A800` (headline/KPI numbers/
dividers), gold `#F7941D` (smaller text accents), green `#1E9E4F`, sky blue
`#29ABE2`, plus light grey panels and the brand red for negative figures.

**A key design decision — two fresh, self-contained scenarios, not the live
dashboard's:** the old version used `dashState.m` (whatever scenario the
customer's sliders/tab happened to be on) for everything. The redesign
instead computes two scenarios itself, inside `buildAndDownload()`, every
time:
- **`allCashScenario`** — `ctx.scenario` with `loan` forced `false`. This
  drives the headline IRR/LCOE/earnings/multiple/payback (page 1's KPI
  chips), the "where this money works hardest" comparison, and the page-2
  "your capital, compounding" chart — matching the reference's framing,
  where the primary pitch is always the unlevered case.
- **`stdFinScenario`** — `config`'s own `dp_default`/`loan_rate_default`/
  `tenure_months_default` with `loan` forced `true`. This drives ONLY the
  page-2 "Financed option — {dp}% down payment (standard scenario)" panel
  — a fixed illustration, not tied to wherever the customer's live loan
  slider happened to be left.

Tax rate, the depreciation toggle, and the FD comparison rate still come
from `ctx.scenario` (genuine customer inputs worth keeping), but financing
terms for the all-cash headline are always off, and the financed panel's
terms are always the config defaults. This is a deliberate simplification
matching the reference's static-memorandum framing, and it means the report
no longer reads `ctx.m`, `ctx.scenarioKey`, or `ctx.charts` at all —
`assets/js/app.js`'s `downloadPdfBtn` handler still builds and passes them
(untouched, per this task's explicit scope), they're just unused now.

**Charts are rendered fresh, not reused from the live dashboard.** The old
version called `.toBase64Image()` on `dashState.chCmp`/`chLump`/`chLev` —
Chart.js instances reflecting whatever the live scenario/tab was. Since the
redesign's numbers are now always the all-cash/standard-financed scenarios
(which may differ from whatever was on screen), reusing those live
instances could show a chart that contradicts the surrounding text. Instead
`renderCompareChartImage()`/`renderCumulativeChartImage()` build their own
throw-away Chart.js instances on a plain (never DOM-attached) `<canvas>`
with `responsive: false, animation: false` — the latter matters, because
without it `toBase64Image()` called immediately after construction could
capture a blank first animation frame instead of the finished chart. Both
are destroyed right after their image is extracted. The compare chart
mirrors `assets/charts.js`'s `renderCompareChart()` visually (same colors,
same "% label past the bar end" plugin) but is a separate implementation —
`charts.js` (the live dashboard) was not touched. The cumulative chart is a
single green fill line (no FD-comparison second line, unlike the on-screen
version) plotted in ₹ lakh on the y-axis, matching the reference exactly.

**Contents, page by page** (all three pages share `stampFooters()` — a
dark-navy strip on every page, "Rite Solar · Powering Homes the Right Way"
left, "Investment Memorandum · {Company} · Page N" right):
- **Page 1** — a tall dark-navy hero band: logo on its white chip, "SOLAR
  INVESTMENT MEMORANDUM" top-right, the "INVESTMENT KA / DHURANDHAR"
  two-line headline, "Prepared for {NAME}" (name upper-cased, matching the
  reference), a 3-line summary sentence templated from
  `allCashM.irrV`/`lock.size`, the advisor photo (`assets/img/advisor.png`,
  downscaled via canvas to a 480px-max source before embedding — "so the
  PDF stays light" per the brief; failure to load it is non-fatal, the
  hero just renders without it) bleeding off the right edge, then 5 navy
  KPI chips (IRR, Solar Cost/Unit, Net Earnings/25yrs, Money Multiple,
  Capital Recovered) inside the same navy field, a yellow divider, the
  compare heading/chart, and a light-green "Value back on {net capital}
  over 25 years — Solar: {total} " panel (the amount in bold green).
- **Page 2** — a slim top band ("The numbers behind the return"), the
  cumulative chart, two sky-blue-accented explainer cards ("1 · System
  size -> {kwp} kWp" / "2 · Per-unit value -> ₹{tariff}/unit" — same
  narrative content `renderNarrative()` shows on screen, re-derived as
  plain paragraph text here rather than reusing its HTML), a striped
  technical-snapshot table (capacity, modules, inverter class, annual
  generation, capital outlay, net capital, metering, warranty), and the
  green-accented financed-option panel (6 mini-stats + a templated
  paragraph — see below).
- **Page 3** — top band ("25-year cash-flow schedule"), a caption noting
  this is the all-cash case, the 25-year table (8 columns — Yr/Rate/Units/
  Gross Saving/AMC/Dep. Benefit/Net Cash Flow/Cumulative, dropping Finance
  Cost/Spares/Interest to match the reference's simpler layout; the
  underlying `r.net`/`r.cum` figures already fold spares in regardless of
  whether that column is shown, so nothing is miscalculated by omitting
  it), striped rows, Net Cash Flow bold green/red by sign, Cumulative red
  when negative (`didParseCell` in the `jspdf-autotable` call), and the
  existing short disclaimer sentence beneath it (kept verbatim, per the
  brief — NOT the reference's own longer legal paragraph).

One deliberate deviation from the reference's literal numbers: the
"work this hard"/"value back" panel uses `RiteEngine.inrShort()` (auto
picks L or Cr by magnitude) rather than hardcoding "lakh" the way the
Safal example happens to read — `inrShort()` already renders "₹25.50 L" for
that example, but a much larger installation would need "Cr", and
hardcoding "lakh" would be wrong for those customers.

The 25-year table also switches to plain Western-grouped numbers with no
₹ prefix (`toLocaleString("en-US")`), matching the reference's schedule
exactly — every OTHER money figure in the PDF keeps this tool's usual
₹-prefixed Indian grouping (`RiteEngine.inr`/`inrShort`), this table alone
is styled like the reference's dense schedule.

**Font (`assets/fonts/NotoSans-{Regular,Bold}.ttf`):** jsPDF's built-in
"helvetica" has no ₹ glyph — it rendered as garbage (¹, a stray quote mark)
everywhere a rupee amount appeared, and the `−` (U+2212 MINUS SIGN) used for
the GSC/ToD-rebate lines hit the same problem. Fixed by bundling Noto Sans
(static Regular + Bold instances, OFL-licensed, sourced from
`notofonts/NotoSans` on GitHub — confirmed both contain U+20B9 ₹, U+2013 en
dash, U+2014 em dash, and U+00B7 middle dot via `fontTools` before bundling)
as real `.ttf` files under `assets/fonts/`, fetched once per report
(`loadFontBase64()`), base64-encoded, and embedded into the PDF itself via
`doc.addFileToVFS()` + `doc.addFont()` (`registerFonts()`) — NOT loaded from
a CDN at runtime, so this keeps working offline and on Hostinger with no
external dependency. Every `doc.setFont(...)` call in the redesigned file
(including inside every `jspdf-autotable` call's `styles`/`headStyles`,
which otherwise default back to Helvetica regardless of the document's
current font) uses this `"NotoSans"` family — there is no code path left
that touches Helvetica, including the new KPI chips, striped tables, and
mini-stat panels this task added. Every minus sign in the file (the two
"− ₹" GSC/ToD-rebate lines) uses a plain ASCII hyphen `-` (U+002D), not
U+2212, which this font doesn't have — confirmed via a `fontTools` cmap
check and a source-file scan for the character, both showing zero
remaining U+2212 usages. `loadFontBase64()`/`loadImage()` (the logo and,
new in this task, the advisor photo) are fetched together via
`Promise.all()` before any PDF drawing starts; the advisor photo's promise
is wrapped in its own `.catch(() => null)` so a missing/failed photo
doesn't take down the whole report, unlike the logo and fonts, which
remain hard requirements.

**Bug fixed along the way:** `LOGO_URL` still pointed at
`rite-solar-logo.jpeg` from the original branding task, but the actual
file under `assets/img/` had since become `rite-solar-logo.png` (and the
`addImage()` format argument still said `"JPEG"`) — the logo silently
couldn't have loaded at all before this fix. Both the URL and the
`addImage()` format argument now say `.png`/`"PNG"`.

**Company name / category / consumer number:** `ctx.companyName` comes from
the entry form's Name field (`nameInput.value`, the same value already sent
as `company_name` to `lead.php` — see the Persistence section's note on
this field), `ctx.category`/`ctx.consumerNumber` come from
`dashState.confirmed.tariff_category`/`.consumer_number` (the CONFIRMED
values, stashed onto `dashState` in the `confirmBtn` handler specifically so
the PDF button can reach them later without re-reading the DOM). Page 1's
"Prepared for" line upper-cases the company name (`.toUpperCase()`),
matching the reference memorandum's all-caps company name; nowhere else in
the PDF changes its case.

**Resilience — download first, store best-effort:** `doc.save(filename)`
triggers the browser download; `doc.output("blob")` (called immediately
after, same `doc` object, no race) gives the bytes for the upload. `app.js`
downloads first, THEN calls `uploadReportFile(blob)`, which — like
`uploadBillFile()` — is fire-and-forget: it awaits
`currentSubmission.idPromise`, no-ops (with a `console.warn` explaining
why) if there's no id, and its promise chain ends in a `.catch()` that only
`console.warn`s. A Supabase outage (or a missing `reports` bucket) can
never take away the customer's already-downloaded PDF. Unlike a bare
`fetch()`, `uploadReportFile()` also reads the JSON response and
`console.warn`s if `success` is `false` — a `fetch()` promise only rejects
on a network-level failure, not on a `200 {"success": false}` response, so
without this the browser console would show nothing at all when the
upload logically failed.

**`api/upload_report.php`** — mirrors `api/upload_bill.php`'s shape, with
much more verbose `error_log()` coverage added after a real "nothing
appears in the bucket" bug report: every branch (missing id, missing
`report_file`, a PHP `UPLOAD_ERR_*` code, oversize file, unreadable
tmp file, the Storage upload itself, the `report_path` `PATCH`) now logs
specifically why it failed — including a call to `supabase_config_problem()`
(new in `api/supabase.php`, returns *which* of `SUPABASE_URL`/
`SUPABASE_SERVICE_ROLE_KEY` is missing or still a placeholder, instead of a
bare "not configured"), and `supabase_storage_upload()`'s own failure log
now includes the full request URL, byte count, mime type, and the HTTP
status + response body from Supabase — that line is almost always the
answer (e.g. HTTP 404 "Bucket not found" means the private `reports`
bucket, a manual Supabase Dashboard step per `backend_and_admin.md`/
`DEPLOY.md`, was never created). Also fixed a real silent-success bug found
during this: a PostgREST `PATCH` that matches **zero** rows still returns
HTTP 200 with `[]` — `is_array([])` is `true`, so the endpoint used to
report `{"success": true}` even when `id` didn't match any `submissions`
row and nothing was actually updated. It now checks `count($rows) > 0` and
logs a specific "PATCH matched ZERO rows" message when that happens. Mime
type is hardcoded `application/pdf` (unlike `upload_bill.php`, no need to
sniff it — this endpoint only ever receives a report this codebase itself
generated).

The same zero-rows-PATCH gap likely exists in `api/complete.php` and
`api/upload_bill.php` too (both share the `is_array($rows)` success check)
— not fixed here since neither was reported broken and this task was
scoped to the report-upload path specifically, but worth the same
`count($rows) > 0` tightening if a similar "nothing happened but it said
success" report ever comes up for either of them.

## Project layout

```
/index.html               entry + confirm + dashboard, one-page step flow
/assets/css/style.css      palette + layout, matches reference/estimate.html
/assets/js/app.js          form validation, image downscale, PDF->image via
                           pdf.js, submit, confirm render (needs_review/
                           suggested_corrections/quality UI), dashboard
                           wiring (formulation -> engine -> charts), sliders,
                           narrative templating
/assets/config-defaults.js DEFAULTS fallback + RiteConfig.load() (fetches
                           api/get_config.php, falls back to DEFAULTS)
/assets/formulation.js     RiteFormulation.derive() — SPEC.md's Formulas
/assets/engine.js          RiteEngine — irr/npv/pmt, inr/inrShort, compute()
/assets/charts.js          RiteCharts — Chart.js builders + 25-year table
/assets/report.js          RiteReport — builds + downloads the branded PDF,
                           "Investment Ka Dhurandhar" memorandum layout
                           (jsPDF + jspdf-autotable, no screenshot)
/assets/img/rite-solar-logo.png  the real logo — index.html's hero, the PDF
                           hero bands, and admin/index.html's header chip
/assets/img/advisor.png    advisor photo — index.html's hero AND the PDF's
                           page-1 hero (downscaled on embed — see report.js)
/assets/fonts/NotoSans-Regular.ttf  bundled Unicode font (has ₹), embedded
                           into the PDF by assets/report.js — not a CDN
/assets/fonts/NotoSans-Bold.ttf     same, bold weight
/assets/vendor/xlsx.full.min.js  SheetJS, bundled locally — powers the admin
                           Leads tab's Excel export, not a CDN
/assets/css/admin.css      admin-only CSS additions layered on style.css
/api/extract.php          extraction endpoint (text fast-path + vision path,
                           validation rules from extraction_hardening.md)
/api/lead.php             inserts a 'submissions' row on entry-form submit
/api/complete.php         patches that row on confirm (extracted + computed)
/api/upload_bill.php      uploads the original bill file(s) to Storage
                           (front required, back optional), patches
                           bill_path / bill_path_back
/api/upload_report.php    uploads the generated PDF to Storage, patches
                           report_path
/api/get_config.php       reads the app_config row (service role key)
/api/sign_url.php         mints a short-lived signed URL for a bill/report
                           file — requires a valid admin access token
/api/supabase.php         shared PostgREST/Storage/Auth REST helper (fail-soft)
/api/config.php           NOT git-ignored (holds no real secret); reads
                           ANTHROPIC_*/SUPABASE_* from getenv() first,
                           REPLACE_ME_... placeholders as fallback
/admin/index.html         admin login + config editor + Leads tab markup
/admin/admin.js           Supabase Auth + app_config load/validate/save +
                           Leads table/Excel export/signed downloads
/admin/config.js          NOT git-ignored; Supabase URL + anon key (public)
/composer.json            requires smalot/pdfparser
/Dockerfile               packages this app for Render (or any Docker host)
                           — see DEPLOY-RENDER.md
/docker/entrypoint.sh     rewrites Apache's port to $PORT before starting
                           (Render's health check requires this)
/.dockerignore            excludes vendor/ (rebuilt fresh in the image), .git
/SPEC.md                  this file
/DEPLOY.md                Hostinger deploy checklist (secrets, admin accounts,
                           Supabase setup)
/DEPLOY-RENDER.md         Render (Docker) deploy checklist
/reference/…              existing demo + sample bills + the "Investment Ka
                           Dhurandhar" reference PDF the report is designed
                           after — all left as-is / reference-only
/.gitignore               /vendor, composer.lock, /uploads (config.php is
                           deliberately NOT listed — see api/config.php above)
```

## Owner notes / things assumed (flag if wrong)

- Visual palette is reused as-is from `reference/estimate.html`'s `:root` CSS
  variables (`--rs-blue`, `--rs-gold`, `--rs-navy`, etc.) — not a separate
  brand-guideline hex set.
- Vision model defaults to `claude-opus-4-8` in `api/config.php` (highest
  accuracy on messy handwriting/stamps). Swap to a cheaper model there if
  per-bill cost matters more than accuracy — extraction quality on skewed,
  faint, or low-contrast photos should be re-checked before downgrading.
- `pdf.js` is loaded from cdnjs, pinned to `3.11.174` (the last line that
  still ships a classic `pdf.min.js`/`pdf.worker.min.js` UMD build usable
  from a plain `<script>` tag — newer releases are ES-module-only). Bump
  deliberately, not opportunistically, and re-test PDF rendering if you do.
- The "positive and large" daytime-rate-sign threshold
  (`extraction_hardening.md` doesn't give a number) is implemented as
  `> 0.5` Rs/unit in `validate_extraction()` — a judgment call to avoid
  flagging small, genuinely-non-rebate positive values while still catching
  an obvious dropped minus sign.
- A multi-page bill now uploads one image per page (capped at 8). Each is
  individually capped at 6 MB, but a several-page bill's total POST size can
  add up — if extraction mysteriously fails only on multi-page PDFs in
  production, check the host's `upload_max_filesize` / `post_max_size` /
  `max_file_uploads` PHP ini limits before assuming it's a code bug.
- `composer install` has not been run in this repo (no local PHP/Composer in
  the dev sandbox that built this) — `vendor/` does not exist yet. Run
  `composer install` before deploying or testing `api/extract.php`'s text
  path.
- Panel count on the Technical Snapshot card assumes ~580 Wp bifacial
  modules (`PANEL_WATTAGE` in `assets/js/app.js`) — the same assumption
  `reference/estimate.html` used (its "50 kWp → ~86 panels" checks out
  against 580 Wp exactly). Update this constant if the actual module spec
  changes.
- The dashboard heading is NOT yet "Prepared for {Company Name}" — the
  entry form still only collects Name/Mobile/Category (this task didn't
  touch the entry form itself, only formulation/engine/dashboard). Wiring
  the company-name heading through is a small follow-up, not done here.
- This was built and reviewed by reading the code, not by running it — there
  is no local PHP/Composer/browser test loop in this sandbox. The engine math
  was checked line-by-line against `reference/estimate.html`, but it hasn't
  been run against a real confirmed bill in a browser. Sanity-check the
  first real dashboard render (numbers in the right ballpark, sliders
  actually move the charts) before trusting it in front of a customer.
- If `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` in `api/config.php` are ever
  left as their `REPLACE_ME_...` placeholders (e.g. on a fresh checkout),
  every Supabase-touching endpoint (`lead.php`, `complete.php`,
  `upload_bill.php`, `get_config.php`) silently no-ops (logs via
  `error_log`, never breaks the customer flow) until real values are filled
  in — `get_config.php` specifically falls back to
  `assets/config-defaults.js`'s `DEFAULTS`.
- `api/lead.php`'s `company_name` comes from the entry form's Name field —
  the earlier-noted follow-up (renaming that field/label to "Company Name"
  and heading the dashboard "Prepared for {Company Name}") still hasn't been
  done; this task only wired the data flow, not that UI text.
- Bill files land in Storage at `{submission_id}/{submission_id}_front.{ext}`
  and, if a back photo was sent, `{submission_id}/{submission_id}_back.{ext}`
  inside the `bills` bucket — a fixed, suffixed filename per slot rather
  than the customer's original filename, so a re-upload for the same
  submission id always overwrites the same object (`x-upsert: true`) instead
  of accumulating stale files; this is intentional, not a bug.
- This task's Supabase code (REST inserts/patches, Storage upload) was also
  only reviewed by reading, not run against a live Supabase project — the
  request shapes match Supabase's documented PostgREST/Storage REST APIs,
  but verify a real `lead.php` call actually creates a row, and a real
  `upload_bill.php` call actually lands a file in the bucket, before relying
  on it.
- `admin/config.js`'s `SUPABASE_ANON_KEY` is still a `REPLACE_ME_...`
  placeholder — sign-in on `/admin/` won't work at all until it's replaced
  with the real anon/public key (see `DEPLOY.md`). This is the one piece of
  this task that needs a value only the project owner has; everything else
  works with what's already in the repo/`api/config.php`.
- Supabase JS is loaded from jsdelivr pinned to the **major** version only
  (`@2`), not an exact patch — confirmed the URL resolves to a real UMD
  build exposing `window.supabase` at the time of writing, but jsdelivr's
  `@2` alias means the exact patch version served can change over time.
  This is a deliberate tradeoff (see "Admin page" above), not an oversight;
  pin to an exact version instead if that drift is ever a concern.
- The admin page was reviewed by reading, not tested against a live
  Supabase project or in a browser — same caveat as everywhere else in this
  sandbox. Before handing login credentials to anyone: verify sign-in
  actually works, the loaded form matches what's in the `app_config` row,
  Save actually persists (reload and confirm), and that invalid input
  (e.g. `gst_rate=1.5`, `daytime_window=foo`) is rejected with a visible
  error rather than silently saved.
- Confirmed by reading every file under `/admin/`, `assets/config-defaults.js`,
  and `assets/js/app.js` that the string `SUPABASE_SERVICE_ROLE_KEY` and its
  value never appear outside `api/*.php` — the service role key stays
  server-side only.
- `jspdf`/`jspdf-autotable` are pinned to `2.5.1`/`3.8.2` from cdnjs —
  confirmed both URLs resolve to real UMD builds (the latter correctly
  attaching `.autoTable` to `jsPDF`'s prototype) before pinning them, same
  discipline as `pdf.js`/`Chart.js`. Bump deliberately and re-test PDF
  generation if you do — `assets/report.js`'s layout math (page-break
  thresholds, chart aspect-ratio scaling) was tuned against this exact
  version's page-size/text-measurement behavior.
- **PHP 8.5 deprecation cleanup**: removed every explicit `curl_close()`/
  `finfo_close()` call across `api/extract.php`, `api/supabase.php`, and
  `api/upload_bill.php` (5 call sites). Both `CurlHandle` and `finfo` are
  ordinary objects in PHP 8+, garbage-collected when the variable goes out
  of scope — the explicit close was always a no-op, and PHP 8.5 deprecates
  calling it at all. No behavior change; only quieter logs. `api/lead.php`,
  `api/complete.php`, `api/get_config.php`, and `api/upload_report.php`
  were written without these calls in the first place.
- **Mobile pass**: added breakpoints tightening `.wrap`/`.card` padding,
  stacking `.radiorow` and `.tabs` into full-width single columns, dropping
  `.kpis`/`.statline` to one column, and shrinking `.chartbox`/`.tod-table`
  — all below ~480px so desktop/tablet layouts are untouched. Charts
  themselves needed no JS changes: `RiteCharts`' builders already set
  `responsive: true, maintainAspectRatio: false` in every Chart.js config,
  so a canvas already fills whatever width its (now narrower) `.chartbox`
  container gives it. The wide 25-year table already had a working
  horizontal-scroll container (`.tbl-scroll{overflow:auto}`) from the
  engine-integration task; this task just confirmed it and left it alone.
  Reviewed by reading breakpoints against typical phone widths (320-400px),
  not in an actual mobile browser/device — worth a real-device check before
  trusting it in front of a customer, same caveat as always in this sandbox.
- **Graceful-degradation audit** (manual entry after total extraction
  failure): found and fixed a real bug rather than just confirming the
  happy path — see the "Formulas" section's expanded defensive-guard list
  above. The confirm form itself already worked end-to-end for manual entry
  (every field is built the same way regardless of whether extraction
  returned data or `blankExtraction()`); the gap was specifically in
  `formulation.js` silently zeroing missing tariff fields instead of
  refusing to compute — now fixed.
- The PDF's "Prepared for {Company Name}" header uses the same Name-field
  value as `api/lead.php`'s `company_name` — this task did NOT rename the
  entry form's field/label to "Company Name" or add that heading to the
  on-screen dashboard (only the PDF header uses that exact phrase); that
  remains the same open follow-up noted since the persistence task.
- This was built and reviewed by reading the code, not by running it — no
  local PHP/Composer/browser test loop in this sandbox, same as every prior
  task here. In particular: the PDF has never actually been generated and
  opened (page-break math, chart image scaling, and the landscape 25-year
  table were all reasoned through by hand against jsPDF/autotable's
  documented API, not visually confirmed), and `api/upload_report.php` has
  never run against a live Supabase project or a real `reports` bucket.
  Generate one real PDF end-to-end (ideally with a loan scenario active, to
  exercise the leveraged-tab code path too) and open it before sending one
  to an actual customer.
- **Font fix follow-up**: `assets/fonts/NotoSans-{Regular,Bold}.ttf` were
  verified with `fontTools` (`getBestCmap()`) to actually contain every
  non-ASCII codepoint `report.js` uses (₹ U+20B9, en/em dash, middle dot)
  before bundling — real static TTFs, not variable-font instances (jsPDF's
  built-in font parser is not guaranteed to handle variable fonts). What's
  still NOT verified: that `doc.addFont()`/`addFileToVFS()` actually
  produces a readable PDF with these files at runtime — that call path has
  never executed in a real browser in this sandbox. If ₹ still renders
  wrong after this fix, check the browser console first (`loadFontBase64()`
  will reject loudly if `assets/fonts/*.ttf` 404s or the fetch fails) before
  assuming the font itself is at fault.
- **Report-upload fix follow-up**: the added `error_log()` lines are the
  actual next step for diagnosing the original "nothing appears in the
  bucket" report — this sandbox has no way to read Hostinger's or a local
  PHP server's error log, so the true root cause (bucket missing vs. bad
  key vs. something else) is still unconfirmed. Trigger one real report
  download, then check the PHP error log for lines starting `[upload_report.php]`
  and `[supabase]` — they now say exactly which step failed and why.
- **PDF visual redesign follow-up (most recent task)**: `assets/report.js`
  was rewritten essentially from scratch to match
  `reference/Rite_Solar_Investment_Safal_50kw.pdf`'s "Investment Ka
  Dhurandhar" layout — every coordinate/spacing value in the file (hero
  band height, chip sizes, card heights, panel padding) was hand-picked
  from reading the reference PDF's rendered pages and the written design
  spec, NOT from any pixel measurement tool or live render — there is
  still no browser/PDF-viewer test loop in this sandbox. The very first
  real PDF this produces should be opened and checked page-by-page against
  the reference for: page 1 fitting on one page (KPI chip captions are the
  most likely thing to overflow their 60pt-tall chip if a caption wraps to
  3 lines — unlikely but not impossible for unusual numbers), the advisor
  photo not overlapping the summary paragraph or headline for a very long
  company name, page 2's stack (chart + cards + table + financed panel)
  fitting on one page without a card/table given the actual (not
  estimated) heights `jspdf-autotable` produces, and page 3's 25-row table
  actually fitting one portrait page rather than triggering `autoTable`'s
  automatic pagination (both are handled gracefully — pagination just
  means a bonus page 4 with a repeated header row — but only the
  single-page case matches the reference).
- The 25-year table's column set was deliberately narrowed from 11 columns
  (the previous generic-report version) to the reference's 8 — Finance
  Cost/Spares/Interest are no longer shown as their own columns on page 3.
  This is a display-only change: `RiteEngine.compute()`'s `r.net`/`r.cum`
  already fold spares/finance/interest into their totals internally
  regardless of which columns get printed, so the bottom-line Net Cash
  Flow / Cumulative figures are exactly as correct as before — nothing
  about the engine or its math changed for this task.
- The reference PDF's own page-3 disclaimer is a longer legal paragraph
  ("Illustrative financial estimate based on the inputs shown... IRR,
  yield and comparisons are project cash-flow metrics for illustration
  only.") — per this task's explicit instruction to "keep existing
  disclaimer text," the PDF still uses this tool's own shorter sentence
  ("This tool gives an illustrative estimate only and is not a binding
  quotation."), not the reference's longer wording. Flag if the longer
  legal paragraph was actually wanted instead.
- Found and fixed a real (unrelated to this task's ask, but blocking)
  bug while rewriting the logo-loading code: `assets/report.js`'s
  `LOGO_URL` still pointed at `rite-solar-logo.jpeg` from the original
  branding task, but the actual file has since become
  `assets/img/rite-solar-logo.png` — the PDF's logo could not have loaded
  at all before this fix (the `Promise.all()` covering image+font loads
  would have rejected on the 404, failing the entire report generation).
  `index.html`'s own hero header already correctly referenced the `.png`
  file, so only `report.js` had the stale reference.
- **Admin Leads view follow-up (most recent task)**: the `admin_read_submissions`
  RLS policy is written into `backend_and_admin.md`'s SQL block, but this
  sandbox has no way to run SQL against a live Supabase project — it must
  be applied manually (Supabase SQL editor) before the Leads tab will show
  anything but a "Couldn't load submissions" error. Likewise, the whole
  Leads flow (the query, `flattenLead()`'s field mapping, the Excel
  export's cell formats) was reviewed by reading only, never against a
  real `submissions` table with real rows — in particular, verify a
  `stage='entered'` row (no `computed` at all) renders its numeric columns
  as blank rather than erroring, and open one exported `.xlsx` in Excel to
  confirm the IRR column actually reads as a percent-formatted cell and
  not a raw `0.289`.
- `assets/vendor/xlsx.full.min.js` is npm's published `xlsx@0.18.5` UMD
  build (SheetJS Community Edition, Apache-2.0), fetched once and
  committed — confirmed it's syntactically valid and exposes `window.XLSX`
  before bundling, but (same caveat as everything else here) the actual
  `aoa_to_sheet`/cell-format/`writeFile` call sequence in `admin.js` has
  never produced a real file in a browser. If newer SheetJS versions are
  ever needed, re-verify the `XLSX.utils.*` function names used here still
  exist — this pin was chosen specifically because 0.18.5 is a long-stable,
  widely-used release, not the latest.
- **Update (signed-downloads task, most recent)**: the previous note here
  said Bill/Report columns were plain filename text because turning them
  into real downloads was out of scope — that follow-up is now done. They
  render as live "Download" buttons wired to `api/sign_url.php` (see
  "Signed downloads" above); the option chosen was the new-PHP-endpoint one
  (not a `storage.objects` RLS policy), since it keeps the service role key
  server-side and needed no change to bucket-level RLS at all.
- **Signed-downloads follow-up**: `api/sign_url.php`,
  `supabase_auth_user_valid()`, and `supabase_storage_sign_url()` were
  reviewed by reading only — the same caveat as everywhere else in this
  sandbox — never run against a live Supabase project or clicked in a
  browser. Before relying on this: click one Download button in a real
  session and confirm the file actually opens; sign out (or let the
  session expire) and confirm the button then shows the "session has
  expired" error instead of silently failing or, worse, still signing
  successfully; and confirm `GET {SUPABASE_URL}/auth/v1/user` really does
  reject an expired/garbage token with a non-2xx (this is the entire
  security boundary of `sign_url.php` — if that assumption about GoTrue's
  behavior is wrong, the endpoint's access-token check is a no-op).
  Sending the access token in the JSON body instead of an `Authorization`
  header (to dodge Hostinger's known header-stripping quirk) was also
  never verified against Hostinger specifically — if a future refactor
  moves it back to a header, re-check that first.
- **Render/Docker packaging (most recent task)**: `api/config.php` changed
  shape — it now reads `getenv()` first and falls back to `REPLACE_ME_...`
  placeholders instead of hardcoded real values, and is **no longer
  git-ignored** (see `.gitignore`, `DEPLOY.md`, `DEPLOY-RENDER.md`). This
  was a deliberate, security-motivated rewrite: the file is about to become
  git-tracked for a container-based deploy, and "reads from env, falls back
  to file constants" only makes sense end-to-end if the fallback constants
  in the *committed* file are safe to expose — real per-deployment values
  now live exclusively in Render's dashboard env vars, or are edited
  directly on a Hostinger server and never committed back. Functionally
  nothing changes for the existing Hostinger flow (still edit the file
  in-place on the server), and nothing changes for any other code that
  reads `ANTHROPIC_API_KEY`/`SUPABASE_URL`/etc. — same constant names, same
  values once configured, just a different source (env var vs. hardcoded
  literal) checked in a specific order.
- The `Dockerfile`/`docker/entrypoint.sh` were written and reviewed by
  reading Apache's and Render's documented behavior carefully, not by
  actually building the image or deploying it — there is no Docker daemon
  or Render account in this sandbox. `DEPLOY-RENDER.md`'s last section
  spells out the local `docker build`/`docker run` smoke test to run before
  trusting this in production. The riskiest untested assumption: that
  Apache's Debian package always ships `/etc/apache2/ports.conf` and
  `/etc/apache2/sites-available/000-default.conf` with exactly the
  `Listen 80`/`<VirtualHost *:80>` text the entrypoint's `sed` patterns
  expect — true for the stock `php:8.2-apache` image at the time of
  writing, but worth a quick `docker run --rm php:8.2-apache cat
  /etc/apache2/ports.conf` check if a future base-image bump ever changes
  that file's contents.
- **Two-image bill upload (front/back, most recent task)**: the single
  `in-bill` file input became two slots (`in-bill-front` required,
  `in-bill-back` optional, image-only) — see "Bill upload: front/back photo
  slots" above. Schema change: rather than a `jsonb` array of paths, a
  single new nullable column `bill_path_back text` was added to
  `submissions` (`alter table submissions add column if not exists
  bill_path_back text;` in `backend_and_admin.md`, same pattern as
  `report_path`'s earlier addition), leaving the existing `bill_path` column
  as the front/only-page path unchanged. This was the smaller, lower-risk
  option of the two offered: it touches nothing that already reads
  `bill_path` (admin Leads columns, `sign_url.php`'s generic bucket/path
  validation, the RLS policy), it needed no migration of existing rows (all
  simply get `bill_path_back = null`), and it avoids restructuring a
  well-established scalar-column shape into a `jsonb` array for what is, at
  most, two files. The PDF path is completely untouched — `bill_pdf` /
  `bill_image[]` semantics, `MAX_IMAGE_COUNT`, and the free text-layer
  fast-path in `api/extract.php` are all exactly as before. As with
  everything else in this sandbox, this was built and reviewed by reading,
  not by clicking through a real upload in a browser or running it against
  a live Supabase project — before trusting it in front of a customer,
  apply the `bill_path_back` column migration, then manually test: (a) a
  front-only image upload, (b) a front+back image upload, (c) a PDF upload
  (confirm the back slot actually hides/clears and no `bill_file_back` is
  sent), and confirm the admin Leads tab's new "Bill file (back)" column and
  its Excel export column both behave correctly when the value is `null`.
- **Commercial formulation (most recent task)**: added a second, fully
  independent tariff path — `deriveCommercial()` in `assets/formulation.js`,
  its own extraction schema/prompt/validator in `api/extract.php`
  (`call_commercial_vision_api*()`, `commercial_vision_*()`,
  `validate_commercial_extraction()`), its own confirm-screen field builder
  in `assets/js/app.js` (`buildCommercialRateFields()`), and its own
  narrative prose in both `app.js` and `report.js` (`renderCommercialNarrative()`
  / `narrativeCards()`'s commercial branch). Industrial's own functions were
  renamed (`derive()` -> `deriveIndustrial()`, `renderNarrative()` ->
  `renderIndustrialNarrative()`) but their BODIES are untouched — verified by
  reading, not by a diff tool, so worth a `git diff` gut-check on
  `deriveIndustrial()`/`renderIndustrialNarrative()` specifically against the
  pre-this-task version if that matters to you.
  - **Deliberately duplicated, not shared, despite this file's usual
    "parameterize, don't duplicate" preference**: `call_commercial_vision_api_attempt()`
    in `api/extract.php` re-implements `call_vision_api_attempt()`'s curl
    mechanics rather than parameterizing the existing function with a
    prompt/schema/tool-name argument. The one exception was `engine.js`'s
    `compute()`, which genuinely had to change (see "Commercial formulation"
    section's "Downstream engine" note) — everywhere else, duplicating ~50
    lines of already-working curl code seemed like a better trade than
    touching a function every existing industrial customer's extraction
    already runs through.
  - **No free text-layer fast path for commercial** — `api/extract.php`'s
    commercial branch always calls vision, never attempts
    `smalot/pdfparser` + regex parsing the way industrial's PDF uploads can.
    No commercial bill layout was available to build/verify a parser
    against (same caveat industrial's own fast path already carries, just
    with zero attempt made here instead of an unverified one). This costs
    more per commercial PDF upload than it strictly needs to, but a wrong
    guess at a commercial bill's text layout seemed worse than a small,
    known cost increase.
  - **Verified exactly**: `effective_tariff` (10.22545), `offered_kwp`
    (7.49, sanctioned-load-capped, kept as a decimal not rounded),
    `rate_per_kwp` (58000, from the floor-lookup table), `gross_cost`
    (434420), `net_cost_inc_gst` (473083.38) — all matched the reference
    bill's expected values exactly in the Node test harness (see below).
  - **NOT verified exactly — closest match found**: IRR/payback. See the
    "Commercial formulation" section's `dep_default_commercial` note for the
    full account — turning commercial's depreciation-toggle default OFF
    closes nearly all of a ~10-point IRR gap, landing at ≈34.86%/≈4.14yr
    against an expected ≈34.25%/≈4.275yr (both figures were given with "≈"
    in the task, so this may already be within the reference workbook's own
    rounding — but it was not possible to confirm that here). **If exact
    parity matters**, the most likely remaining lever is a downstream
    constant this task's brief called "commercial equivalents of existing
    tunables" without naming one specifically (a different AMC rate, spares
    rate, or degradation curve for small commercial systems) — none of
    which could be reverse-engineered from a single worked example with only
    two free knobs (IRR, payback) to fit against. Provide either the
    reference workbook itself or a second worked example (different size/
    tariff) and this can be pinned down exactly.
  - **Test harness**: `C:\Users\asus\AppData\Local\Temp\claude\d--RiteSolar-estimate\754e1555-0394-4ea7-bc75-9964bf4d4c0d\scratchpad\test-commercial.js`
    (session scratchpad, not part of the repo) — a standalone Node script
    that `require()`s the real `assets/formulation.js`/`assets/engine.js`
    (shimming the `window` global they attach to) and runs the reference
    bill's numbers through both, asserting the exact-match figures above and
    reporting the IRR/payback gap. Not committed to the repo since it's a
    one-off verification script, not a maintained test suite — copy it
    somewhere durable if you want to re-run it after a future change to
    either file.
  - Admin UI: a new "Commercial" `FIELD_GROUPS` entry in `admin/admin.js`,
    plus a new `type: "json"` field kind (a `<textarea>`, parsed/
    stringified as JSON) added to `buildField()`/`populateForm()`/
    `validateAndCollect()` — purely additive, the existing `number`/
    `fraction`/`bool`/`select` branches are untouched. This was reviewed by
    reading only; open `/admin/` and confirm the JSON textarea actually
    populates, validates malformed JSON with a clear error, and saves/
    reloads the `commercial_rate_table` correctly before relying on it.
  - The `update app_config set config = config || '...'::jsonb where id=1;`
    merge statement in `backend_and_admin.md` must be run once before the
    admin page's "Commercial" fields have real values to show (they'll
    render blank/`NaN` otherwise, same as any other config key added after
    a project's `app_config` row was first seeded).
- **Wheeling/demand_charge correction (most recent task)**: real-bill
  testing found the field captured as `commercial.demand_charge` was
  mislabelled — it's actually the bill's "Wheeling Charges" line, which the
  commercial formulation already had a SEPARATE `wheeling` input for. Both
  were being summed into `effective_tariff` (a genuine double-count), and
  `demand_charge` was additionally divided by `current_month_units` even
  though the value is already Rs/unit, not a Rs/month total. `demand_charge`
  is now removed entirely (extraction schema/prompt/validator in
  `api/extract.php`, confirm-screen field in `app.js`, `deriveCommercial()`
  in `formulation.js`, narrative prose in `app.js`/`report.js`) — `wheeling`
  is the only field for this line, used directly (no ÷ units). Industrial's
  `demand_charge_per_unit` is a real, separate, correctly-Rs/unit field and
  was NOT touched anywhere.
  - **Effective tariff changed**: `10.22545` -> `10.0621` for the reference
    bill (delta `-0.16335`) — see "Commercial formulation" above for the
    corrected formula and worked example. Sizing/pricing (`offered_kwp`,
    `rate_per_kwp`, `gross_cost`, `net_cost_inc_gst`) are unaffected — they
    never depended on this field.
  - **Legacy read-side fallback**: `deriveCommercial()` now does
    `wheeling = !isMissing(c.wheeling) ? c.wheeling : c.demand_charge` before
    validating, so an old-shaped `commercial` object (has `demand_charge`,
    no `wheeling`) still produces a number instead of throwing. This is
    "graceful", not "numerically correct" — a legacy row's `demand_charge`
    was captured as a Rs/month total under the wrong label, so feeding it
    in raw (as the fallback does) does NOT retroactively fix historical
    data, it just avoids a hard failure. Checked whether this matters in
    practice: the admin Leads view's query never selects `submissions
    .extracted` at all (only the flattened `computed` summary), and nothing
    else in this codebase re-feeds an archived `extracted` row back into
    `deriveCommercial()` — so as of this task, no live code path actually
    exercises this fallback. It exists for whatever future feature might
    read raw archived extractions (e.g. an admin "view original extraction"
    or "re-run formulation" tool), not because a real bug was found today.
    Could not check live Supabase data directly (no DB access in this
    sandbox) — if you want to know whether any real stored rows actually
    have the old shape, run `select id, extracted->'commercial' from
    submissions where extracted->'commercial'->'demand_charge' is not null`
    in the Supabase SQL editor.
  - **IRR/payback got closer, coincidentally**: re-running the "Commercial
    formulation" section's IRR/payback investigation with the corrected
    `10.0621` tariff (same `dep_default_commercial=false` assumption) landed
    at ≈34.13%/≈4.21yr — closer to the ≈34.25%/≈4.275yr target than the
    ≈34.86%/≈4.14yr found before this fix. Not re-verified against any new
    target (none was given for this task), just reported for visibility.
  - Verified via the same scratchpad Node harness as the original
    commercial-formulation task (not committed to the repo — see that
    task's Owner note for the path), extended with an assertion that
    `demand_charge`/`demand_per_unit` no longer appear in
    `tariff_breakdown` and a hand-computed check of the new
    `effective_tariff`. Not re-tested in a live browser or against a real
    commercial bill photo — same standing caveat as the original task.
