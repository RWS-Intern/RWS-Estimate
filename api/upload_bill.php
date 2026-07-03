<?php
/**
 * api/upload_bill.php — called right after a successful extraction (SPEC.md
 * "Persist to Supabase"). Uploads the ORIGINAL bill file (the untouched
 * photo/PDF the customer picked — not the downscaled/rendered images sent
 * to api/extract.php) to the private 'bills' storage bucket, then stamps
 * the submission row's bill_path.
 *
 * Fire-and-forget from the client's point of view: the confirm screen is
 * already showing by the time this runs. Any failure is logged server-side
 * only.
 */

header('Content-Type: application/json');

error_reporting(E_ALL);
ini_set('display_errors', '0');

function respond($payload) {
    echo json_encode($payload);
    exit;
}

set_exception_handler(function ($e) {
    error_log('[upload_bill.php] ' . $e->getMessage());
    respond(array('success' => false));
});
register_shutdown_function(function () {
    $err = error_get_last();
    if ($err && in_array($err['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)) {
        error_log('[upload_bill.php] fatal: ' . $err['message']);
        respond(array('success' => false));
    }
});

require __DIR__ . '/config.php';
require __DIR__ . '/supabase.php';

const MAX_BILL_BYTES = 20 * 1024 * 1024; // matches app.js's RAW_FILE_MAX_BYTES

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(array('success' => false));
}

$id = isset($_POST['id']) ? trim($_POST['id']) : '';
if ($id === '' || !isset($_FILES['bill_file']) || $_FILES['bill_file']['error'] !== UPLOAD_ERR_OK) {
    respond(array('success' => false, 'error' => 'Missing id or bill_file.'));
}

$file = $_FILES['bill_file'];
if ($file['size'] <= 0 || $file['size'] > MAX_BILL_BYTES) {
    respond(array('success' => false, 'error' => 'File too large.'));
}

$bytes = file_get_contents($file['tmp_name']);
if ($bytes === false) {
    respond(array('success' => false, 'error' => 'Could not read the uploaded file.'));
}

$mime = null;
if (function_exists('finfo_open')) {
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    if ($finfo) {
        $mime = finfo_file($finfo, $file['tmp_name']);
        // No finfo_close() — finfo is a normal object in PHP 8, garbage
        // collected when $finfo goes out of scope; closing it explicitly is
        // deprecated as of PHP 8.5.
    }
}
if (!$mime) $mime = 'application/octet-stream';

$safeName = preg_replace('/[^A-Za-z0-9._-]/', '_', $file['name']);
if ($safeName === '' || $safeName === null) $safeName = 'bill';
$objectPath = $id . '/' . $safeName; // within the 'bills' bucket

$uploaded = supabase_storage_upload('bills', $objectPath, $bytes, $mime);
if (!$uploaded) {
    respond(array('success' => false));
}

$rows = supabase_rest('PATCH', 'submissions?id=eq.' . rawurlencode($id), array(
    'bill_path' => 'bills/' . $objectPath,
), array('Prefer: return=representation'));

respond(array('success' => is_array($rows)));
