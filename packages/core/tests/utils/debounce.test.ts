import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { debounce } from "../../src/utils/debounce.js"

describe("debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("delays function execution by the specified delay", () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 100)

    debounced()
    expect(fn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(99)
    expect(fn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledOnce()
  })

  it("resets the timer on subsequent calls", () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 100)

    debounced()
    vi.advanceTimersByTime(50)
    debounced()
    vi.advanceTimersByTime(50)
    expect(fn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(50)
    expect(fn).toHaveBeenCalledOnce()
  })

  it("passes arguments to the debounced function", () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 100)

    debounced("hello", 42)
    vi.advanceTimersByTime(100)

    expect(fn).toHaveBeenCalledWith("hello", 42)
  })

  it("uses arguments from the last call when reset", () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 100)

    debounced("first")
    vi.advanceTimersByTime(50)
    debounced("second")
    vi.advanceTimersByTime(100)

    expect(fn).toHaveBeenCalledOnce()
    expect(fn).toHaveBeenCalledWith("second")
  })

  it("can be called multiple times after firing", () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 100)

    debounced()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(1)

    debounced()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("handles zero delay", () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 0)

    debounced()
    vi.advanceTimersByTime(0)
    expect(fn).toHaveBeenCalledOnce()
  })
})
