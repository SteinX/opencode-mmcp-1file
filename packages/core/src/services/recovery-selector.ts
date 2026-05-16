import type { MemoryEntry } from "../utils/format.js"

export interface RecoverySelection {
  taskMemories: MemoryEntry[]
  contextMemories: MemoryEntry[]
  skippedSimilarToSummary: number
}

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[`"'()[\]{}:;,.!?，。！？、]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3)
}

function tokenSimilarity(a: string, b: string): number {
  const aTokens = new Set(normalize(a))
  const bTokens = new Set(normalize(b))
  if (aTokens.size === 0 || bTokens.size === 0) return 0

  let intersection = 0
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1
  }

  return intersection / Math.min(aTokens.size, bTokens.size)
}

function hasOperationalDetail(content: string): boolean {
  return (
    /(?:^|\s)(?:\/[\w.-]+|[A-Za-z]:\\|\.{1,2}\/)[\w./\\-]+/.test(content)
    || /`[^`]+`/.test(content)
    || /\b(?:npm|pnpm|yarn|bun|git|xcodebuild|swiftlint|cargo|pytest|vitest|tsc)\b/.test(content)
    || /\b[0-9a-f]{7,40}\b/i.test(content)
    || /\b(?:failed|failure|error|warning|pre-existing|not verified|用户|rejected|拒绝|纠正)\b/i.test(content)
  )
}

function compactOperationalDetail(content: string): string {
  const lines = content
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(hasOperationalDetail)

  if (lines.length > 0) return lines.join("\n")

  const fragments = content
    .split(/(?<=[。.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter(hasOperationalDetail)

  return fragments.join(" ")
}

function selectMemory(memory: MemoryEntry, compactSummary?: string): MemoryEntry | null {
  if (!compactSummary?.trim()) return memory

  const similarity = tokenSimilarity(memory.content, compactSummary)
  if (similarity < 0.72) return memory

  if (!hasOperationalDetail(memory.content)) return null

  const detail = compactOperationalDetail(memory.content)
  if (!detail) return null

  return {
    ...memory,
    content: detail,
  }
}

function unique(memories: MemoryEntry[]): MemoryEntry[] {
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

export function selectAdditiveRecoveryMemories(args: {
  taskMemories: MemoryEntry[]
  contextMemories: MemoryEntry[]
  compactSummary?: string
}): RecoverySelection {
  let skippedSimilarToSummary = 0

  const select = (memory: MemoryEntry): MemoryEntry | null => {
    const selected = selectMemory(memory, args.compactSummary)
    if (!selected) skippedSimilarToSummary += 1
    return selected
  }

  return {
    taskMemories: unique(args.taskMemories.flatMap((memory) => {
      const selected = select(memory)
      return selected ? [selected] : []
    })),
    contextMemories: unique(args.contextMemories.flatMap((memory) => {
      const selected = select(memory)
      return selected ? [selected] : []
    })),
    skippedSimilarToSummary,
  }
}
