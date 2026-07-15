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
  "sanctioned_load_value": number|null,
  "sanctioned_load_unit": "kW"|"HP"|"kVA"|null,
  "current_month": {
    "total_units": number|null,
    "energy_total_amount": number|null,
    "wheeling_total_amount": number|null,
    "fac_total_amount": number|null,
    "tod_ec_total": number|null,
    "duty_total_amount": number|null,
    "duty_rate_pct": number|null,
    "duty_per_unit": number|null,
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
- total_units: read this from the BILLING DETAILS / Consumption block — the
  row for the customer's OWN tariff category (e.g. a row literally labelled
  "Industrial" or "Commercial"), which lists that row's Units, Rate, and
  Amount/Energy Charge together (e.g. a row reading "Industrial   4520
  7.66   34623.20" means total_units = 4520). You can sanity-check your
  reading: units x rate should equal (or come very close to) that row's
  printed Energy Charge amount. Do NOT use the current-minus-previous METER
  READING difference for this field — on assessed/KVAH-billed accounts the
  billed units can legitimately differ from the raw meter delta (a real
  bill's Multiplying Factor of 1.00 still had a billed-units figure that
  differed from the meter delta), and using the meter delta here would
  silently corrupt every per-unit rate derived from total_units downstream
  (energy_rate, wheeling_per_unit, fac, electricity_duty all divide by it).
  The four TOD slot units (below) are a secondary cross-check only, and
  their sum may differ slightly from total_units — do not use their sum as
  your primary reading either, only total_units's own consumption-block row.
- All PER-UNIT rate fields still in this shape (duty_per_unit, tax_on_sale,
  and every tod rate) MUST be in RUPEES PER UNIT. MSEDCL prints some of these
  in "Ps/U" (paise per unit). If a value is labelled Ps/U or paise, DIVIDE BY
  100. Example: "Tax on Sale @ 28.94 Ps/U" -> 0.2894. Sanity: tax_on_sale/
  duty_per_unit are normally well below 1.
- energy_total_amount / wheeling_total_amount / fac_total_amount / tod_ec_total:
  copy the printed monthly TOTAL Rs AMOUNT for each of these charges EXACTLY
  AS PRINTED — do NOT convert to a per-unit rate, do NOT divide by
  total_units, do NOT do any arithmetic on them at all. All per-unit
  derivation happens server-side, after extraction, per Rite Water's
  official Solar Working Sheet formula (energy_per_unit = energy_total /
  total_units, etc. — see SPEC.md's "Formulas" section). This replaced an
  earlier per-unit-rate extraction (energy_rate/wheeling_per_unit/fac) once
  the workbook alignment task required deriving these from their TOTALS, not
  a model-read rate — same rationale as the duty split below: model-side
  arithmetic on these values was a source of nondeterminism, so the model
  now only ever copies a printed total.
    - energy_total_amount: the bill's "Energy Charges" TOTAL amount for the
      current month's units, verbatim.
    - wheeling_total_amount: the bill's "Wheeling Charges" line TOTAL
      monthly amount, verbatim (e.g. 6855.2). Do NOT read the bill's
      separate "Demand Charges" line for this field — Demand Charges is a
      different, fixed monthly charge (based on billed kVA, not units) and
      must be ignored entirely; it is never used anywhere in this
      extraction. (This field was named demand_charge_per_unit, then
      wheeling_per_unit, until real-bill testing and then the workbook
      alignment task changed both its label and its shape — see SPEC.md's
      Owner notes.)
    - fac_total_amount: the bill's "FAC" (Fuel Adjustment Charge) TOTAL
      monthly amount, verbatim.
    - tod_ec_total: the bill's "TOD Tariff EC" line TOTAL monthly amount,
      verbatim. CAN BE NEGATIVE (it is usually a rebate, e.g. -57.83).
      Preserve the sign exactly.
- duty_total_amount / duty_rate_pct / duty_per_unit: MSEDCL industrial bills
  typically show duty in TWO places — a rate table with a line like "E.D. on
  (Rs.) / Rate %" (e.g. 7.50), and a billing-details line labelled
  "Electricity Duty" showing the monthly TOTAL AMOUNT (e.g. 4178.77). COPY
  THESE THREE NUMBERS EXACTLY AS PRINTED — do NOT convert or divide ANY of
  them yourself:
    - duty_total_amount: the billing-details "Electricity Duty" TOTAL amount
      for the month, verbatim (e.g. 4178.77).
    - duty_rate_pct: the rate-table "E.D. on (Rs.) / Rate %" PERCENTAGE,
      verbatim (e.g. 7.50, not 0.075).
    - duty_per_unit: ONLY if the bill separately, literally prints a
      per-unit duty RATE in Rs/unit somewhere (rare) — otherwise null.
  All server-side math (dividing the total by units, etc.) happens after
  extraction — your job is to copy the printed numbers, not compute
  anything. If the bill is duty-exempt (prints "0.00" or "Exempt" for the
  rate/amount), return duty_rate_pct or duty_total_amount as 0, and do NOT
  add any duty field to low_confidence_fields for a clearly printed
  zero/exempt. Only use null (and flag it) if nothing about duty can be
  read at all. (This field was split from a single model-computed
  electricity_duty after real-bill testing found the model's own division
  was nondeterministic — a later run of the SAME bill divided the printed
  7.50% rate by 100 instead of the total by units, producing a wrong value
  that happened to sit inside the plausible range with no flag raised. See
  SPEC.md's Owner notes.) Server-side, the final electricity_duty per-unit
  value used in the tariff formula is now, by default, RECOMPUTED from
  duty_rate_pct and the four totals above per the Solar Working Sheet
  (`ROUND(duty_rate_pct/100 * (energy_total_amount+wheeling_total_amount+
  fac_total_amount+tod_ec_total)/total_units, 4)`) — it does NOT use
  duty_total_amount directly for the tariff calculation. duty_total_amount
  is still extracted and shown for display/logging only; the bill-amount-
  based resolution described above is now only a fallback for when the
  workbook formula's inputs are incomplete.
- The four TOD (Time of Day) slots are 00:00–06:00, 06:00–09:00, 09:00–17:00,
  17:00–24:00. Each has its own units and its own rate. RATES CAN BE NEGATIVE
  (the daytime 09:00–17:00 slot is usually a rebate, e.g. -1.149). Preserve the
  sign exactly.
- sanctioned_load_value/sanctioned_load_unit: read the customer's
  sanctioned/contracted load EXACTLY as printed — the number and its unit
  separately, verbatim. Do NOT convert units yourself (e.g. do NOT turn
  "90 HP" into a kW number) — copy the raw value and set the unit to
  whichever of "kW"/"HP"/"kVA" is actually printed next to it. Do not
  confuse this with contract_demand_kva (a related but different figure).
  (Split from a single model-converted sanctioned_load_kw after real-bill
  testing found the same nondeterminism — the same bill's "90 HP" line came
  back as raw 90 in one run and a converted 66.1949 in another. See SPEC.md's
  Owner notes.)
- billing_history_units: the bill has a "Billing History" table listing months
  and their units. Return the UNITS values, MOST RECENT FIRST, up to 12 numbers.
  Strip commas.
- If any value is unclear, illegible, or you are guessing, put null for that field
  and add its dotted path (e.g. "current_month.fac_total_amount" or "tod.t09_17.rate") to
  low_confidence_fields. DO NOT invent numbers — a null the user can fill in is
  far better than a wrong value.
- Strip thousands separators from all numbers. Return numbers as numbers, not
  strings.
```

---

## VALIDATION RULES (run after extraction; set needs_review per field)

Ranges (flag if outside; these apply to the server-derived per-unit values —
`energy_rate`/`wheeling_per_unit`/`fac` — computed as total/total_units,
not to the raw `*_total_amount` fields the model extracts, which have no
natural per-unit range):
- `energy_rate`            : 3 – 12
- `wheeling_per_unit`      : 0 – 3
- `fac`                    : 0 – 2
- `electricity_duty`       : 0 – 3 (widened from 0-2 after a real bill's
                             genuine 7.5%-duty per-unit value of ~0.93 sat
                             close to the old ceiling; an exact `0` is NEVER
                             flagged, even if the model added it to
                             low_confidence_fields — duty-exempt bills are a
                             confirmed, valid `0`; only `null`/out-of-range
                             flags)
- `tax_on_sale`            : 0 – 2
- each `tod.*.rate`        : -5 – 5
- `total_units`            : 100 – 1,000,000
- `contract_demand_kva`    : 1 – 5,000

Cross-checks (flag the involved fields if they fail):
- **Amount-vs-rate detector (wheeling_per_unit, fac, electricity_duty):**
  when one of these is out of its range above, try TWO candidate fixes and
  offer whichever lands back in range, preferring the first: (1) the value
  ÷ total_units — it was actually a monthly TOTAL amount mistaken for a
  per-unit rate (the real bug found on a real bill: Electricity Duty's Rs
  4178.77 total in the per-unit field); (2) the value ÷ 100 — it was left
  in paise, not converted to rupees (the older detector, kept as a
  fallback for fac/tax_on_sale/wheeling, which don't have a printed total
  amount to divide by 100 in the same way duty does). The confirm screen's
  one-tap button wording differs depending on which fix is offered ("Use
  0.93? (amount ÷ units)" vs the plain "Use X?" paise version) so it's
  never misleading about what the button actually does.
- **Paise-not-converted detector (tax_on_sale only):** if tax_on_sale is >
  5, it was almost certainly left in paise. Flag it, and offer the ÷100
  value as a suggested correction — this field has no natural "total
  amount" counterpart on the bill, so it only ever gets this one fix.
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
   - Industrial's energy_rate/wheeling_per_unit/fac/electricity_duty are
     DERIVED from total_units (charge_total/total_units, or the duty-rate%
     formula) — editing total_units (by hand, or via its own "Use N?"
     reconcile suggestion) must live-recompute all four, mirroring
     api/extract.php's formulas exactly, or a units correction leaves the
     rates stranded on the old denominator. A field the customer has
     directly edited/accepted a suggestion for should not be silently
     overwritten by a later total_units recompute. See SPEC.md's "CRITICAL
     extraction gotchas" and Owner notes for the real-bill bug this fixes.

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
