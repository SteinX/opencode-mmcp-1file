/**
 * Central connection state management for the MCP server.
 *
 * Tracks whether the server is reachable and manages a background retry loop
 * that periodically attempts reconnection when the connection has failed.
 *
 * Separated from mcp-client.ts to avoid circular dependencies — multiple
 * modules (tool-registry, system-prompt, index) need to read connection state.
 */

import { logger } from "../utils/logger.js"

const DEFAULT_RETRY_INTERVAL_MS = 30_000

let connectionFailed = false
let failureCount = 0
let lastFailureTime: number | null = null
let retryTimer: ReturnType<typeof setInterval> | null = null
let retryInFlight = false
let onReconnect: (() => void) | null = null

export function isConnectionFailed(): boolean {
  return connectionFailed
}

export function markConnectionFailed(): void {
  connectionFailed = true
  failureCount++
  lastFailureTime = Date.now()
  logger.warn("MCP connection marked as failed", { failureCount })
}

export function markConnectionHealthy(): void {
  const wasFailed = connectionFailed
  connectionFailed = false
  failureCount = 0
  lastFailureTime = null
  if (wasFailed) {
    logger.info("MCP connection restored")
    onReconnect?.()
  }
}

export interface ConnectionStatus {
  connected: boolean
  failureCount: number
  lastFailureTime: number | null
  retrying: boolean
}

export function getConnectionStatus(): ConnectionStatus {
  return {
    connected: !connectionFailed,
    failureCount,
    lastFailureTime,
    retrying: retryTimer !== null,
  }
}

/**
 * Start a periodic retry loop. The loop calls `retryFn` at `intervalMs`
 * intervals. When `retryFn` resolves to `true`, the loop stops and
 * `markConnectionHealthy()` is called automatically.
 */
export function startRetryLoop(
  retryFn: () => Promise<boolean>,
  intervalMs = DEFAULT_RETRY_INTERVAL_MS,
  reconnectCallback?: () => void,
): void {
  stopRetryLoop()
  onReconnect = reconnectCallback ?? null

  retryTimer = setInterval(async () => {
    if (retryInFlight) {
      logger.debug("Skipping MCP reconnection attempt because previous attempt is still running")
      return
    }

    retryInFlight = true
    logger.debug("Attempting MCP reconnection...")
    try {
      const success = await retryFn()
      if (success) {
        markConnectionHealthy()
        stopRetryLoop()
      }
    } catch {
      logger.debug("MCP reconnection attempt failed")
    } finally {
      retryInFlight = false
    }
  }, intervalMs)

  // Allow Node to exit even if the timer is still active
  if (retryTimer && typeof retryTimer === "object" && "unref" in retryTimer) {
    retryTimer.unref()
  }
}

export function stopRetryLoop(): void {
  if (retryTimer !== null) {
    clearInterval(retryTimer)
    retryTimer = null
  }
  retryInFlight = false
  onReconnect = null
}

export function _resetForTest(): void {
  connectionFailed = false
  failureCount = 0
  lastFailureTime = null
  stopRetryLoop()
}
