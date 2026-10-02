import { describe, expect, it } from 'vitest'
import handler from '../pos-sync.js'

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    status(code) { this.statusCode = code; return this },
    setHeader(name, value) { this.headers[name] = value; return this },
    end(value = '') { this.body = value; return this },
  }
}

describe('pos-sync API', () => {
  it('rejects non-POST methods', async () => {
    const response = responseRecorder()
    await handler({ method: 'GET', headers: {} }, response)
    expect(response.statusCode).toBe(405)
  })

  it('fails closed when cloud configuration is missing', async () => {
    const response = responseRecorder()
    await handler({ method: 'POST', headers: {}, body: {} }, response)
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body).error).toBe('Cloud sync belum dikonfigurasi')
  })
})

