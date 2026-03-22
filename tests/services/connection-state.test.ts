import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { logger } = await import("../../src/utils/logger.js")

const {
  isConnectionFailed,
  markConnectionFailed,
  markConnectionHealthy,
  getConnectionStatus,
  startRetryLoop,
  stopRetryLoop,
  _resetForTest,
} = await import("../../src/services/connection-state.js")

describe("connection-state", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetForTest()
    vi.clearAllMocks()
  })

  afterEach(() => {
    _resetForTest()
    vi.useRealTimers()
  })

  describe("isConnectionFailed", () => {
    it("returns false initially", () => {
      expect(isConnectionFailed()).toBe(false)
    })

    it("returns true after markConnectionFailed()", () => {
      markConnectionFailed()
      expect(isConnectionFailed()).toBe(true)
    })

    it("returns false after markConnectionHealthy() resets state", () => {
      markConnectionFailed()
      markConnectionHealthy()
      expect(isConnectionFailed()).toBe(false)
    })
  })

  describe("markConnectionFailed", () => {
    it("increments failureCount on each call", () => {
      markConnectionFailed()
      expect(getConnectionStatus().failureCount).toBe(1)

      markConnectionFailed()
      expect(getConnectionStatus().failureCount).toBe(2)
    })

    it("sets lastFailureTime", () => {
      vi.setSystemTime(new Date("2025-01-15T10:00:00Z"))
      markConnectionFailed()
      expect(getConnectionStatus().lastFailureTime).toBe(new Date("2025-01-15T10:00:00Z").getTime())
    })

    it("logs a warning", () => {
      markConnectionFailed()
      expect(logger.warn).toHaveBeenCalledWith("MCP connection marked as failed", { failureCount: 1 })
    })
  })

  describe("markConnectionHealthy", () => {
    it("resets failureCount and lastFailureTime", () => {
      markConnectionFailed()
      markConnectionFailed()
      markConnectionHealthy()

      const status = getConnectionStatus()
      expect(status.failureCount).toBe(0)
      expect(status.lastFailureTime).toBeNull()
      expect(status.connected).toBe(true)
    })

    it("logs info when recovering from failed state", () => {
      markConnectionFailed()
      markConnectionHealthy()
      expect(logger.info).toHaveBeenCalledWith("MCP connection restored")
    })

    it("does not log when already healthy", () => {
      markConnectionHealthy()
      expect(logger.info).not.toHaveBeenCalledWith("MCP connection restored")
    })

    it("calls onReconnect callback when recovering from failed state", () => {
      const cb = vi.fn()
      markConnectionFailed()
      startRetryLoop(vi.fn().mockResolvedValue(false), 60_000, cb)
      markConnectionHealthy()
      expect(cb).toHaveBeenCalledTimes(1)
    })

    it("does not call onReconnect when not recovering", () => {
      const cb = vi.fn()
      startRetryLoop(vi.fn().mockResolvedValue(false), 60_000, cb)
      markConnectionHealthy()
      expect(cb).not.toHaveBeenCalled()
    })
  })

  describe("getConnectionStatus", () => {
    it("returns connected=true, zero failures initially", () => {
      const status = getConnectionStatus()
      expect(status).toEqual({
        connected: true,
        failureCount: 0,
        lastFailureTime: null,
        retrying: false,
      })
    })

    it("reflects failed state", () => {
      vi.setSystemTime(new Date("2025-06-01T12:00:00Z"))
      markConnectionFailed()
      const status = getConnectionStatus()
      expect(status.connected).toBe(false)
      expect(status.failureCount).toBe(1)
      expect(status.lastFailureTime).toBe(new Date("2025-06-01T12:00:00Z").getTime())
    })

    it("shows retrying=true when retry loop active", () => {
      startRetryLoop(vi.fn().mockResolvedValue(false), 30_000)
      expect(getConnectionStatus().retrying).toBe(true)
    })

    it("shows retrying=false after stopRetryLoop", () => {
      startRetryLoop(vi.fn().mockResolvedValue(false), 30_000)
      stopRetryLoop()
      expect(getConnectionStatus().retrying).toBe(false)
    })
  })

  describe("startRetryLoop", () => {
    it("calls retryFn at configured interval", async () => {
      const retryFn = vi.fn().mockResolvedValue(false)
      startRetryLoop(retryFn, 5_000)

      expect(retryFn).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(5_000)
      expect(retryFn).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(5_000)
      expect(retryFn).toHaveBeenCalledTimes(2)
    })

    it("stops loop and marks healthy when retryFn returns true", async () => {
      markConnectionFailed()
      const retryFn = vi.fn().mockResolvedValue(true)
      startRetryLoop(retryFn, 5_000)

      await vi.advanceTimersByTimeAsync(5_000)
      expect(retryFn).toHaveBeenCalledTimes(1)
      expect(isConnectionFailed()).toBe(false)
      expect(getConnectionStatus().retrying).toBe(false)

      await vi.advanceTimersByTimeAsync(10_000)
      expect(retryFn).toHaveBeenCalledTimes(1)
    })

    it("calls reconnectCallback on successful reconnection", async () => {
      markConnectionFailed()
      const retryFn = vi.fn().mockResolvedValue(true)
      const callback = vi.fn()
      startRetryLoop(retryFn, 5_000, callback)

      await vi.advanceTimersByTimeAsync(5_000)
      expect(callback).toHaveBeenCalledTimes(1)
    })

    it("continues retrying when retryFn returns false", async () => {
      const retryFn = vi.fn().mockResolvedValue(false)
      startRetryLoop(retryFn, 5_000)

      await vi.advanceTimersByTimeAsync(15_000)
      expect(retryFn).toHaveBeenCalledTimes(3)
      expect(getConnectionStatus().retrying).toBe(true)
    })

    it("continues retrying when retryFn throws", async () => {
      const retryFn = vi.fn().mockRejectedValue(new Error("spawn failed"))
      startRetryLoop(retryFn, 5_000)

      await vi.advanceTimersByTimeAsync(10_000)
      expect(retryFn).toHaveBeenCalledTimes(2)
      expect(getConnectionStatus().retrying).toBe(true)
    })

    it("stops previous loop when called again", async () => {
      const retryFn1 = vi.fn().mockResolvedValue(false)
      const retryFn2 = vi.fn().mockResolvedValue(false)
      startRetryLoop(retryFn1, 5_000)
      startRetryLoop(retryFn2, 5_000)

      await vi.advanceTimersByTimeAsync(5_000)
      expect(retryFn1).not.toHaveBeenCalled()
      expect(retryFn2).toHaveBeenCalledTimes(1)
    })
  })

  describe("stopRetryLoop", () => {
    it("stops the retry timer", async () => {
      const retryFn = vi.fn().mockResolvedValue(false)
      startRetryLoop(retryFn, 5_000)
      stopRetryLoop()

      await vi.advanceTimersByTimeAsync(10_000)
      expect(retryFn).not.toHaveBeenCalled()
    })

    it("clears onReconnect callback", async () => {
      const cb = vi.fn()
      markConnectionFailed()
      startRetryLoop(vi.fn().mockResolvedValue(false), 5_000, cb)
      stopRetryLoop()
      markConnectionHealthy()
      expect(cb).not.toHaveBeenCalled()
    })

    it("is safe to call multiple times", () => {
      stopRetryLoop()
      stopRetryLoop()
      expect(getConnectionStatus().retrying).toBe(false)
    })
  })

  describe("_resetForTest", () => {
    it("resets all state back to initial values", () => {
      markConnectionFailed()
      markConnectionFailed()
      startRetryLoop(vi.fn().mockResolvedValue(false), 5_000)

      _resetForTest()

      expect(isConnectionFailed()).toBe(false)
      expect(getConnectionStatus()).toEqual({
        connected: true,
        failureCount: 0,
        lastFailureTime: null,
        retrying: false,
      })
    })
  })
})
