<?php
/**
 * order_webhook.php — FiqStudio Universal Order Logger & Client Issue Report Receiver
 * Works 100% on InfinityFree free hosting (uses standard GET redirect for cross-domain reports & clicks).
 *
 * Upload into fiqstudio.page.gd/htdocs/order_webhook.php
 */

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$ordersFile  = __DIR__ . '/orders_log.json';
$reportsFile = __DIR__ . '/reports_log.json';

function readJsonList(string $path): array {
    if (!file_exists($path)) return [];
    $arr = json_decode(file_get_contents($path), true);
    return is_array($arr) ? $arr : [];
}
function writeJsonList(string $path, array $list): void {
    file_put_contents($path, json_encode(array_values($list), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
}

$data = [];
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $decoded = json_decode(file_get_contents('php://input'), true);
    if (is_array($decoded)) $data = $decoded;
}
if (empty($data)) {
    $data = $_GET;
}

$action = trim((string)($data['action'] ?? ''));

// =====================================================================
// A. CLIENT ISSUE / TROUBLESHOOTING REPORTS (saved to reports_log.json)
// =====================================================================
if ($action === 'report') {
    $siteId    = trim((string)($data['site_id'] ?? 'site_dms'));
    $siteName  = trim((string)($data['site_name'] ?? 'Client Website'));
    $issueType = trim((string)($data['issue_type'] ?? 'General Issue'));
    $reporter  = trim((string)($data['reporter'] ?? 'Client / Visitor'));
    $message   = trim((string)($data['message'] ?? ''));
    $pageUrl   = trim((string)($data['page_url'] ?? ''));
    $returnUrl = trim((string)($data['return_url'] ?? ''));

    if ($message !== '') {
        $reports = readJsonList($reportsFile);
        $rep = [
            'id'        => 'rep_' . time() . '_' . random_int(100, 999),
            'ref'       => 'FIX-' . strtoupper(substr(uniqid(), -4)),
            'siteId'    => $siteId,
            'siteName'  => $siteName,
            'issueType' => $issueType,
            'reporter'  => $reporter !== '' ? $reporter : 'Client / Visitor',
            'message'   => $message,
            'pageUrl'   => $pageUrl,
            'status'    => 'Open',
            'timestamp' => date('Y-m-d H:i')
        ];
        array_unshift($reports, $rep);
        writeJsonList($reportsFile, $reports);
    }

    // Redirect cleanly back to the client website with ?reported=1 confirmation
    if ($returnUrl !== '' && preg_match('#^https?://#i', $returnUrl)) {
        $sep = strpos($returnUrl, '?') === false ? '?' : '&';
        $dest = $returnUrl . $sep . 'reported=1';
        header('Location: ' . $dest, true, 302);
        echo '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=' . htmlspecialchars($dest, ENT_QUOTES, 'UTF-8') . '"></head><body>Report sent to FiqStudio...</body></html>';
        exit;
    }

    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['status' => 'reported']);
    exit;
}

if ($action === 'resolve_report') {
    header('Content-Type: application/json; charset=utf-8');
    $repId = trim((string)($data['id'] ?? ''));
    $newStatus = trim((string)($data['status'] ?? 'Resolved'));
    $reports = readJsonList($reportsFile);
    foreach ($reports as &$r) {
        if (($r['id'] ?? '') === $repId) {
            $r['status'] = $newStatus;
            break;
        }
    }
    unset($r);
    writeJsonList($reportsFile, $reports);
    echo json_encode(['status' => 'updated', 'id' => $repId]);
    exit;
}

if ($action === 'delete_report') {
    header('Content-Type: application/json; charset=utf-8');
    $repId = trim((string)($data['id'] ?? ''));
    $reports = array_filter(readJsonList($reportsFile), function ($r) use ($repId) {
        return ($r['id'] ?? '') !== $repId;
    });
    writeJsonList($reportsFile, $reports);
    echo json_encode(['status' => 'deleted', 'id' => $repId]);
    exit;
}

// =====================================================================
// B. ADMIN ORDER ACTIONS (delete / update_stage / clear_all)
// =====================================================================
if ($action === 'delete') {
    header('Content-Type: application/json; charset=utf-8');
    $delId = trim((string)($data['id'] ?? ''));
    $logs = array_filter(readJsonList($ordersFile), function ($item) use ($delId) {
        return ($item['id'] ?? '') !== $delId;
    });
    writeJsonList($ordersFile, $logs);
    echo json_encode(['status' => 'deleted', 'id' => $delId]);
    exit;
}

if ($action === 'update_stage') {
    header('Content-Type: application/json; charset=utf-8');
    $updId = trim((string)($data['id'] ?? ''));
    $newStage = trim((string)($data['stage'] ?? ''));
    $logs = readJsonList($ordersFile);
    foreach ($logs as &$item) {
        if (($item['id'] ?? '') === $updId) {
            $item['stage'] = $newStage;
            break;
        }
    }
    unset($item);
    writeJsonList($ordersFile, $logs);
    echo json_encode(['status' => 'updated', 'id' => $updId, 'stage' => $newStage]);
    exit;
}

if ($action === 'clear_all') {
    header('Content-Type: application/json; charset=utf-8');
    writeJsonList($ordersFile, []);
    echo json_encode(['status' => 'cleared']);
    exit;
}

// =====================================================================
// C. LOG NEW "ORDER NOW" CLICK + OPTIONAL WHATSAPP REDIRECT
// =====================================================================
$siteId   = trim((string)($data['site_id'] ?? ''));
$siteName = trim((string)($data['site_name'] ?? 'Client Website'));
$pkg      = trim((string)($data['package'] ?? 'Custom Order'));
$pageUrl  = trim((string)($data['page_url'] ?? ''));
$toUrl    = trim((string)($data['to'] ?? ''));

if ($siteId === '') {
    header('Content-Type: application/json; charset=utf-8');
    http_response_code(400);
    echo json_encode(['status' => 'ignored', 'reason' => 'missing site_id']);
    exit;
}

$logs = readJsonList($ordersFile);
$entry = [
    'id'        => 'ord_' . time() . '_' . random_int(100, 999),
    'ref'       => 'ORD-' . strtoupper(substr(uniqid(), -5)),
    'siteId'    => $siteId,
    'siteName'  => $siteName !== '' ? $siteName : 'Client Website',
    'pkg'       => $pkg !== '' ? $pkg : 'Custom Order',
    'customer'  => 'Website Visitor',
    'phone'     => '',
    'pageUrl'   => $pageUrl,
    'stage'     => 'Clicked Order Now',
    'notes'     => $pageUrl !== '' ? ('Clicked Order Now on ' . $pageUrl) : 'Clicked Order Now',
    'timestamp' => date('Y-m-d H:i')
];
array_unshift($logs, $entry);
writeJsonList($ordersFile, $logs);

if (preg_match('#^https://(wa\.me|api\.whatsapp\.com)/#i', $toUrl) === 1) {
    header('Location: ' . $toUrl, true, 302);
    echo '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=' . htmlspecialchars($toUrl, ENT_QUOTES, 'UTF-8') . '"></head><body>Redirecting to WhatsApp...</body></html>';
    exit;
}

header('Content-Type: application/json; charset=utf-8');
echo json_encode(['status' => 'logged', 'ref' => $entry['ref']]);