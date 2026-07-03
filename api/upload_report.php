<?php
/**
 * api/upload_report.php — called right after the customer's branded PDF
 * report has already started downloading in their browser (assets/report.js
 * / assets/js/app.js). Uploads that same PDF to the private 'reports'
 * storage bucket at {submission_id}/report.pdf, then stamps the
 * submission row's report_path.
 *
 * Fire-and-forget from the client's point of view — the download has
 * already happened by the time this runs. Any failure here is logged
 * server-side only, never surfaced to the customer (SPEC.md "PDF report" /
 * "Resilience": download first, store best-effort).
 */

header('Content-Type: application/json');

error_reporting(E_ALL);
ini_set('display_errors', '0');

function respond($payload) {
    echo json_encode($payload);
    exit;
}

set_exception_handler(function ($e) {
    error_log('[upload_report.php] ' . $e->getMessage());
    respond(array('success' => false));
});
register_shutdown_function(function () {
    $err = error_get_last();
    if ($err && in_array($err['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)) {
        error_log('[upload_report.php] fatal: ' . $err['message']);
        respond(array('success' => false));
    }
});

require __DIR__ . '/config.php';
require __DIR__ . '/supabase.php';

const MAX_REPORT_BYTES = 15 * 1024 * 1024; // a text+chart-image PDF is usually well under 5MB; generous cap

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    error_log('[upload_report.php] rejected: not a POST request (' . $_SERVER['REQUEST_METHOD'] . ')');
    respond(array('success' => false));
}

$configProblem = supabase_config_problem();
if ($configProblem !== null) {
    error_log('[upload_report.php] Supabase is not configured (' . $configProblem . ') — cannot upload.');
    respond(array('success' => false, 'error' => 'Server is not configured to store reports yet.'));
}

$id = isset($_POST['id']) ? trim($_POST['id']) : '';
if ($id === '') {
    error_log('[upload_report.php] rejected: no non-empty "id" in the request. POST keys received: [' . implode(', ', array_keys($_POST)) . ']');
    respond(array('success' => false, 'error' => 'Missing submission id.'));
}

if (!isset($_FILES['report_file'])) {
    error_log('[upload_report.php] rejected: no "report_file" in $_FILES for id=' . $id . '. $_FILES keys received: [' . implode(', ', array_keys($_FILES)) . ']. Check the client is sending FormData with a "report_file" field (see uploadReportFile() in assets/js/app.js).');
    respond(array('success' => false, 'error' => 'Missing report_file.'));
}

$file = $_FILES['report_file'];
if ($file['error'] !== UPLOAD_ERR_OK) {
    // Common causes: UPLOAD_ERR_INI_SIZE (1) / UPLOAD_ERR_FORM_SIZE (2) — the
    // generated PDF (chart images included) exceeded this server's
    // upload_max_filesize/post_max_size; UPLOAD_ERR_PARTIAL (3) — the
    // connection dropped mid-upload.
    error_log('[upload_report.php] upload error for id=' . $id . ': PHP UPLOAD_ERR_* code ' . $file['error'] .
        ' — if this is 1 or 2, raise upload_max_filesize/post_max_size in php.ini for this reason.');
    respond(array('success' => false, 'error' => 'Upload failed (error code ' . $file['error'] . ').'));
}

if ($file['size'] <= 0 || $file['size'] > MAX_REPORT_BYTES) {
    error_log('[upload_report.php] rejected: report_file size ' . $file['size'] . ' bytes for id=' . $id . ' (limit ' . MAX_REPORT_BYTES . ')');
    respond(array('success' => false, 'error' => 'File too large.'));
}

$bytes = file_get_contents($file['tmp_name']);
if ($bytes === false) {
    error_log('[upload_report.php] could not read tmp_name (' . $file['tmp_name'] . ') for id=' . $id);
    respond(array('success' => false, 'error' => 'Could not read the generated report.'));
}

$objectPath = $id . '/report.pdf'; // within the 'reports' bucket
error_log('[upload_report.php] uploading ' . strlen($bytes) . ' bytes to reports/' . $objectPath);

$uploaded = supabase_storage_upload('reports', $objectPath, $bytes, 'application/pdf');
if (!$uploaded) {
    // supabase_storage_upload() (api/supabase.php) already logged the exact
    // HTTP status + response body from Supabase on the line above this one
    // — that's the line that tells you the real reason (bucket missing,
    // bad key, etc). Most likely cause: the private 'reports' Storage
    // bucket hasn't been created yet — it's a manual Supabase Dashboard
    // step (Storage > New bucket > name it exactly "reports", private),
    // see backend_and_admin.md / DEPLOY.md.
    error_log('[upload_report.php] supabase_storage_upload() failed for reports/' . $objectPath . ' — see the [supabase] log line immediately above for the HTTP status and response body.');
    respond(array('success' => false, 'error' => 'Could not store the report.'));
}

$rows = supabase_rest('PATCH', 'submissions?id=eq.' . rawurlencode($id), array(
    'report_path' => 'reports/' . $objectPath,
), array('Prefer: return=representation'));

if (!is_array($rows)) {
    error_log('[upload_report.php] uploaded reports/' . $objectPath . ' successfully, but the PATCH to set submissions.report_path failed for id=' . $id . ' — see the [supabase] log line above.');
} elseif (count($rows) === 0) {
    error_log('[upload_report.php] uploaded reports/' . $objectPath . ' successfully, but the PATCH matched ZERO rows for id=' . $id . ' — that id does not exist in submissions (check lead.php actually created this row).');
}

respond(array('success' => is_array($rows) && count($rows) > 0));
