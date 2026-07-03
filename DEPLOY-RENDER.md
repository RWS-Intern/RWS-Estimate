# Deploy notes — running this app on Render (Docker Web Service)

An alternative to the Hostinger deploy in `DEPLOY.md`: this packages the app
as a container (`Dockerfile` at the repo root) instead of a plain PHP file
upload. Same codebase, same Supabase project, same behavior — only how the
PHP process gets hosted changes. Read `DEPLOY.md`'s "Supabase setup" section
first if you haven't already; that one-time SQL/bucket setup is identical
regardless of where the PHP side runs.

## How the container works

- `Dockerfile` builds `smalot/pdfparser`'s Composer dependencies in a
  throwaway `composer:2` stage, then copies the whole project — `index.html`,
  `/api`, `/admin`, `/assets` — into `php:8.2-apache`'s document root
  (`/var/www/html`), plus `curl`/`mbstring`/`fileinfo`/`zip` and
  `mod_rewrite` enabled.
- `docker/entrypoint.sh` rewrites Apache's hardcoded port-80 config to
  Render's `$PORT` environment variable before starting Apache. **This is
  required** — Render assigns a random port per deploy and marks the
  service unhealthy if it isn't listening on exactly that port.
- `api/config.php` reads every secret from `getenv()` first, falling back
  to a `REPLACE_ME_...` placeholder if the environment variable isn't set
  (see the file itself). Nothing secret is baked into the image or
  committed to the repo — real values live only in Render's dashboard.

## Steps

1. **Push this repo to a Git provider Render can read** (GitHub/GitLab/
   Bitbucket). `api/config.php` is safe to commit as-is — it holds
   placeholders, not real keys. `vendor/`, `composer.lock`, and `/uploads/`
   stay git-ignored as before; the Docker build regenerates `vendor/`
   itself (see `.dockerignore`).
2. **Render dashboard > New > Web Service** > connect that repo. Render
   detects the root `Dockerfile` automatically (Environment: **Docker**) —
   no build/start command fields to fill in, the `Dockerfile`'s own
   `ENTRYPOINT`/`CMD` handle that.
3. Pick a region/instance size and click **Create Web Service**. First
   build takes a few minutes (installing PHP extensions + Composer deps).
4. **Set environment variables** — Render dashboard > your service >
   Environment > Add Environment Variable:

   | Key | Value | Notes |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | your real Anthropic Console key | required — extraction fails loudly without it |
   | `ANTHROPIC_MODEL` | `claude-opus-4-8` | optional — this is already the code's default if unset |
   | `SUPABASE_URL` | your project's URL, e.g. `https://xxxx.supabase.co` | required |
   | `SUPABASE_SERVICE_ROLE_KEY` | the **service_role** key (Project Settings > API) | required — never the anon key here |

   Save, and Render redeploys automatically with the new values in scope.
5. **`admin/config.js` still needs a real value, but NOT via an env var.**
   That file holds the Supabase **anon/public** key for the browser-side
   admin page — it's a static JS file served as-is, not templated by PHP,
   so environment variables never reach it. Edit
   `SUPABASE_ANON_KEY` in `admin/config.js` directly (it's already
   git-tracked, safe to commit — RLS protects the data, not secrecy of this
   key) and commit/push that change; Render redeploys on push. This is the
   same edit `DEPLOY.md` describes for Hostinger — identical either way.
6. **Verify.** Once deployed, open `https://<your-service>.onrender.com/`
   (the public estimate tool) and `https://<your-service>.onrender.com/admin/`
   (sign-in screen). If either 500s, check the service's Logs tab in Render
   first — `api/*.php`'s `error_log()` calls (see SPEC.md's various
   "Resilience" notes) land there.
7. **Custom domain (optional).** Render dashboard > your service > Settings
   > Custom Domains > add `estimate.ritesolar.in`, then create the CNAME
   record Render gives you at your DNS provider. Only point the domain here
   instead of Hostinger if you're actually moving the deployment, not
   running both at once.

## Security verification

Same checks as `DEPLOY.md`'s "Security verification" section, plus one
Render-specific one: confirm no real secret value was ever pasted into
`api/config.php` before a commit. Run this before every push:

```sh
# Should print NOTHING except the getenv()/REPLACE_ME lines in config.php
# itself. Any OTHER match means a real key got hardcoded somewhere.
grep -rn "sk-ant-api03-[A-Za-z0-9_-]\{20,\}" . --exclude-dir=.git --exclude-dir=vendor
grep -rEn "eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}" . --exclude-dir=.git --exclude-dir=vendor | grep -v "admin/config.js"
```

`admin/config.js`'s anon key is the one expected JWT-shaped match outside
`api/config.php` — everything else should be empty. If `api/config.php`
ever ends up with a real key hardcoded in git history (e.g. someone pastes
one in locally to test, then commits), rotate that key in the Anthropic
Console / Supabase dashboard — a `git revert` does not remove it from
history.

## Notes / things to know

- The Docker image always runs `composer install` fresh in its own build
  stage rather than trusting a locally-generated `vendor/` folder — this
  guarantees dependencies actually built for the image's PHP version, and
  keeps working regardless of whether `vendor/` happens to exist in your
  local checkout.
- `AllowOverride All` is set for `/var/www/html` in the image (Apache's
  Debian default is `None`) so a `.htaccess` file works if one is ever
  added — none exists in this repo today, this is just future-proofing,
  not a behavior change.
- This was written and reviewed by reading the Dockerfile/entrypoint
  carefully against Apache's and Render's documented behavior, not by
  actually building and deploying the image — there's no Docker daemon or
  Render account in this sandbox. Before trusting this in production:
  build the image locally (`docker build -t rite-solar-estimate .`), run
  it with `-e PORT=8080 -p 8080:8080`, and confirm `curl
  localhost:8080/index.html` and `localhost:8080/api/get_config.php`
  actually respond before pushing to Render.
