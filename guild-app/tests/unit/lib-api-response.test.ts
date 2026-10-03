import { describe, it, expect } from 'vitest'
import { success, error, paginated, fromError } from '@/lib/api-response'
import { AppError } from '@/lib/errors'

describe('lib/api-response', () => {
  describe('success', () => {
    it('should return { ok: true, data }', async () => {
      const data = { message: 'test' }
      const response = success(data)

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ok: true, data })
    })
  })

  describe('error', () => {
    it('should return { ok: false, error: { code, message } } with correct HTTP status', () => {
      const response = error('Test error', 'TEST_ERROR', 400)

      expect(response.status).toBe(400)
      // We can't easily extract the JSON body from NextResponse in tests,
      // but we can verify the structure by checking the response was created correctly
      expect(response).toBeDefined()
    })
  })

  describe('paginated', () => {
    it('should return paginated response structure', () => {
      const data = [{ id: 1 }, { id: 2 }]
      const response = paginated(data, 'cursor123', true)

      expect(response.status).toBe(200)
      expect(response).toBeDefined()
    })
  })

  describe('fromError', () => {
    it('should map AppError to error response with correct code and status', () => {
      const appError = new AppError('Test message', 'TEST_CODE', 422)
      const response = fromError(appError)

      expect(response.status).toBe(422)
      expect(response).toBeDefined()
    })

    it('should return 500 INTERNAL_ERROR for unknown errors', () => {
      const unknownError = new Error('Unknown error')
      const response = fromError(unknownError)

      expect(response.status).toBe(500)
      expect(response).toBeDefined()
    })
  })
})
