import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { createSession, verifySession, getSessionUser, withAuth } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

// Mock jose, next/headers and the users query module — hoisted so vi.mock
// factories can reference them
const { mockSignJWT, mockJwtVerify, mockCookies, mockFindUserById } = vi.hoisted(() => {
  const mockSignJWT = {
    setProtectedHeader: vi.fn().mockReturnThis(),
    setIssuedAt: vi.fn().mockReturnThis(),
    setExpirationTime: vi.fn().mockReturnThis(),
    sign: vi.fn(),
  }
  const mockJwtVerify = vi.fn()
  const mockCookies = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  }
  const mockFindUserById = vi.fn()
  return { mockSignJWT, mockJwtVerify, mockCookies, mockFindUserById }
})

vi.mock('jose', () => ({
  // class form so `new SignJWT(...)` works
  SignJWT: class { constructor() { return mockSignJWT } },
  jwtVerify: mockJwtVerify,
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => mockCookies),
}))

// withAuth's suspension check (P1-14) reads the DB via findUserById — mock it
// so these tests stay DB-free. Default resolves to null (no row / not
// suspended); individual tests override for the suspension cases.
vi.mock('@/db/queries/users', () => ({
  findUserById: mockFindUserById,
}))

beforeAll(() => {
  vi.stubEnv('JWT_SECRET', 'test-secret-do-not-use-in-prod')
})

beforeEach(() => {
  vi.clearAllMocks()
  // Re-bind chainable methods
  mockSignJWT.setProtectedHeader.mockReturnValue(mockSignJWT)
  mockSignJWT.setIssuedAt.mockReturnValue(mockSignJWT)
  mockSignJWT.setExpirationTime.mockReturnValue(mockSignJWT)
  mockFindUserById.mockResolvedValue(null)
})

describe('lib/auth', () => {
  describe('createSession', () => {
    it('should return a JWT string for a given userId', async () => {
      const mockToken = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ0ZXN0LXVzZXIifQ.signature'
      mockSignJWT.sign.mockResolvedValue(mockToken)

      const result = await createSession('test-user')

      expect(mockSignJWT.setProtectedHeader).toHaveBeenCalledWith({ alg: 'HS256' })
      expect(mockSignJWT.setIssuedAt).toHaveBeenCalled()
      expect(mockSignJWT.setExpirationTime).toHaveBeenCalledWith('604800s') // 7 days
      expect(mockSignJWT.sign).toHaveBeenCalled()
      expect(result).toBe(mockToken)
    })
  })

  describe('verifySession', () => {
    it('should decode a valid token and return { userId }', async () => {
      const mockPayload = { userId: 'test-user' }
      mockJwtVerify.mockResolvedValue({ payload: mockPayload })

      const result = await verifySession('valid-token')

      expect(mockJwtVerify).toHaveBeenCalledWith('valid-token', expect.any(Uint8Array))
      expect(result).toEqual({ userId: 'test-user' })
    })

    it('should return null on invalid/expired token', async () => {
      mockJwtVerify.mockRejectedValue(new Error('JWTExpired'))

      const result = await verifySession('invalid-token')

      expect(result).toBeNull()
    })
  })

  describe('getSessionUser', () => {
    it('should read cookie and return userId', async () => {
      const mockToken = 'valid-token'
      const mockPayload = { userId: 'test-user' }
      mockCookies.get.mockReturnValue({ value: mockToken })
      mockJwtVerify.mockResolvedValue({ payload: mockPayload })

      const result = await getSessionUser()

      expect(mockCookies.get).toHaveBeenCalledWith('guild_session')
      expect(result).toEqual({ userId: 'test-user' })
    })

    it('should return null when cookie missing', async () => {
      mockCookies.get.mockReturnValue(undefined)

      const result = await getSessionUser()

      expect(result).toBeNull()
    })
  })

  describe('withAuth', () => {
    it('should call handler with user when authenticated', async () => {
      const mockUser = { userId: 'test-user' }
      const mockHandler = vi.fn().mockResolvedValue(NextResponse.json({ success: true }))
      const mockReq = {} as NextRequest
      const mockCtx = { params: Promise.resolve({}) }

      mockCookies.get.mockReturnValue({ value: 'valid-token' })
      mockJwtVerify.mockResolvedValue({ payload: mockUser })

      const wrappedHandler = withAuth(mockHandler)
      await wrappedHandler(mockReq, mockCtx)

      expect(mockHandler).toHaveBeenCalledWith(mockReq, { ...mockCtx, user: mockUser })
    })

    it('should return 401 when not authenticated', async () => {
      const mockHandler = vi.fn()
      const mockReq = {} as NextRequest
      const mockCtx = { params: Promise.resolve({}) }

      mockCookies.get.mockReturnValue(undefined)

      const wrappedHandler = withAuth(mockHandler)
      const response = await wrappedHandler(mockReq, mockCtx)

      expect(mockHandler).not.toHaveBeenCalled()
      expect(response.status).toBe(401)
    })

    // P1-14 (catalogue task 86): app-level account suspension, enforced here
    // — the one place every authed route passes through.
    describe('suspension (P1-14)', () => {
      it('returns 403 ACCOUNT_SUSPENDED and never calls the handler for a suspended user', async () => {
        const mockUser = { userId: 'account_rdx1suspended' }
        const mockHandler = vi.fn()
        const mockReq = {} as NextRequest
        const mockCtx = { params: Promise.resolve({}) }

        mockCookies.get.mockReturnValue({ value: 'valid-token' })
        mockJwtVerify.mockResolvedValue({ payload: mockUser })
        mockFindUserById.mockResolvedValue({
          id: mockUser.userId,
          suspendedAt: new Date('2026-09-15T00:00:00Z'),
          suspendedReason: 'compromised key',
        })

        const wrappedHandler = withAuth(mockHandler)
        const response = await wrappedHandler(mockReq, mockCtx)
        const body = await response.json()

        expect(mockHandler).not.toHaveBeenCalled()
        expect(response.status).toBe(403)
        expect(body).toEqual({
          ok: false,
          error: { code: 'ACCOUNT_SUSPENDED', message: expect.any(String) },
        })
      })

      it('calls the handler for an active user (suspendedAt null)', async () => {
        const mockUser = { userId: 'account_rdx1active' }
        const mockHandler = vi.fn().mockResolvedValue(NextResponse.json({ success: true }))
        const mockReq = {} as NextRequest
        const mockCtx = { params: Promise.resolve({}) }

        mockCookies.get.mockReturnValue({ value: 'valid-token' })
        mockJwtVerify.mockResolvedValue({ payload: mockUser })
        mockFindUserById.mockResolvedValue({
          id: mockUser.userId,
          suspendedAt: null,
          suspendedReason: null,
        })

        const wrappedHandler = withAuth(mockHandler)
        await wrappedHandler(mockReq, mockCtx)

        expect(mockHandler).toHaveBeenCalledWith(mockReq, { ...mockCtx, user: mockUser })
      })

      it('calls the handler when the user has no DB row at all (never suspended)', async () => {
        const mockUser = { userId: 'account_rdx1norow' }
        const mockHandler = vi.fn().mockResolvedValue(NextResponse.json({ success: true }))
        const mockReq = {} as NextRequest
        const mockCtx = { params: Promise.resolve({}) }

        mockCookies.get.mockReturnValue({ value: 'valid-token' })
        mockJwtVerify.mockResolvedValue({ payload: mockUser })
        mockFindUserById.mockResolvedValue(null)

        const wrappedHandler = withAuth(mockHandler)
        await wrappedHandler(mockReq, mockCtx)

        expect(mockHandler).toHaveBeenCalledWith(mockReq, { ...mockCtx, user: mockUser })
      })
    })
  })
})
