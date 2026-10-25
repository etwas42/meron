import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test'
import { formatEventRange, formatThreadDate, taskIsOverdue, fromDateInputValue } from './date'

// Fixed reference: Wednesday 2026-06-10 15:30 local time.
const NOW = new Date(2026, 5, 10, 15, 30, 0)

// Epoch seconds for a local Date.
const sec = (d: Date) => Math.floor(d.getTime() / 1000)

beforeEach(() => {
  setSystemTime(NOW)
})

afterEach(() => {
  setSystemTime()
})

describe('formatThreadDate', () => {
  it('returns empty for unknown (0)', () => {
    expect(formatThreadDate(0)).toBe('')
  })

  it('formats a same-day timestamp as HH:MM', () => {
    expect(formatThreadDate(sec(new Date(2026, 5, 10, 9, 5)))).toBe('09:05')
  })

  it('formats yesterday as month + day', () => {
    expect(formatThreadDate(sec(new Date(2026, 5, 9, 9, 0)))).toMatch(/Jun 9/)
  })

  it('formats earlier this week as month + day', () => {
    // Monday 2026-06-08, two days before the fixed "now".
    expect(formatThreadDate(sec(new Date(2026, 5, 8, 9, 0)))).toMatch(/Jun 8/)
  })

  it('formats older dates as month + day', () => {
    expect(formatThreadDate(sec(new Date(2026, 4, 1, 9, 0)))).toMatch(/May 1/)
  })

  it('includes the year for prior-year dates', () => {
    expect(formatThreadDate(sec(new Date(2025, 11, 31, 9, 0)))).toMatch(/2025/)
  })
})

describe('taskIsOverdue', () => {
  it('only marks dates before today overdue', () => {
    expect(taskIsOverdue(fromDateInputValue('2026-06-09'))).toBe(true)
    expect(taskIsOverdue(fromDateInputValue('2026-06-10'))).toBe(false)
    expect(taskIsOverdue(fromDateInputValue('2026-06-11'))).toBe(false)
    expect(taskIsOverdue(0)).toBe(false)
  })

  it('becomes overdue at the next local midnight', () => {
    const due = fromDateInputValue('2026-03-08')
    expect(taskIsOverdue(due, new Date(2026, 2, 8, 23, 59, 59).getTime())).toBe(false)
    expect(taskIsOverdue(due, new Date(2026, 2, 9).getTime())).toBe(true)
  })
})

describe('formatEventRange', () => {
  it('an all-day event shows its UTC dates whatever the local zone', () => {
    const christmasEve = Date.UTC(2026, 11, 24) / 1000
    const oneDay = formatEventRange(christmasEve, christmasEve + 86_400, true)
    expect(oneDay).toMatch(/\b24\b/)
    expect(oneDay).not.toMatch(/\b25\b/)
    const twoDays = formatEventRange(christmasEve, christmasEve + 2 * 86_400, true)
    expect(twoDays).toMatch(/\b24\b/)
    expect(twoDays).toMatch(/\b25\b/)
    expect(twoDays).not.toMatch(/\b26\b/)
  })

  it('a timed event spans its start and end, and an unknown start shows nothing', () => {
    const start = new Date(2026, 9, 22, 10, 0).getTime() / 1000
    const range = formatEventRange(start, start + 3600, false)
    expect(range).toMatch(/\b10:00\b/)
    expect(range).toMatch(/\b11:00\b/)
    expect(formatEventRange(start, start, false)).not.toMatch(/[–-]\s*\d/)
    expect(formatEventRange(0, 0, false)).toBe('')
  })
})
