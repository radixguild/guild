import { describe, it, expect } from 'vitest'
import {
  DISPUTE_WINDOW_MS,
  disputeWindowMs,
  formatRemaining,
  getTaskCountdown,
  windowLengthLabel,
} from '@/lib/countdown'
import { DEFAULT_DISPUTE_WINDOW_DAYS, DEFAULT_DISPUTE_WINDOW_HOURS } from '@/lib/marketplace'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

describe('lib/countdown', () => {
  describe('DISPUTE_WINDOW_MS', () => {
    // The live component's dispute_auto_resolve_secs since the owner's
    // 2026-10-11 set_dispute_auto_resolve_secs (it was instantiated at 259200 =
    // 72h). Display default only — a dispute keeps the window pinned at raise.
    it('matches the live component dispute_auto_resolve_secs (604800 = 7 days)', () => {
      expect(DISPUTE_WINDOW_MS).toBe(604_800 * 1000)
      expect(DEFAULT_DISPUTE_WINDOW_HOURS).toBe(168)
      expect(DEFAULT_DISPUTE_WINDOW_DAYS).toBe(7)
    })
  })

  describe('disputeWindowMs — prefer the window pinned on the task', () => {
    it('uses a readable pinned value (a dispute raised under the old 72h window keeps it)', () => {
      expect(disputeWindowMs(259_200)).toBe(72 * HOUR)
      expect(disputeWindowMs(604_800)).toBe(7 * DAY)
    })

    it('falls back to the default when there is no usable pin', () => {
      for (const pinned of [undefined, null, 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
        expect(disputeWindowMs(pinned as number | null | undefined)).toBe(DISPUTE_WINDOW_MS)
      }
    })
  })

  describe('windowLengthLabel', () => {
    it('reads 72h as hours (how it was always described) and 7 days as days', () => {
      expect(windowLengthLabel(72 * HOUR)).toBe('72-hour')
      expect(windowLengthLabel(7 * DAY)).toBe('7-day')
      expect(windowLengthLabel(DISPUTE_WINDOW_MS)).toBe(`${DEFAULT_DISPUTE_WINDOW_DAYS}-day`)
      expect(windowLengthLabel(100 * HOUR)).toBe('100-hour')
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

    describe('disputed tasks (7-day default auto-resolve window, pinned window preferred)', () => {
      it('counts down from the persisted on-chain disputedAt when present', () => {
        const disputedAt = new Date(now - DAY) // disputed 1d ago → 6d left of 7 days
        expect(getTaskCountdown({ status: 'disputed', disputedAt }, now)).toEqual({
          kind: 'dispute',
          lapsed: false,
          label: 'resolves in 6d',
        })
      })

      it('uses the task\'s PINNED window when the caller has it (72h pin, raised before the change)', () => {
        const disputedAt = new Date(now - DAY)
        expect(
          getTaskCountdown({ status: 'disputed', disputedAt, disputeAutoResolveSecs: 259_200 }, now)
        ).toEqual({ kind: 'dispute', lapsed: false, label: 'resolves in 2d' })
        // Four days in: lapsed on a 72h pin, three days left on the default.
        const fourDaysIn = new Date(now - 4 * DAY)
        expect(
          getTaskCountdown({ status: 'disputed', disputedAt: fourDaysIn, disputeAutoResolveSecs: 259_200 }, now)
        ).toEqual({ kind: 'dispute', lapsed: true, label: 'finalize available' })
        expect(getTaskCountdown({ status: 'disputed', disputedAt: fourDaysIn }, now)?.label).toBe('resolves in 3d')
      })

      it('falls back to the default when the pinned window is null', () => {
        const disputedAt = new Date(now - DAY)
        expect(
          getTaskCountdown({ status: 'disputed', disputedAt, disputeAutoResolveSecs: null }, now)?.label
        ).toBe('resolves in 6d')
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
          label: 'resolves in 6d',
        })
      })

      it('shows the full window for a just-raised dispute', () => {
        const updatedAt = new Date(now)
        expect(getTaskCountdown({ status: 'disputed', updatedAt }, now)).toEqual({
          kind: 'dispute',
          lapsed: false,
          label: 'resolves in 7d',
        })
      })

      it('flips to "finalize available" once the window lapses', () => {
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
