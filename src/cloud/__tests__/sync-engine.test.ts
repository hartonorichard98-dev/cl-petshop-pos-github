import { describe, expect, it } from 'vitest'
import { pendingCount, takeBatch } from '../sync-engine'

describe('sync batching', () => {
  it('limits egress payload size', () => expect(takeBatch([1, 2, 3, 4], 2)).toEqual([1, 2]))
  it('counts all pending groups', () => expect(pendingCount([1, 2], [3], [])).toBe(3))
})

