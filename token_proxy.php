<?php
/**
 * FiqStudio — Token Monitor Secure PHP Proxy
 * Upload this file to your htdocs/ folder alongside index.html.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$HUB_URL    = 'https://token-monitor-hub.wafiq-ggle.workers.dev';
$HUB_SECRET = '338800';

$hubUrl = rtrim(trim($HUB_URL), '/');
$secret = trim($HUB_SECRET);

if ($hubUrl === '' || $secret === '') {
    http_response_code(503);
    echo json_encode([
        'ok'      => false,
        'error'   => 'not_configured',
        'message' => 'Edit token_proxy.php on your server and set $HUB_URL and $HUB_SECRET.'
    ]);
    exit;
}

$action = isset($_GET['action']) ? $_GET['action'] : 'stats';
$endpoint = ($action === 'health') ? '/api/health' : '/api/stats';
$targetUrl = $hubUrl . $endpoint;

$headers = [
    'Accept: application/json',
    'User-Agent: FiqStudio-TokenProxy/1.0'
];

if ($endpoint !== '/api/health') {
    $headers[] = 'Authorization: Bearer ' . $secret;
}

$body = false;
$httpCode = 0;
$errMsg = '';

if (function_exists('curl_init')) {
    $ch = curl_init($targetUrl);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $body = curl_exec($ch);
    $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $errMsg = curl_error($ch);
    curl_close($ch);
} else {
    $ctx = stream_context_create([
        'http' => [
            'method'        => 'GET',
            'header'        => implode("\r\n", $headers),
            'timeout'       => 15,
            'ignore_errors' => true
        ]
    ]);
    $body = @file_get_contents($targetUrl, false, $ctx);
    if (isset($http_response_header[0]) && preg_match('/\s(\d{3})\s/', $http_response_header[0], $m)) {
        $httpCode = (int) $m[1];
    }
    if ($body === false) {
        $errMsg = 'HTTP request failed (cURL unavailable and allow_url_fopen failed).';
    }
}

if ($body === false || $httpCode === 0) {
    http_response_code(502);
    echo json_encode([
        'ok'      => false,
        'error'   => 'upstream_unreachable',
        'message' => $errMsg ?: 'Could not reach Token Monitor Hub.'
    ]);
    exit;
}

http_response_code($httpCode);
echo $body;