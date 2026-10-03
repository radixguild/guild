import { describe, it, expect } from 'vitest'
import {
  DISPUTE_WINDOW_MS,
  formatRemaining,
  getTaskCountdown,
} from '@/lib/countdown'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

describe('lib/countdown', () => {
  describe('DISPUTE_WINDOW_MS', () => {
    it('matches the deployed component dispute_auto_resolve_secs (259200 = 72h)', () => {
      expect(DISPUTE_WINDOW_MS).toBe(259_200 * 1000)
    })
  })

  describe('formatRemaining', () => {
    it('collapses sub-minute spans to "<1m"', () => {
      expect(formatRemaining(0)).toBe('<1m')
      expect(formatRemaining(59_999)).toBe('<1m')
      expect(formatRemaining(-5_000)).toBe('<1m')
    })

    it('formats exactly one minute (boundary)', () => {
      expect(formatRemaining(MINUTE)).toBe('1m')
    })

    it('formats minutes only', () => {
      expect(formatRemaining(32 * MINUTE)).toBe('32m')
    })

    it('formats hours with minute remainder', () => {
      expect(formatRemaining(4 * HOUR + 32 * MINUTE)).toBe('4h 32m')
    })

    it('formats whole hours without a zero-minute tail', () => {
      expect(formatRemaining(2 * HOUR)).toBe('2h')
    })

    it('formats days with hour remainder', () => {
      expect(formatRemaining(2 * DAY + 4 * HOUR)).toBe('2d 4h')
    })

    it('formats whole days without a zero-hour tail', () => {
      expect(formatRemaining(3 * DAY)).toBe('3d')
    })

    it('drops sub-leading units below days (no minutes shown)', () => {
      expect(formatRemaining(2 * DAY + 4 * HOUR + 59 * MINUTE)).toBe('2d 4h')
    })

    it('floors partial units instead of rounding up', () => {
      expect(formatRemaining(DAY - 1)).toBe('23h 59m')
      expect(formatRemaining(HOUR - 1)).toBe('59m')
    })
  })

  describe('getTaskCountdown', () => {
    const now = Date.UTC(2026, 5, 12, 12, 0, 0)

    describe('open tasks (deadline window)', () => {
      it('counts down to a future deadline', () => {
        const deadline = new Date(now + 2 * DAY + 4 * HOUR)
        expect(getTaskCountdown({ status: 'open', deadline }, now)).toEqual({
          kind: 'deadline',
          lapsed: false,
          label: 'due in 2d 4h',
        })
      })

      it('flips to "past due date" after the deadline (no negative time)', () => {
        const deadline = new Date(now - HOUR)
        expect(getTaskCountdown({ status: 'open', deadline }, now)).toEqual({
          kind: 'deadline',
          lapsed: true,
          label: 'past due date',
        })
      })

      it('treats the exact deadline instant as lapsed', () => {
        const deadline = new Date(now)
        expect(getTaskCountdown({ status: 'open', deadline }, now)?.lapsed).toBe(true)
      })

      it('returns null for an open task without a deadline', () => {
        expect(getTaskCountdown({ status: 'open', deadline: null }, now)).toBeNull()
      })
    })

    describe('disputed tasks (72h auto-resolve window)', () => {
      it('counts down from the persisted on-chain disputedAt when present', () => {
        const disputedAt = new Date(now - DAY) // disputed 1d ago → 2d left of 72h
        expect(getTaskCountdown({ status: 'disputed', disputedAt }, now)).toEqual({
          kind: 'dispute',
          lapsed: false,
          label: 'resolves in 2d',
        })
      })

      it('prefers the persisted disputedAt over the updatedAt approximation', () => {
        // The mainnet task-2 shape: updatedAt ran 10min EARLY vs the chain's
        // disputed_at. Near the window end the approximation flips the chip to
        // "finalize available" while the chain would still reject the call —
        // the persisted value must win.
        const disputedAt = new Date(now - DISPUTE_WINDOW_MS + 5 * MINUTE) // 5m left
        const updatedAt = new Date(disputedAt.getTime() - 10 * MINUTE) // lapsed if used
        expect(getTaskCountdown({ status: 'disputed', disputedAt, updatedAt }, now)).toEqual({
          kind: 'dispute',
          lapsed: false,
          label: 'resolves in 5m',
        })
      })

      it('falls back to updatedAt for legacy rows without a persisted disputedAt', () => {
        const updatedAt = new Date(now - DAY)
        expect(
          getTaskCountdown({ status: 'disputed', disputedAt: null, updatedAt }, now)
        ).toEqual({
          kind: 'dispute',
          lapsed: false,
          label: 'resolves in 2d',
        })
      })

      it('shows the full window for a just-raised dispute', () => {
        const updatedAt = new Date(now)
        expect(getTaskCountdown({ status: 'disputed', updatedAt }, now)).toEqual({
          kind: 'dispute',
          lapsed: false,
          label: 'resolves in 3d',
        })
      })

      it('flips to "finalize available" once the 72h window lapses', () => {
        const updatedAt = new Date(now - DISPUTE_WINDOW_MS - 1)
        expect(getTaskCountdown({ status: 'disputed', updatedAt }, now)).toEqual({
          kind: 'dispute',
          lapsed: true,
          label: 'finalize available',
        })
      })

      it('treats the exact window end as lapsed', () => {
        const updatedAt = new Date(now - DISPUTE_WINDOW_MS)
        expect(getTaskCountdown({ status: 'disputed', updatedAt }, now)?.lapsed).toBe(true)
      })

      it('returns null when both dispute timestamps are missing', () => {
        expect(
          getTaskCountdown({ status: 'disputed', disputedAt: null, updatedAt: null }, now)
        ).toBeNull()
      })

      it('ignores the deadline for disputed tasks', () => {
        const result = getTaskCountdown(
          { status: 'disputed', deadline: new Date(now + DAY), updatedAt: new Date(now) },
          now
        )
        expect(result?.kind).toBe('dispute')
      })
    })

    describe('other statuses (no window)', () => {
      it.each(['assigned', 'submitted', 'paid', 'cancelled', 'refunded'])(
        'returns null for %s tasks even with a deadline set',
        (status) => {
          const deadline = new Date(now + DAY)
          const updatedAt = new Date(now - DAY)
          expect(getTaskCountdown({ status, deadline, updatedAt }, now)).toBeNull()
        }
      )
    })
  })
})
