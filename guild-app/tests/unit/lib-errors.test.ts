import { describe, it, expect } from 'vitest'
import { AppError, AuthError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors'

describe('lib/errors', () => {
  describe('AppError', () => {
    it('should expose correct code and statusCode', () => {
      const error = new AppError('Test message', 'TEST_CODE', 422)

      expect(error.message).toBe('Test message')
      expect(error.code).toBe('TEST_CODE')
      expect(error.statusCode).toBe(422)
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(AppError)
    })
  })

  describe('AuthError', () => {
    it('should expose correct code and httpStatus', () => {
      const error = new AuthError()

      expect(error.message).toBe('Authentication required')
      expect(error.code).toBe('AUTH_ERROR')
      expect(error.statusCode).toBe(401)
      expect(error).toBeInstanceOf(AppError)
    })

    it('should accept custom message', () => {
      const error = new AuthError('Custom auth message')

      expect(error.message).toBe('Custom auth message')
      expect(error.code).toBe('AUTH_ERROR')
      expect(error.statusCode).toBe(401)
    })
  })

  describe('ForbiddenError', () => {
    it('should expose correct code and httpStatus', () => {
      const error = new ForbiddenError()

      expect(error.message).toBe('Forbidden')
      expect(error.code).toBe('FORBIDDEN')
      expect(error.statusCode).toBe(403)
      expect(error).toBeInstanceOf(AppError)
    })
  })

  describe('NotFoundError', () => {
    it('should expose correct code and httpStatus', () => {
      const error = new NotFoundError()

      expect(error.message).toBe('Not found')
      expect(error.code).toBe('NOT_FOUND')
      expect(error.statusCode).toBe(404)
      expect(error).toBeInstanceOf(AppError)
    })
  })

  describe('ValidationError', () => {
    it('should expose correct code and httpStatus', () => {
      const error = new ValidationError()

      expect(error.message).toBe('Validation failed')
      expect(error.code).toBe('VALIDATION_ERROR')
      expect(error.statusCode).toBe(400)
      expect(error).toBeInstanceOf(AppError)
    })

    it('should accept details parameter', () => {
      const details = { field: 'invalid' }
      const error = new ValidationError('Custom validation message', details)

      expect(error.message).toBe('Custom validation message')
      expect(error.details).toEqual(details)
    })
  })

  describe('error type checking', () => {
    it('should identify AppError instances correctly', () => {
      const appError = new AppError('test', 'TEST', 400)
      const authError = new AuthError()
      const plainError = new Error('plain')
      const notError = { message: 'not an error' }

      expect(appError instanceof AppError).toBe(true)
      expect(authError instanceof AppError).toBe(true)
      expect(plainError instanceof AppError).toBe(false)
      expect(notError instanceof AppError).toBe(false)
    })
  })
})
