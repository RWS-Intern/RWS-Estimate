# Rite Solar Estimate Tool

**Live at:** `estimate.ritesolar.in` (hosted on Hostinger Business)
**Repo:** `RWS-Intern/RWS-Estimate` · branch `main`
**Stack:** PHP 8.2 · Vanilla JS/HTML/CSS · Supabase · Anthropic API · jsPDF · Chart.js

---

## What It Does

A C&I customer uploads their MSEDCL electricity bill (photo or PDF). The tool:
1. Extracts all billing values using Claude vision (structured tool-use output)
2. Shows a confirm screen — customer can correct any misread value
3. Runs a 25-year rooftop solar financial model (sizing, tariff, cashflow)
4. Shows an interactive dashboard (live sliders: tax, loan, FD rate)
5. Generates a branded "Investment Ka Dhurandhar" PDF report
6. Captures the lead in Supabase in two stages (entry + completion)

Supports both **Industrial** and **Commercial** MSEDCL tariff categories, each with their own extraction schema and formulation logic.

---

## Project Structure

```
/
├── index.html              # Public tool — entry form, confirm screen, dashboard
├── favicon.ico
├── composer.json
├── Dockerfile              # Render-only; ignored by Hostinger
├── /api
│   ├── config.php          # Secrets — reads env vars, falls back to in-file values
│   ├── extract.php         # Vision extraction + all deterministic parsing/validation
│   ├── get_config.php      # Reads app_config from Supabase (server-side, service role)
│   ├── lead.php            # Stage-1 Supabase write (entry)
│   ├── complete.php        # Stage-2 Supabase write (completed estimate)
│   ├── upload_bill.php     # Uploads bill image(s) to Supabase storage
│   ├── upload_report.php   # Uploads generated PDF to Supabase storage
│   ├── sign_url.php        # Issues signed URLs for admin downloads
│   └── supabase.php        # Shared Supabase REST helper
├── /admin
│   ├── index.html          # Password-protected constants editor + Leads table
│   ├── admin.js            # Admin logic — config edit, leads view, Excel export
│   └── config.js           # Supabase anon key (public, RLS-protected)
├── /assets
│   ├── formulation.js      # Tariff + sizing derivation (industrial + commercial)
│   ├── engine.js           # 25-year cashflow, IRR, NPV, payback, LCOE
│   ├── config-defaults.js  # Code-level fallback constants
│   ├── charts.js           # Chart.js dashboard charts + 25-yr table
│   ├── report.js           # jsPDF report generation
│   └── /js/app.js          # Main frontend logic — form, confirm screen, dashboard
├── /vendor                 # Composer deps (smalot/pdfparser) — upload as-is to Hostinger
├── SPEC.md                 # Full specification and all formula decisions
├── extraction_hardening.md # Extraction prompt rules and real-bill lessons
├── backend_and_admin.md    # Supabase schema, SQL, admin setup
├── DEPLOY.md               # Hostinger deploy steps
└── DEPLOY-RENDER.md        # Render deploy steps (legacy)
```

---

## Configuration & Secrets

`api/config.php` reads env vars first, then falls back to in-file values:

```php
define('ANTHROPIC_API_KEY',         getenv('ANTHROPIC_API_KEY')         ?: 'REPLACE_ME');
define('ANTHROPIC_MODEL',           getenv('ANTHROPIC_MODEL')           ?: 'claude-sonnet-5');
define('SUPABASE_URL',              getenv('SUPABASE_URL')              ?: 'REPLACE_ME');
define('SUPABASE_SERVICE_ROLE_KEY', getenv('SUPABASE_SERVICE_ROLE_KEY') ?: 'REPLACE_ME');
```

- **On Hostinger:** edit `public_html/api/config.php` directly on the server. No env var panel exists on shared hosting.
- **On Render:** set as env vars in the service dashboard.
- **Never commit real keys.** The repo always holds `REPLACE_ME` placeholders.
- The Supabase **anon key** (public) lives in `admin/config.js` — committed, safe to expose, RLS-protected.

### Model cost guide
| Model string | Cost | Notes |
|---|---|---|
| `claude-opus-4-8` | ~₹60/bill (observed) | Highest accuracy |
| `claude-sonnet-5` | ~₹15–25/bill (est.) | Recommended balance |
| `claude-haiku-4-5-20251001` | ~₹6–8/bill (est.) | Test accuracy on hard bills first |

---

## Supabase

- **Project:** "RiteEstimate" · org "Rite Water's Org"
- **Tables:** `app_config` (single-row JSONB constants), `submissions` (one row per customer)
- **Buckets (private):** `bills`, `reports`
- **Admin users:** created manually in Supabase Dashboard → Authentication (no signup UI)
- Full SQL in `backend_and_admin.md`

### Running this SQL if deploying fresh
```sql
-- Add commercial constants (if not already present)
UPDATE app_config
SET config = config || '{
  "solar_hour_share_pct": 75,
  "gst_pct_commercial": 8.9,
  "dep_default_commercial": false,
  "insurance_rate_pct": 0.33,
  "commercial_rate_table": [
    {"kwp": 0,   "rate": 58000},
    {"kwp": 10,  "rate": 54000},
    {"kwp": 25,  "rate": 52000},
    {"kwp": 50,  "rate": 50000},
    {"kwp": 100, "rate": 48000}
  ]
}'::jsonb,
    updated_at = now()
WHERE id = 1;

-- Add back-of-bill column (if not already present)
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS bill_path_back TEXT;
```

---

## Canonical Calculation Rules

> **These must not be changed without sign-off.** The industrial path is aligned to match the official Rite Water Solar Working Sheet exactly. Reference bills verify this.

### Industrial — Effective Tariff
```
effective_tariff = energy/u + wheeling/u + FAC/u + duty/u + TOS
                 + raw_09-17_slot_rate   ← added directly, unweighted, usually negative
                 − GSC
```
- Each `/u` = (monthly charge total in Rs) ÷ total_units
- **Duty:** `duty_rate_pct% × (energy_total + wheeling_total + FAC_total + TOD_EC_total) ÷ units` — NOT the bill's charged duty amount
- **Demand Charges** (fixed monthly Rs) deliberately excluded — solar doesn't avoid them
- ✅ Reference: Shriram Stone Crusher → **7.36 exactly**

### Industrial — Sizing
```
required_kwp = 12-month_total_units × daytime_share ÷ (4 × 365)
```
Rounds UP to whole kWp. Rate: **₹52,000/kWp flat**. Insurance: **0.33%/yr of net cost**.

### Commercial — Effective Tariff
```
duty/u  = duty_pct% × (energy + wheeling + FAC)
rebate  = tod_rebate_pct% × energy_rate
effective_tariff = energy + wheeling + FAC + duty/u + TOS − rebate − GSC
```
- Sizing capped at **sanctioned load** (decimal kept, no round-up)
- Rate from `commercial_rate_table` — **⚠ currently placeholder values, replace before launch**
- ✅ Reference: ₹10.0621 exactly

### 25-Year Engine (shared)
| Parameter | Value |
|---|---|
| Tariff escalation | 3%/year |
| Degradation | 3% Year 1, then 0.71%/year |
| AMC | ₹1,200/kWp, escalates 1%/year |
| Spares | Every ~5 years (Yr 6, 11, 16, 21) |
| Insurance | 0.33%/year of net cost, every year |
| Depreciation (optional) | 40% WDV, first 9 years, × tax rate |
| Surplus interest | 4.5% net (6% FD − 25% TDS) |
| Discount rate (NPV) | 12% |

---

## All Changes Made (Chronological)

### Phase 1 — Core Build
- Initial tool: single PNG/JPEG upload, industrial only, basic extraction
- Multi-page PDF support (pdf.js renders pages → images → vision call)
- Extraction confirm screen with amber-flag validation
- 25-year financial engine with live sliders
- Branded 3-page PDF report ("Investment Ka Dhurandhar")
- Supabase persistence: two-stage lead/complete writes
- Admin page: config editor, Leads table, Excel export, signed-URL downloads
- Deployed to Render (Docker, free tier, Singapore)

---

### Phase 2 — Front/Back Bill Upload
**Problem:** MSEDCL bills often have key fields on the back — single-image upload missed them.

**Changes:**
- `index.html` — replaced single file input with two labeled slots: "Bill – Front" (required, PDF/JPG/PNG) and "Bill – Back" (optional, JPG/PNG)
- CSS — side-by-side layout, thumbnail previews, clear (×) button, mobile stack below 480px
- `app.js` — `wireBillSlot()`, `onFrontSelected()`, `onBackSelected()`, `setBackSlotEnabled()`. Selecting a PDF in Front hides/clears Back (PDF already covers both pages). Both images sent as same `bill_image[]` array
- `upload_bill.php` — uploads front (`{id}_front.ext`) + optional back (`{id}_back.ext`)
- `api/extract.php` — both images included as separate vision blocks in same Claude call
- Supabase: added `bill_path_back TEXT` column to `submissions`
- Admin Leads table: added "Bill file (back)" column

---

### Phase 3 — Cache-Busting
**Problem:** after deploy, browsers served stale cached JS/CSS causing "app.js line 69" errors.

**Changes:**
- `index.html` and `admin/index.html` — all local JS/CSS assets now carry `?v=N` with bump-reminder comments
- CDN scripts (pdf.js, Chart.js, jsPDF, Supabase-js) left untouched — already version-pinned in URLs
- Rule: **bump `?v=` on every file you touch before committing**

---

### Phase 4 — Commercial Formulation Path
**Problem:** tool ran industrial calculations regardless of category selected.

**Changes:**
- `formulation.js` — added `deriveCommercial()` + dispatcher `derive()`. Industrial path renamed `deriveIndustrial()`, bodies untouched
- `api/extract.php` — commercial vision schema/prompt/validator; dispatches on `category`. Industrial path inside `if` guard
- `app.js` — commercial confirm-screen fields, ToD table hidden for commercial, category-select live-swaps field set, commercial narrative card
- `report.js` — matching PDF narrative branch
- `admin/admin.js` — new "Commercial" field group + JSON-textarea for rate lookup table
- `config-defaults.js` — added `solar_hour_share_pct: 75`, `gst_pct_commercial: 8.9`, `dep_default_commercial: false`, `commercial_rate_table`
- Supabase: merge `UPDATE app_config SET config = config || '{...}'` (see SQL above)

---

### Phase 5 — Wheeling vs Demand Charge Rename

**Problem:** the field labeled "Demand charge" was actually the Wheeling Charge rate from the bill. Wrong label AND wrong math (demand was being divided by units; wheeling is already Rs/unit).

**Commercial path fix:**
- `api/extract.php` — renamed field, updated vision prompt to explicitly read "Wheeling Charges" rate line, warns model to ignore "Demand Charges" line
- `formulation.js` — removed ÷units division, wheeling used directly
- `app.js`, `report.js` — label and narrative updated
- Legacy fallback: `wheeling = c.wheeling ?? c.demand_charge`

**Industrial path fix (separate pass):**
- Same rename across all of `extract.php`, `formulation.js`, `app.js`, `report.js`
- Vision prompt: "read the RATE value from Wheeling Charges line — never the Demand Charges line"
- Electricity duty: if duty line shows 0.00/exempt, return 0 (not null); PHP strict-comparison bug fixed (`!== 0.0` → `!= 0`)
- Free-text fast-path (`parse_bill_text()`) retargeted from "Demand Charge" to "Wheeling Charge"
- ✅ Industrial reference 6.5604 bit-identical after change

---

### Phase 6 — Electricity Duty Extraction Fix (v1)
**Problem:** Shriram Stone Crusher bill — model returned 4178.77 (total monthly duty amount) instead of a per-unit rate. Effective tariff became ₹4,185/unit. Dashboard showed ₹697 Cr earnings.

**Changes:**
- `api/extract.php` — replaced single `electricity_duty` field with THREE raw fields: `duty_total_amount`, `duty_rate_pct`, `duty_per_unit`. Model copies verbatim ("do NOT convert or divide"). PHP derives per-unit deterministically: printed per-unit → total÷units → 0 if exempt
- `api/extract.php` — new `suggest_per_unit_correction()` helper: tries amount÷units first, falls back to ÷100 paise. Applied to wheeling, FAC, electricity duty
- `api/extract.php` — new `correction_reasons` response field drives confirm-screen button wording ("Use 0.93? (amount ÷ units)" vs plain "Use X?")
- `formulation.js` — `TariffSanityError` class; both `deriveIndustrial()` and `deriveCommercial()` throw if effective tariff outside **₹3–25/unit**
- `app.js` — catches `TariffSanityError` specifically, re-flags all per-unit fields, shows blocking message
- ✅ Test: buggy 4178.77 input throws `TariffSanityError` (tariff 4186.29); corrected 0.9266 input → tariff 8.4466

---

### Phase 7 — Sanctioned Load HP/kVA Conversion
**Problem:** bills print sanctioned load as "90 HP" — model sometimes returned raw 90 into a kW field, sometimes converted (nondeterministic).

**Changes:**
- `api/extract.php` — both schemas now extract `sanctioned_load_value` + `sanctioned_load_unit` ("kW"/"HP"/"kVA") verbatim. PHP converts deterministically: HP × 0.7355 → kW; kVA flagged for review
- `app.js` — confirm screen shows conversion hint: "90 HP on bill → 66.2 kW"
- Legacy fallback: old flat `sanctioned_load_kw` passes through unchanged
- ✅ Test: `resolve_sanctioned_load_kw(90, "HP")` → 66.195, not flagged

---

### Phase 8 — Working Sheet Alignment
**Problem:** website effective tariff (7.58) didn't match the official Rite Water Solar Working Sheet (7.36) for Shriram. Three input differences identified.

**Three decisions made:**

**1. Duty formula changed to match sheet:**
`duty/u = duty_rate_pct% × (energy_total + wheeling_total + FAC_total + TOD_EC_total) ÷ units`
(Previously: `duty_total_amount ÷ units`)

**2. ToD adjustment changed to match sheet:**
Raw 09–17 slot rate added directly, unweighted (previously consumption-weighted).

**3. Rate/kWp and insurance:**
- `config-defaults.js`: `rate_per_kwp` 51000 → **52000**
- `engine.js`: insurance added as flat yearly line: `netCost × 0.33%`, subtracted in net cash flow, included in LCOE
- `admin/admin.js`: insurance rate field added
- `charts.js`, `report.js`: Insurance column added to 25-year table (screen + PDF)
- Supabase: `UPDATE app_config SET config = config || '{"rate_per_kwp": 52000, "insurance_rate_pct": 0.33}'`

✅ References after change: industrial **7.36**, commercial **10.0621** (unchanged)

---

### Phase 9 — Billable Units Extraction Fix
**Problem:** Shivani Stone Crushers bill — model pulled 2477 (meter-reading difference) instead of 4520 (billable assessed consumption). Since all per-unit rates = total ÷ units, every rate was wrong (wheeling showed 2.77 instead of 1.52).

**Root cause:** KVAH/assessed billing — billed units differ from the current−previous meter delta.

**Changes:**
- `api/extract.php` vision prompt — `total_units` = the units on the tariff-category consumption row in BILLING DETAILS (the Industrial/Commercial row), verifiable as energy_charge_total ÷ energy_rate. Explicitly forbids using meter delta or ToD slot sum
- `api/extract.php` — raw charge totals (`energy_total_amount`, `wheeling_total_amount`, `fac_total_amount`, `tod_ec_total`, `duty_rate_pct`) added to the response so the browser can re-derive
- `app.js` — new `recomputeDerivedRates()`: live-recomputes energy_rate, wheeling_per_unit, FAC, electricity_duty whenever `total_units` changes — via reconcile button OR manual edit
- `app.js` — `dataset.userEdited` flag: manual rate override is never clobbered by a later units change
- `app.js` — `makeFieldDiv()` dispatches synthetic `input` event after applying a reconcile suggestion, triggering the recompute chain
- CSS — `.field.just-updated` flash highlight on recomputed fields
- ✅ Shivani: units 4520, wheeling 1.52, FAC 0.30, duty 0.6789, tariff 7.3289

---

### Phase 10 — Error Message Hardening
**Problem:** when the Anthropic API was out of credits, the raw provider error ("Your credit balance is too low to access the Anthropic API...") was shown verbatim to customers.

**Changes:**
- `api/extract.php` — new `fail_extraction_generic()` helper used by all error paths (vision catch blocks, uncaught-exception handler, fatal-error shutdown handler). Customer always sees: "We couldn't read your bill automatically this time — please fill in the values below"
- `api/extract.php` — full raw provider error logged via `error_log()` with:
  - `[EXTRACT_QUOTA]` prefix for credit/quota/rate-limit errors (ops emergency — extraction down for all users)
  - `[EXTRACT_FAIL]` for routine failures (bad image, timeout etc.)
- `app.js` — client no longer reads `json.error` for display. Always shows the same `GENERIC_EXTRACTION_ERROR` constant regardless of server response (belt-and-braces)

---

## Extraction Hardening — Real-Bill Lessons

These guards are baked into `extract.php`. Do not regress them.

| # | Problem discovered | Guard in place |
|---|---|---|
| 1 | "Wheeling Charges" RATE confused with "Demand Charges" total | Vision prompt explicitly names both lines; demand line forbidden |
| 2 | Duty total amount (₹4,178) put in per-unit field | Three raw fields extracted; PHP derives deterministically |
| 3 | Duty rate% ÷ 100 = 0.075 (looked plausible, was wrong) | `resolve_electricity_duty_workbook()` uses totals formula |
| 4 | Sanctioned load "90 HP" returned as raw 90 into kW field | value + unit extracted verbatim; PHP converts |
| 5 | Meter delta (2477) used instead of billable units (4520) | Vision prompt explicitly points to BILLING DETAILS consumption row |
| 6 | Changing units didn't update derived rates | `recomputeDerivedRates()` fires on every units change |
| 7 | Tariff ₹4,185/unit rendered ₹697 Cr earnings silently | `TariffSanityError` blocks dashboard if tariff outside ₹3–25 |
| 8 | Provider error text leaked to customer | `fail_extraction_generic()` normalises all error paths |

---

## Hosting

**Current:** Hostinger Business plan (0 additional cost — plan already covers 100 sites)
**Staging subdomain:** `darkgray-opossum-905943.hostingersite.com`
**Target domain:** `estimate.ritesolar.in` (DNS cutover pending)

**Legacy:** Render free tier (`rite-solar-estimate`, srv-d93lgt7aqgkc73c7bs3g) — suspended due to free-tier hours cap. Dockerfile kept for reference; Hostinger ignores it.

### Deploy to Hostinger
1. Zip **contents** of project (index.html, /api, /admin, /assets, /vendor, favicon.ico, composer.json) — not the wrapping folder; exclude Dockerfile, .git, .md docs
2. File Manager → `public_html` → upload zip → Extract into `.`
3. Advanced → PHP Configuration → PHP 8.1/8.2; confirm curl, mbstring, fileinfo on
4. Edit `public_html/api/config.php` on server — fill 4 real values
5. Test on staging subdomain before pointing real domain

---

## Open Items / Pre-Launch Checklist

- [ ] **Fund Anthropic account** + set low-balance alert (console.anthropic.com → Billing)
- [ ] **Decide extraction model** (`claude-sonnet-5` recommended) — set in `config.php`
- [ ] **Replace `commercial_rate_table` placeholder rates** with real quoted rates (in admin)
- [ ] **Commercial ToD rebate %** — add `tod_rebate_pct_commercial` to `app_config` (default 15) so it's config-driven, not a vision guess
- [ ] **Test a real commercial bill** end-to-end on live site
- [ ] **Compress `advisor.png`** (~1.49 MB, loads on every page view)
- [ ] **Point `estimate.ritesolar.in` DNS** at Hostinger after staging confirmed
- [ ] Add "Get a Free Solar Estimate" button on ritesolar.ai pointing to the tool
- [ ] Confirm Hostinger `max_execution_time` ≥ 120s (vision calls can be slow)

---

## Running Costs

| Cost | Amount | Notes |
|---|---|---|
| Hosting | ₹0 | Covered by existing Hostinger Business plan |
| AI extraction | Pay-per-bill | Observed ~₹60/bill on Opus; ~₹15–25 on Sonnet; ~₹6–8 on Haiku |
| Supabase | ₹0 | Free tier sufficient for current volume |

**Critical:** when the Anthropic balance hits ₹0, extraction stops for all users silently (customers see the generic error). Set a low-balance email alert.

---

## Reference Numbers (for verification)

After any change to formulation, engine, or extraction — run these checks:

| Bill | Category | Expected tariff | Expected size | IRR |
|---|---|---|---|---|
| Shriram Stone Crusher (Dhule) | Industrial | **7.36** | 23 kWp | ~32% |
| Shivani Stone Crushers (Buldana) | Industrial | **7.33** | ~14 kWp | — |
| Commercial reference | Commercial | **10.0621** | 7.49 kWp | — |

---

*Built by Sarvesh, Rite Solar Division, Rite Water Solutions (India) Limited, Nagpur.*
*Full specification: `SPEC.md` · Extraction rules: `extraction_hardening.md` · DB schema: `backend_and_admin.md`*
