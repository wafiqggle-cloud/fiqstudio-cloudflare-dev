<?php
/**
 * FiqStudio Settings & Drive Config Sync (InfinityFree htdocs/)
 * Stores and loads Hub layout, Websites, Drive IDs in fiqstudio_config.json.
 *
 * SECURITY CHANGES (same JSON response shape, so index.html needs no change):
 *  1. Secrets are NEVER written to fiqstudio_config.json and NEVER returned by GET.
 *     (apiKey, workerSecret, haToken, fiqAiSecret, shadowKey, and any string URL
 *     containing ?secret= / ?token= / ?key=). Secrets stay in the browser's localStorage.
 *  2. POST is only accepted from the FiqStudio origin (browser Origin/Referer check).
 *     NOTE: this stops other websites abusing it, but a determined person using a
 *     script can fake headers. A passphrase is planned as a later step.
 *  3. Worker URLs in the saved state must be https and point to an allowed host,
 *     so nobody can redirect the dashboard's secrets to their own server.
 */
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('X-Content-Type-Options: nosniff');

$configFile = __DIR__ . '/fiqstudio_config.json';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// ---- Settings you may edit ----
$allowedOrigin = 'https://fiqstudio.page.gd';
$allowedHostSuffixes = ['.wafiq-ggle.workers.dev'];   // your Cloudflare workers.dev account
$secretKeys = ['apiKey', 'workerSecret', 'haToken', 'fiqAiSecret', 'shadowKey'];
// --------------------------------

function respond($code, $payload) {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function strip_secrets($value, $secretKeys) {
    if (is_array($value)) {
        $out = [];
        foreach ($value as $k => $v) {
            if (is_string($k) && in_array($k, $secretKeys, true)) {
                $out[$k] = '';
                continue;
            }
            $out[$k] = strip_secrets($v, $secretKeys);
        }
        return $out;
    }
    if (is_string($value) && preg_match('/[?&](secret|token|key|apikey|api_key)=/i', $value)) {
        return '';
    }
    return $value;
}

function url_allowed($url, $originHost, $suffixes) {
    $url = trim((string)$url);
    if ($url === '') return true;
    $p = parse_url($url);
    if (!$p || ($p['scheme'] ?? '') !== 'https' || empty($p['host'])) return false;
    $host = strtolower($p['host']);
    if ($host === $originHost) return true;
    foreach ($suffixes as $s) {
        if (substr($host, -strlen($s)) === $s) return true;
    }
    return false;
}

if ($method === 'GET') {
    if (file_exists($configFile)) {
        $raw = @file_get_contents($configFile);
        $decoded = json_decode($raw ?: '', true);
        if (is_array($decoded)) {
            echo json_encode([
                'status' => 'ok',
                'exists' => true,
                'data' => strip_secrets($decoded, $secretKeys)
            ]);
            exit;
        }
    }
    echo json_encode(['status' => 'ok', 'exists' => false, 'data' => null]);
    exit;
}

if ($method === 'POST') {
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $referer = $_SERVER['HTTP_REFERER'] ?? '';
    $originOk = ($origin === $allowedOrigin)
        || ($origin === '' && strpos($referer, $allowedOrigin . '/') === 0);
    if (!$originOk) {
        respond(403, ['status' => 'error', 'error' => 'Origin not allowed']);
    }

    $rawBody = file_get_contents('php://input');
    if (!$rawBody || strlen($rawBody) > 250000) {
        respond(400, ['status' => 'error', 'error' => 'Invalid or oversized payload']);
    }

    $decoded = json_decode($rawBody, true);
    if (!is_array($decoded) || !isset($decoded['websites']) || !isset($decoded['cameras'])) {
        respond(400, ['status' => 'error', 'error' => 'Invalid FiqStudio state format']);
    }

    $originHost = strtolower((string)parse_url($allowedOrigin, PHP_URL_HOST));
    $s = (isset($decoded['settings']) && is_array($decoded['settings'])) ? $decoded['settings'] : [];
    $urlsToCheck = [
        $s['smartDevices']['workerUrl'] ?? '',
        $s['fiqAiUrl'] ?? '',
        $s['fiqAi']['workerUrl'] ?? '',
        $s['tokenMonitor']['publicUrl'] ?? ''
    ];
    foreach ($urlsToCheck as $u) {
        if (!url_allowed($u, $originHost, $allowedHostSuffixes)) {
            respond(400, ['status' => 'error', 'error' => 'A worker URL points to a host that is not allowed']);
        }
    }

    $clean = strip_secrets($decoded, $secretKeys);
    $clean['_savedAt'] = gmdate('Y-m-d\TH:i:s\Z');
    $ok = @file_put_contents($configFile, json_encode($clean, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);

    if ($ok === false) {
        respond(500, ['status' => 'error', 'error' => 'Could not write fiqstudio_config.json (check folder permissions)']);
    }

    echo json_encode(['status' => 'ok', 'savedAt' => $clean['_savedAt']]);
    exit;
}

respond(405, ['status' => 'error', 'error' => 'Method not allowed']);
