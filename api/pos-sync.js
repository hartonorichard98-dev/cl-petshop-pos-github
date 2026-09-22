const MAX_SALES_PER_SYNC = 250
const MAX_EXPENSES_PER_SYNC = 250
const MAX_MOVEMENTS_PER_SYNC = 500
const MAX_INVENTORY_PRODUCTS_PER_SYNC = 500

function wholeMoney(value) {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.round(amount) : 0
}

function json(response, status, body) {
  response.status(status).setHeader('Content-Type', 'application/json')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(body))
}

function allowLocalFileOrigin(request, response) {
  if (request.headers.origin !== 'null') return
  response.setHeader('Access-Control-Allow-Origin', 'null')
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  response.setHeader('Vary', 'Origin')
}

function validCursor(value) {
  const cursor = String(value || '').trim()
  return cursor && Number.isFinite(Date.parse(cursor)) ? cursor : ''
}

function changedAfter(rows, cursor, fields) {
  if (!Array.isArray(rows) || !cursor) return Array.isArray(rows) ? rows : []
  const since = Date.parse(cursor)
  return rows.filter(row => {
    const timestamp = fields.map(field => row?.[field]).find(Boolean)
    return !timestamp || Date.parse(timestamp) > since
  })
}

export default async function handler(request, response) {
  allowLocalFileOrigin(request, response)
  if (request.method === 'OPTIONS') return response.status(204).end()
  if (request.method !== 'POST') return json(response, 405, { error: 'Method not allowed' })

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
  const storeId = process.env.STORE_ID || process.env.VITE_STORE_ID
  const syncSecret = process.env.POS_SYNC_SECRET
  if (!supabaseUrl || !supabaseKey || !storeId || !syncSecret) {
    return json(response, 503, { error: 'Cloud sync belum dikonfigurasi' })
  }

  const username = String(request.body?.username || '').trim().toLowerCase()
  const pin = String(request.body?.pin || '')
  const pullSince = validCursor(request.body?.pullSince)
  const syncCursor = new Date().toISOString()
  const sales = Array.isArray(request.body?.sales) ? request.body.sales : []
  const expenses = Array.isArray(request.body?.expenses) ? request.body.expenses : []
  const movements = Array.isArray(request.body?.movements) ? request.body.movements : []
  const inventoryProducts = Array.isArray(request.body?.inventoryProducts) ? request.body.inventoryProducts : []
  if (!/^[a-z0-9._-]{2,40}$/.test(username) || !/^\d{4,12}$/.test(pin)) {
    return json(response, 401, { error: 'Login cloud tidak valid' })
  }
  if (sales.length > MAX_SALES_PER_SYNC) {
    return json(response, 413, { error: 'Antrean transaksi terlalu besar' })
  }
  if (expenses.length > MAX_EXPENSES_PER_SYNC) {
    return json(response, 413, { error: 'Antrean pengeluaran terlalu besar' })
  }
  if (movements.length > MAX_MOVEMENTS_PER_SYNC) {
    return json(response, 413, { error: 'Antrean perubahan stok terlalu besar' })
  }
  if (inventoryProducts.length > MAX_INVENTORY_PRODUCTS_PER_SYNC) {
    return json(response, 413, { error: 'Baseline stok terlalu besar' })
  }
  const normalizedSales = sales.map(sale => ({
    ...sale,
    total: wholeMoney(sale?.total),
    cost: wholeMoney(sale?.cost),
    cash: wholeMoney(sale?.cash),
    change: wholeMoney(sale?.change),
    paymentBreakdown: Array.isArray(sale?.paymentBreakdown)
      ? sale.paymentBreakdown.map(part => ({ method: part?.method, amount: wholeMoney(part?.amount) }))
      : [],
    paymentEditHistory: Array.isArray(sale?.paymentEditHistory) ? sale.paymentEditHistory.slice(-20) : [],
  }))
  const normalizedExpenses = expenses.map(expense => ({
    ...expense,
    amount: wholeMoney(expense?.amount),
    status: expense?.status === 'cancelled' ? 'cancelled' : 'active',
    type: expense?.type === 'goods' ? 'goods' : 'cash',
    pocket: expense?.pocket === 'profit' ? 'profit' : expense?.pocket === 'pending' ? 'pending' : 'store',
    productId: Number(expense?.productId) || null,
    productName: expense?.productName || null,
    quantity: Number(expense?.quantity) || null,
    unitValue: wholeMoney(expense?.unitValue),
  }))

  try {
    for (const sale of normalizedSales) {
      const edit = sale.paymentEditHistory.at(-1)
      if (!edit?.id) continue
      const correctionResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/pos_update_sale_payment`, {
        method: 'POST',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_api_secret: syncSecret,
          p_store_id: storeId,
          p_username: username,
          p_pin: pin,
          p_sale_id: sale.id,
          p_payment_method: sale.paymentMethod,
          p_payment_breakdown: sale.paymentBreakdown,
          p_cash_received: sale.cash,
          p_reason: edit.reason,
          p_edit_id: edit.id,
          p_edited_at: edit.createdAt,
        }),
      })
      const correctionText = await correctionResponse.text()
      const correctionResult = correctionText ? JSON.parse(correctionText) : false
      if (!correctionResponse.ok) {
        console.error('[pos-sync] Supabase rejected payment correction', {
          code: correctionResult?.code,
          message: correctionResult?.message,
          saleId: sale.id,
        })
        return json(response, 422, { error: 'Koreksi pembayaran gagal disimpan' })
      }
    }

    const cloudResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/pos_sync_and_pull`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_api_secret: syncSecret,
        p_store_id: storeId,
        p_username: username,
        p_pin: pin,
        p_sales: normalizedSales,
      }),
    })
    const text = await cloudResponse.text()
    const result = text ? JSON.parse(text) : {}
    if (!cloudResponse.ok) {
      const cloudMessage = String(result?.message || '')
      console.error('[pos-sync] Supabase rejected batch', {
        code: result?.code,
        message: cloudMessage,
        salesCount: sales.length,
      })
      if (cloudMessage.includes('Invalid POS login')) {
        return json(response, 401, { error: 'Username atau PIN cloud salah' })
      }
      if (cloudMessage.includes('Cashier can only sync completed sales')) {
        return json(response, 422, { error: 'Akun kasir hanya boleh mengirim transaksi selesai' })
      }
      if (cloudMessage.includes('Invalid sale payload') || cloudMessage.includes('invalid input syntax for type uuid')) {
        return json(response, 422, { error: 'Ada data transaksi lokal yang tidak valid' })
      }
      return json(response, 502, { error: 'Supabase gagal menyimpan transaksi' })
    }
    const expenseResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/pos_sync_expenses`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_api_secret: syncSecret,
        p_store_id: storeId,
        p_username: username,
        p_pin: pin,
        p_expenses: normalizedExpenses,
      }),
    })
    const expenseText = await expenseResponse.text()
    const expenseResult = expenseText ? JSON.parse(expenseText) : {}
    if (!expenseResponse.ok) {
      const expenseMessage = String(expenseResult?.message || '')
      console.error('[pos-sync] Supabase rejected expenses', { code: expenseResult?.code, message: expenseMessage, expensesCount: expenses.length })
      if (expenseMessage.includes('Invalid POS login')) return json(response, 401, { error: 'Username atau PIN cloud salah' })
      return json(response, 502, { error: 'Supabase gagal menyimpan pengeluaran' })
    }
    const inventoryResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/pos_sync_inventory`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_api_secret: syncSecret,
        p_store_id: storeId,
        p_username: username,
        p_pin: pin,
        p_products: inventoryProducts,
        p_movements: movements,
      }),
    })
    const inventoryText = await inventoryResponse.text()
    const inventoryResult = inventoryText ? JSON.parse(inventoryText) : {}
    if (!inventoryResponse.ok) {
      console.error('[pos-sync] Supabase rejected inventory movements', { code: inventoryResult?.code, message: inventoryResult?.message, movementsCount: movements.length })
      if (String(inventoryResult?.message || '').includes('Invalid POS login')) return json(response, 401, { error: 'Username atau PIN cloud salah' })
      return json(response, 502, { error: 'Supabase gagal menyimpan perubahan stok' })
    }
    let auditLogs = []
    if (result.role === 'owner') {
      const auditResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/pos_pull_audit_logs`, {
        method: 'POST',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_api_secret: syncSecret,
          p_store_id: storeId,
          p_username: username,
          p_pin: pin,
        }),
      })
      if (auditResponse.ok) auditLogs = await auditResponse.json()
    }
    return json(response, 200, {
      ...result,
      sales: changedAfter(result.sales, pullSince, ['updated_at', 'created_at']),
      expenses: changedAfter(expenseResult.expenses, pullSince, ['updated_at', 'created_at']),
      inventory_movements: changedAfter(inventoryResult.movements, pullSince, ['created_at']),
      inventory_products: changedAfter(inventoryResult.products, pullSince, ['updated_at', 'created_at']),
      audit_logs: changedAfter(auditLogs, pullSince, ['created_at']),
      sync_cursor: syncCursor,
    })
  } catch (error) {
    console.error('[pos-sync]', error)
    return json(response, 502, { error: 'Cloud tidak dapat dihubungi' })
  }
}
