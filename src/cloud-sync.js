if (!window.__CL_POS_CLOUD_SYNC_LOADED__) {
  window.__CL_POS_CLOUD_SYNC_LOADED__ = true
const FINGERPRINTS_KEY = 'cl-petshop-cloud-fingerprints-v3'
const EXPENSE_FINGERPRINTS_KEY = 'cl-petshop-cloud-expense-fingerprints-v1'
const POLL_MS = 15000
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

function setStatus(message, state = 'local') {
  window.CL_POS?.setCloudStatus(message, state)
}

function currentSales() {
  return window.CL_POS?.getSales?.() || []
}

function currentExpenses() {
  return window.CL_POS?.getExpenses?.() || []
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
    createdBy: expense.createdBy || '',
    createdAt: expense.createdAt,
    updatedAt: expense.updatedAt || expense.createdAt,
  }
}

async function syncSales() {
  if (!credentials || !navigator.onLine) return
  if (syncing) {
    rerunRequested = true
    return
  }
  syncing = true
  rerunRequested = false
  setStatus('Menyinkronkan cloud…', 'syncing')
  try {
    const previous = fingerprints()
    const sales = currentSales()
    const requestFingerprints = new Map(sales.map(sale => [sale.id, fingerprint(sale)]))
    const expenses = currentExpenses()
    const previousExpenseFingerprints = expenseFingerprints()
    const requestExpenseFingerprints = new Map(expenses.map(expense => [expense.id, expenseFingerprint(expense)]))
    const eligibleSales = credentials.role === 'cashier'
      ? sales.filter(sale => sale.status === 'completed')
      : sales
    const changed = eligibleSales.filter(sale => previous[sale.id] !== requestFingerprints.get(sale.id))
    const response = await fetch(SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: credentials.username,
        pin: credentials.pin,
        sales: changed.map(cloudPayloadSale),
        expenses: expenses.filter(expense => previousExpenseFingerprints[expense.id] !== requestExpenseFingerprints.get(expense.id)).map(cloudPayloadExpense),
      }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)

    const latestBeforeMerge = currentSales()
    const latestFingerprints = new Map(latestBeforeMerge.map(sale => [sale.id, fingerprint(sale)]))
    const preserveIds = latestBeforeMerge
      .filter(sale => requestFingerprints.get(sale.id) !== latestFingerprints.get(sale.id))
      .map(sale => sale.id)
    const cloudSales = Array.isArray(result.sales) ? result.sales : []
    const cloudExpenses = Array.isArray(result.expenses) ? result.expenses : []
    window.CL_POS?.mergeCloudReceipts?.(cloudSales)
    window.CL_POS?.mergeCloudSales?.(cloudSales, {
      includeCost: result.role === 'owner',
      preserveIds,
      deletedIds: Array.isArray(result.deleted_ids) ? result.deleted_ids : [],
      auditLogs: Array.isArray(result.audit_logs) ? result.audit_logs : [],
    })
    window.CL_POS?.mergeCloudAuditLogs?.(Array.isArray(result.audit_logs) ? result.audit_logs : [])
    window.CL_POS?.mergeCloudExpenses?.(cloudExpenses)

    const next = fingerprints()
    const preserved = new Set(preserveIds)
    const current = new Map(currentSales().map(sale => [sale.id, sale]))
    cloudSales.forEach(sale => {
      const local = current.get(sale.id)
      if (local && !preserved.has(sale.id)) next[sale.id] = fingerprint(local)
    })
    changed.forEach(sale => {
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
    expenses.forEach(expense => {
      const local = currentExpenseMap.get(expense.id)
      const sentFingerprint = requestExpenseFingerprints.get(expense.id)
      if (local && expenseFingerprint(local) === sentFingerprint) nextExpenseFingerprints[expense.id] = sentFingerprint
    })
    Object.keys(nextExpenseFingerprints).forEach(id => {
      if (!currentExpenseMap.has(id)) delete nextExpenseFingerprints[id]
    })
    saveExpenseFingerprints(nextExpenseFingerprints)

    const pendingSales = [...current.values()].some(sale => {
      if (credentials.role === 'cashier' && sale.status !== 'completed') return false
      return next[sale.id] !== fingerprint(sale)
    })
    const pendingExpenses = [...currentExpenseMap.values()].some(expense => nextExpenseFingerprints[expense.id] !== expenseFingerprint(expense))
    if (pendingSales || pendingExpenses) {
      rerunRequested = true
      setStatus('Mengirim perubahan terbaru…', 'syncing')
    } else {
      setStatus('Cloud tersambung · data terbaru', 'online')
    }
  } catch (error) {
    console.warn('[CL POS] cloud sync:', error)
    const message = error instanceof Error ? error.message : 'Cloud gagal dihubungi'
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
window.addEventListener('cl-pos-data-changed', () => syncSales())
window.addEventListener('online', () => syncSales())
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
