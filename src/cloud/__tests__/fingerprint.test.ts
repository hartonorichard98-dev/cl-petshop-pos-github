import { describe, expect, it } from 'vitest'
import { changedAfter, saleFingerprint } from '../fingerprint'
import type { CloudSale } from '../types'

const sale: CloudSale = {
  id: 'sale-1', receipt: '021026-0001', items: [], total: 10000,
  paymentMethod: 'cash', status: 'completed', day: '2026-10-02', createdAt: '2026-10-02T10:00:00Z',
}

describe('cloud fingerprints', () => {
  it('stays stable for same payload and changes when status changes', () => {
    expect(saleFingerprint(sale)).toBe(saleFingerprint({ ...sale }))
    expect(saleFingerprint(sale)).not.toBe(saleFingerprint({ ...sale, status: 'voided' }))
  })

  it('returns only rows newer than cursor', () => {
    const rows = [{ id: 'old', updatedAt: '2026-10-02T09:00:00Z' }, { id: 'new', updatedAt: '2026-10-02T11:00:00Z' }]
    expect(changedAfter(rows, '2026-10-02T10:00:00Z', ['updatedAt']).map((row) => row.id)).toEqual(['new'])
  })
})

