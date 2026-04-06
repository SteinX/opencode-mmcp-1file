import type { PluginConfig, TierConfig } from "../config.js"
import {
  recallMemories,
  listProjectMemories,
  callMemoryTool,
  type RetrievalResult,
} from "./mcp-client.js"
import {
  formatMemoriesForInjection,
  formatProjectKnowledge,
  formatTieredProjectKnowledge,
} from "../utils/format.js"
import type { MemoryEntry } from "../utils/format.js"
import { logger } from "../utils/logger.js"

export type InjectionSource = "query_recall" | "project_knowledge" | "code_intel"

const queryInjectedSessions = new Set<string>()
const projectKnowledgeInjectedSessions = new Set<string>()
const codeIntelInjectedSessions = new Set<string>()

function sourceSet(source: InjectionSource): Set<string> {
  switch (source) {
    case "query_recall":
      return queryInjectedSessions
    case "project_knowledge":
      return projectKnowledgeInjectedSessions
    case "code_intel":
      return codeIntelInjectedSessions
  }
}

function shouldInjectSource(
  config: PluginConfig,
  sessionID: string,
  source: InjectionSource,
  isAfterCompaction: boolean,
): boolean {
  if (!config.chatMessage.enabled) return false

  const mode =
    source === "query_recall"
      ? config.chatMessage.injectOn
      : source === "project_knowledge"
        ? (config.chatMessage.projectKnowledgeInjectOn ?? "first")
        : (config.chatMessage.codeIntelInjectOn ?? "first")

  if (mode === "never") return false
  if (isAfterCompaction) return mode === "compaction" || mode === "always" || source === "query_recall"
  if (mode === "compaction") return false
  if (mode === "always") return true

  return !sourceSet(source).has(sessionID)
}

export function shouldInjectMemories(
  config: PluginConfig,
  sessionID: string,
  isAfterCompaction: boolean,
): boolean {
  return (
    shouldInjectSource(config, sessionID, "query_recall", isAfterCompaction)
    || shouldInjectSource(config, sessionID, "project_knowledge", isAfterCompaction)
    || shouldInjectSource(config, sessionID, "code_intel", isAfterCompaction)
  )
}

export function markSessionInjected(
  sessionID: string,
  sources: InjectionSource[] = ["query_recall", "project_knowledge", "code_intel"],
): void {
  for (const source of sources) {
    sourceSet(source).add(sessionID)
  }
}

export function markSessionCompacted(sessionID: string): void {
  queryInjectedSessions.delete(sessionID)
  projectKnowledgeInjectedSessions.delete(sessionID)
  codeIntelInjectedSessions.delete(sessionID)
}

function uniqueMemories(memories: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>()
  const result: MemoryEntry[] = []

  for (const memory of memories) {
    const key = memory.id || memory.content.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(memory)
  }

  return result
}

function filterRecallMemories(config: PluginConfig, memories: MemoryEntry[]): MemoryEntry[] {
  const minScore = config.chatMessage.minScore ?? 0.35
  const maxInjectedMemories = config.chatMessage.maxInjectedMemories ?? config.chatMessage.maxMemories

  return uniqueMemories(memories)
    .filter((memory) => memory.score == null || memory.score >= minScore)
    .slice(0, maxInjectedMemories)
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
    for (const memory of memories) {
      const memoryKey = memory.id || memory.content
      if (used.has(memoryKey)) continue
      if (bucket.length >= tier.limit) break
      if (matchesTier(memory, tier)) {
        bucket.push(memory)
        used.add(memoryKey)
      }
    }
  }

  return result
}

function shortQueryThreshold(config: PluginConfig): number {
  return Math.max(1, config.chatMessage.shortQueryMinLength ?? 3)
}

function formatRetrievalFailure(result: RetrievalResult, label: string): string | null {
  if (result.status === "failed" || result.status === "unavailable") {
    logger.debug(`${label} retrieval unavailable`, {
      source: result.source,
      status: result.status,
      reason: result.reason,
    })
  }
  return null
}

export async function fetchAndFormatMemories(
  config: PluginConfig,
  userMessageText: string,
): Promise<string | null> {
  if (userMessageText.trim().length < shortQueryThreshold(config)) return null

  const result = await recallMemories(config, userMessageText, config.chatMessage.maxMemories)
  if (result.status !== "ok") return formatRetrievalFailure(result, "query recall")

  const filtered = filterRecallMemories(config, result.memories)
  if (filtered.length === 0) return null

  return formatMemoriesForInjection(filtered)
}

export async function fetchProjectKnowledge(
  config: PluginConfig,
): Promise<string | null> {
  try {
    const maxProjectMemories = config.chatMessage.maxProjectMemories ?? 30
    const validOnly = config.chatMessage.projectKnowledgeValidOnly ?? false
    const result = await listProjectMemories(config, maxProjectMemories, validOnly)

    if (result.status !== "ok") return formatRetrievalFailure(result, "project knowledge")

    const memories = uniqueMemories(result.memories)
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
      (project) => project.status === "completed" || project.status === "indexed",
    )
    if (indexed.length === 0) return null

    const lines = indexed.map((project) => {
      const parts = [`- **${project.id}**`]
      if (project.symbols != null) parts.push(`${project.symbols} symbols`)
      if (project.chunks != null) parts.push(`${project.chunks} chunks`)
      return parts.join(" | ")
    })

    return [
      "[CODE INTELLIGENCE] Indexed projects available:",
      ...lines,
      "",
      "Use `code_search` with `search_type: \"intent\"` for semantic code search,",
      "`search_type: \"symbol\"` for symbol lookup, and `search_type: \"callers\" | \"callees\" | \"related\"` to traverse call relationships.",
      "Use `project_status(action: \"list\")` to verify indexing state before deeper code-intel queries.",
    ].join("\n")
  } catch (err) {
    logger.debug("Failed to fetch code intel context", { error: String(err) })
    return null
  }
}

export function shouldInjectQueryRecall(
  config: PluginConfig,
  sessionID: string,
  isAfterCompaction: boolean,
): boolean {
  return shouldInjectSource(config, sessionID, "query_recall", isAfterCompaction)
}

export function shouldInjectProjectKnowledge(
  config: PluginConfig,
  sessionID: string,
  isAfterCompaction: boolean,
): boolean {
  return shouldInjectSource(config, sessionID, "project_knowledge", isAfterCompaction)
}

export function shouldInjectCodeIntel(
  config: PluginConfig,
  sessionID: string,
  isAfterCompaction: boolean,
): boolean {
  return shouldInjectSource(config, sessionID, "code_intel", isAfterCompaction)
}
