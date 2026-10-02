export interface CloudCredentials {
  username: string
  pin: string
}

export interface CloudRequestOptions {
  endpoint: string
  credentials: CloudCredentials
  payload: Record<string, unknown>
  timeoutMs?: number
  fetcher?: typeof fetch
}

export async function postCloud<T>({ endpoint, credentials, payload, timeoutMs = 30000, fetcher = fetch }: CloudRequestOptions): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ username: credentials.username, pin: credentials.pin, ...payload }),
    })
    const result = await response.json().catch(() => ({})) as T & { error?: string }
    if (!response.ok) throw new Error(result.error || `Cloud request gagal (${response.status})`)
    return result
  } finally {
    clearTimeout(timeout)
  }
}

export function fetchHistoryRange(endpoint: string, credentials: CloudCredentials, from: string, to: string, fetcher?: typeof fetch) {
  return postCloud<{ sales: unknown[]; role: string }>({ endpoint, credentials, payload: { historyFrom: from, historyTo: to }, fetcher })
}

export function fetchSalesSummary(endpoint: string, credentials: CloudCredentials, from: string, to: string, fetcher?: typeof fetch) {
  return postCloud<{ monthly: Record<string, unknown>; yearly: Record<string, unknown>; role: string }>({ endpoint, credentials, payload: { summaryFrom: from, summaryTo: to }, fetcher })
}

