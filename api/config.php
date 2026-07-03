<?php
/**
 * Server-side secrets. Two supported deployment shapes share this one file:
 *
 * - Render, or any host that sets real process environment variables
 *   (see DEPLOY-RENDER.md): every define() below reads getenv() FIRST. Set
 *   the real values in the host's dashboard/env config — never here. This
 *   file is safe to commit exactly as it reads below: no real secret ever
 *   lives in it, only REPLACE_ME placeholders used purely as a fallback
 *   when the environment variable isn't set.
 * - Hostinger, or any shared host with no env-var support (see DEPLOY.md):
 *   getenv() returns false there, so each define() falls through to its
 *   placeholder fallback — edit THIS file directly on the server (hPanel
 *   File Manager / SFTP) and replace the placeholder with the real value.
 *   Never commit that edited copy back — keep the placeholder-only version
 *   in source control and edit only the deployed file on the server itself.
 */

// Vision extraction (Claude API — https://api.anthropic.com/v1/messages).
define('ANTHROPIC_API_KEY', getenv('ANTHROPIC_API_KEY') ?: 'REPLACE_ME_ANTHROPIC_API_KEY');

// Model used for bill-photo extraction. claude-opus-4-8 for best accuracy on
// skewed/faint/stamped photos; swap to a cheaper model (e.g. claude-haiku-4-5)
// if per-bill cost matters more than accuracy on hard images. Not a secret —
// this default is a real, working value, not a REPLACE_ME placeholder.
define('ANTHROPIC_MODEL', getenv('ANTHROPIC_MODEL') ?: 'claude-opus-4-8');

// Supabase project (submissions + app_config tables, 'bills'/'reports'
// storage buckets — see backend_and_admin.md for the SQL). SERVICE ROLE
// key only — this file never ships to the browser. Get both from Supabase
// dashboard > Project Settings > API.
define('SUPABASE_URL', getenv('SUPABASE_URL') ?: 'REPLACE_ME_SUPABASE_URL');
define('SUPABASE_SERVICE_ROLE_KEY', getenv('SUPABASE_SERVICE_ROLE_KEY') ?: 'REPLACE_ME_SUPABASE_SERVICE_ROLE_KEY');
