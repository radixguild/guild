import { describe, it, expect } from 'vitest'
import {
  createTaskSchema,
  updateTaskSchema,
  createSubmissionSchema,
  reviewSubmissionSchema,
  verifyAuthSchema,
} from '@/lib/validation'

describe('lib/validation', () => {
  describe('createTaskSchema', () => {
    it('should accept a valid task input', () => {
      const validTask = {
        title: 'Test Task',
        description: 'A test task description',
        reward_amount: '10.5',
        requirements: 'Some requirements',
        deadline: '2024-12-31T23:59:59.000Z',
      }

      const result = createTaskSchema.safeParse(validTask)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(validTask)
      }
    })

    it('should reject bad reward_amount (non-numeric)', () => {
      const invalidTask = {
        title: 'Test Task',
        description: 'A test task description',
        reward_amount: 'not-a-number',
      }

      const result = createTaskSchema.safeParse(invalidTask)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some(issue => 
          issue.path.includes('reward_amount') && issue.message.includes('Invalid XRD amount')
        )).toBe(true)
      }
    })

    it('should reject reward_amount with too many decimals', () => {
      const invalidTask = {
        title: 'Test Task',
        description: 'A test task description',
        reward_amount: '10.123456789', // 9 decimals, max is 8
      }

      const result = createTaskSchema.safeParse(invalidTask)

      expect(result.success).toBe(false)
    })
  })

  describe('reviewSubmissionSchema', () => {
    it('should reject status outside its enum', () => {
      const invalidReview = {
        status: 'invalid_status',
        reviewer_notes: 'Some notes',
      }

      const result = reviewSubmissionSchema.safeParse(invalidReview)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some(issue => 
          issue.path.includes('status')
        )).toBe(true)
      }
    })

    it('should accept valid status values', () => {
      const validStatuses = ['approved', 'rejected', 'revision_requested']
      
      for (const status of validStatuses) {
        const validReview = {
          status,
          reviewer_notes: 'Some notes',
        }

        const result = reviewSubmissionSchema.safeParse(validReview)
        expect(result.success).toBe(true)
      }
    })
  })

  describe('updateTaskSchema', () => {
    it('should accept a valid update with all optional fields', () => {
      const validUpdate = {
        title: 'Updated Task',
        description: 'Updated description',
        reward_amount: '15.25',
        requirements: 'Updated requirements',
        deadline: '2024-12-31T23:59:59.000Z',
      }

      const result = updateTaskSchema.safeParse(validUpdate)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(validUpdate)
      }
    })

    it('should accept update with only some fields', () => {
      const partialUpdate = {
        title: 'Just updating title',
      }

      const result = updateTaskSchema.safeParse(partialUpdate)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(partialUpdate)
      }
    })

    it('should reject malformed reward_amount', () => {
      const invalidUpdate = {
        reward_amount: 'not-a-number',
      }

      const result = updateTaskSchema.safeParse(invalidUpdate)

      expect(result.success).toBe(false)
    })

    it('should reject too-long title', () => {
      const invalidUpdate = {
        title: 'a'.repeat(201), // max is 200
      }

      const result = updateTaskSchema.safeParse(invalidUpdate)

      expect(result.success).toBe(false)
    })
  })

  describe('createSubmissionSchema', () => {
    it('should accept valid submission content', () => {
      const validSubmission = {
        content: 'Here is my submission content',
      }

      const result = createSubmissionSchema.safeParse(validSubmission)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(validSubmission)
      }
    })

    it('should reject missing content', () => {
      const invalidSubmission = {}

      const result = createSubmissionSchema.safeParse(invalidSubmission)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some(issue => 
          issue.path.includes('content')
        )).toBe(true)
      }
    })

    it('should reject empty content', () => {
      const invalidSubmission = {
        content: '',
      }

      const result = createSubmissionSchema.safeParse(invalidSubmission)

      expect(result.success).toBe(false)
    })

    it('should reject too-long content', () => {
      const invalidSubmission = {
        content: 'a'.repeat(10001), // max is 10000
      }

      const result = createSubmissionSchema.safeParse(invalidSubmission)

      expect(result.success).toBe(false)
    })
  })

  describe('reviewSubmissionSchema', () => {
    it('should accept valid review with all fields', () => {
      const validReview = {
        status: 'approved' as const,
        reviewer_notes: 'Looks good to me',
      }

      const result = reviewSubmissionSchema.safeParse(validReview)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(validReview)
      }
    })

    it('should accept review without optional reviewer_notes', () => {
      const validReview = {
        status: 'rejected' as const,
      }

      const result = reviewSubmissionSchema.safeParse(validReview)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(validReview)
      }
    })

    it('should reject invalid status enum value', () => {
      const invalidReview = {
        status: 'invalid_status',
        reviewer_notes: 'Some notes',
      }

      const result = reviewSubmissionSchema.safeParse(invalidReview)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some(issue => 
          issue.path.includes('status')
        )).toBe(true)
      }
    })

    it('should reject too-long reviewer_notes', () => {
      const invalidReview = {
        status: 'approved' as const,
        reviewer_notes: 'a'.repeat(5001), // max is 5000
      }

      const result = reviewSubmissionSchema.safeParse(invalidReview)

      expect(result.success).toBe(false)
    })
  })

  describe('verifyAuthSchema', () => {
    it('should accept valid auth structure', () => {
      const validAuth = {
        signed_challenge: {
          challenge: 'test-challenge',
          address: 'account_rdx123',
          proof: {
            publicKey: 'test-key',
            signature: 'test-signature',
            curve: 'curve25519' as const,
          },
          type: 'account' as const,
        },
      }

      const result = verifyAuthSchema.safeParse(validAuth)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(validAuth)
      }
    })

    it('should accept persona type', () => {
      const validAuth = {
        signed_challenge: {
          challenge: 'test-challenge',
          address: 'identity_rdx123',
          proof: {
            publicKey: 'test-key',
            signature: 'test-signature',
            curve: 'secp256k1' as const,
          },
          type: 'persona' as const,
        },
      }

      const result = verifyAuthSchema.safeParse(validAuth)

      expect(result.success).toBe(true)
    })

    it('should reject missing challenge', () => {
      const invalidAuth = {
        signed_challenge: {
          address: 'account_rdx123',
          proof: {
            publicKey: 'test-key',
            signature: 'test-signature',
            curve: 'curve25519' as const,
          },
          type: 'account' as const,
        },
      }

      const result = verifyAuthSchema.safeParse(invalidAuth)

      expect(result.success).toBe(false)
    })

    it('should reject missing proof fields', () => {
      const invalidAuth = {
        signed_challenge: {
          challenge: 'test-challenge',
          address: 'account_rdx123',
          proof: {
            publicKey: 'test-key',
            // missing signature and curve
          },
          type: 'account' as const,
        },
      }

      const result = verifyAuthSchema.safeParse(invalidAuth)

      expect(result.success).toBe(false)
    })

    it('should reject wrong curve type', () => {
      const invalidAuth = {
        signed_challenge: {
          challenge: 'test-challenge',
          address: 'account_rdx123',
          proof: {
            publicKey: 'test-key',
            signature: 'test-signature',
            curve: 'invalid-curve',
          },
          type: 'account' as const,
        },
      }

      const result = verifyAuthSchema.safeParse(invalidAuth)

      expect(result.success).toBe(false)
    })
  })
})
