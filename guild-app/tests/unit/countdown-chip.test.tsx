import { describe, it, expect, beforeEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

import { CountdownChip } from "@/components/tasks/countdown-chip"

// Render-path checks for the chip itself; the window/label threshold logic is
// pinned in lib-countdown.test.ts. In RTL this is a pure client render, so the
// useSyncExternalStore client snapshot applies immediately (the null server
// snapshot only ever renders during SSR/hydration).

const HOUR = 3_600_000
const DAY = 86_400_000

describe("CountdownChip", () => {
  beforeEach(() => cleanup())

  it("shows a deadline countdown for an open task", () => {
    render(
      <CountdownChip
        status="open"
        deadline={new Date(Date.now() + 2 * DAY + 4 * HOUR + HOUR / 2)}
      />
    )
    expect(screen.getByText(/due in 2d 4h/)).toBeInTheDocument()
  })

  it("shows the lapsed state for a disputed task past the 72h window", () => {
    render(
      <CountdownChip status="disputed" updatedAt={new Date(Date.now() - 4 * DAY)} />
    )
    expect(screen.getByText("finalize available")).toBeInTheDocument()
  })

  it("shows the dispute countdown for a fresh dispute", () => {
    render(
      <CountdownChip status="disputed" updatedAt={new Date(Date.now() - HOUR)} />
    )
    expect(screen.getByText(/resolves in 2d 23h/)).toBeInTheDocument()
  })

  it("counts from the persisted disputedAt, not the updatedAt approximation", () => {
    // updatedAt says the window lapsed; the persisted on-chain time says 1h
    // in — the chip must follow the chain's clock.
    render(
      <CountdownChip
        status="disputed"
        disputedAt={new Date(Date.now() - HOUR)}
        updatedAt={new Date(Date.now() - 4 * DAY)}
      />
    )
    expect(screen.getByText(/resolves in 2d 23h/)).toBeInTheDocument()
  })

  it("renders nothing when no timing window applies", () => {
    const { container } = render(
      <CountdownChip status="assigned" deadline={new Date(Date.now() + DAY)} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing for an open task without a deadline", () => {
    const { container } = render(<CountdownChip status="open" deadline={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})
