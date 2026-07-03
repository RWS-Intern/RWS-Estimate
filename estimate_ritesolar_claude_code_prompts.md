# Claude Code Prompts — `estimate.ritesolar.in`

Automated solar rooftop assessment tool for Rite Solar C&I customers.
A customer enters their details and uploads their MSEDCL electricity bill; the
page extracts the bill values, computes their system size / tariff / 25-year
financial model, and renders an interactive dashboard (the existing
`estimate.html` engine), all on one page.

## Before you start (do this once)
1. Create an empty repo/folder for the project.
2. Copy your existing demo into it as **`reference/estimate.html`** (the static
   dashboard — it already contains the working 25-year engine and sliders).
3. Copy one **portal-downloaded PDF bill** and one **phone-photo bill** into
   **`reference/sample_bills/`** for testing.
4. Then paste the prompts below into Claude Code **in order**, checking each
   deliverable before moving to the next.

Target host: **Hostinger Single Web Hosting**, subdomain `estimate.ritesolar.in`
→ served from a normal folder in the file manager. PHP + MySQL available.
Shared hosting: **no shell binaries** (no Tesseract), so image bills must be read
via a hosted vision API called from PHP with `curl`.

---

## PROMPT 1 — Scaffold, SPEC.md, entry form, extractor + confirm screen

```
We are building a solar rooftop assessment tool that will be deployed to a PHP
shared-hosting subdomain (estimate.ritesolar.in on Hostinger). This first task:
set up the project, write a SPEC.md that fully documents the domain logic, and
build (a) the entry form, (b) a PHP bill-extraction endpoint, and (c) an
editable confirm screen. Do NOT build the financial dashboard yet.

Read reference/estimate.html — it is the existing static demo whose visual style
and colour palette (the :root CSS variables like --rs-blue, --rs-gold, --rs-navy)
we will reuse. Match that look. Also read the sample bills in
reference/sample_bills/.

=== FIRST, create SPEC.md at the repo root with EXACTLY this domain knowledge ===

## Pipeline (per customer)
1. Entry form: Name, Mobile, Category (Commercial | Industrial), Bill upload
   (PDF or image).
2. Extract: PHP endpoint reads the bill and returns the JSON schema below.
   - If the uploaded PDF has a real text layer (portal download), parse the text
     for free (PHP: smalot/pdfparser). No API cost.
   - If there is NO usable text layer (photo/scan/image file), fall back to a
     vision LLM call via curl. Same JSON schema out either way.
3. Confirm: show extracted values in an EDITABLE form for the user to verify /
   correct before any calculation runs. This is mandatory — extraction is never
   assumed perfect.
4. Compute (built in a later task): formulation -> 25-year engine.
5. Render dashboard (later task).
6. Persist to Supabase (later task).

## Extraction JSON schema (the contract every path must return)
{
  "consumer_number": string,
  "consumer_name": string,
  "tariff_category": "Industrial" | "Commercial",
  "tariff_code": string,                // e.g. "LT-V B II"
  "contract_demand_kva": number,
  "sanctioned_load_kw": number,
  "current_month": {
    "total_units": number,              // e.g. 5703
    "energy_rate": number,              // base energy Rs/unit, e.g. 7.66
    "demand_charge_per_unit": number,   // Rs/unit, e.g. 1.52
    "fac": number,                      // Rs/unit, e.g. 0.20
    "electricity_duty": number,         // Rs/unit, e.g. 0
    "tax_on_sale": number,              // Rs/unit, e.g. 0.2894
    "tod": {
      "t00_06": { "units": number, "rate": number },
      "t06_09": { "units": number, "rate": number },
      "t09_17": { "units": number, "rate": number },  // rate e.g. -1.149 (daytime rebate)
      "t17_24": { "units": number, "rate": number }   // rate e.g.  1.915
    }
  },
  "billing_history_units": [number]     // most recent up to 12 months of units
}

## CRITICAL extraction gotchas (document these in SPEC.md and handle in code)
- UNITS OF RATE: MSEDCL prints some charges in "Ps/U" (paise per unit) and some
  in Rs/unit. tax_on_sale often shows as "28.94 Ps/U" = Rs 0.2894. FAC may show
  as paise too. ALWAYS normalise every rate to Rs/unit before returning JSON.
  When in doubt, prefer the interpretation that keeps the value in a sane
  Rs/unit range (energy ~6-9, FAC/duty/TOS < 1). The confirm screen is the
  backstop.
- demand_charge_per_unit: if the bill shows a total "Demand Charges" amount and a
  billed demand in kVA, you may derive per-unit as (demand_charges_total /
  total_units). Prefer a directly-printed per-unit rate if present.
- TOD slot rates can be negative (daytime rebate). Preserve the sign.
- billing_history_units: the MSEDCL bill has a "Billing History" table on page 1
  with ~12 rows of month + units. Return the units column, most-recent-first.

## Formulation constants (Rite Solar policy — fixed unless told otherwise)
GSC              = 1.96      // Grid Support Charge, Rs/unit — NOT on a non-solar
                             // customer's bill; always this fixed value.
RATE_PER_KWP     = 51000     // ex-GST, Rs/kWp
GST_RATE         = 0.089
GEN_PER_KWP_DAY  = 4         // units/kWp/day (365-day basis)
AMC_RATE_PER_KWP = 1200
AMC_ESC          = 0.01
DEG_Y1           = 0.03
DEG_YR           = 0.0071
SPARES_ON        = true
SPARES_RATE_PER_KWP = 2800
SPARES_BASE_RATE = 2000
DISCOUNT         = 0.12
INT_SURPLUS      = 0.045
DAYS             = 365
DEP_RATE         = 0.40
DEP_YEARS        = 9
PROC_FEE_PCT     = 0.01
TARIFF_ESC       = 0.03
// User-adjustable scenario defaults (sliders on dashboard):
DEP_DEFAULT=true, TAX_DEFAULT=25.18, LOAN_DEFAULT=false, DP_DEFAULT=20,
LOAN_RATE_DEFAULT=9, TENURE_MONTHS_DEFAULT=60, FD_RATE_DEFAULT=7

## Formulas (to be implemented in the NEXT task, but document them now)
EFFECTIVE_TARIFF (Rs/unit) =
    energy_rate + demand_charge_per_unit + fac + electricity_duty + tax_on_sale
    - GSC + tod.t09_17.rate
  // Worked example from the reference customer:
  // 7.66 + 1.52 + 0.20 + 0 + 0.2894 - 1.96 + (-1.149) = 6.5604

DAYTIME_FRACTION = (tod.t06_09.units + tod.t09_17.units) / current_month.total_units
  // NOTE / OPEN CHOICE: the source Excel used the 06:00-17:00 window
  // (t06_09 + t09_17) giving ~0.8187 for the reference customer. The demo's
  // prose text instead cited the 09:00-17:00 window only (~0.81). Default to the
  // Excel definition (06-17) and put DAYTIME_WINDOW = "06-17" as a documented
  // config flag so it can be switched to "09-17" easily.

ANNUAL_UNITS       = sum(billing_history_units)   // use available months; if <12, note it
REQUIRED_KWP_EXACT = (ANNUAL_UNITS * DAYTIME_FRACTION) / (GEN_PER_KWP_DAY * DAYS)
OFFERED_KWP        = ceil(REQUIRED_KWP_EXACT)      // round UP to next whole kWp
  // e.g. 46.38 -> 47, 23.4 -> 24. Show the exact required value next to the
  // offered whole number on the confirm screen; OFFERED_KWP stays user-editable.

ANNUAL_GENERATION  = OFFERED_KWP * GEN_PER_KWP_DAY * DAYS   // Year-1, before degradation
GROSS_COST         = OFFERED_KWP * RATE_PER_KWP
GST_AMOUNT         = GROSS_COST * GST_RATE
NET_COST_INC_GST   = GROSS_COST + GST_AMOUNT
EX_GST_CAPITAL     = GROSS_COST   // returns are computed on ex-GST (ITC recoverable for C&I)

=== END of SPEC.md content ===

Now build these three pieces:

A) ENTRY FORM (index.html + its CSS/JS, styled to match reference/estimate.html):
   - Fields: Name (text), Mobile (10-digit validation), Category (Commercial |
     Industrial radio/dropdown), Bill upload (accept .pdf,.jpg,.jpeg,.png).
   - CLIENT-SIDE image downscale before upload: if the file is an image, resize
     the long edge to ~1600px via a canvas and re-encode as JPEG (~0.8 quality)
     to stay under shared-hosting POST limits (~4-6 MB). Leave PDFs as-is.
   - On submit, POST to api/extract.php as multipart/form-data, show a loading
     state, then render the confirm screen with the returned JSON.

B) api/extract.php (the extraction endpoint):
   - Accept the uploaded file. Validate type and size (reject > 6 MB).
   - Detect text layer: use smalot/pdfparser (add composer.json requiring
     smalot/pdfparser) to read the PDF text; if the extracted text is empty or
     clearly not a bill (no consumer number / no "Units" table), treat as image.
   - TEXT PATH: parse the bill text into the JSON schema using anchored, labelled
     matches (find the label, read the adjacent value) — NOT brittle fixed
     offsets. Normalise paise->rupees per the gotchas above.
   - IMAGE PATH (fallback): read the file bytes, base64-encode, and POST to a
     vision LLM endpoint via curl. Put the API key in a server-side config file
     config.php that is git-ignored; read it from an env/constant. Use a
     PLACEHOLDER key for now and make it obvious where the real key goes. The
     vision prompt must ask the model to return ONLY the JSON schema above, no
     prose. Parse and validate the returned JSON.
   - For PDFs with no text layer, rasterise page(s) to images for the vision call
     if a pure-PHP rasteriser is feasible; if not, document the limitation in
     SPEC.md and handle image uploads directly (the client can also send the
     bill as an image).
   - Return application/json matching the schema. On failure return a clear JSON
     error the front-end can show ("couldn't read the bill, please enter values
     manually").
   - NEVER put any API key in client-side code.

C) CONFIRM SCREEN (same page, shown after extraction):
   - Render every extracted field in an EDITABLE form, grouped: customer/tariff,
     current-month rates, the four TOD slots (units + rate each), and the
     12-month history.
   - Pre-fill the Category from tariff_category but keep it editable.
   - A clear "Confirm & see my estimate" button (wire it to a no-op / console.log
     for now — the compute step is the next task).
   - Keep everything on one page as a step flow (entry -> loading -> confirm),
     no navigation to other URLs.

Project layout:
  /index.html            (entry + confirm + step flow)
  /assets/…              (css, js, logo — reuse the palette from estimate.html)
  /api/extract.php
  /api/config.php        (git-ignored; API keys)
  /composer.json
  /SPEC.md
  /reference/…           (leave as-is)
  /.gitignore            (config.php, /vendor, uploads)

Do not implement the financial model or Supabase yet. Make the extractor and
confirm screen solid enough that I can throw the sample bills at it and verify
the JSON.
```

---

## PROMPT 2 — Formulation module + wire to the existing 25-year engine

```
Read SPEC.md and reference/estimate.html. estimate.html contains a complete,
working financial engine: a K constants object, an S scenario object, an irr()/
npv()/pmt() set, a compute() that builds a 25-year cash-flow table, chart
rendering (Chart.js), and hero metrics (IRR, payback, NPV, LCOE, money multiple).
The ONLY things hardcoded per-customer in that file are the "LOCK" values
(system size, effective tariff, generation). We now compute those from the
confirmed bill values instead.

Build assets/formulation.js exporting a function that takes the CONFIRMED
extraction JSON (from the confirm screen) and returns the derived project inputs,
using exactly the formulas and constants in SPEC.md:
  - effective_tariff, daytime_fraction, annual_units, required_kwp_exact,
    offered_kwp (ceil), annual_generation, gross_cost, gst_amount,
    net_cost_inc_gst, ex_gst_capital.
Respect the DAYTIME_WINDOW config flag (default "06-17").

Then integrate the engine from estimate.html into the live page:
  - Lift the K constants, S defaults, the math helpers, compute(), the chart
    builders, and the metric/table rendering out of estimate.html into reusable
    JS modules (e.g. assets/engine.js, assets/charts.js). Keep the same visual
    output and the SAME interactive sliders (down payment, loan rate, tenure,
    tax rate, FD rate, depreciation toggle) that recompute live.
  - Replace the hardcoded LOCK block: feed offered_kwp, effective_tariff, and
    annual_generation from formulation.js. flatRate in K becomes the per-customer
    effective_tariff.
  - On "Confirm & see my estimate", run formulation -> engine -> render the
    dashboard in place, below the confirm summary.

Regenerate the NARRATIVE text per customer. In estimate.html the prose contains
this customer's specific figures ("~4,633 units/month, about 81% of your daily
use", "needs ~46 kWp", "50 kWp, ~86 panels", the per-unit build-up, etc.). Make
those sentences template from the current customer's derived values so the page
reads as genuinely theirs. Show the effective-tariff build-up
(energy + demand + FAC + duty + TOS - GSC + daytime-TOD = effective) as an
itemised breakdown, and show "required X.XX kWp -> offered Y kWp" transparently.

Keep the confirm screen editable: if the user changes a value there and
re-confirms, everything recomputes.

Verify against the reference customer: with the reference bill's values you
should get effective_tariff = 6.5604 and required_kwp_exact ≈ 46.38 (which now
ceilings to 47, not 50 — that's expected). Sanity-check IRR/payback are in the
same ballpark as the demo.
```

---

## PROMPT 3 — Lead capture + Supabase persistence

```
Read SPEC.md. Add lead + result persistence to Supabase. All Supabase writes go
through PHP (server-side), never with a service key in client code.

- Add api/save.php. It accepts: the entry-form fields (name, mobile, category),
  the confirmed extraction JSON, and the computed summary (offered_kwp,
  effective_tariff, annual_generation, ex_gst_capital, irr, payback_years, npv,
  lcoe). It writes one row to a Supabase table via the REST endpoint using a
  SERVICE ROLE key stored in api/config.php (git-ignored). Return {ok:true,id}.
- Write two rows worth of data sensibly: capture the LEAD (name, mobile,
  category, created_at) as early as possible — ideally right after the entry
  form submits, before extraction even finishes — so a bounced visitor is still
  captured. Then update/append the extracted + computed RESULT when the user
  confirms and the dashboard renders.
- Provide the SQL to create the table(s) in Supabase (a leads table and a
  results table, or one table updated in two stages — your call, document it in
  SPEC.md). Include created_at defaults and a sensible primary key.
- Store phone/name responsibly; do NOT put any personal data in URLs or query
  strings.
- The customer's dashboard must render regardless of whether the Supabase write
  succeeds (persistence failure should never block the user's result — log it
  server-side and continue).

Owner visibility note for me (put in SPEC.md): I will view submissions in the
Supabase Table Editor from day one; a dedicated admin page is out of scope for
now.
```

---

## PROMPT 4 — Polish + Hostinger deploy notes

```
Read SPEC.md. Final pass:
- Responsive/mobile check for the whole flow (entry -> loading -> confirm ->
  dashboard). The dashboard and charts must be usable on a phone.
- Graceful degradation: if extraction fails entirely, let the user fill the
  confirm form manually and still get a result.
- Add a PDF/print export of the finished dashboard (a clean print stylesheet or
  a client-side export), matching the Rite Solar look.
- Add the standard disclaimer text already present in estimate.html (illustrative
  estimate, ex-GST capital, not a binding quotation / securities offer).
- Add a short, self-contained DEPLOY.md with the Hostinger steps:
    1. In hPanel, create subdomain estimate.ritesolar.in pointing to its own
       folder (e.g. /home/…/domains/estimate.ritesolar.in/public_html).
    2. Upload the built files (run `composer install` locally and upload /vendor,
       since shared hosting may not run composer).
    3. Create api/config.php on the server with the real vision API key and the
       Supabase service key (never commit these).
    4. Confirm PHP version and that curl + the needed extensions are enabled.
    5. In the Rite Solar Website Builder site, add a button/menu link to
       https://estimate.ritesolar.in labelled e.g. "Get a Free Solar Estimate".
- Confirm no API keys or Supabase service keys exist anywhere in client-side
  code or in the repo history.
```

---

### Things I assumed (change in SPEC.md if wrong)
- `GEN_PER_KWP_DAY = 4` units/kWp/day and all K constants are taken from your
  Working sheet / the demo's `K` object and treated as current.
- Daytime window defaults to **06:00–17:00** (the Excel definition). The demo's
  prose used 09:00–17:00; a `DAYTIME_WINDOW` flag lets you switch.
- Offered size = **ceil(required)**, GSC = **1.96**, as you locked.
- Reuse the demo's existing colour palette (not the formal brand-guideline hex
  values) so the live page matches the look you already approved.
