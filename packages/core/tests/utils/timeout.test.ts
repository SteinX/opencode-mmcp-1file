import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/utils/logger.js", () => ({
  logger: {
    warn: vi.fn(),
  },
}))

import { logger } from "../../src/utils/logger.js"

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns result when promise resolves before timeout", async () => {
    const { withTimeout } = await import("../../src/utils/timeout.js")
    const promise = Promise.resolve("ok")

    await expect(withTimeout(promise, 100, { fallback: "fallback" })).resolves.toBe("ok")
  })

  it("returns fallback null when promise exceeds timeout", async () => {
    const { withTimeout } = await import("../../src/utils/timeout.js")
    const promise = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200))

    const resultPromise = withTimeout(promise, 50, { fallback: null })
    await vi.advanceTimersByTimeAsync(50)

    await expect(resultPromise).resolves.toBeNull()
  })

  it("logs a warning on timeout", async () => {
    const { withTimeout } = await import("../../src/utils/timeout.js")
    const promise = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200))

    const resultPromise = withTimeout(promise, 50, { fallback: "fallback", label: "load data" })
    await vi.advanceTimersByTimeAsync(50)
    await resultPromise

    expect(logger.warn).toHaveBeenCalledOnce()
  })

  it("does not throw or reject on timeout", async () => {
    const { withTimeout } = await import("../../src/utils/timeout.js")
    const promise = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200))

    const resultPromise = withTimeout(promise, 50, { fallback: "fallback" })
    await vi.advanceTimersByTimeAsync(50)

    await expect(resultPromise).resolves.toBe("fallback")
  })

  it("returns fallback when fallback is null", async () => {
    const { withTimeout } = await import("../../src/utils/timeout.js")
    const promise = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200))

    const resultPromise = withTimeout(promise, 50, { fallback: null })
    await vi.advanceTimersByTimeAsync(50)

    await expect(resultPromise).resolves.toBeNull()
  })

  it("includes custom label in warning log message", async () => {
    const { withTimeout } = await import("../../src/utils/timeout.js")
    const promise = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200))

    const resultPromise = withTimeout(promise, 50, { fallback: "fallback", label: "sync records" })
    await vi.advanceTimersByTimeAsync(50)
    await resultPromise

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("sync records"))
  })

  it("clears the timer when the main promise wins", async () => {
    const { withTimeout } = await import("../../src/utils/timeout.js")
    const promise = Promise.resolve("fast")

    await expect(withTimeout(promise, 100, { fallback: "fallback" })).resolves.toBe("fast")
    expect(vi.getTimerCount()).toBe(0)
  })
})
