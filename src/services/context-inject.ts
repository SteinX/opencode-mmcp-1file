import type { PluginConfig, TierConfig } from "../config.js"
import { recall, listMemories, callMemoryTool } from "./mcp-client.js"
import { formatMemoriesForInjection, formatProjectKnowledge, formatTieredProjectKnowledge } from "../utils/format.js"
import type { MemoryEntry } from "../utils/format.js"
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

function matchesTier(memory: MemoryEntry, tier: TierConfig): boolean {
  if (tier.categories.length === 0) return true
  const upper = memory.content.toUpperCase()
  return tier.categories.some((cat) => upper.startsWith(cat.toUpperCase()))
}

export function allocateToTiers(
  memories: MemoryEntry[],
  tiers: TierConfig[],
): Map<number, MemoryEntry[]> {
  const result = new Map<number, MemoryEntry[]>()
  const used = new Set<string>()

  for (let i = 0; i < tiers.length; i++) {
    result.set(i, [])
  }

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i]
    const bucket = result.get(i)!
    for (const m of memories) {
      if (used.has(m.id)) continue
      if (bucket.length >= tier.limit) break
      if (matchesTier(m, tier)) {
        bucket.push(m)
        used.add(m.id)
      }
    }
  }

  return result
}

export async function fetchProjectKnowledge(
  config: PluginConfig,
): Promise<string | null> {
  try {
    const maxProjectMemories = config.chatMessage.maxProjectMemories ?? 30
    const memories = await listMemories(config, maxProjectMemories)
    if (memories.length === 0) return null

    const tiers = config.chatMessage.projectKnowledgeTiers
    if (!tiers || tiers.length === 0) {
      return formatProjectKnowledge(memories)
    }

    const allocated = allocateToTiers(memories, tiers)
    return formatTieredProjectKnowledge(allocated, tiers)
  } catch (err) {
    logger.debug("Failed to fetch project knowledge", { error: String(err) })
    return null
  }
}
