const MAX_SALES_PER_SYNC = 250

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
  const sales = Array.isArray(request.body?.sales) ? request.body.sales : []
  if (!/^[a-z0-9._-]{2,40}$/.test(username) || !/^\d{4,12}$/.test(pin)) {
    return json(response, 401, { error: 'Login cloud tidak valid' })
  }
  if (sales.length > MAX_SALES_PER_SYNC) {
    return json(response, 413, { error: 'Antrean transaksi terlalu besar' })
  }
  const normalizedSales = sales.map(sale => ({
    ...sale,
    total: wholeMoney(sale?.total),
    cost: wholeMoney(sale?.cost),
    cash: wholeMoney(sale?.cash),
    change: wholeMoney(sale?.change),
  }))

  try {
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
    return json(response, 200, result)
  } catch (error) {
    console.error('[pos-sync]', error)
    return json(response, 502, { error: 'Cloud tidak dapat dihubungi' })
  }
}
