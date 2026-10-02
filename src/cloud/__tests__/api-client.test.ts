import { describe, expect, it, vi } from 'vitest'
import { fetchHistoryRange, postCloud } from '../api-client'

describe('cloud API client', () => {
  it('sends credentials and history range in one POST', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body).toEqual({ username: 'owner', pin: '123456', historyFrom: '2026-10-02', historyTo: '2026-10-02' })
      return new Response(JSON.stringify({ sales: [], role: 'owner' }), { status: 200 })
    }) as typeof fetch
    const result = await fetchHistoryRange('/api/pos-sync', { username: 'owner', pin: '123456' }, '2026-10-02', '2026-10-02', fetcher)
    expect(result.role).toBe('owner')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('surfaces safe API error text', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'Login cloud tidak valid' }), { status: 401 })) as typeof fetch
    await expect(postCloud({ endpoint: '/api/pos-sync', credentials: { username: 'x', pin: '1' }, payload: {}, fetcher })).rejects.toThrow('Login cloud tidak valid')
  })
})

