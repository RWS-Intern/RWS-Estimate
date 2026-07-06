<?php
/**
 * api/upload_bill.php — called right after a successful extraction (SPEC.md
 * "Persist to Supabase"). Uploads the ORIGINAL bill file(s) (the untouched
 * photo/PDF the customer picked — not the downscaled/rendered images sent
 * to api/extract.php) to the private 'bills' storage bucket, then stamps
 * the submission row's bill_path (front/only page) and, if a back-of-bill
 * photo was also sent, bill_path_back.
 *
 * bill_file_front is required; bill_file_back is optional (only present
 * when the customer uploaded two loose photos rather than a PDF — see
 * app.js's setBackSlotEnabled()). Both are stored under the same
 * submission id with suffixed filenames, e.g. {id}/{id}_front.jpg and
 * {id}/{id}_back.jpg, so a submission's two pages sort together in the
 * bucket and never collide with each other's names.
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
if ($id === '' || !isset($_FILES['bill_file_front']) || $_FILES['bill_file_front']['error'] !== UPLOAD_ERR_OK) {
    respond(array('success' => false, 'error' => 'Missing id or bill_file_front.'));
}

/** Detects the file's MIME type and uploads it to the 'bills' bucket under
 *  {id}/{id}_{suffix}.{ext}. Returns the bucket-prefixed object path on
 *  success, or null on any failure (bad upload, storage error). */
function upload_bill_page($file, $id, $suffix) {
    if ($file['size'] <= 0 || $file['size'] > MAX_BILL_BYTES) {
        return null;
    }
    $bytes = file_get_contents($file['tmp_name']);
    if ($bytes === false) {
        return null;
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

    $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
    if ($ext === '' || $ext === null) $ext = 'bin';
    $ext = preg_replace('/[^a-z0-9]/', '', $ext);
    $safeName = $id . '_' . $suffix . '.' . $ext;
    $objectPath = $id . '/' . $safeName; // within the 'bills' bucket

    $uploaded = supabase_storage_upload('bills', $objectPath, $bytes, $mime);
    return $uploaded ? ('bills/' . $objectPath) : null;
}

$frontPath = upload_bill_page($_FILES['bill_file_front'], $id, 'front');
if ($frontPath === null) {
    respond(array('success' => false, 'error' => 'Could not upload the front page.'));
}

$patch = array('bill_path' => $frontPath);

if (isset($_FILES['bill_file_back']) && $_FILES['bill_file_back']['error'] === UPLOAD_ERR_OK) {
    $backPath = upload_bill_page($_FILES['bill_file_back'], $id, 'back');
    if ($backPath !== null) {
        $patch['bill_path_back'] = $backPath;
    }
}

$rows = supabase_rest('PATCH', 'submissions?id=eq.' . rawurlencode($id), $patch,
    array('Prefer: return=representation'));

respond(array('success' => is_array($rows)));
