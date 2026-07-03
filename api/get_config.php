<?php
/**
 * api/get_config.php — reads the single app_config row from Supabase via
 * the REST API, using the SERVICE ROLE key (server-side only, from
 * api/config.php). This is the ONLY way the public page's constants reach
 * the browser — the app_config table itself is never queried directly from
 * client-side JS, and the service role key never leaves this file.
 *
 * assets/config-defaults.js's RiteConfig.load() calls this on every page
 * load. Always responds 200 with JSON, even on failure — {"success": false}
 * lets load() fall back to its inlined defaults instead of treating a
 * Supabase hiccup as a fetch-level error the front end has to special-case.
 */

header('Content-Type: application/json');

error_reporting(E_ALL);
ini_set('display_errors', '0');

function respond($payload) {
    echo json_encode($payload);
    exit;
}

set_exception_handler(function ($e) {
    error_log('[get_config.php] ' . $e->getMessage());
    respond(array('success' => false));
});
register_shutdown_function(function () {
    $err = error_get_last();
    if ($err && in_array($err['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)) {
        error_log('[get_config.php] fatal: ' . $err['message']);
        respond(array('success' => false));
    }
});

require __DIR__ . '/config.php';
require __DIR__ . '/supabase.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    respond(array('success' => false));
}

$rows = supabase_rest('GET', 'app_config?id=eq.1&select=config');

if (!is_array($rows) || !isset($rows[0]['config']) || !is_array($rows[0]['config'])) {
    respond(array('success' => false));
}

respond(array('success' => true, 'config' => $rows[0]['config']));
