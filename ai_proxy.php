<?php
/**
 * FiqStudio Personal AI Agent Proxy (InfinityFree Ready)
 * Upload as exact lowercase `ai_proxy.php` inside `fiqstudio.page.gd/htdocs/`.
 * Powers multi-turn "ask anything" Fiq AI agent via Google Gemini API.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

// ==================== CONFIGURATION ====================
$GEMINI_API_KEY = 'AQ.Ab8RN6Jk4W_nPXaHC_VeBa2DBGSgLfXzAeWaM8Zc1iwqDlrjuw';
$GEMINI_MODELS  = ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-2.0-flash'];
// =======================================================

function call_gemini_endpoint($url, $apiKey, $payload) {
    if (!function_exists('curl_init')) {
        return ['body' => false, 'code' => 0, 'err' => 'PHP cURL is disabled on this server'];
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            'x-goog-api-key: ' . $apiKey,
        ],
        CURLOPT_POSTFIELDS => json_encode($payload),
        CURLOPT_TIMEOUT => 30,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    curl_close($ch);

    if ($body === false && stripos($err, 'SSL') !== false) {
        $ch2 = curl_init($url);
        curl_setopt_array($ch2, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'x-goog-api-key: ' . $apiKey,
            ],
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_TIMEOUT => 30,
            CURLOPT_SSL_VERIFYPEER => false,
        ]);
        $body = curl_exec($ch2);
        $code = curl_getinfo($ch2, CURLINFO_HTTP_CODE);
        $err  = curl_error($ch2);
        curl_close($ch2);
    }

    return ['body' => $body, 'code' => $code, 'err' => $err];
}

// GET -> health check
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    echo json_encode([
        'status' => 'ok',
        'configured' => ($GEMINI_API_KEY !== '' && $GEMINI_API_KEY !== 'PASTE_YOUR_GOOGLE_AI_STUDIO_KEY_HERE'),
        'model' => $GEMINI_MODELS[0],
        'mode' => 'agent',
    ]);
    exit;
}

// POST JSON body
$input = json_decode(file_get_contents('php://input') ?: '', true);
if (!is_array($input)) {
    echo json_encode(['status' => 'error', 'error' => 'Invalid JSON payload']);
    exit;
}

$message = trim((string)($input['message'] ?? ''));
$context = trim((string)($input['context'] ?? ''));
$history = is_array($input['history'] ?? null) ? $input['history'] : [];

if ($message === '') {
    echo json_encode(['status' => 'error', 'error' => 'Message is empty']);
    exit;
}

$systemText = "You are Fiq AI, a smart, friendly, capable personal AI agent built inside the user's FiqStudio Command OS. "
    . "The user can ask you ANYTHING — coding, web development, freelance client replies, study help, brainstorming, writing, planning, or managing FiqStudio. "
    . "Always reply naturally, concisely, and helpfully in the exact language the user writes (Malay, Manglish, or English). "
    . "When the user asks you to perform a FiqStudio dashboard action, you may append one or more action tags at the very end of your reply (the app will execute and hide them):\n"
    . "- [ACTION:SET_5H:<0-100>] to set Claude 5-Hour usage %\n"
    . "- [ACTION:SET_WEEKLY:<0-100>] to set Claude Weekly usage %\n"
    . "- [ACTION:THEME:dark] or [ACTION:THEME:light] to switch theme\n"
    . "- [ACTION:NAV:hub|websites|cctv|assistant] to open a tab\n"
    . "Only include an [ACTION:...] tag when the user clearly asks to change a setting or navigate.";

if ($context !== '') {
    $systemText .= "\n\nLive FiqStudio dashboard state:\n" . $context;
}

// Build multi-turn contents array (up to last 14 messages + current message)
$contents = [];
$recentHistory = array_slice($history, -14);
foreach ($recentHistory as $item) {
    $role = (($item['role'] ?? '') === 'user') ? 'user' : 'model';
    $txt  = trim((string)($item['text'] ?? ''));
    if ($txt !== '') {
        $contents[] = [
            'role' => $role,
            'parts' => [['text' => $txt]],
        ];
    }
}
$contents[] = [
    'role' => 'user',
    'parts' => [['text' => $message]],
];

$payload = [
    'system_instruction' => [
        'parts' => [['text' => $systemText]],
    ],
    'contents' => $contents,
    'generationConfig' => [
        'temperature' => 0.7,
        'maxOutputTokens' => 1024,
    ],
];

$lastError = 'Unknown Gemini API error';
$successData = null;
$usedModel = $GEMINI_MODELS[0];

foreach ($GEMINI_MODELS as $model) {
    $m = rawurlencode($model);
    $endpoints = [
        'https://generativelanguage.googleapis.com/v1beta/models/' . $m . ':generateContent',
        'https://aiplatform.googleapis.com/v1/publishers/google/models/' . $m . ':generateContent',
    ];
    foreach ($endpoints as $ep) {
        $res = call_gemini_endpoint($ep, $GEMINI_API_KEY, $payload);
        if ($res['body'] === false || $res['err']) {
            $lastError = 'cURL error: ' . $res['err'];
            continue;
        }
        $decoded = json_decode($res['body'], true);
        if ($res['code'] >= 200 && $res['code'] < 300 && is_array($decoded) && isset($decoded['candidates'])) {
            $successData = $decoded;
            $usedModel = $model;
            break 2;
        }
        $lastError = 'HTTP ' . $res['code'] . ': ' . ($decoded['error']['message'] ?? substr((string)$res['body'], 0, 180));
    }
}

if (!$successData) {
    echo json_encode(['status' => 'error', 'error' => $lastError]);
    exit;
}

$reply = $successData['candidates'][0]['content']['parts'][0]['text'] ?? 'No response returned.';

echo json_encode([
    'status' => 'ok',
    'model' => $usedModel,
    'reply' => $reply,
]);