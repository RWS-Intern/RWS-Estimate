# Backend + Admin — Supabase schema, storage, and prompts

Adds data storage, bill-file storage, and an admin page for editing the fixed
constants. Uses Supabase (Postgres + Storage + Auth), consistent with the rest of
the Rite Solar stack.

Run the SQL in the Supabase SQL editor first, then the two Claude Code prompts.

---

## 1. SPEC.md edits (make these first, in the repo)

- The entry field for the customer's name is **Company Name** (the dashboard is
  headed "Prepared for {Company Name}").
- **Constants are no longer hardcoded.** All tunable values live in a Supabase
  `app_config` table and are read at runtime. The engine must consume them from
  config, not from an inlined `K` object. The values currently in SPEC.md become
  the *seed defaults* for `app_config`.
- The public page reads config **server-side via PHP** (never expose the config
  table to the anon client — it holds the ₹/kWp cost basis). The admin page reads
  and writes config via Supabase Auth + RLS.
- No user-facing history/login. Backend stores the submission details and the
  uploaded bill file for every customer.

Admin-editable constants (seed app_config with these):
```
rate_per_kwp=51000, gst_rate=0.089, gen_per_kwp_day=4, amc_rate_per_kwp=1200,
amc_esc=0.01, deg_y1=0.03, deg_yr=0.0071, spares_on=true,
spares_rate_per_kwp=2800, spares_base_rate=2000, discount=0.12,
int_surplus=0.045, days=365, dep_rate=0.40, dep_years=9, proc_fee_pct=0.01,
tariff_esc=0.03, gsc=1.96, daytime_window="06-17",
// scenario defaults (starting slider positions on the dashboard):
dep_default=true, tax_default=25.18, loan_default=false, dp_default=20,
loan_rate_default=9, tenure_months_default=60, fd_rate_default=7,
// comparison rates on the "vs deposit/bond" chart:
bond_rate=0.08, savings_rate=0.035, equity_rate=0.12
```

**Commercial formulation constants** (added alongside the commercial tariff
category — see SPEC.md's "Commercial formulation" section):
```
solar_hour_share_pct=75, gst_pct_commercial=8.9, dep_default_commercial=false,
commercial_rate_table=[{"kwp":0,"rate":58000},{"kwp":10,"rate":54000},
  {"kwp":25,"rate":52000},{"kwp":50,"rate":50000},{"kwp":100,"rate":48000}]
```
If `app_config` already has a row (it almost certainly does — this is a
**single-row JSONB blob**, `id=1`, not a per-key table, so these are NOT new
rows to insert), merge the four new keys into the existing row instead:
```sql
update app_config
set config = config || '{
  "solar_hour_share_pct": 75,
  "gst_pct_commercial": 8.9,
  "dep_default_commercial": false,
  "commercial_rate_table": [
    {"kwp": 0, "rate": 58000}, {"kwp": 10, "rate": 54000},
    {"kwp": 25, "rate": 52000}, {"kwp": 50, "rate": 50000},
    {"kwp": 100, "rate": 48000}
  ]
}'::jsonb,
    updated_at = now()
where id = 1;
```
Until this runs, `assets/config-defaults.js`'s `DEFAULTS` fallback covers the
same four values in code — a commercial estimate still works, it just can't
be tuned from `/admin/` for that customer until the row is updated.

---

## 2. Supabase SQL (run in the SQL editor)

```sql
-- === Config: single-row JSON blob of all tunable constants ===
create table if not exists app_config (
  id int primary key default 1,
  config jsonb not null,
  updated_at timestamptz default now(),
  constraint app_config_single_row check (id = 1)
);

-- Seed the one row with the defaults above (fill in the full JSON):
insert into app_config (id, config) values (1, '{
  "rate_per_kwp":51000,"gst_rate":0.089,"gen_per_kwp_day":4,
  "amc_rate_per_kwp":1200,"amc_esc":0.01,"deg_y1":0.03,"deg_yr":0.0071,
  "spares_on":true,"spares_rate_per_kwp":2800,"spares_base_rate":2000,
  "discount":0.12,"int_surplus":0.045,"days":365,"dep_rate":0.40,
  "dep_years":9,"proc_fee_pct":0.01,"tariff_esc":0.03,"gsc":1.96,
  "daytime_window":"06-17","dep_default":true,"tax_default":25.18,
  "loan_default":false,"dp_default":20,"loan_rate_default":9,
  "tenure_months_default":60,"fd_rate_default":7,
  "bond_rate":0.08,"savings_rate":0.035,"equity_rate":0.12
}') on conflict (id) do nothing;

-- === Submissions: one row per customer, filled in two stages ===
create table if not exists submissions (
  id uuid primary key default gen_random_uuid(),
  company_name text,
  mobile text,
  category text,                 -- 'Commercial' | 'Industrial'
  bill_path text,                -- object path in the 'bills' storage bucket (front/only page)
  bill_path_back text,           -- object path of the optional back-of-bill photo (null if not sent)
  report_path text,              -- object path in the 'reports' storage bucket (branded PDF)
  extracted jsonb,               -- confirmed extraction JSON
  computed jsonb,                -- offered_kwp, effective_tariff, irr, payback, npv, lcoe, ...
  stage text default 'entered',  -- 'entered' -> 'completed'
  created_at timestamptz default now(),
  completed_at timestamptz
);

-- If submissions already existed before report_path was added:
-- alter table submissions add column if not exists report_path text;

-- If submissions already existed before bill_path_back was added (two-image
-- bill upload — front required, back optional):
-- alter table submissions add column if not exists bill_path_back text;

-- === RLS ===
alter table app_config enable row level security;
alter table submissions enable row level security;

-- app_config: only authenticated admins may read/write it directly.
-- (The PUBLIC page does NOT read this table from the client — PHP reads it with
--  the service role key. So no anon policy here.)
create policy admin_read_config  on app_config for select to authenticated using (true);
create policy admin_write_config on app_config for update to authenticated using (true) with check (true);

-- submissions: authenticated admins may READ (powers the /admin/ "Leads"
-- table + Excel export). Writes still ONLY happen via PHP with the service
-- role key (bypasses RLS) — this policy grants read-only access, no insert/
-- update/delete policy exists for the authenticated role, so the admin
-- page cannot modify a submissions row even by accident.
-- No anon (public) access at all — the public estimate tool never reads
-- this table directly, and neither does an unauthenticated visitor to
-- /admin/ (they only see the login screen).
create policy admin_read_submissions on submissions for select to authenticated using (true);

-- === Storage buckets (create in Dashboard > Storage) ===
-- Bucket name: bills     | Public: NO (private). The customer's original uploaded bill.
-- Bucket name: reports   | Public: NO (private). The branded PDF report generated on download.
-- Uploads/downloads go through PHP with the service role key; the row stores the
-- object path, and PHP issues short-lived signed URLs if a file ever needs viewing.
```

Then, in the Supabase Dashboard: create two **private** Storage buckets named
`bills` and `reports`, and under Authentication add the one or two **admin
user accounts** (email + password) that will be allowed to edit config. (You
do this yourself — it is not part of the code.)

---

## 3. CLAUDE CODE PROMPT — persistence + config injection

```
Read SPEC.md and backend_and_admin.md. Wire up Supabase persistence and make the
engine read its constants from config instead of hardcoded values. The Supabase
tables (app_config, submissions) and the private 'bills' storage bucket already
exist (SQL in backend_and_admin.md).

Server-side secrets live in git-ignored api/config.php: SUPABASE_URL,
SUPABASE_SERVICE_ROLE_KEY, and the vision API key. Never ship any of these to the
client.

1. api/get_config.php:
   - Reads the single app_config row via the Supabase REST API using the SERVICE
     ROLE key (server-side). Returns the config JSON.
   - The public page calls this on load and uses the returned values as the
     engine's constants (replace the hardcoded K object). Cache it in memory for
     the session.

2. Two-stage submission write (all via PHP, service role key, RLS bypassed):
   - api/lead.php: called right after the entry form submits (before extraction
     finishes). Inserts a submissions row with company_name, mobile, category,
     stage='entered'. Returns the new row id. This captures bounced visitors.
   - api/complete.php: called when the user confirms and the dashboard renders.
     Updates that row (by id) with the confirmed `extracted` JSON, the `computed`
     summary (offered_kwp, effective_tariff, annual_generation, ex_gst_capital,
     irr, payback_years, npv, lcoe), bill_path, stage='completed', completed_at.

3. Bill file storage:
   - In api/extract.php (or a small api/upload_bill.php), after a successful
     extraction, upload the ORIGINAL bill file to the private 'bills' bucket via
     the Storage REST API (service role key). Use a path like
     bills/{submission_id}/{original_filename}. Save that path into the
     submission row's bill_path.

4. Resilience: the customer's dashboard MUST render even if any Supabase call
   fails. Persistence and file upload run in the background / after render; on
   failure, log server-side and continue — never block the user's result.

Do not build the admin page in this task (next prompt). Keep the extraction schema
and field names exactly as in SPEC.md.
```

---

## 4. CLAUDE CODE PROMPT — admin page (edit the constants)

```
Read SPEC.md and backend_and_admin.md. Build a password-protected admin page at
/admin/ for editing the fixed constants in app_config. This page uses Supabase
Auth + RLS directly from the browser (Supabase JS client with the PUBLIC anon
key — anon keys are safe to expose; RLS protects the data). It must NOT use the
service role key.

1. /admin/index.html:
   - Login screen using Supabase Auth (email + password sign-in only; no sign-up
     UI — admin accounts are created by us in the Supabase dashboard).
   - After login, load the app_config row (RLS allows authenticated read) and
     render an editable form grouped sensibly:
       * Pricing & tax: rate_per_kwp, gst_rate, proc_fee_pct
       * Generation & sizing: gen_per_kwp_day, days, daytime_window (06-17 | 09-17)
       * Degradation & O&M: deg_y1, deg_yr, amc_rate_per_kwp, amc_esc, spares_on,
         spares_rate_per_kwp, spares_base_rate
       * Tariff & finance: gsc, tariff_esc, discount, int_surplus, dep_rate, dep_years
       * Dashboard slider defaults: dep_default, tax_default, loan_default,
         dp_default, loan_rate_default, tenure_months_default, fd_rate_default
       * Comparison rates: bond_rate, savings_rate, equity_rate
   - Each field labelled with units and a one-line hint (e.g. "Rs per kWp,
     ex-GST"; "fraction, e.g. 0.089 = 8.9%").
   - "Save" writes the whole config back to the single app_config row (RLS allows
     authenticated update), stamps updated_at, and shows a success/failure toast.
   - Basic validation before save (numbers are numbers, fractions in 0–1 where
     they should be, daytime_window is one of the two allowed strings).
   - A "Log out" button. Match the Rite Solar look from the main page.

2. Security checks:
   - The anon key may appear in /admin JS (that is fine). The service role key
     must NOT appear anywhere client-side.
   - Confirm RLS is the only thing granting write access; there is no unprotected
     endpoint that can modify config.

3. Note in DEPLOY.md: admin accounts are added manually in Supabase Dashboard >
   Authentication; there is intentionally no public sign-up.

Changing a value here must take effect for all NEW estimates automatically,
because the public page reads app_config fresh via api/get_config.php on load.
```

---

### Recap of the four data pieces
- **app_config** — the tunable constants; edited via the admin page, read by the
  public page through PHP.
- **submissions** — one row per customer (company, mobile, category, extracted
  values, computed results), written in two stages so bounced leads are still
  captured; read-only viewable by admins via the `/admin/` "Leads" table and
  its Excel export (see SPEC.md's "Admin Leads view").
- **bills bucket** — the private store for each uploaded bill file; path saved on
  the submission row.
- **auth users** — the one or two admin logins you create in the dashboard.
