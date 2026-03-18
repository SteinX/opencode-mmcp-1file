/**
 * Memory formatting utilities for injection into conversation context.
 */

export interface MemoryEntry {
  id: string
  content: string
  memory_type?: string
  score?: number
  created_at?: string
}

/**
 * Format recalled memories as a markdown block for injection into the conversation.
 */
export function formatMemoriesForInjection(memories: MemoryEntry[]): string {
  if (memories.length === 0) return ""

  const lines = memories.map((m) => {
    const score = m.score != null ? ` [${Math.round(m.score * 100)}%]` : ""
    const type = m.memory_type ? ` (${m.memory_type})` : ""
    return `- ${m.content}${score}${type}`
  })

  return `[MEMORY] Project Knowledge (auto-injected by memory plugin):\n${lines.join("\n")}`
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


