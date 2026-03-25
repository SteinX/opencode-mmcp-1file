import type { TierConfig } from "../config.js"

export interface MemoryEntry {
  id: string
  content: string
  memory_type?: string
  score?: number
  created_at?: string
}

/**
 * Format confidence score as human-readable label.
 */
function formatConfidence(score: number | undefined): string {
  if (score == null) return ""
  if (score >= 0.8) return "[high match] "
  if (score >= 0.5) return "[medium match] "
  return "[low match] "
}

/**
 * Format memory age as human-readable label.
 */
function formatAge(createdAt: string | undefined): string {
  if (!createdAt) return ""

  const now = new Date()
  const created = new Date(createdAt)
  const diffMs = now.getTime() - created.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays < 1) return "today"
  if (diffDays === 1) return "yesterday"
  if (diffDays < 7) return `${diffDays} days ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`
  return `${Math.floor(diffDays / 365)} years ago`
}

/**
 * Format recalled memories as a markdown block for injection into the conversation.
 */
export function formatMemoriesForInjection(memories: MemoryEntry[]): string {
  if (memories.length === 0) return ""

  const lines = memories.map((m) => {
    const confidence = formatConfidence(m.score)
    const age = formatAge(m.created_at)
    const ageLabel = age ? ` (${age})` : ""
    const type = m.memory_type ? ` [${m.memory_type}]` : ""
    return `- ${confidence}${m.content}${type}${ageLabel}`
  })

  return `[MEMORY] Relevant Memories (auto-injected by memory plugin):\n${lines.join("\n")}`
}

/**
 * Format project knowledge memories for full injection (not query-dependent).
 * These are the most recent valid memories, injected regardless of semantic match.
 */
export function formatProjectKnowledge(memories: MemoryEntry[]): string {
  if (memories.length === 0) return ""

  const lines = memories.map((m) => {
    const type = m.memory_type ? ` (${m.memory_type})` : ""
    return `- ${m.content}${type}`
  })

  return `[MEMORY] Project Knowledge (always-on context):\n${lines.join("\n")}`
}

/**
 * Format memories for compaction recovery — includes more context.
 */
export function formatMemoriesForRecovery(
  taskMemories: MemoryEntry[],
  contextMemories: MemoryEntry[],
): string {
  const sections: string[] = []

  if (taskMemories.length > 0) {
    sections.push(
      "## Active Tasks (restored after compaction)",
      ...taskMemories.map((m) => `- ${m.content}`),
    )
  }

  if (contextMemories.length > 0) {
    sections.push(
      "## Recent Project Context (restored after compaction)",
      ...contextMemories.map((m) => `- ${m.content}`),
    )
  }

  if (sections.length === 0) return ""

  return `[MEMORY RECOVERY]\n${sections.join("\n")}`
}

function tierLabel(tier: TierConfig): string {
  if (tier.categories.length === 0) return "Other"
  return tier.categories.join(" / ")
}

export function formatTieredProjectKnowledge(
  allocated: Map<number, MemoryEntry[]>,
  tiers: TierConfig[],
): string {
  const sections: string[] = []

  for (let i = 0; i < tiers.length; i++) {
    const memories = allocated.get(i) ?? []
    if (memories.length === 0) continue

    const label = tierLabel(tiers[i])
    sections.push(`### ${label}`)
    for (const m of memories) {
      const type = m.memory_type ? ` (${m.memory_type})` : ""
      sections.push(`- ${m.content}${type}`)
    }
  }

  if (sections.length === 0) return ""

  return `[MEMORY] Project Knowledge (tiered, always-on context):\n${sections.join("\n")}`
}

