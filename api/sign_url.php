<?php
/**
 * api/sign_url.php — mints a short-lived signed URL for a private Storage
 * object (the 'bills'/'reports' buckets), for the admin Leads tab's
 * Bill/Report "Download" buttons. Server-side only: SUPABASE_URL and the
 * SERVICE ROLE key never reach the browser (api/config.php).
 *
 * This is deliberately NOT an open signing endpoint — every request must
 * carry the caller's own currently-valid Supabase Auth access token (the
 * admin's session, from sb.auth.getSession() on /admin/), verified against
 * Supabase's own Auth API (supabase_auth_user_valid() in api/supabase.php)
 * before anything gets signed. No valid admin session, no signature.
 *
 * Request (JSON body): {"bucket": "bills"|"reports", "path": "...",
 * "access_token": "..."}. Response: {"success": true, "url": "...",
 * "expiresIn": 300} or {"success": false, "error": "..."}. Always HTTP 200
 * — same fail-soft convention as every other api/*.php endpoint — the
 * client checks the "success" field.
 */

header('Content-Type: application/json');

error_reporting(E_ALL);
ini_set('display_errors', '0');

function respond($payload) {
    echo json_encode($payload);
    exit;
}

set_exception_handler(function ($e) {
    error_log('[sign_url.php] ' . $e->getMessage());
    respond(array('success' => false, 'error' => 'Server error.'));
});
register_shutdown_function(function () {
    $err = error_get_last();
    if ($err && in_array($err['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)) {
        error_log('[sign_url.php] fatal: ' . $err['message']);
        respond(array('success' => false, 'error' => 'Server error.'));
    }
});

require __DIR__ . '/config.php';
require __DIR__ . '/supabase.php';

const ALLOWED_BUCKETS = array('bills', 'reports');
const SIGNED_URL_TTL_SECONDS = 300;

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(array('success' => false, 'error' => 'Method not allowed.'));
}

$configProblem = supabase_config_problem();
if ($configProblem !== null) {
    error_log('[sign_url.php] Supabase is not configured (' . $configProblem . ').');
    respond(array('success' => false, 'error' => 'Server is not configured.'));
}

$body = json_decode(file_get_contents('php://input'), true);
if (!is_array($body)) {
    respond(array('success' => false, 'error' => 'Invalid request.'));
}

// --- 1. Require a currently-valid Supabase Auth session (the signed-in
//     admin's own access token). This — not the request's origin or any
//     shared secret — is what keeps this endpoint from being an open
//     "sign anything in these buckets" oracle.
$accessToken = isset($body['access_token']) ? trim((string) $body['access_token']) : '';
if ($accessToken === '') {
    respond(array('success' => false, 'error' => 'Missing admin session.'));
}
if (!supabase_auth_user_valid($accessToken)) {
    error_log('[sign_url.php] rejected: access token failed verification against Supabase Auth.');
    respond(array('success' => false, 'error' => 'Your admin session has expired — please sign in again.'));
}

// --- 2. Validate the requested bucket/path.
$bucket = isset($body['bucket']) ? trim((string) $body['bucket']) : '';
$path = isset($body['path']) ? trim((string) $body['path']) : '';

if (!in_array($bucket, ALLOWED_BUCKETS, true)) {
    error_log('[sign_url.php] rejected: bucket "' . $bucket . '" is not one of: ' . implode(', ', ALLOWED_BUCKETS));
    respond(array('success' => false, 'error' => 'Invalid bucket.'));
}
if ($path === '') {
    respond(array('success' => false, 'error' => 'Missing path.'));
}

// submissions.bill_path/report_path are stored WITH the bucket name
// prefixed (e.g. "bills/{id}/{filename}") — strip that back off before
// asking Storage to sign it, since the bucket is already its own URL
// segment there. Harmless if the caller already sent a bucket-relative
// path (no prefix to strip).
$prefix = $bucket . '/';
if (strpos($path, $prefix) === 0) {
    $path = substr($path, strlen($prefix));
}
if ($path === '') {
    respond(array('success' => false, 'error' => 'Missing path.'));
}

// --- 3. Ask Supabase Storage to sign it (service role key, server-side only).
$signedUrl = supabase_storage_sign_url($bucket, $path, SIGNED_URL_TTL_SECONDS);
if ($signedUrl === null) {
    respond(array('success' => false, 'error' => 'Could not create a download link.'));
}

respond(array('success' => true, 'url' => $signedUrl, 'expiresIn' => SIGNED_URL_TTL_SECONDS));
