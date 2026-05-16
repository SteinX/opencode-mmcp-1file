import type { PluginConfig, TierConfig } from "../config.js"
import {
  recallMemories,
  listProjectMemories,
  getProjectListInfo,
  detectKnowledgeGraphCommunities,
  getRelatedKnowledgeGraphEntities,
  type RetrievalResult,
  type MemoryOperationContext,
} from "./mcp-client.js"
import {
  formatMemoriesForInjection,
  formatProjectKnowledge,
  formatTieredProjectKnowledge,
  formatKnowledgeGraph,
} from "../utils/format.js"
import type { MemoryEntry } from "../utils/format.js"
import { logger } from "../utils/logger.js"
import { withTimeout } from "../utils/timeout.js"

export type InjectionSource = "query_recall" | "project_knowledge" | "code_intel" | "knowledge_graph"

let projectInfoCache: { data: string | null; timestamp: number } | null = null

export function clearProjectInfoCache(): void {
  projectInfoCache = null
}

const queryInjectedSessions = new Set<string>()
const projectKnowledgeInjectedSessions = new Set<string>()
const codeIntelInjectedSessions = new Set<string>()
const knowledgeGraphInjectedSessions = new Set<string>()

function sourceSet(source: InjectionSource): Set<string> {
  switch (source) {
    case "query_recall":
      return queryInjectedSessions
    case "project_knowledge":
      return projectKnowledgeInjectedSessions
    case "code_intel":
      return codeIntelInjectedSessions
    case "knowledge_graph":
      return knowledgeGraphInjectedSessions
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
        : source === "code_intel"
          ? (config.chatMessage.codeIntelInjectOn ?? "first")
          : (config.chatMessage.knowledgeGraphInjectOn ?? "first")

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
    || shouldInjectSource(config, sessionID, "knowledge_graph", isAfterCompaction)
  )
}

export function markSessionInjected(
  sessionID: string,
  sources: InjectionSource[] = ["query_recall", "project_knowledge", "code_intel", "knowledge_graph"],
): void {
  for (const source of sources) {
    sourceSet(source).add(sessionID)
  }
}

export function markSessionCompacted(sessionID: string): void {
  queryInjectedSessions.delete(sessionID)
  projectKnowledgeInjectedSessions.delete(sessionID)
  codeIntelInjectedSessions.delete(sessionID)
  knowledgeGraphInjectedSessions.delete(sessionID)
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

function projectKnowledgeContext(config: PluginConfig): MemoryOperationContext | undefined {
  const namespace = config.memoryScope.namespace?.trim()
  return namespace ? { namespace } : undefined
}

function formatIndexedCodeIntelContext(
  indexedProjects: Array<{ id: string; symbols?: number | null; chunks?: number | null }>,
): string {
  const lines = indexedProjects.map((project) => {
    const parts = [`- **${project.id}**`]
    if (project.symbols != null) parts.push(`${project.symbols} symbols`)
    if (project.chunks != null) parts.push(`${project.chunks} chunks`)
    return parts.join(" | ")
  })

  return [
    "[CODE INTELLIGENCE] Indexed projects available:",
    ...lines,
    "",
    "Next steps: use `code_search` with `search_type: \"intent\"` for semantic search, `search_type: \"symbol\"` for exact symbols, and `search_type: \"callers\" | \"callees\" | \"related\"` to traverse relationships.",
    "Use `project_status(action: \"list\")` to confirm indexing state before deeper code-intel queries.",
  ].join("\n")
}

function formatUnindexedCodeIntelContext(
  projects: Array<{ id: string; status?: string | null }>,
): string {
  const lines = ["[CODE INTELLIGENCE] No indexed projects are available yet."]

  if (projects.length > 0) {
    lines.push("Discovered projects:")
    for (const project of projects) {
      const status = project.status ? ` (${project.status})` : ""
      lines.push(`- **${project.id}**${status}`)
    }
  }

  lines.push(
    "",
    "Next steps: use `project_status(action: \"list\")` to confirm what is present, then index a project before using `code_search` for intent, symbol, or relationship traversal queries.",
  )

  return lines.join("\n")
}

export async function fetchAndFormatMemories(
  config: PluginConfig,
  userMessageText: string,
): Promise<string | null> {
  if (userMessageText.trim().length < shortQueryThreshold(config)) return null

  const result = await recallMemories(
    config,
    userMessageText,
    config.chatMessage.maxMemories,
    projectKnowledgeContext(config),
  )
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
    const result = await listProjectMemories(
      config,
      maxProjectMemories,
      validOnly,
      projectKnowledgeContext(config),
    )

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
  const ttl = config.performance?.projectInfoCacheTtlMs ?? 300_000
  const now = Date.now()
  if (projectInfoCache && now - projectInfoCache.timestamp < ttl) {
    return projectInfoCache.data
  }
  try {
    const info = await getProjectListInfo(config)
    if (!info) return null

    const indexed = info.projects.filter(
      (project) =>
        project.status === "completed" ||
        project.status === "indexed" ||
        project.status === "stale" ||
        project.status === "serving",
    )
    const result = indexed.length === 0
      ? formatUnindexedCodeIntelContext(info.projects)
      : formatIndexedCodeIntelContext(indexed)

    projectInfoCache = { data: result, timestamp: now }
    return result
  } catch (err) {
    logger.debug("Failed to fetch code intel context", { error: String(err) })
    return null
  }
}

function formatRelatedKnowledgeGraphContext(relatedResult: Awaited<ReturnType<typeof getRelatedKnowledgeGraphEntities>>): string | null {
  if (!relatedResult || relatedResult.related.length === 0) return null

  const lines = [`[KNOWLEDGE GRAPH] Related context for ${relatedResult.entity.name}:`]
  for (const item of relatedResult.related) {
    const type = item.entity.entity_type ? ` [${item.entity.entity_type}]` : ""
    const relation = item.relation?.relation_type ? ` — ${item.relation.relation_type}` : ""
    lines.push(`  - ${item.entity.name}${type}${relation}`)
  }

  return lines.join("\n")
}

export async function fetchKnowledgeGraphContext(
  config: PluginConfig,
  userMessageText?: string,
): Promise<string | null> {
  try {
    const communities = await detectKnowledgeGraphCommunities(config)
    if (communities.length === 0) return null

    const formatted = formatKnowledgeGraph(communities, config.chatMessage.maxKnowledgeGraphItems ?? 10)
    if (!formatted) return null

    const sections = [formatted]
    const normalizedMessage = userMessageText?.toLowerCase()
    if (config.chatMessage.knowledgeGraphEntityMatch && normalizedMessage) {
      const matchedEntities = communities
        .flatMap((community) => community.entities)
        .filter((entity) => {
          const normalizedName = entity.name.toLowerCase().trim()
          return normalizedName && normalizedMessage.includes(normalizedName)
        })

      const entityResults = await Promise.allSettled(
        matchedEntities.map((entity) =>
          withTimeout<Awaited<ReturnType<typeof getRelatedKnowledgeGraphEntities>> | null>(
            getRelatedKnowledgeGraphEntities(config, entity.id),
            config.performance?.knowledgeGraphTimeoutMs ?? 10_000,
            { fallback: null, label: `kg-entity:${entity.name}` },
          ),
        ),
      )

      for (const result of entityResults) {
        const related = result.status === "fulfilled" ? result.value : null
        if (related) {
          const relatedContext = formatRelatedKnowledgeGraphContext(related)
          if (relatedContext) sections.push(relatedContext)
        }
      }
    }

    return sections.join("\n\n")
  } catch (err) {
    logger.debug("Failed to fetch knowledge graph context", { error: String(err) })
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

export function shouldInjectKnowledgeGraph(
  config: PluginConfig,
  sessionID: string,
  isAfterCompaction: boolean,
): boolean {
  return shouldInjectSource(config, sessionID, "knowledge_graph", isAfterCompaction)
}
