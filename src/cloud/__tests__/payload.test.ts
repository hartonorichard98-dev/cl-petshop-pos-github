import { describe, expect, it } from 'vitest'
import { normalizeSale, wholeMoney } from '../payload'
import type { CloudSale } from '../types'

describe('cloud payload normalization', () => {
  it('rounds money and rejects invalid numeric values', () => {
    expect(wholeMoney('12500.7')).toBe(12501)
    expect(wholeMoney('not-a-number')).toBe(0)
  })

  it('normalizes transaction amounts without changing identity', () => {
    const sale: CloudSale = {
      id: 'sale-1', receipt: 'R-1', items: [{ name: 'Item', quantity: 2.8, sellPrice: 12500.4 }],
      total: 25000.6, paymentMethod: 'cash', status: 'completed', day: '2026-10-02', createdAt: '2026-10-02T10:00:00Z',
    }
    const normalized = normalizeSale(sale)
    expect(normalized.id).toBe('sale-1')
    expect(normalized.total).toBe(25001)
    expect(normalized.items[0].quantity).toBe(3)
    expect(normalized.items[0].sellPrice).toBe(12500)
  })
})

