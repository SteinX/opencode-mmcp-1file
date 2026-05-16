import type { PluginConfig } from "../config.js"
import type { MemoryOperationContext, RetrievalResult } from "./mcp-client.js"
import { listProjectMemories } from "./mcp-client.js"

const LEGACY_PREFERENCE_PREFIX = "USER — Preference:"

type LegacyPreferenceStatus = "confirmed" | "candidate"

interface LegacyPreferenceMemory {
  id: string
  content: string
  status: LegacyPreferenceStatus
  metadata?: Record<string, unknown>
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ")
}

function normalizeLegacyPreferenceContent(text: string): string {
  return normalizeText(text).toLowerCase()
}

function parseLegacyPreferenceContent(content: string): string | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith(LEGACY_PREFERENCE_PREFIX)) return null

  const raw = trimmed.slice(LEGACY_PREFERENCE_PREFIX.length).trim()
  return raw || null
}

function normalizeLegacyPreferenceStatus(value: unknown): LegacyPreferenceStatus | null {
  if (value === "confirmed" || value === "candidate") return value
  return null
}

function extractLegacyPreferenceStatus(memory: RetrievalResult["memories"][number]): LegacyPreferenceStatus {
  const metadata = (memory as { metadata?: unknown }).metadata
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const status = normalizeLegacyPreferenceStatus((metadata as { status?: unknown }).status)
    if (status) return status
  }

  return "confirmed"
}

function mergeLegacyPreference(
  existing: LegacyPreferenceMemory | undefined,
  incoming: LegacyPreferenceMemory,
): LegacyPreferenceMemory {
  if (!existing) return incoming
  if (existing.status === "confirmed") return existing
  if (incoming.status === "confirmed") return incoming
  return existing
}

function collectLegacyPreferences(memories: RetrievalResult["memories"]): LegacyPreferenceMemory[] {
  const deduped = new Map<string, LegacyPreferenceMemory>()

  for (const memory of memories) {
    const parsed = parseLegacyPreferenceContent(memory.content)
    if (!parsed) continue

    const normalized = normalizeLegacyPreferenceContent(parsed)
    if (!normalized) continue

    const incoming: LegacyPreferenceMemory = {
      id: String((memory as { id?: unknown }).id ?? parsed),
      content: parsed,
      status: extractLegacyPreferenceStatus(memory),
      metadata: (memory as { metadata?: unknown }).metadata && typeof (memory as { metadata?: unknown }).metadata === "object" && !Array.isArray((memory as { metadata?: unknown }).metadata)
        ? ((memory as { metadata?: Record<string, unknown> }).metadata)
        : undefined,
    }

    deduped.set(normalized, mergeLegacyPreference(deduped.get(normalized), incoming))
  }

  return [...deduped.values()]
}

function formatLegacyPreferenceSection(title: string, hint: string, values: string[]): string | null {
  if (values.length === 0) return null

  return [`## ${title}`, hint, ...values.map((value) => `- ${value}`)].join("\n")
}

export async function listLegacyPreferences(
  config: PluginConfig,
  context?: MemoryOperationContext,
): Promise<RetrievalResult> {
  try {
    const result = await listProjectMemories(
      config,
      Math.max(1, config.preferenceLearning.maxStoredPreferences),
      false,
      context,
    )

    if (result.status !== "ok") {
      return { ...result, memories: [] }
    }

    const memories = collectLegacyPreferences(result.memories)
    const filtered = memories.map(({ id, content, status, metadata }) => ({
      id,
      content,
      ...(metadata ? { metadata: { ...metadata, status } } : { metadata: { status } }),
    }))

    if (filtered.length === 0) {
      return { ...result, status: "empty", memories: [] }
    }

    return { ...result, memories: filtered }
  } catch {
    return {
      status: "failed",
      source: "list",
      memories: [],
      reason: "legacy preference lookup failed",
    }
  }
}

export function formatLegacyPreferencesForInjection(memories: RetrievalResult["memories"]): string | null {
  const confirmed: string[] = []
  const candidates: string[] = []

  for (const memory of memories) {
    const parsed = parseLegacyPreferenceContent(memory.content)
    if (!parsed) continue

    const status = extractLegacyPreferenceStatus(memory)
    if (status === "candidate") {
      candidates.push(parsed)
    } else {
      confirmed.push(parsed)
    }
  }

  if (confirmed.length === 0 && candidates.length === 0) return null

  const sections = [
    "[MEMORY] Legacy User Preferences",
    formatLegacyPreferenceSection(
      "Confirmed Preferences",
      "Treat these as strong guidance from prior user signals:",
      confirmed,
    ),
    formatLegacyPreferenceSection(
      "Candidate Preferences",
      "Tentative hints only — validate before treating as hard rules:",
      candidates,
    ),
  ].filter(Boolean)

  return sections.join("\n\n")
}
