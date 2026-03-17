import type { PluginConfig } from "../config.js"
import { recall } from "./mcp-client.js"
import { formatMemoriesForInjection } from "../utils/format.js"

const injectedSessions = new Set<string>()

export function shouldInjectMemories(
  config: PluginConfig,
  sessionID: string,
  isAfterCompaction: boolean,
): boolean {
  if (!config.chatMessage.enabled) return false

  if (isAfterCompaction) return true

  if (config.chatMessage.injectOn === "always") return true

  if (config.chatMessage.injectOn === "first" && !injectedSessions.has(sessionID)) {
    return true
  }

  return false
}

export function markSessionInjected(sessionID: string): void {
  injectedSessions.add(sessionID)
}

export function markSessionCompacted(sessionID: string): void {
  injectedSessions.delete(sessionID)
}

export async function fetchAndFormatMemories(
  config: PluginConfig,
  userMessageText: string,
): Promise<string | null> {
  if (userMessageText.length < 10) return null

  const memories = await recall(config, userMessageText, config.chatMessage.maxMemories)

  if (memories.length === 0) return null

  return formatMemoriesForInjection(memories)
}
