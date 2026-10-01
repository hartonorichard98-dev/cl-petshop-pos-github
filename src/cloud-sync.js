if (!window.__CL_POS_CLOUD_SYNC_LOADED__) {
  window.__CL_POS_CLOUD_SYNC_LOADED__ = true
const FINGERPRINTS_KEY = 'cl-petshop-cloud-fingerprints-v3'
const EXPENSE_FINGERPRINTS_KEY = 'cl-petshop-cloud-expense-fingerprints-v1'
const INVENTORY_FINGERPRINTS_KEY = 'cl-petshop-cloud-inventory-fingerprints-v1'
const INVENTORY_REQUEST_FINGERPRINTS_KEY = 'cl-petshop-cloud-inventory-request-fingerprints-v1'
const RECEIVING_FINGERPRINTS_KEY = 'cl-petshop-cloud-receiving-fingerprints-v1'
const LAST_PULL_KEY_PREFIX = 'cl-petshop-cloud-last-pull-v1'
const FULL_PULL_KEY_PREFIX = 'cl-petshop-cloud-full-pull-v2'
const POPULAR_PRODUCTS_KEY = 'cl-petshop-popular-products-v1'
const POLL_MS = 120000
const REQUEST_TIMEOUT_MS = 30000
const SALES_BATCH_SIZE = 100
const EXPENSE_BATCH_SIZE = 100
const MOVEMENT_BATCH_SIZE = 200
const INVENTORY_BASELINE_DAY = '2026-10-01'
const SYNC_ENDPOINT = window.location.protocol === 'file:'
  ? 'https://cl-petshop-pos.vercel.app/api/pos-sync'
  : '/api/pos-sync'

let credentials = null
let syncing = false
let rerunRequested = false
let timer = null

async function fetchHistoryRange(from, to) {
  if (!credentials || !navigator.onLine) return { ok: false, error: 'Cloud tidak tersedia' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ username: credentials.username, pin: credentials.pin, historyFrom: from, historyTo: to }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) return { ok: false, error: result.error || 'Supabase gagal membaca transaksi' }
    return { ok: true, sales: Array.isArray(result.sales) ? result.sales : [], role: result.role }
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'Cloud terlalu lama merespons' : 'Cloud tidak dapat membaca transaksi' }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchSalesSummary(from, to) {
  if (!credentials || !navigator.onLine) return { ok: false, error: 'Cloud tidak tersedia' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ username: credentials.username, pin: credentials.pin, summaryFrom: from, summaryTo: to }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) return { ok: false, error: result.error || 'Supabase gagal membaca ringkasan' }
    return { ok: true, monthly: result.monthly || {}, yearly: result.yearly || {}, role: result.role }
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'Cloud terlalu lama merespons' : 'Cloud tidak dapat membaca ringkasan' }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchPopularProducts(limit = 48) {
  if (!credentials || !navigator.onLine) return { ok: false, error: 'Cloud tidak tersedia' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ username: credentials.username, pin: credentials.pin, popularLimit: limit }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) return { ok: false, error: result.error || 'Supabase gagal membaca produk terlaris' }
    return { ok: true, products: Array.isArray(result.products) ? result.products : [], role: result.role }
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'Cloud terlalu lama merespons' : 'Cloud tidak dapat membaca produk terlaris' }
  } finally {
    clearTimeout(timeout)
  }
}

function dispatchPopularProducts(products) {
  window.dispatchEvent(new CustomEvent('cl-pos-popular-products', { detail: { products } }))
}

async function loadPopularProducts() {
  try {
    const cached = JSON.parse(localStorage.getItem(POPULAR_PRODUCTS_KEY) || '[]')
    if (Array.isArray(cached) && cached.length) dispatchPopularProducts(cached)
  } catch {}
  const result = await fetchPopularProducts(48)
  if (!result.ok) return
  localStorage.setItem(POPULAR_PRODUCTS_KEY, JSON.stringify(result.products))
  dispatchPopularProducts(result.products)
}

function compactFingerprint(value) {
  const text = JSON.stringify(value)
  let first = 2166136261
  let second = 2246822507
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ code, 3266489909)
  }
  return `v2:${text.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`
}

function fingerprint(sale) {
  return compactFingerprint({
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

function saveCache(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch (error) {
    if (error?.name !== 'QuotaExceededError') throw error
    localStorage.removeItem(key)
    return false
  }
}

function saveFingerprints(value) {
  if (saveCache(FINGERPRINTS_KEY, value)) return
  saveCache(FINGERPRINTS_KEY, Object.fromEntries(Object.entries(value).slice(-500)))
}

function expenseFingerprint(expense) {
  return compactFingerprint({
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
  if (saveCache(EXPENSE_FINGERPRINTS_KEY, value)) return
  saveCache(EXPENSE_FINGERPRINTS_KEY, Object.fromEntries(Object.entries(value).slice(-500)))
}

function inventoryFingerprint(operation) {
  return compactFingerprint({ id: operation.id, type: operation.type, referenceId: operation.referenceId, changes: operation.changes, note: operation.note, createdBy: operation.createdBy, createdAt: operation.createdAt })
}

function inventoryFingerprints() {
  try { return JSON.parse(localStorage.getItem(INVENTORY_FINGERPRINTS_KEY) || '{}') || {} } catch { return {} }
}

function saveInventoryFingerprints(value) {
  if (saveCache(INVENTORY_FINGERPRINTS_KEY, value)) return
  saveCache(INVENTORY_FINGERPRINTS_KEY, Object.fromEntries(Object.entries(value).slice(-500)))
}

function inventoryRequestFingerprint(request) {
  return compactFingerprint({ id: request.id, movementId: request.movementId, requestType: request.requestType, proposedChanges: request.proposedChanges, proposedNote: request.proposedNote, status: request.status, requestedBy: request.requestedBy, requestedAt: request.requestedAt, reviewNote: request.reviewNote })
}

function inventoryRequestFingerprints() {
  try { return JSON.parse(localStorage.getItem(INVENTORY_REQUEST_FINGERPRINTS_KEY) || '{}') || {} } catch { return {} }
}

function saveInventoryRequestFingerprints(value) {
  if (saveCache(INVENTORY_REQUEST_FINGERPRINTS_KEY, value)) return
  saveCache(INVENTORY_REQUEST_FINGERPRINTS_KEY, Object.fromEntries(Object.entries(value).slice(-500)))
}

function receivingFingerprint(receiving) {
  return compactFingerprint({
    id: receiving.id,
    number: receiving.number,
    supplier: receiving.supplier,
    reference: receiving.reference,
    expectedDate: receiving.expectedDate,
    ownerNote: receiving.ownerNote,
    cashierNote: receiving.cashierNote,
    reviewNote: receiving.reviewNote,
    items: receiving.items,
    status: receiving.status,
    createdBy: receiving.createdBy,
    checkedBy: receiving.checkedBy,
    approvedBy: receiving.approvedBy,
    createdAt: receiving.createdAt,
    checkedAt: receiving.checkedAt,
    approvedAt: receiving.approvedAt,
    stockAppliedAt: receiving.stockAppliedAt,
    updatedAt: receiving.updatedAt,
  })
}

function receivingFingerprints() {
  try { return JSON.parse(localStorage.getItem(RECEIVING_FINGERPRINTS_KEY) || '{}') || {} } catch { return {} }
}

function saveReceivingFingerprints(value) {
  if (saveCache(RECEIVING_FINGERPRINTS_KEY, value)) return
  saveCache(RECEIVING_FINGERPRINTS_KEY, Object.fromEntries(Object.entries(value).slice(-500)))
}

function lastPullKey() {
  return `${LAST_PULL_KEY_PREFIX}:${credentials?.username || 'unknown'}`
}

function lastPullCursor() {
  const value = localStorage.getItem(lastPullKey()) || ''
  return Number.isFinite(Date.parse(value)) ? value : ''
}

function saveLastPullCursor(value) {
  if (Number.isFinite(Date.parse(value))) {
    try { localStorage.setItem(lastPullKey(), value) } catch (error) { if (error?.name !== 'QuotaExceededError') throw error }
  }
}

function fullPullKey() {
  return `${FULL_PULL_KEY_PREFIX}:${credentials?.username || 'unknown'}`
}

function needsFullPull() {
  return localStorage.getItem(fullPullKey()) !== 'done'
}

function markFullPullComplete() {
  try { localStorage.setItem(fullPullKey(), 'done') } catch {}
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

function currentReceivings() {
  return window.CL_POS?.getReceivings?.() || []
}

function recordTime(record, fields) {
  for (const field of fields) {
    const time = Date.parse(record?.[field] || '')
    if (Number.isFinite(time)) return time
  }
  return Number.POSITIVE_INFINITY
}

function isLegacyInventoryBaseline(operation, salesById) {
  const referencedSale = salesById.get(String(operation?.referenceId || ''))
  if (referencedSale && String(referencedSale.day || '') < INVENTORY_BASELINE_DAY) return true
  const createdAt = Date.parse(operation?.createdAt || '')
  return Number.isFinite(createdAt) && createdAt < Date.parse(`${INVENTORY_BASELINE_DAY}T00:00:00+07:00`)
}

function repairFingerprintCaches() {
  const cursor = Date.parse(lastPullCursor())
  if (!Number.isFinite(cursor)) return

  const salesCache = fingerprints()
  let salesChanged = false
  currentSales().forEach(sale => {
    if (salesCache[sale.id]?.startsWith?.('v2:')) return
    if (recordTime(sale, ['updatedAt', 'editedAt', 'deletedAt', 'voidedAt', 'createdAt']) > cursor) return
    salesCache[sale.id] = fingerprint(sale)
    salesChanged = true
  })
  if (salesChanged) saveFingerprints(salesCache)

  const expenseCache = expenseFingerprints()
  let expensesChanged = false
  currentExpenses().forEach(expense => {
    if (expenseCache[expense.id]?.startsWith?.('v2:')) return
    if (recordTime(expense, ['updatedAt', 'createdAt']) > cursor) return
    expenseCache[expense.id] = expenseFingerprint(expense)
    expensesChanged = true
  })
  if (expensesChanged) saveExpenseFingerprints(expenseCache)

  const inventoryCache = inventoryFingerprints()
  let inventoryChanged = false
  currentInventoryOperations().forEach(operation => {
    if (inventoryCache[operation.id]?.startsWith?.('v2:')) return
    if (operation.syncStatus === 'pending') return
    inventoryCache[operation.id] = inventoryFingerprint(operation)
    inventoryChanged = true
  })
  if (inventoryChanged) saveInventoryFingerprints(inventoryCache)

  const requestCache = inventoryRequestFingerprints()
  let requestsChanged = false
  currentInventoryChangeRequests().forEach(request => {
    if (requestCache[request.id]?.startsWith?.('v2:')) return
    if (recordTime(request, ['updatedAt', 'reviewedAt', 'requestedAt']) > cursor) return
    requestCache[request.id] = inventoryRequestFingerprint(request)
    requestsChanged = true
  })
  if (requestsChanged) saveInventoryRequestFingerprints(requestCache)

  const receivingCache = receivingFingerprints()
  let receivingsChanged = false
  currentReceivings().forEach(receiving => {
    if (receivingCache[receiving.id]?.startsWith?.('v2:')) return
    if (recordTime(receiving, ['updatedAt', 'approvedAt', 'checkedAt', 'createdAt']) > cursor) return
    receivingCache[receiving.id] = receivingFingerprint(receiving)
    receivingsChanged = true
  })
  if (receivingsChanged) saveReceivingFingerprints(receivingCache)
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

function cloudPayloadReceiving(receiving) {
  return {
    id: receiving.id,
    number: receiving.number,
    supplier: receiving.supplier,
    reference: receiving.reference || '',
    expectedDate: receiving.expectedDate || '',
    ownerNote: receiving.ownerNote || '',
    cashierNote: receiving.cashierNote || '',
    reviewNote: receiving.reviewNote || '',
    items: Array.isArray(receiving.items) ? receiving.items : [],
    status: receiving.status || 'waiting_check',
    createdBy: receiving.createdBy || '',
    checkedBy: receiving.checkedBy || '',
    approvedBy: receiving.approvedBy || '',
    createdAt: receiving.createdAt,
    checkedAt: receiving.checkedAt || '',
    approvedAt: receiving.approvedAt || '',
    stockAppliedAt: receiving.stockAppliedAt || '',
    updatedAt: receiving.updatedAt || receiving.createdAt,
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
    repairFingerprintCaches()
    const previous = fingerprints()
    const sales = currentSales()
    const requestFingerprints = new Map(sales.map(sale => [sale.id, fingerprint(sale)]))
    const expenses = currentExpenses()
    const previousExpenseFingerprints = expenseFingerprints()
    const requestExpenseFingerprints = new Map(expenses.map(expense => [expense.id, expenseFingerprint(expense)]))
    const previousInventoryFingerprints = inventoryFingerprints()
    const operations = currentInventoryOperations()
    const inventoryChangeRequests = currentInventoryChangeRequests()
    const receivings = currentReceivings()
    const previousInventoryRequestFingerprints = inventoryRequestFingerprints()
    const previousReceivingFingerprints = receivingFingerprints()
    const requestChangeFingerprints = new Map(inventoryChangeRequests.map(request => [request.id, inventoryRequestFingerprint(request)]))
    const requestReceivingFingerprints = new Map(receivings.map(receiving => [receiving.id, receivingFingerprint(receiving)]))
    const requestInventoryFingerprints = new Map(operations.map(operation => [operation.id, inventoryFingerprint(operation)]))
    const salesById = new Map(sales.map(sale => [String(sale.id), sale]))
    const eligibleSales = credentials.role === 'cashier'
      ? sales.filter(sale => sale.status === 'completed')
      : sales
    const changed = eligibleSales.filter(sale => previous[sale.id] !== requestFingerprints.get(sale.id))
    const changedExpenses = expenses.filter(expense => previousExpenseFingerprints[expense.id] !== requestExpenseFingerprints.get(expense.id))
    const changedMovements = operations.filter(operation => !isLegacyInventoryBaseline(operation, salesById) && previousInventoryFingerprints[operation.id] !== requestInventoryFingerprints.get(operation.id))
    const salesBatch = changed.slice(0, SALES_BATCH_SIZE)
    const expenseBatch = changedExpenses.slice(0, EXPENSE_BATCH_SIZE)
    const movementBatch = changedMovements.slice(0, MOVEMENT_BATCH_SIZE)
    const changedRequests = inventoryChangeRequests.filter(request => previousInventoryRequestFingerprints[request.id] !== requestChangeFingerprints.get(request.id))
    const requestBatch = changedRequests.slice(0, MOVEMENT_BATCH_SIZE)
    const eligibleReceivings = credentials.role === 'cashier'
      ? receivings.filter(receiving => receiving.status === 'owner_review')
      : receivings
    const changedReceivings = eligibleReceivings.filter(receiving => previousReceivingFingerprints[receiving.id] !== requestReceivingFingerprints.get(receiving.id))
    const receivingBatch = changedReceivings.slice(0, MOVEMENT_BATCH_SIZE)
    const pendingCount = changed.length + changedExpenses.length + changedMovements.length + requestBatch.length + receivingBatch.length
    const pullCursor = lastPullCursor()
    if (pendingCount) setStatus(`Mengirim antrean cloud · ${pendingCount} perubahan`, 'syncing')
    else setStatus('Cloud tersambung · memeriksa pembaruan', 'online')
    const syncRequest = async (payload, pullSinceOverride = pullCursor) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await fetch(SYNC_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            username: credentials.username,
            pin: credentials.pin,
            pullSince: pullSinceOverride,
            ...payload,
          }),
        })
        const result = await response.json().catch(() => ({}))
        return { response, result }
      } finally {
        clearTimeout(timeout)
      }
    }
    const pendingPayload = {
      sales: salesBatch.map(cloudPayloadSale),
      expenses: expenseBatch.map(cloudPayloadExpense),
      inventoryProducts: inventoryBaselines(movementBatch),
      movements: movementBatch.map(operation => ({ id: operation.id, type: operation.type, referenceId: operation.referenceId, changes: operation.changes, note: operation.note || '', createdBy: operation.createdBy || '', createdAt: operation.createdAt })),
      inventoryRequests: requestBatch.map(request => ({ id: request.id, movementId: request.movementId, requestType: request.requestType, proposedChanges: request.proposedChanges || [], proposedNote: request.proposedNote || '', status: request.status || 'pending', requestedBy: request.requestedBy || '', requestedAt: request.requestedAt || request.createdAt, reviewNote: request.reviewNote || '' })),
      receivings: receivingBatch.map(cloudPayloadReceiving),
    }
    let { response, result } = await syncRequest(pendingPayload)
    let pushRecoveredWithPullOnly = false
    if (!response.ok) {
      console.warn('[CL POS] cloud push gagal; mencoba pull cloud terpisah', result.error || response.status)
      const recovery = await syncRequest({ sales: [], expenses: [], inventoryProducts: [], movements: [], inventoryRequests: [], receivings: [] })
      if (recovery.response.ok) {
        result = recovery.result
        pushRecoveredWithPullOnly = true
        setStatus(`Cloud tersambung · antrean lokal ${pendingCount} belum terkirim`, 'syncing')
      } else {
        throw new Error(result.error || `HTTP ${response.status}`)
      }
    } else if (!response.ok) {
      throw new Error(result.error || `HTTP ${response.status}`)
    }

    const latestBeforeMerge = currentSales()
    const latestFingerprints = new Map(latestBeforeMerge.map(sale => [sale.id, fingerprint(sale)]))
    const preserveIds = latestBeforeMerge
      .filter(sale => requestFingerprints.get(sale.id) !== latestFingerprints.get(sale.id))
      .map(sale => sale.id)
    const cloudSales = Array.isArray(result.sales) ? result.sales : []
    const cloudExpenses = Array.isArray(result.expenses) ? result.expenses : []
    const cloudMovements = Array.isArray(result.inventory_movements) ? result.inventory_movements : []
    const cloudRequests = Array.isArray(result.inventory_change_requests) ? result.inventory_change_requests : []
    const cloudReceivings = Array.isArray(result.receivings) ? result.receivings : []
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
    window.CL_POS?.mergeCloudReceivings?.(cloudReceivings)
    if (Array.isArray(result.rejected_inventory_movements) && result.rejected_inventory_movements.length) {
      window.CL_POS?.rejectCloudInventoryMovements?.(result.rejected_inventory_movements)
    }
    const mergedSalesCount = currentSales().length
    let persistedSalesCount = mergedSalesCount
    try {
      const stored = JSON.parse(localStorage.getItem('cl-petshop-standalone-v1') || 'null')
      persistedSalesCount = Array.isArray(stored?.sales) ? stored.sales.length : 0
    } catch {}
    if (persistedSalesCount < mergedSalesCount) {
      localStorage.removeItem(fullPullKey())
      localStorage.removeItem(lastPullKey())
      setStatus(`Cloud tersambung · ${mergedSalesCount.toLocaleString('id-ID')} transaksi`, 'online')
    } else {
      saveLastPullCursor(result.sync_cursor)
      if (pushRecoveredWithPullOnly) markFullPullComplete()
    }

    const next = fingerprints()
    const preserved = new Set(preserveIds)
    const current = new Map(currentSales().map(sale => [sale.id, sale]))
    cloudSales.forEach(sale => {
      const local = current.get(sale.id)
      if (local && !preserved.has(sale.id)) next[sale.id] = fingerprint(local)
    })
    if (!pushRecoveredWithPullOnly) salesBatch.forEach(sale => {
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
    if (!pushRecoveredWithPullOnly) expenseBatch.forEach(expense => {
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
    if (!pushRecoveredWithPullOnly) movementBatch.forEach(operation => {
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
    if (!pushRecoveredWithPullOnly) requestBatch.forEach(request => {
      const local = currentRequestMap.get(request.id)
      const sentFingerprint = requestChangeFingerprints.get(request.id)
      if (local && inventoryRequestFingerprint(local) === sentFingerprint) nextRequestFingerprints[request.id] = sentFingerprint
    })
    Object.keys(nextRequestFingerprints).forEach(id => { if (!currentRequestMap.has(id)) delete nextRequestFingerprints[id] })
    saveInventoryRequestFingerprints(nextRequestFingerprints)

    const nextReceivingFingerprints = receivingFingerprints()
    const currentReceivingMap = new Map(currentReceivings().map(receiving => [receiving.id, receiving]))
    cloudReceivings.forEach(receiving => {
      const local = currentReceivingMap.get(receiving.id)
      if (local) nextReceivingFingerprints[receiving.id] = receivingFingerprint(local)
    })
    if (!pushRecoveredWithPullOnly) receivingBatch.forEach(receiving => {
      const local = currentReceivingMap.get(receiving.id)
      const sentFingerprint = requestReceivingFingerprints.get(receiving.id)
      if (local && receivingFingerprint(local) === sentFingerprint) nextReceivingFingerprints[receiving.id] = sentFingerprint
    })
    Object.keys(nextReceivingFingerprints).forEach(id => { if (!currentReceivingMap.has(id)) delete nextReceivingFingerprints[id] })
    saveReceivingFingerprints(nextReceivingFingerprints)

    const pendingSales = [...current.values()].some(sale => {
      if (credentials.role === 'cashier' && sale.status !== 'completed') return false
      return next[sale.id] !== fingerprint(sale)
    })
    const currentSalesById = new Map([...current.values()].map(sale => [String(sale.id), sale]))
    const pendingExpenses = [...currentExpenseMap.values()].some(expense => nextExpenseFingerprints[expense.id] !== expenseFingerprint(expense))
    const pendingInventory = [...currentInventoryMap.values()].some(operation => !isLegacyInventoryBaseline(operation, currentSalesById) && nextInventoryFingerprints[operation.id] !== inventoryFingerprint(operation))
    const pendingRequests = [...currentRequestMap.values()].some(request => nextRequestFingerprints[request.id] !== inventoryRequestFingerprint(request))
    const pendingReceivings = [...currentReceivingMap.values()].some(receiving => nextReceivingFingerprints[receiving.id] !== receivingFingerprint(receiving))
    if (pushRecoveredWithPullOnly) {
      setStatus(`Cloud tersambung · ${pendingCount} perubahan lokal perlu dicoba ulang`, 'syncing')
    } else if (pendingSales || pendingExpenses || pendingInventory || pendingRequests || pendingReceivings) {
      rerunRequested = true
      setStatus('Mengirim perubahan terbaru…', 'syncing')
    } else {
      setStatus(`Cloud tersambung · ${currentSales().length.toLocaleString('id-ID')} transaksi`, 'online')
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
  loadPopularProducts()
  syncSales().finally(() => window.dispatchEvent(new CustomEvent('cl-pos-cloud-ready')))
  timer = setInterval(syncSales, POLL_MS)
}

window.CL_POS.fetchHistoryRange = fetchHistoryRange
window.CL_POS.fetchSalesSummary = fetchSalesSummary
window.CL_POS.fetchPopularProducts = fetchPopularProducts

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
