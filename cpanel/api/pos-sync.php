<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(405, ['error' => 'Method not allowed']);
}

$configPath = __DIR__ . '/config.php';
if (!is_file($configPath)) {
    respond(503, ['error' => 'Database cPanel belum dikonfigurasi']);
}
$config = require $configPath;

try {
    $pdo = new PDO($config['dsn'], $config['user'], $config['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
} catch (Throwable $error) {
    error_log('[cl-pos] database connection failed: ' . $error->getMessage());
    respond(503, ['error' => 'Database cPanel tidak dapat dihubungi']);
}

$body = json_decode(file_get_contents('php://input') ?: '{}', true);
if (!is_array($body)) respond(400, ['error' => 'JSON tidak valid']);

$username = strtolower(trim((string)($body['username'] ?? '')));
$pin = (string)($body['pin'] ?? '');
if (!preg_match('/^[a-z0-9._-]{2,40}$/', $username) || !preg_match('/^\d{4,12}$/', $pin)) {
    respond(401, ['error' => 'Login cloud tidak valid']);
}

$staff = authenticate($pdo, $config, $username, $pin);
if (!$staff) respond(401, ['error' => 'Username atau PIN cloud salah']);

try {
    $historyFrom = validDate($body['historyFrom'] ?? null);
    $historyTo = validDate($body['historyTo'] ?? null);
    if ($historyFrom || $historyTo) {
        if (!$historyFrom || !$historyTo || $historyFrom > $historyTo) respond(400, ['error' => 'Periode transaksi tidak valid']);
        $sales = selectPayloads($pdo, 'SELECT payload FROM sales WHERE business_date BETWEEN ? AND ? ORDER BY created_at DESC', [$historyFrom, $historyTo]);
        if ($staff['role'] !== 'owner') $sales = hideSaleCosts($sales);
        respond(200, ['role' => $staff['role'], 'sales' => $sales, 'sales_total' => count($sales), 'history_from' => $historyFrom, 'history_to' => $historyTo]);
    }

    $summaryFrom = validDate($body['summaryFrom'] ?? null);
    $summaryTo = validDate($body['summaryTo'] ?? null);
    if ($summaryFrom || $summaryTo) {
        if (!$summaryFrom || !$summaryTo || $summaryFrom > $summaryTo) respond(400, ['error' => 'Periode ringkasan tidak valid']);
        respond(200, salesSummary($pdo, $summaryFrom, $summaryTo, $staff['role']));
    }

    $popularLimit = min(100, max(0, (int)($body['popularLimit'] ?? 0)));
    if ($popularLimit > 0) respond(200, ['role' => $staff['role'], 'products' => popularProducts($pdo, $popularLimit)]);

    $pdo->beginTransaction();
    writeBatch($pdo, $body, $staff);
    $pdo->commit();

    $since = validCursor($body['pullSince'] ?? null);
    $result = pullDelta($pdo, $since, $staff['role']);
    $result['role'] = $staff['role'];
    $result['sales_total'] = count($result['sales']);
    $result['rejected_inventory_movements'] = [];
    $result['sync_cursor'] = gmdate('c');
    respond(200, $result);
} catch (Throwable $error) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log('[cl-pos] sync failed: ' . $error->getMessage());
    respond(500, ['error' => 'Sinkronisasi database cPanel gagal']);
}

function respond(int $status, array $body): never {
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function authenticate(PDO $pdo, array $config, string $username, string $pin): ?array {
    $statement = $pdo->prepare('SELECT username, display_name, role, pin_hash FROM pos_staff WHERE username = ? AND active = 1');
    $statement->execute([$username]);
    $staff = $statement->fetch();
    if (!$staff) return null;
    $storedHash = (string)$staff['pin_hash'];
    if (password_verify($pin, $storedHash)) return $staff;
    if (strlen($storedHash) !== 64 || empty($config['pin_pepper'])) return null;
    $legacyCandidate = hash('sha256', (string)$config['pin_pepper'] . $pin);
    return hash_equals($storedHash, $legacyCandidate) ? $staff : null;
}

function validDate(mixed $value): string {
    $date = trim((string)$value);
    return preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) ? $date : '';
}

function validCursor(mixed $value): string {
    $cursor = trim((string)$value);
    return $cursor !== '' && strtotime($cursor) !== false ? mysqlDate($cursor) : '';
}

function mysqlDate(mixed $value, ?string $fallback = null): string {
    $timestamp = strtotime((string)$value);
    if ($timestamp === false) $timestamp = strtotime($fallback ?? 'now');
    return gmdate('Y-m-d H:i:s.u', $timestamp);
}

function decodePayload(string $payload): array {
    $decoded = json_decode($payload, true);
    return is_array($decoded) ? $decoded : [];
}

function selectPayloads(PDO $pdo, string $sql, array $params = []): array {
    $statement = $pdo->prepare($sql);
    $statement->execute($params);
    return array_map(fn(array $row) => decodePayload($row['payload']), $statement->fetchAll());
}

function hideSaleCosts(array $sales): array {
    foreach ($sales as &$sale) $sale['cost_total'] = null;
    return $sales;
}

function salesSummary(PDO $pdo, string $from, string $to, string $role): array {
    $sql = "SELECT DATE_FORMAT(business_date, '%Y-%m') month_key, YEAR(business_date) year_key,
                   COUNT(*) sales_count, COALESCE(SUM(total), 0) revenue,
                   COALESCE(SUM(cost_total), 0) cost
            FROM sales WHERE status = 'completed' AND business_date BETWEEN ? AND ?
            GROUP BY month_key, year_key ORDER BY month_key";
    $statement = $pdo->prepare($sql);
    $statement->execute([$from, $to]);
    $monthly = [];
    $yearly = [];
    foreach ($statement->fetchAll() as $row) {
        $profit = (int)$row['revenue'] - (int)$row['cost'];
        $entry = ['sales_count' => (int)$row['sales_count'], 'revenue' => (int)$row['revenue']];
        if ($role === 'owner') $entry += ['cost' => (int)$row['cost'], 'profit' => $profit];
        $monthly[$row['month_key']] = $entry;
        $year = (string)$row['year_key'];
        if (!isset($yearly[$year])) $yearly[$year] = ['sales_count' => 0, 'revenue' => 0, 'cost' => 0, 'profit' => 0];
        $yearly[$year]['sales_count'] += (int)$row['sales_count'];
        $yearly[$year]['revenue'] += (int)$row['revenue'];
        $yearly[$year]['cost'] += (int)$row['cost'];
        $yearly[$year]['profit'] += $profit;
    }
    if ($role !== 'owner') foreach ($yearly as &$entry) { unset($entry['cost'], $entry['profit']); }
    return ['role' => $role, 'monthly' => $monthly, 'yearly' => $yearly];
}

function popularProducts(PDO $pdo, int $limit): array {
    $sales = selectPayloads($pdo, "SELECT payload FROM sales WHERE status = 'completed' AND business_date >= DATE_SUB(CURDATE(), INTERVAL 180 DAY)");
    $stats = [];
    foreach ($sales as $sale) {
        $seen = [];
        foreach (($sale['items'] ?? []) as $item) {
            $key = trim((string)($item['groupKey'] ?? $item['baseName'] ?? $item['name'] ?? ''));
            if ($key === '') continue;
            if (!isset($stats[$key])) $stats[$key] = ['key' => $key, 'orders' => 0, 'qty' => 0];
            if (!isset($seen[$key])) {
                $stats[$key]['orders']++;
                $seen[$key] = true;
            }
            $stats[$key]['qty'] += (float)($item['qty'] ?? $item['quantity'] ?? 0);
        }
    }
    usort($stats, fn($a, $b) => [$b['orders'], $b['qty'], $a['key']] <=> [$a['orders'], $a['qty'], $b['key']]);
    return array_slice(array_values($stats), 0, $limit);
}

function writeBatch(PDO $pdo, array $body, array $staff): void {
    foreach (array_slice(is_array($body['sales'] ?? null) ? $body['sales'] : [], 0, 250) as $sale) upsertSale($pdo, $sale, $staff);
    foreach (array_slice(is_array($body['expenses'] ?? null) ? $body['expenses'] : [], 0, 250) as $expense) upsertExpense($pdo, $expense, $staff);
    foreach (array_slice(is_array($body['inventoryProducts'] ?? null) ? $body['inventoryProducts'] : [], 0, 500) as $product) upsertProduct($pdo, $product);
    foreach (array_slice(is_array($body['movements'] ?? null) ? $body['movements'] : [], 0, 500) as $movement) upsertMovement($pdo, $movement, $staff);
    foreach (array_slice(is_array($body['inventoryRequests'] ?? null) ? $body['inventoryRequests'] : [], 0, 200) as $request) upsertRequest($pdo, $request);
    foreach (array_slice(is_array($body['receivings'] ?? null) ? $body['receivings'] : [], 0, 200) as $receiving) upsertReceiving($pdo, $receiving, $staff);
    foreach (array_slice(is_array($body['stockOpnames'] ?? null) ? $body['stockOpnames'] : [], 0, 100) as $stockOpname) upsertStockOpname($pdo, $stockOpname, $staff);
}

function upsertSale(PDO $pdo, array $sale, array $staff): void {
    if (($staff['role'] ?? '') !== 'owner' && ($sale['status'] ?? 'completed') !== 'completed') return;
    $id = (string)($sale['id'] ?? '');
    if ($id === '') return;
    $row = [
        'id' => $id,
        'receipt_number' => (string)($sale['receipt_number'] ?? $sale['receipt'] ?? $id),
        'cashier_name' => (string)($sale['cashier_name'] ?? $sale['cashier'] ?? $staff['display_name']),
        'items' => is_array($sale['items'] ?? null) ? $sale['items'] : [],
        'total' => (int)($sale['total'] ?? 0),
        'cost_total' => (int)($sale['cost_total'] ?? $sale['cost'] ?? 0),
        'payment_method' => (string)($sale['payment_method'] ?? $sale['paymentMethod'] ?? 'cash'),
        'payment_breakdown' => is_array($sale['payment_breakdown'] ?? null) ? $sale['payment_breakdown'] : (is_array($sale['paymentBreakdown'] ?? null) ? $sale['paymentBreakdown'] : []),
        'payment_edit_history' => is_array($sale['payment_edit_history'] ?? null) ? $sale['payment_edit_history'] : (is_array($sale['paymentEditHistory'] ?? null) ? $sale['paymentEditHistory'] : []),
        'cash_received' => (int)($sale['cash_received'] ?? $sale['cash'] ?? 0),
        'change_due' => (int)($sale['change_due'] ?? $sale['change'] ?? 0),
        'status' => (string)($sale['status'] ?? 'completed'),
        'correction_reason' => $sale['correction_reason'] ?? $sale['reason'] ?? null,
        'business_date' => validDate($sale['business_date'] ?? $sale['day'] ?? '') ?: gmdate('Y-m-d'),
        'created_at' => (string)($sale['created_at'] ?? $sale['createdAt'] ?? gmdate('c')),
        'updated_at' => (string)($sale['updated_at'] ?? $sale['updatedAt'] ?? $sale['editedAt'] ?? gmdate('c')),
    ];
    $sql = 'INSERT INTO sales (id, receipt_number, cashier_name, business_date, created_at, updated_at, status, total, cost_total, payment_method, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE receipt_number=VALUES(receipt_number), cashier_name=VALUES(cashier_name), business_date=VALUES(business_date), created_at=VALUES(created_at), updated_at=VALUES(updated_at), status=VALUES(status), total=VALUES(total), cost_total=VALUES(cost_total), payment_method=VALUES(payment_method), payload=VALUES(payload)';
    $pdo->prepare($sql)->execute([$id, $row['receipt_number'], $row['cashier_name'], $row['business_date'], mysqlDate($row['created_at']), mysqlDate($row['updated_at'], $row['created_at']), $row['status'], $row['total'], $row['cost_total'], $row['payment_method'], json_encode($row, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)]);
    if ($row['status'] === 'deleted') $pdo->prepare('INSERT INTO sale_deletions (sale_id, deleted_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE deleted_at=VALUES(deleted_at)')->execute([$id, mysqlDate($row['updated_at'])]);
}

function upsertExpense(PDO $pdo, array $expense, array $staff): void {
    $id = (string)($expense['id'] ?? ''); if ($id === '') return;
    $row = ['id'=>$id, 'amount'=>(int)($expense['amount']??0), 'recipient'=>(string)($expense['recipient']??''), 'purpose'=>(string)($expense['purpose']??''), 'note'=>(string)($expense['note']??''), 'status'=>(string)($expense['status']??'active'), 'expense_type'=>(string)($expense['expense_type']??$expense['type']??'cash'), 'pocket'=>(string)($expense['pocket']??'store'), 'product_local_id'=>$expense['product_local_id']??$expense['productId']??null, 'product_name'=>(string)($expense['product_name']??$expense['productName']??''), 'quantity'=>$expense['quantity']??null, 'unit_value'=>(int)($expense['unit_value']??$expense['unitValue']??0), 'created_by_name'=>(string)($expense['created_by_name']??$expense['createdBy']??$staff['display_name']), 'business_date'=>validDate($expense['business_date']??$expense['day']??'')?:gmdate('Y-m-d'), 'created_at'=>(string)($expense['created_at']??$expense['createdAt']??gmdate('c')), 'updated_at'=>(string)($expense['updated_at']??$expense['updatedAt']??gmdate('c'))];
    $sql='INSERT INTO expenses (id,business_date,created_at,updated_at,status,amount,payload) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE business_date=VALUES(business_date),created_at=VALUES(created_at),updated_at=VALUES(updated_at),status=VALUES(status),amount=VALUES(amount),payload=VALUES(payload)';
    $pdo->prepare($sql)->execute([$id,$row['business_date'],mysqlDate($row['created_at']),mysqlDate($row['updated_at']),$row['status'],$row['amount'],json_encode($row,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES)]);
}

function upsertProduct(PDO $pdo, array $product): void {
    $localId=(int)($product['local_id']??$product['localId']??$product['productId']??$product['id']??0); if(!$localId)return;
    $row=['id'=>$product['id']??null,'local_id'=>$localId,'sku'=>(string)($product['sku']??('CL-'.$localId)),'name'=>(string)($product['name']??''),'stock'=>(int)($product['stock']??0),'active'=>(bool)($product['active']??true),'barcode'=>$product['barcode']??null,'base_name'=>$product['base_name']??$product['baseName']??$product['name']??'','image_url'=>$product['image_url']??$product['image']??null,'cost_price'=>(int)($product['cost_price']??$product['cost']??0),'sell_price'=>(int)($product['sell_price']??$product['sell']??0),'track_stock'=>(bool)($product['track_stock']??$product['trackStock']??false),'pricing_rule'=>$product['pricing_rule']??['tiers'=>$product['tiers']??[]],'updated_at'=>(string)($product['updated_at']??$product['updatedAt']??gmdate('c'))];
    $sql='INSERT INTO products (local_id,sku,stock,track_stock,updated_at,payload) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE sku=VALUES(sku),stock=VALUES(stock),track_stock=VALUES(track_stock),updated_at=VALUES(updated_at),payload=VALUES(payload)';
    $pdo->prepare($sql)->execute([$localId,$row['sku'],$row['stock'],$row['track_stock']?1:0,mysqlDate($row['updated_at']),json_encode($row,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES)]);
}

function upsertMovement(PDO $pdo, array $movement, array $staff): void {
    $id=(string)($movement['id']??''); if($id==='')return;
    $row=['id'=>$id,'movement_type'=>(string)($movement['movement_type']??$movement['type']??'adjustment'),'reference_id'=>$movement['reference_id']??$movement['referenceId']??null,'changes'=>is_array($movement['changes']??null)?$movement['changes']:[],'note'=>(string)($movement['note']??''),'status'=>(string)($movement['status']??'active'),'actor_name'=>(string)($movement['actor_name']??$movement['createdBy']??$staff['display_name']),'created_at'=>(string)($movement['created_at']??$movement['createdAt']??gmdate('c')),'updated_at'=>(string)($movement['updated_at']??$movement['updatedAt']??gmdate('c'))];
    $sql='INSERT INTO inventory_movements (id,created_at,updated_at,status,payload) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE created_at=VALUES(created_at),updated_at=VALUES(updated_at),status=VALUES(status),payload=VALUES(payload)';
    $pdo->prepare($sql)->execute([$id,mysqlDate($row['created_at']),mysqlDate($row['updated_at']),$row['status'],json_encode($row,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES)]);
}

function upsertRequest(PDO $pdo, array $request): void {
    $id=(string)($request['id']??''); if($id==='')return;
    $row=['id'=>$id,'movement_id'=>$request['movement_id']??$request['movementId']??'','request_type'=>$request['request_type']??$request['requestType']??'edit','proposed_changes'=>$request['proposed_changes']??$request['proposedChanges']??[],'proposed_note'=>$request['proposed_note']??$request['proposedNote']??'','status'=>$request['status']??'pending','requested_by'=>$request['requested_by']??$request['requestedBy']??'','requested_at'=>$request['requested_at']??$request['requestedAt']??gmdate('c'),'reviewed_by'=>$request['reviewed_by']??$request['reviewedBy']??null,'reviewed_at'=>$request['reviewed_at']??$request['reviewedAt']??null,'review_note'=>$request['review_note']??$request['reviewNote']??null,'updated_at'=>$request['updated_at']??$request['updatedAt']??gmdate('c')];
    $sql='INSERT INTO inventory_change_requests (id,requested_at,updated_at,status,payload) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE requested_at=VALUES(requested_at),updated_at=VALUES(updated_at),status=VALUES(status),payload=VALUES(payload)';
    $pdo->prepare($sql)->execute([$id,mysqlDate($row['requested_at']),mysqlDate($row['updated_at']),$row['status'],json_encode($row,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES)]);
}

function upsertReceiving(PDO $pdo, array $receiving, array $staff): void {
    $id=(string)($receiving['id']??''); if($id==='')return;
    $status=(string)($receiving['status']??'waiting_check'); if(($staff['role']??'')!=='owner'&&$status!=='owner_review')return;
    $row=['id'=>$id,'receiving_number'=>(string)($receiving['receiving_number']??$receiving['number']??$id),'supplier'=>(string)($receiving['supplier']??''),'reference_number'=>$receiving['reference_number']??$receiving['reference']??null,'expected_date'=>$receiving['expected_date']??$receiving['expectedDate']??null,'owner_note'=>$receiving['owner_note']??$receiving['ownerNote']??null,'cashier_note'=>$receiving['cashier_note']??$receiving['cashierNote']??null,'review_note'=>$receiving['review_note']??$receiving['reviewNote']??null,'items'=>is_array($receiving['items']??null)?$receiving['items']:[],'status'=>$status,'created_by_name'=>$receiving['created_by_name']??$receiving['createdBy']??$staff['display_name'],'checked_by_name'=>$receiving['checked_by_name']??$receiving['checkedBy']??null,'approved_by_name'=>$receiving['approved_by_name']??$receiving['approvedBy']??null,'created_at'=>$receiving['created_at']??$receiving['createdAt']??gmdate('c'),'checked_at'=>$receiving['checked_at']??$receiving['checkedAt']??null,'approved_at'=>$receiving['approved_at']??$receiving['approvedAt']??null,'stock_applied_at'=>$receiving['stock_applied_at']??$receiving['stockAppliedAt']??null,'deleted_at'=>$receiving['deleted_at']??$receiving['deletedAt']??($status==='deleted'?gmdate('c'):null),'updated_at'=>$receiving['updated_at']??$receiving['updatedAt']??gmdate('c')];
    $sql='INSERT INTO receivings (id,receiving_number,created_at,updated_at,deleted_at,status,payload) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE receiving_number=VALUES(receiving_number),created_at=VALUES(created_at),updated_at=VALUES(updated_at),deleted_at=VALUES(deleted_at),status=VALUES(status),payload=VALUES(payload)';
    $pdo->prepare($sql)->execute([$id,$row['receiving_number'],mysqlDate($row['created_at']),mysqlDate($row['updated_at']),$row['deleted_at']?mysqlDate($row['deleted_at']):null,$row['status'],json_encode($row,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES)]);
}

function upsertStockOpname(PDO $pdo, array $stockOpname, array $staff): void {
    $id=(string)($stockOpname['id']??''); if($id==='')return;
    $requestedStatus=(string)($stockOpname['status']??'owner_review');
    if(($staff['role']??'')!=='owner' && $requestedStatus!=='owner_review')return;
    $status=in_array($requestedStatus,['owner_review','approved','returned'],true)?$requestedStatus:'owner_review';
    if(($staff['role']??'')!=='owner')$status='owner_review';
    $items=is_array($stockOpname['items']??null)?$stockOpname['items']:[];
    $row=['id'=>$id,'opname_date'=>validDate($stockOpname['opnameDate']??'')?:gmdate('Y-m-d'),'status'=>$status,'items'=>$items,'total_plus_qty'=>(int)($stockOpname['totalPlusQty']??0),'total_minus_qty'=>(int)($stockOpname['totalMinusQty']??0),'total_plus_value'=>(int)($stockOpname['totalPlusValue']??0),'total_minus_value'=>(int)($stockOpname['totalMinusValue']??0),'note'=>(string)($stockOpname['note']??''),'created_by_name'=>(string)($stockOpname['createdBy']??$staff['display_name']),'reviewed_by_name'=>(string)($stockOpname['reviewedBy']??''),'reviewed_at'=>$stockOpname['reviewedAt']??null,'approved_by_name'=>(string)($stockOpname['approvedBy']??''),'approved_at'=>$stockOpname['approvedAt']??null,'created_at'=>$stockOpname['createdAt']??gmdate('c'),'updated_at'=>$stockOpname['updatedAt']??gmdate('c')];
    $sql='INSERT INTO stock_opnames (id,opname_date,created_at,updated_at,status,payload) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE opname_date=VALUES(opname_date),created_at=VALUES(created_at),updated_at=VALUES(updated_at),status=VALUES(status),payload=VALUES(payload)';
    $pdo->prepare($sql)->execute([$id,$row['opname_date'],mysqlDate($row['created_at']),mysqlDate($row['updated_at']),$row['status'],json_encode($row,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES)]);
}

function pullDelta(PDO $pdo, string $since, string $role): array {
    $salesSql=$since?'SELECT payload FROM sales WHERE updated_at > ? ORDER BY created_at DESC LIMIT 2000':"SELECT payload FROM sales WHERE business_date >= DATE_SUB(CURDATE(), INTERVAL 45 DAY) ORDER BY created_at DESC LIMIT 2000";
    $sales=selectPayloads($pdo,$salesSql,$since?[$since]:[]); if($role!=='owner')$sales=hideSaleCosts($sales);
    $expenses=selectPayloadsOptional($pdo,$since?'SELECT payload FROM expenses WHERE updated_at > ? ORDER BY created_at DESC':'SELECT payload FROM expenses WHERE business_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY) ORDER BY created_at DESC',$since?[$since]:[]);
    $products=selectPayloadsOptional($pdo,$since?'SELECT payload FROM products WHERE track_stock=1 AND updated_at > ? ORDER BY local_id':'SELECT payload FROM products WHERE track_stock=1 ORDER BY local_id',$since?[$since]:[]);
    $movements=selectPayloadsOptional($pdo,$since?'SELECT payload FROM inventory_movements WHERE updated_at > ? ORDER BY created_at DESC LIMIT 500':'SELECT payload FROM inventory_movements ORDER BY created_at DESC LIMIT 500',$since?[$since]:[]);
    $requests=selectPayloadsOptional($pdo,$since?'SELECT payload FROM inventory_change_requests WHERE updated_at > ? ORDER BY requested_at DESC':"SELECT payload FROM inventory_change_requests WHERE status='pending' OR updated_at > DATE_SUB(NOW(), INTERVAL 90 DAY) ORDER BY requested_at DESC",$since?[$since]:[]);
    $receivings=selectPayloadsOptional($pdo,$since?'SELECT payload FROM receivings WHERE updated_at > ? OR deleted_at > ? ORDER BY created_at DESC':"SELECT payload FROM receivings WHERE deleted_at IS NULL OR updated_at > DATE_SUB(NOW(), INTERVAL 180 DAY) ORDER BY created_at DESC",$since?[$since,$since]:[]);
    $stockOpnames=selectPayloadsOptional($pdo,$since?'SELECT payload FROM stock_opnames WHERE updated_at > ? ORDER BY opname_date DESC':"SELECT payload FROM stock_opnames WHERE updated_at > DATE_SUB(NOW(), INTERVAL 730 DAY) ORDER BY opname_date DESC",$since?[$since]:[]);
    $deletionsStatement=$pdo->prepare($since?'SELECT sale_id FROM sale_deletions WHERE deleted_at > ?':'SELECT sale_id FROM sale_deletions'); $deletionsStatement->execute($since?[$since]:[]);
    $audit=$role==='owner'?selectPayloadsOptional($pdo,$since?'SELECT payload FROM audit_logs WHERE created_at > ? ORDER BY created_at DESC LIMIT 500':'SELECT payload FROM audit_logs ORDER BY created_at DESC LIMIT 500',$since?[$since]:[]):[];
    return ['sales'=>$sales,'deleted_ids'=>array_column($deletionsStatement->fetchAll(),'sale_id'),'expenses'=>$expenses,'inventory_products'=>$products,'inventory_movements'=>$movements,'inventory_change_requests'=>$requests,'receivings'=>$receivings,'stock_opnames'=>$stockOpnames,'audit_logs'=>$audit];
}

function selectPayloadsOptional(PDO $pdo, string $sql, array $params = []): array {
    try {
        return selectPayloads($pdo, $sql, $params);
    } catch (Throwable $error) {
        error_log('[cl-pos] optional sync query skipped: ' . $error->getMessage());
        return [];
    }
}
