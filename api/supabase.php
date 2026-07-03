<?php
/**
 * api/supabase.php — thin wrapper around the Supabase REST (PostgREST),
 * Storage, and Auth APIs, shared by lead.php, complete.php,
 * upload_bill.php, upload_report.php, get_config.php, and sign_url.php.
 * Always uses the SERVICE ROLE key (server-side only — never sent to the
 * client) and always bypasses RLS.
 *
 * Every function here returns null/false on ANY failure (missing config,
 * network error, non-2xx response) instead of throwing. Persistence must
 * never be able to break the customer-facing flow (SPEC.md "Resilience"),
 * so callers get a clean signal to log-and-continue rather than an
 * exception to catch.
 */

function supabase_configured() {
    return supabase_config_problem() === null;
}

/** Returns null if SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY both look real, or
 *  a short human-readable reason why not — used so a "not configured" log
 *  line actually says WHICH constant is missing/still a placeholder,
 *  instead of just "not configured". */
function supabase_config_problem() {
    if (!defined('SUPABASE_URL') || SUPABASE_URL === '') return 'SUPABASE_URL is not defined in api/config.php';
    if (strpos(SUPABASE_URL, 'REPLACE_ME') === 0) return 'SUPABASE_URL is still the REPLACE_ME placeholder';
    if (!defined('SUPABASE_SERVICE_ROLE_KEY') || SUPABASE_SERVICE_ROLE_KEY === '') return 'SUPABASE_SERVICE_ROLE_KEY is not defined in api/config.php';
    if (strpos(SUPABASE_SERVICE_ROLE_KEY, 'REPLACE_ME') === 0) return 'SUPABASE_SERVICE_ROLE_KEY is still the REPLACE_ME placeholder';
    return null;
}

/**
 * Generic PostgREST call against .../rest/v1/{$path}. $body, if given, is
 * JSON-encoded as the request body. Returns the decoded JSON response
 * (typically an array of rows, given "Prefer: return=representation") on
 * success, or null on any failure.
 */
function supabase_rest($method, $path, $body = null, $extraHeaders = array()) {
    $configProblem = supabase_config_problem();
    if ($configProblem !== null) {
        error_log('[supabase] not configured (' . $configProblem . ') — skipping ' . $method . ' ' . $path);
        return null;
    }

    $headers = array_merge(array(
        'apikey: ' . SUPABASE_SERVICE_ROLE_KEY,
        'Authorization: Bearer ' . SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type: application/json',
    ), $extraHeaders);

    $opts = array(
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_TIMEOUT => 15,
    );
    if ($body !== null) {
        $opts[CURLOPT_POSTFIELDS] = json_encode($body);
    }

    $ch = curl_init(rtrim(SUPABASE_URL, '/') . '/rest/v1/' . $path);
    curl_setopt_array($ch, $opts);
    $raw = curl_exec($ch);
    $curlErr = curl_error($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    // No curl_close() — PHP 8's CurlHandle is a normal object, garbage
    // collected when $ch goes out of scope; closing it explicitly is
    // deprecated as of PHP 8.5.

    if ($raw === false) {
        error_log('[supabase] REST ' . $method . ' ' . $path . ' failed: ' . $curlErr);
        return null;
    }
    if ($httpCode < 200 || $httpCode >= 300) {
        error_log('[supabase] REST ' . $method . ' ' . $path . ' returned HTTP ' . $httpCode . ': ' . substr($raw, 0, 500));
        return null;
    }
    return json_decode($raw, true);
}

/**
 * Uploads raw bytes to a Storage bucket at $objectPath (no leading slash,
 * no bucket name in the path — that's passed separately as $bucket).
 * Returns true on success, false on any failure.
 */
function supabase_storage_upload($bucket, $objectPath, $bytes, $mimeType) {
    $configProblem = supabase_config_problem();
    if ($configProblem !== null) {
        error_log('[supabase] not configured (' . $configProblem . ') — skipping storage upload to ' . $bucket . '/' . $objectPath);
        return false;
    }

    $encodedPath = implode('/', array_map('rawurlencode', explode('/', $objectPath)));
    $url = rtrim(SUPABASE_URL, '/') . '/storage/v1/object/' . rawurlencode($bucket) . '/' . $encodedPath;

    $ch = curl_init($url);
    curl_setopt_array($ch, array(
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST => 'POST',
        CURLOPT_HTTPHEADER => array(
            'apikey: ' . SUPABASE_SERVICE_ROLE_KEY,
            'Authorization: Bearer ' . SUPABASE_SERVICE_ROLE_KEY,
            'Content-Type: ' . $mimeType,
            'x-upsert: true',
        ),
        CURLOPT_POSTFIELDS => $bytes,
        CURLOPT_TIMEOUT => 30,
    ));
    $raw = curl_exec($ch);
    $curlErr = curl_error($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    // No curl_close() — see the comment in supabase_rest() above.

    if ($raw === false || $httpCode < 200 || $httpCode >= 300) {
        // Deliberately verbose: this is the one line that tells you WHY a
        // report/bill upload silently didn't land — e.g. HTTP 404 "Bucket
        // not found" means the bucket doesn't exist yet (a manual Supabase
        // Dashboard step, see backend_and_admin.md/DEPLOY.md), 401/403 means
        // the service-role key is wrong, and so on.
        error_log('[supabase] storage upload failed: POST ' . $url .
            ' -> HTTP ' . $httpCode .
            ($curlErr !== '' ? (' (curl error: ' . $curlErr . ')') : '') .
            ' | bytes_sent=' . strlen($bytes) . ' mime=' . $mimeType .
            ' | response_body=' . substr((string) $raw, 0, 500));
        return false;
    }
    return true;
}

/**
 * Verifies a Supabase Auth access token by asking Supabase's own Auth API
 * (GoTrue) who it belongs to, rather than verifying the JWT signature
 * ourselves — that would need the project's separate JWT secret (not one
 * of the keys already in api/config.php) and a JWT library. A 200 response
 * with a user id means the token is a real, currently-valid, non-expired
 * admin session; anything else means it isn't. Used by sign_url.php so
 * that endpoint isn't an open "sign anything" oracle.
 */
function supabase_auth_user_valid($accessToken) {
    $configProblem = supabase_config_problem();
    if ($configProblem !== null) {
        error_log('[supabase] not configured (' . $configProblem . ') — cannot verify access token');
        return false;
    }
    if (!is_string($accessToken) || trim($accessToken) === '') {
        return false;
    }

    $ch = curl_init(rtrim(SUPABASE_URL, '/') . '/auth/v1/user');
    curl_setopt_array($ch, array(
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => array(
            'apikey: ' . SUPABASE_SERVICE_ROLE_KEY,
            'Authorization: Bearer ' . $accessToken,
        ),
        CURLOPT_TIMEOUT => 10,
    ));
    $raw = curl_exec($ch);
    $curlErr = curl_error($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);

    if ($raw === false || $httpCode < 200 || $httpCode >= 300) {
        error_log('[supabase] access token verification failed: HTTP ' . $httpCode .
            ($curlErr !== '' ? (' (curl error: ' . $curlErr . ')') : ''));
        return false;
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) && isset($decoded['id']) && $decoded['id'] !== '';
}

/**
 * Requests a signed URL (valid for $ttl seconds) for a private Storage
 * object. Supabase's own sign-URL API returns a PATH relative to
 * /storage/v1 (e.g. "/object/sign/bills/abc/bill.pdf?token=...") — this
 * stitches SUPABASE_URL back onto it so the caller gets a real, directly
 * usable absolute URL. Returns null on any failure.
 */
function supabase_storage_sign_url($bucket, $objectPath, $ttl) {
    $configProblem = supabase_config_problem();
    if ($configProblem !== null) {
        error_log('[supabase] not configured (' . $configProblem . ') — skipping sign for ' . $bucket . '/' . $objectPath);
        return null;
    }

    $encodedPath = implode('/', array_map('rawurlencode', explode('/', $objectPath)));
    $url = rtrim(SUPABASE_URL, '/') . '/storage/v1/object/sign/' . rawurlencode($bucket) . '/' . $encodedPath;

    $ch = curl_init($url);
    curl_setopt_array($ch, array(
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST => 'POST',
        CURLOPT_HTTPHEADER => array(
            'apikey: ' . SUPABASE_SERVICE_ROLE_KEY,
            'Authorization: Bearer ' . SUPABASE_SERVICE_ROLE_KEY,
            'Content-Type: application/json',
        ),
        CURLOPT_POSTFIELDS => json_encode(array('expiresIn' => $ttl)),
        CURLOPT_TIMEOUT => 15,
    ));
    $raw = curl_exec($ch);
    $curlErr = curl_error($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);

    if ($raw === false || $httpCode < 200 || $httpCode >= 300) {
        error_log('[supabase] sign-url failed: POST ' . $url .
            ' -> HTTP ' . $httpCode .
            ($curlErr !== '' ? (' (curl error: ' . $curlErr . ')') : '') .
            ' | response_body=' . substr((string) $raw, 0, 500));
        return null;
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded) || !isset($decoded['signedURL']) || $decoded['signedURL'] === '') {
        error_log('[supabase] sign-url returned an unexpected body for ' . $bucket . '/' . $objectPath . ': ' . substr((string) $raw, 0, 300));
        return null;
    }

    return rtrim(SUPABASE_URL, '/') . '/storage/v1' . $decoded['signedURL'];
}
