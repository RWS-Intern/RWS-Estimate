<?php
/**
 * api/complete.php — called when the user confirms and the dashboard
 * renders (SPEC.md "Persist to Supabase"). Updates the lead row created by
 * api/lead.php with the confirmed extraction JSON and the computed summary.
 *
 * By the time the front end calls this, the dashboard has already rendered
 * — this is a fire-and-forget background call. Any failure is logged
 * server-side only; never surfaced to the customer.
 *
 * Only extracted/computed/stage/completed_at are set here. bill_path is set
 * separately by api/upload_bill.php (which runs earlier, right after a
 * successful extraction) — a PATCH only touches the fields present in its
 * body, so this call never clobbers a bill_path that's already there.
 */

header('Content-Type: application/json');

error_reporting(E_ALL);
ini_set('display_errors', '0');

function respond($payload) {
    echo json_encode($payload);
    exit;
}

set_exception_handler(function ($e) {
    error_log('[complete.php] ' . $e->getMessage());
    respond(array('success' => false));
});
register_shutdown_function(function () {
    $err = error_get_last();
    if ($err && in_array($err['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)) {
        error_log('[complete.php] fatal: ' . $err['message']);
        respond(array('success' => false));
    }
});

require __DIR__ . '/config.php';
require __DIR__ . '/supabase.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(array('success' => false));
}

$id = isset($_POST['id']) ? trim($_POST['id']) : '';
$extractedRaw = isset($_POST['extracted']) ? $_POST['extracted'] : null;
$computedRaw = isset($_POST['computed']) ? $_POST['computed'] : null;

if ($id === '' || $extractedRaw === null || $computedRaw === null) {
    respond(array('success' => false, 'error' => 'Missing id, extracted, or computed.'));
}

$extracted = json_decode($extractedRaw, true);
$computed = json_decode($computedRaw, true);
if (!is_array($extracted) || !is_array($computed)) {
    respond(array('success' => false, 'error' => 'extracted/computed must be JSON.'));
}

$rows = supabase_rest('PATCH', 'submissions?id=eq.' . rawurlencode($id), array(
    'extracted' => $extracted,
    'computed' => $computed,
    'stage' => 'completed',
    'completed_at' => gmdate('Y-m-d\TH:i:s\Z'),
), array('Prefer: return=representation'));

respond(array('success' => is_array($rows)));
