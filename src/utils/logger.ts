import type { createOpencodeClient } from "@opencode-ai/sdk"

type Client = ReturnType<typeof createOpencodeClient>

const SERVICE_NAME = "opencode-mmcp-1file"

let _client: Client | null = null

export function initLogger(client: Client): void {
  _client = client
}

function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
): void {
  if (!_client) return
  _client.app
    .log({
      body: {
        service: SERVICE_NAME,
        level,
        message,
        ...(extra && { extra }),
      },
    })
    .catch(() => {
      // Avoid infinite loop — swallow logging failures silently
    })
}

export const logger = {
  debug: (message: string, extra?: Record<string, unknown>) => log("debug", message, extra),
  info: (message: string, extra?: Record<string, unknown>) => log("info", message, extra),
  warn: (message: string, extra?: Record<string, unknown>) => log("warn", message, extra),
  error: (message: string, extra?: Record<string, unknown>) => log("error", message, extra),
}
