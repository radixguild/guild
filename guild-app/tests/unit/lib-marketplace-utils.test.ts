import { describe, it, expect } from 'vitest'
import {
  formatXrd,
  formatAddress,
  getStatusColor,
} from '@/lib/marketplace-utils'

describe('lib/marketplace-utils', () => {
  describe('formatXrd', () => {
    it('formats integer string with locale grouping', () => {
      expect(formatXrd('1000')).toBe(`${Number('1000').toLocaleString()} XRD`)
    })

    it('formats decimal string', () => {
      expect(formatXrd('1.5')).toBe('1.5 XRD')
    })

    it('formats zero', () => {
      expect(formatXrd('0')).toBe('0 XRD')
    })

    it('formats large decimal locale-stably', () => {
      const input = '1234567.89'
      expect(formatXrd(input)).toBe(`${Number(input).toLocaleString()} XRD`)
    })
  })

  describe('formatAddress', () => {
    it('returns address unchanged when shorter than 20 chars', () => {
      expect(formatAddress('short_addr')).toBe('short_addr')
    })

    it('returns address unchanged at exactly 20 chars (boundary)', () => {
      const addr = 'a'.repeat(20)
      expect(formatAddress(addr)).toBe(addr)
    })

    it('truncates address longer than 20 chars', () => {
      const addr = 'a'.repeat(21)
      expect(formatAddress(addr)).toBe(`${addr.slice(0, 12)}...${addr.slice(-6)}`)
    })

    it('truncates a realistic radix mainnet account address', () => {
      const addr = 'account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw'
      expect(formatAddress(addr)).toBe('account_rdx1...k9u5mw')
    })
  })

  describe('getStatusColor', () => {
    it('returns class for open', () => {
      expect(getStatusColor('open')).toBe('bg-green-500/10 text-green-500')
    })

    it('returns class for assigned', () => {
      expect(getStatusColor('assigned')).toBe('bg-yellow-500/10 text-yellow-500')
    })

    it('returns class for submitted', () => {
      expect(getStatusColor('submitted')).toBe('bg-blue-500/10 text-blue-500')
    })

    it('returns class for paid', () => {
      expect(getStatusColor('paid')).toBe('bg-muted text-muted-foreground')
    })

    it('returns class for cancelled', () => {
      expect(getStatusColor('cancelled')).toBe('bg-red-500/10 text-red-500')
    })

    it('returns class for disputed', () => {
      expect(getStatusColor('disputed')).toBe('bg-orange-500/10 text-orange-500')
    })
  })
})
