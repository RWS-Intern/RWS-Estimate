<?php
/**
 * api/lead.php — called right after the entry form submits, BEFORE
 * extraction finishes (SPEC.md "Persist to Supabase"). Captures the lead
 * (company_name, mobile, category) even if the customer never makes it to
 * the confirm/dashboard step.
 *
 * Always responds 200 with JSON, even on failure — a Supabase outage here
 * must never surface as a fetch-level error the front end has to special-
 * case; the front end just treats a missing "id" as "no persistence this
 * time" and carries on.
 */

header('Content-Type: application/json');

error_reporting(E_ALL);
ini_set('display_errors', '0');

function respond($payload) {
    echo json_encode($payload);
    exit;
}

set_exception_handler(function ($e) {
    error_log('[lead.php] ' . $e->getMessage());
    respond(array('success' => false));
});
register_shutdown_function(function () {
    $err = error_get_last();
    if ($err && in_array($err['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)) {
        error_log('[lead.php] fatal: ' . $err['message']);
        respond(array('success' => false));
    }
});

require __DIR__ . '/config.php';
require __DIR__ . '/supabase.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(array('success' => false));
}

$companyName = isset($_POST['company_name']) ? trim($_POST['company_name']) : '';
$mobile = isset($_POST['mobile']) ? trim($_POST['mobile']) : '';
$category = isset($_POST['category']) ? trim($_POST['category']) : '';

if ($companyName === '' || $mobile === '' || !in_array($category, array('Commercial', 'Industrial'), true)) {
    respond(array('success' => false, 'error' => 'Missing or invalid lead fields.'));
}

$rows = supabase_rest('POST', 'submissions', array(
    'company_name' => $companyName,
    'mobile' => $mobile,
    'category' => $category,
    'stage' => 'entered',
), array('Prefer: return=representation'));

if (!is_array($rows) || !isset($rows[0]['id'])) {
    respond(array('success' => false));
}

respond(array('success' => true, 'id' => $rows[0]['id']));
