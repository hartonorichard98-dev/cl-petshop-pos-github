if (!window.__CL_POS_CLOUD_SYNC_LOADED__) {
  window.__CL_POS_CLOUD_SYNC_LOADED__ = true
const FINGERPRINTS_KEY = 'cl-petshop-cloud-fingerprints-v3'
const EXPENSE_FINGERPRINTS_KEY = 'cl-petshop-cloud-expense-fingerprints-v1'
const INVENTORY_FINGERPRINTS_KEY = 'cl-petshop-cloud-inventory-fingerprints-v1'
const INVENTORY_REQUEST_FINGERPRINTS_KEY = 'cl-petshop-cloud-inventory-request-fingerprints-v1'
const LAST_PULL_KEY_PREFIX = 'cl-petshop-cloud-last-pull-v1'
const POLL_MS = 30000
const REQUEST_TIMEOUT_MS = 12000
const SALES_BATCH_SIZE = 100
const EXPENSE_BATCH_SIZE = 100
const MOVEMENT_BATCH_SIZE = 200
const SYNC_ENDPOINT = window.location.protocol === 'file:'
  ? 'https://cl-petshop-pos.vercel.app/api/pos-sync'
  : '/api/pos-sync'

let credentials = null
let syncing = false
let rerunRequested = false
let timer = null

function fingerprint(sale) {
  return JSON.stringify({
    id: sale.id,
    receipt: sale.receipt,
    cashier: sale.cashier,
    items: sale.items,
    total: sale.total,
    cost: sale.cost,
    paymentMethod: sale.paymentMethod,
    paymentBreakdown: sale.paymentBreakdown,
    paymentEditHistory: sale.paymentEditHistory,
    cash: sale.cash,
    change: sale.change,
    status: sale.status,
    reason: sale.reason,
    day: sale.day,
    createdAt: sale.createdAt,
    updatedAt: sale.updatedAt,
    editedAt: sale.editedAt,
    editedBy: sale.editedBy,
    editReason: sale.editReason,
    deletedAt: sale.deletedAt,
    deletedBy: sale.deletedBy,
    deleteReason: sale.deleteReason,
    voidedAt: sale.voidedAt,
    voidedBy: sale.voidedBy,
  })
}

function fingerprints() {
  try { return JSON.parse(localStorage.getItem(FINGERPRINTS_KEY) || '{}') || {} } catch { return {} }
}

function saveFingerprints(value) {
  localStorage.setItem(FINGERPRINTS_KEY, JSON.stringify(value))
}

function expenseFingerprint(expense) {
  return JSON.stringify({
    id: expense.id,
    day: expense.day,
    amount: expense.amount,
    recipient: expense.recipient,
    purpose: expense.purpose,
    note: expense.note,
    status: expense.status,
    type: expense.type,
    pocket: expense.pocket,
    productId: expense.productId,
    productName: expense.productName,
    quantity: expense.quantity,
    unitValue: expense.unitValue,
    createdBy: expense.createdBy,
    createdAt: expense.createdAt,
    updatedAt: expense.updatedAt,
  })
}

function expenseFingerprints() {
  try { return JSON.parse(localStorage.getItem(EXPENSE_FINGERPRINTS_KEY) || '{}') || {} } catch { return {} }
}

function saveExpenseFingerprints(value) {
  localStorage.setItem(EXPENSE_FINGERPRINTS_KEY, JSON.stringify(value))
}

function inventoryFingerprint(operation) {
  return JSON.stringify({ id: operation.id, type: operation.type, referenceId: operation.referenceId, changes: operation.changes, note: operation.note, createdBy: operation.createdBy, createdAt: operation.createdAt })
}

function inventoryFingerprints() {
  try { return JSON.parse(localStorage.getItem(INVENTORY_FINGERPRINTS_KEY) || '{}') || {} } catch { return {} }
}

function saveInventoryFingerprints(value) {
  localStorage.setItem(INVENTORY_FINGERPRINTS_KEY, JSON.stringify(value))
}

function inventoryRequestFingerprint(request) {
  return JSON.stringify({ id: request.id, movementId: request.movementId, requestType: request.requestType, proposedChanges: request.proposedChanges, proposedNote: request.proposedNote, status: request.status, requestedBy: request.requestedBy, requestedAt: request.requestedAt, reviewNote: request.reviewNote })
}

function inventoryRequestFingerprints() {
  try { return JSON.parse(localStorage.getItem(INVENTORY_REQUEST_FINGERPRINTS_KEY) || '{}') || {} } catch { return {} }
}

function saveInventoryRequestFingerprints(value) {
  localStorage.setItem(INVENTORY_REQUEST_FINGERPRINTS_KEY, JSON.stringify(value))
}

function lastPullKey() {
  return `${LAST_PULL_KEY_PREFIX}:${credentials?.username || 'unknown'}`
}

function lastPullCursor() {
  const value = localStorage.getItem(lastPullKey()) || ''
  return Number.isFinite(Date.parse(value)) ? value : ''
}

function saveLastPullCursor(value) {
  if (Number.isFinite(Date.parse(value))) localStorage.setItem(lastPullKey(), value)
}

function setStatus(message, state = 'local') {
  window.CL_POS?.setCloudStatus(message, state)
}

function currentSales() {
  return window.CL_POS?.getSales?.() || []
}

function currentExpenses() {
  return window.CL_POS?.getExpenses?.() || []
}

function currentInventoryOperations() {
  return window.CL_POS?.getInventoryOperations?.() || []
}

function currentInventoryProducts() {
  return window.CL_POS?.getInventoryProducts?.() || []
}

function currentInventoryChangeRequests() {
  return window.CL_POS?.getInventoryChangeRequests?.() || []
}

function inventoryBaselines(operations) {
  const products = new Map(currentInventoryProducts().map(product => [Number(product.id), product]))
  const pendingDeltas = new Map()
  const explicitBaselines = new Map()
  operations.forEach(operation => {
    ;(operation.changes || []).forEach(change => {
      const productId = Number(change.productId)
      if (!productId) return
      pendingDeltas.set(productId, (pendingDeltas.get(productId) || 0) + (Number(change.quantityDelta) || 0))
      if (!explicitBaselines.has(productId) && Number.isFinite(Number(change.stockBefore))) {
        explicitBaselines.set(productId, Number(change.stockBefore))
      }
    })
  })
  return [...pendingDeltas.keys()].map(productId => {
    const product = products.get(productId)
    const calculatedStock = (Number(product?.stock) || 0) - pendingDeltas.get(productId)
    return {
      productId,
      stock: Math.max(0, Math.round(explicitBaselines.get(productId) ?? calculatedStock)),
      trackStock: Boolean(product?.trackStock),
    }
  })
}

function wholeMoney(value) {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.round(amount) : 0
}

function cloudPayloadSale(sale) {
  return {
    ...sale,
    total: wholeMoney(sale.total),
    cost: wholeMoney(sale.cost),
    cash: wholeMoney(sale.cash),
    change: wholeMoney(sale.change),
    paymentBreakdown: Array.isArray(sale.paymentBreakdown)
      ? sale.paymentBreakdown.map(part => ({ method: part.method, amount: wholeMoney(part.amount) }))
      : [],
    paymentEditHistory: Array.isArray(sale.paymentEditHistory) ? sale.paymentEditHistory.slice(-20) : [],
  }
}

function cloudPayloadExpense(expense) {
  return {
    id: expense.id,
    day: expense.day,
    amount: wholeMoney(expense.amount),
    recipient: expense.recipient,
    purpose: expense.purpose,
    note: expense.note || '',
    status: expense.status || 'active',
    type: expense.type === 'goods' ? 'goods' : 'cash',
    pocket: expense.pocket === 'profit' ? 'profit' : expense.pocket === 'pending' ? 'pending' : 'store',
    productId: expense.productId || null,
    productName: expense.productName || '',
    quantity: Number(expense.quantity) || null,
    unitValue: wholeMoney(expense.unitValue),
    createdBy: expense.createdBy || '',
    createdAt: expense.createdAt,
    updatedAt: expense.updatedAt || expense.createdAt,
  }
}

async function syncSales(options = {}) {
  if (!credentials || !navigator.onLine) return
  if (syncing) {
    if (options.rerun) rerunRequested = true
    return
  }
  syncing = true
  rerunRequested = false
  try {
    const previous = fingerprints()
    const sales = currentSales()
    const requestFingerprints = new Map(sales.map(sale => [sale.id, fingerprint(sale)]))
    const expenses = currentExpenses()
    const previousExpenseFingerprints = expenseFingerprints()
    const requestExpenseFingerprints = new Map(expenses.map(expense => [expense.id, expenseFingerprint(expense)]))
    const previousInventoryFingerprints = inventoryFingerprints()
    const operations = currentInventoryOperations()
    const inventoryChangeRequests = currentInventoryChangeRequests()
    const previousInventoryRequestFingerprints = inventoryRequestFingerprints()
    const requestChangeFingerprints = new Map(inventoryChangeRequests.map(request => [request.id, inventoryRequestFingerprint(request)]))
    const requestInventoryFingerprints = new Map(operations.map(operation => [operation.id, inventoryFingerprint(operation)]))
    const eligibleSales = credentials.role === 'cashier'
      ? sales.filter(sale => sale.status === 'completed')
      : sales
    const changed = eligibleSales.filter(sale => previous[sale.id] !== requestFingerprints.get(sale.id))
    const changedExpenses = expenses.filter(expense => previousExpenseFingerprints[expense.id] !== requestExpenseFingerprints.get(expense.id))
    const changedMovements = operations.filter(operation => previousInventoryFingerprints[operation.id] !== requestInventoryFingerprints.get(operation.id))
    const salesBatch = changed.slice(0, SALES_BATCH_SIZE)
    const expenseBatch = changedExpenses.slice(0, EXPENSE_BATCH_SIZE)
    const movementBatch = changedMovements.slice(0, MOVEMENT_BATCH_SIZE)
    const changedRequests = inventoryChangeRequests.filter(request => previousInventoryRequestFingerprints[request.id] !== requestChangeFingerprints.get(request.id))
    const requestBatch = changedRequests.slice(0, MOVEMENT_BATCH_SIZE)
    const pendingCount = changed.length + changedExpenses.length + changedMovements.length + requestBatch.length
    if (pendingCount) setStatus(`Mengirim antrean cloud · ${pendingCount} perubahan`, 'syncing')
    else setStatus('Cloud tersambung · memeriksa pembaruan', 'online')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const response = await fetch(SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        username: credentials.username,
        pin: credentials.pin,
        pullSince: lastPullCursor(),
        sales: salesBatch.map(cloudPayloadSale),
        expenses: expenseBatch.map(cloudPayloadExpense),
        inventoryProducts: inventoryBaselines(movementBatch),
        movements: movementBatch.map(operation => ({ id: operation.id, type: operation.type, referenceId: operation.referenceId, changes: operation.changes, note: operation.note || '', createdBy: operation.createdBy || '', createdAt: operation.createdAt })),
        inventoryRequests: requestBatch.map(request => ({ id: request.id, movementId: request.movementId, requestType: request.requestType, proposedChanges: request.proposedChanges || [], proposedNote: request.proposedNote || '', status: request.status || 'pending', requestedBy: request.requestedBy || '', requestedAt: request.requestedAt || request.createdAt, reviewNote: request.reviewNote || '' })),
      }),
    }).finally(() => clearTimeout(timeout))
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)

    const latestBeforeMerge = currentSales()
    const latestFingerprints = new Map(latestBeforeMerge.map(sale => [sale.id, fingerprint(sale)]))
    const preserveIds = latestBeforeMerge
      .filter(sale => requestFingerprints.get(sale.id) !== latestFingerprints.get(sale.id))
      .map(sale => sale.id)
    const cloudSales = Array.isArray(result.sales) ? result.sales : []
    const cloudExpenses = Array.isArray(result.expenses) ? result.expenses : []
    const cloudMovements = Array.isArray(result.inventory_movements) ? result.inventory_movements : []
    const cloudRequests = Array.isArray(result.inventory_change_requests) ? result.inventory_change_requests : []
    const cloudProducts = Array.isArray(result.inventory_products) ? result.inventory_products : []
    window.CL_POS?.mergeCloudReceipts?.(cloudSales)
    window.CL_POS?.mergeCloudSales?.(cloudSales, {
      includeCost: result.role === 'owner',
      preserveIds,
      deletedIds: Array.isArray(result.deleted_ids) ? result.deleted_ids : [],
      auditLogs: Array.isArray(result.audit_logs) ? result.audit_logs : [],
    })
    window.CL_POS?.mergeCloudAuditLogs?.(Array.isArray(result.audit_logs) ? result.audit_logs : [])
    window.CL_POS?.mergeCloudExpenses?.(cloudExpenses)
    window.CL_POS?.mergeCloudInventoryMovements?.(cloudMovements, cloudProducts)
    window.CL_POS?.mergeCloudInventoryChangeRequests?.(cloudRequests)
    if (Array.isArray(result.rejected_inventory_movements) && result.rejected_inventory_movements.length) {
      window.CL_POS?.rejectCloudInventoryMovements?.(result.rejected_inventory_movements)
    }
    saveLastPullCursor(result.sync_cursor)

    const next = fingerprints()
    const preserved = new Set(preserveIds)
    const current = new Map(currentSales().map(sale => [sale.id, sale]))
    cloudSales.forEach(sale => {
      const local = current.get(sale.id)
      if (local && !preserved.has(sale.id)) next[sale.id] = fingerprint(local)
    })
    salesBatch.forEach(sale => {
      const local = current.get(sale.id)
      const sentFingerprint = requestFingerprints.get(sale.id)
      if (local && fingerprint(local) === sentFingerprint) next[sale.id] = sentFingerprint
    })
    Object.keys(next).forEach(id => {
      if (!current.has(id)) delete next[id]
    })
    saveFingerprints(next)

    const nextExpenseFingerprints = expenseFingerprints()
    const currentExpenseMap = new Map(currentExpenses().map(expense => [expense.id, expense]))
    cloudExpenses.forEach(expense => {
      const local = currentExpenseMap.get(expense.id)
      if (local) nextExpenseFingerprints[expense.id] = expenseFingerprint(local)
    })
    expenseBatch.forEach(expense => {
      const local = currentExpenseMap.get(expense.id)
      const sentFingerprint = requestExpenseFingerprints.get(expense.id)
      if (local && expenseFingerprint(local) === sentFingerprint) nextExpenseFingerprints[expense.id] = sentFingerprint
    })
    Object.keys(nextExpenseFingerprints).forEach(id => {
      if (!currentExpenseMap.has(id)) delete nextExpenseFingerprints[id]
    })
    saveExpenseFingerprints(nextExpenseFingerprints)

    const nextInventoryFingerprints = inventoryFingerprints()
    const currentInventoryMap = new Map(currentInventoryOperations().map(operation => [operation.id, operation]))
    cloudMovements.forEach(movement => {
      const local = currentInventoryMap.get(movement.id)
      if (local) nextInventoryFingerprints[movement.id] = inventoryFingerprint(local)
    })
    movementBatch.forEach(operation => {
      const local = currentInventoryMap.get(operation.id)
      const sentFingerprint = requestInventoryFingerprints.get(operation.id)
      if (local && inventoryFingerprint(local) === sentFingerprint) nextInventoryFingerprints[operation.id] = sentFingerprint
    })
    Object.keys(nextInventoryFingerprints).forEach(id => { if (!currentInventoryMap.has(id)) delete nextInventoryFingerprints[id] })
    saveInventoryFingerprints(nextInventoryFingerprints)

    const nextRequestFingerprints = inventoryRequestFingerprints()
    const currentRequestMap = new Map(currentInventoryChangeRequests().map(request => [request.id, request]))
    cloudRequests.forEach(request => {
      const local = currentRequestMap.get(request.id)
      if (local) nextRequestFingerprints[request.id] = inventoryRequestFingerprint(local)
    })
    requestBatch.forEach(request => {
      const local = currentRequestMap.get(request.id)
      const sentFingerprint = requestChangeFingerprints.get(request.id)
      if (local && inventoryRequestFingerprint(local) === sentFingerprint) nextRequestFingerprints[request.id] = sentFingerprint
    })
    Object.keys(nextRequestFingerprints).forEach(id => { if (!currentRequestMap.has(id)) delete nextRequestFingerprints[id] })
    saveInventoryRequestFingerprints(nextRequestFingerprints)

    const pendingSales = [...current.values()].some(sale => {
      if (credentials.role === 'cashier' && sale.status !== 'completed') return false
      return next[sale.id] !== fingerprint(sale)
    })
    const pendingExpenses = [...currentExpenseMap.values()].some(expense => nextExpenseFingerprints[expense.id] !== expenseFingerprint(expense))
    const pendingInventory = [...currentInventoryMap.values()].some(operation => nextInventoryFingerprints[operation.id] !== inventoryFingerprint(operation))
    const pendingRequests = [...currentRequestMap.values()].some(request => nextRequestFingerprints[request.id] !== inventoryRequestFingerprint(request))
    if (pendingSales || pendingExpenses || pendingInventory || pendingRequests) {
      rerunRequested = true
      setStatus('Mengirim perubahan terbaru…', 'syncing')
    } else {
      setStatus('Cloud tersambung · data terbaru', 'online')
    }
  } catch (error) {
    console.warn('[CL POS] cloud sync:', error)
    const message = error?.name === 'AbortError'
      ? 'koneksi timeout, data tetap tersimpan lokal'
      : error instanceof Error ? error.message : 'Cloud gagal dihubungi'
    setStatus(`Cloud gagal · ${message}`, 'error')
  } finally {
    syncing = false
    if (rerunRequested && credentials && navigator.onLine) queueMicrotask(syncSales)
  }
}

function startSync(detail) {
  credentials = detail
  clearInterval(timer)
  syncSales()
  timer = setInterval(syncSales, POLL_MS)
}

window.addEventListener('cl-pos-login', event => startSync(event.detail))
window.addEventListener('cl-pos-data-changed', () => syncSales({ rerun: true }))
window.addEventListener('online', () => syncSales({ rerun: true }))
window.addEventListener('offline', () => setStatus('Offline · antrean tersimpan', 'error'))
window.addEventListener('focus', () => syncSales())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncSales()
})

const restoredCredentials = window.CL_POS?.getCloudCredentials?.()
if (restoredCredentials) startSync(restoredCredentials)
else if (!navigator.onLine) setStatus('Offline · antrean tersimpan', 'error')
else setStatus('Internet tersedia · masuk untuk sinkronisasi', 'local')

}
