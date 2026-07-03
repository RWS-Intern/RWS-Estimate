# Deploy notes — estimate.ritesolar.in (Hostinger)

> Deploying to Render as a container instead? See `DEPLOY-RENDER.md` — same
> app, same Supabase project, packaged with the root `Dockerfile` instead of
> a plain file upload. `api/config.php` now supports both: it reads secrets
> from `getenv()` first (Render) and falls back to an in-file constant you
> edit directly on the server (Hostinger, described below).

## Hostinger deployment checklist

1. **Create the subdomain.** In hPanel: Domains > Subdomains > create
   `estimate.ritesolar.in`, pointing at its own document root folder (e.g.
   `estimate.ritesolar.in/` or `public_html/estimate/` depending on how
   Hostinger names it for you). Upload this project's files into that
   folder — `index.html` at its root, `/admin/`, `/api/`, `/assets/`, etc.
   as siblings.
2. **`composer install` — locally, then upload `vendor/`.** Hostinger shared
   hosting has no shell access to run Composer server-side. Run
   `composer install` on your own machine (installs `smalot/pdfparser` per
   `composer.json`), then upload the resulting `vendor/` folder alongside
   the rest of the site. Without it, `api/extract.php`'s free text-layer PDF
   path silently no-ops and every bill falls straight to the (paid) vision
   path — the tool still works, just costs more per bill.
3. **Create `api/config.php` on the server.** This file is git-ignored — it
   does not come from your repo upload. Create it directly in hPanel's File
   Manager (or over SFTP) with the real `ANTHROPIC_API_KEY`, `SUPABASE_URL`,
   and `SUPABASE_SERVICE_ROLE_KEY` (see "Server-side secrets" below for the
   exact shape). Separately, edit `admin/config.js` (which DOES come from
   your repo — it's not git-ignored) and paste in the real
   `SUPABASE_ANON_KEY`. Never commit real values for either file — the
   placeholders in the repo (`REPLACE_ME_...`) are what should be committed.
4. **Confirm the PHP environment.** Hostinger's shared hosting ships PHP
   with `curl`, `mbstring`, and `fileinfo` enabled by default — this project
   needs all three (`curl` for the Anthropic/Supabase REST calls, `fileinfo`
   for MIME sniffing in `extract.php`/`upload_bill.php`, `mbstring` as a
   `smalot/pdfparser` dependency). Check hPanel > Advanced > PHP
   Configuration for the enabled-extensions list and the PHP version (8.1+
   recommended) before assuming a failure is a code bug. No `--cacert` curl
   flag is needed here — that was only ever a local Windows/XAMPP quirk, not
   something Hostinger requires.
5. **Add a link from the main Rite Solar site.** In the Rite Solar Website
   Builder site, add a "Get a Free Solar Estimate" button/link pointing to
   `https://estimate.ritesolar.in`.
6. **Verify no secret leaked client-side.** Before calling this live, grep
   the deployed files (and `git log -p` / `git grep` across history if this
   repo is ever pushed to a remote) for the literal Anthropic key and the
   Supabase service-role key — neither should appear anywhere under
   `/admin/`, `/assets/`, or in `index.html`. Only `api/config.php`
   (git-ignored, server-side only) should ever contain them. See "Security
   verification" below for the exact commands.

## Supabase setup (one-time)

Run the SQL in `backend_and_admin.md` in the Supabase SQL editor — creates
`app_config` (seeded with the current defaults) and `submissions` (including
`report_path`, added alongside the PDF-report feature — see the
`alter table ... add column if not exists report_path text;` line in
`backend_and_admin.md` if `submissions` already existed before that), plus
RLS policies, **including `admin_read_submissions`** (added alongside the
`/admin/` "Leads" feature — grants `authenticated` read-only SELECT on
`submissions`; if this project's Supabase instance was set up before that
policy existed, run just that one `create policy ...` statement from
`backend_and_admin.md` to bring it up to date — the Leads tab will show a
"Couldn't load submissions" error until it's applied). Then create two
**private** Storage buckets in the dashboard: `bills` (the customer's
original uploaded bill) and `reports` (the branded PDF generated when a
customer downloads their report). All of this is assumed to already exist
by every `api/*.php` endpoint that touches Supabase.

## Server-side secrets (`api/config.php`)

This file IS part of the repo upload now (it holds only `getenv()` reads and
`REPLACE_ME_...` placeholder fallbacks — no real secret, safe to commit; see
the file itself). Hostinger has no environment-variable UI for shared
hosting, so `getenv()` always returns `false` there and every define() falls
through to its placeholder — **edit the file directly** on the server
(hPanel File Manager or SFTP) after uploading, replacing each placeholder
with the real value:

- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` — vision extraction.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — from the Supabase dashboard,
  Project Settings > API. **Service role key only** — this file is never
  sent to the browser.

Edit the file only on the live server — never commit that edited copy back
to the repo (keep the placeholder-only version in source control).

## Admin page secrets (`admin/config.js`)

Unlike `api/config.php`, this file is **not** git-ignored — it only holds
values that are safe to expose client-side (the anon/public key; Row Level
Security is what actually protects `app_config`). Before the admin page can
sign anyone in, replace `SUPABASE_ANON_KEY`'s placeholder with the real
value from Supabase dashboard > Project Settings > API > "anon" / "public"
key (**not** the service_role key).

## Admin accounts

There is intentionally no sign-up UI on `/admin/`. Create each admin login
manually in the Supabase dashboard: Authentication > Users > Add user
(email + password). Anyone with those credentials can read and write
`app_config` — the whole seed/tunable-constants table — and can now also
**read every row of `submissions`** via the Leads tab (customer names,
mobile numbers, and their computed financials — no write access, per the
`admin_read_submissions` policy being SELECT-only), **and download any
customer's uploaded bill or generated report** via the Leads tab's
"Download" buttons (`api/sign_url.php` mints a short-lived signed URL for
whichever admin is currently signed in — see SPEC.md's "Signed downloads").
Only give admin credentials to people who should see all of that.

## Composer

`composer install` has not been run in this repo (no local PHP/Composer in
the dev sandbox that built it) — `vendor/` does not exist yet. Run it before
deploying, or `api/extract.php`'s free text-layer PDF path silently no-ops
(falls straight to the vision path, which still works, just costs more per
bill).

## Security verification

Run before every deploy, and again after any change to `admin/`, `assets/`,
`api/`, or `index.html`:

```sh
# Should print NOTHING. Any match means a secret leaked client-side —
# api/config.php is included now that it's git-tracked (it should only ever
# contain "sk-ant-" or a JWT inside its own REPLACE_ME_... placeholder
# strings, which these patterns don't match).
grep -rn "sk-ant-api03-[A-Za-z0-9_-]\{20,\}" admin/ assets/ api/ index.html
grep -rn "SUPABASE_SERVICE_ROLE_KEY.*eyJ" admin/ assets/ index.html

# admin/config.js is EXPECTED to contain one JWT (the anon key) — exclude it
# and this should still print nothing. A hit elsewhere means a raw JWT (the
# service-role key, most likely) got pasted somewhere it shouldn't be.
grep -rEln "eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}" admin/ assets/ api/ index.html | grep -v "admin/config.js"
```

If this repo is ever pushed to a remote, also check history (a secret
committed once and later "removed" still lives in old commits):

```sh
git log --all -p -- admin/config.js api/config.php | grep -E "sk-ant-|service_role|eyJ[A-Za-z0-9_-]{20,}"
```

`admin/config.js`'s anon key and `SUPABASE_URL` are expected to appear in
`admin/`/`assets/`/`index.html` — those are meant to be public (RLS
protects the data, not secrecy of the key). What must NEVER appear there is
the Anthropic key or the Supabase **service_role** key.
