import type { PluginConfig } from "../config.js"
import { recall, callMemoryTool } from "./mcp-client.js"
import { formatMemoriesForInjection } from "../utils/format.js"
import { logger } from "../utils/logger.js"

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

export async function fetchCodeIntelContext(
  config: PluginConfig,
): Promise<string | null> {
  try {
    const raw = await callMemoryTool(config, "project_info", { action: "list" })
    if (!raw) return null

    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
    const projects: Array<{
      id: string
      status: string
      chunks?: number
      symbols?: number
    }> = parsed.projects ?? []

    const indexed = projects.filter(
      (p) => p.status === "completed" || p.status === "indexed",
    )
    if (indexed.length === 0) return null

    const lines = indexed.map((p) => {
      const parts = [`- **${p.id}**`]
      if (p.symbols != null) parts.push(`${p.symbols} symbols`)
      if (p.chunks != null) parts.push(`${p.chunks} chunks`)
      return parts.join(" | ")
    })

    return [
      "[CODE INTELLIGENCE] Indexed projects available:",
      ...lines,
      "",
      "You can use `recall_code` for semantic code search, `search_symbols` to find symbols by name,",
      "and `symbol_graph` to traverse call graphs (callers/callees/related) on these indexed projects.",
    ].join("\n")
  } catch (err) {
    logger.debug("Failed to fetch code intel context", { error: String(err) })
    return null
  }
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
