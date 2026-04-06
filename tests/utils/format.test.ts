import { describe, it, expect } from "vitest"
import { formatMemoriesForInjection, formatProjectKnowledge, formatMemoriesForRecovery, formatTieredProjectKnowledge } from "../../src/utils/format.js"
import type { MemoryEntry } from "../../src/utils/format.js"
import type { TierConfig } from "../../src/config.js"

describe("formatMemoriesForInjection", () => {
  it("returns empty string for empty array", () => {
    expect(formatMemoriesForInjection([])).toBe("")
  })

  it("formats single memory with all fields", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "Use React 18", memory_type: "semantic", score: 0.95 },
    ]
    const result = formatMemoriesForInjection(memories)
    expect(result).toContain("[MEMORY]")
    expect(result).toContain("Use React 18")
    expect(result).toContain("[high match]")
    expect(result).toContain("[semantic]")
  })

  it("formats multiple memories as list items", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "fact one", score: 0.8 },
      { id: "2", content: "fact two", score: 0.6 },
    ]
    const result = formatMemoriesForInjection(memories)
    expect(result).toContain("- [high match] fact one")
    expect(result).toContain("- [medium match] fact two")
  })

  it("omits score when not present", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "no score" },
    ]
    const result = formatMemoriesForInjection(memories)
    expect(result).toContain("- no score")
    expect(result).not.toContain("[high match]")
    expect(result).not.toContain("[medium match]")
    expect(result).not.toContain("[low match]")
  })

  it("omits memory_type when not present", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "no type", score: 0.5 },
    ]
    const result = formatMemoriesForInjection(memories)
    expect(result).not.toContain("[semantic]")
    expect(result).not.toContain("[episodic]")
    expect(result).not.toContain("[procedural]")
  })

  it("formats high confidence for score >= 0.8", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "test", score: 0.876 },
    ]
    const result = formatMemoriesForInjection(memories)
    expect(result).toContain("[high match]")
  })

  it("formats low confidence for score < 0.5", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "test", score: 0 },
    ]
    const result = formatMemoriesForInjection(memories)
    expect(result).toContain("[low match]")
  })
})

describe("formatProjectKnowledge", () => {
  it("returns empty string for empty array", () => {
    expect(formatProjectKnowledge([])).toBe("")
  })

  it("formats memories without confidence scores", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "DECISION: Use PostgreSQL", score: 0.95, memory_type: "semantic" },
    ]
    const result = formatProjectKnowledge(memories)
    expect(result).toContain("[MEMORY] Project Knowledge")
    expect(result).toContain("- DECISION: Use PostgreSQL (semantic)")
    expect(result).not.toContain("[95%]")
  })

  it("formats multiple memories as list items", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "fact one" },
      { id: "2", content: "fact two" },
    ]
    const result = formatProjectKnowledge(memories)
    expect(result).toContain("- fact one")
    expect(result).toContain("- fact two")
  })

  it("omits memory_type when not present", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "no type" },
    ]
    const result = formatProjectKnowledge(memories)
    expect(result).toContain("- no type")
    expect(result).not.toContain("()")
  })
})

describe("formatMemoriesForRecovery", () => {
  it("returns empty string when both arrays are empty", () => {
    expect(formatMemoriesForRecovery([], [])).toBe("")
  })

  it("formats task memories section", () => {
    const tasks: MemoryEntry[] = [
      { id: "1", content: "TASK: implement auth" },
    ]
    const result = formatMemoriesForRecovery(tasks, [])
    expect(result).toContain("[MEMORY RECOVERY]")
    expect(result).toContain("Active Tasks")
    expect(result).toContain("- TASK: implement auth")
  })

  it("formats context memories section", () => {
    const context: MemoryEntry[] = [
      { id: "1", content: "DECISION: use PostgreSQL" },
    ]
    const result = formatMemoriesForRecovery([], context)
    expect(result).toContain("[MEMORY RECOVERY]")
    expect(result).toContain("Recent Project Context")
    expect(result).toContain("- DECISION: use PostgreSQL")
  })

  it("formats both sections together", () => {
    const tasks: MemoryEntry[] = [
      { id: "1", content: "TASK: migrate DB" },
    ]
    const context: MemoryEntry[] = [
      { id: "2", content: "CONTEXT: using v3 API" },
    ]
    const result = formatMemoriesForRecovery(tasks, context)
    expect(result).toContain("Active Tasks")
    expect(result).toContain("Recent Project Context")
    expect(result).toContain("- TASK: migrate DB")
    expect(result).toContain("- CONTEXT: using v3 API")
  })

  it("does not include score in recovery format", () => {
    const tasks: MemoryEntry[] = [
      { id: "1", content: "TASK: test", score: 0.9 },
    ]
    const result = formatMemoriesForRecovery(tasks, [])
    expect(result).not.toContain("90%")
  })
})

describe("formatTieredProjectKnowledge", () => {
  const tiers: TierConfig[] = [
    { categories: ["DECISION", "PATTERN"], limit: 5 },
    { categories: ["TASK"], limit: 3 },
    { categories: [], limit: 3 },
  ]

  it("returns empty string when all tiers are empty", () => {
    const allocated = new Map<number, MemoryEntry[]>([
      [0, []],
      [1, []],
      [2, []],
    ])
    expect(formatTieredProjectKnowledge(allocated, tiers)).toBe("")
  })

  it("formats tier headers using category names", () => {
    const allocated = new Map<number, MemoryEntry[]>([
      [0, [{ id: "1", content: "DECISION: Use PostgreSQL" }]],
      [1, []],
      [2, []],
    ])
    const result = formatTieredProjectKnowledge(allocated, tiers)
    expect(result).toContain("### DECISION / PATTERN")
    expect(result).toContain("- DECISION: Use PostgreSQL")
  })

  it("labels catch-all tier as 'Other'", () => {
    const allocated = new Map<number, MemoryEntry[]>([
      [0, []],
      [1, []],
      [2, [{ id: "1", content: "BUGFIX: fixed something" }]],
    ])
    const result = formatTieredProjectKnowledge(allocated, tiers)
    expect(result).toContain("### Other")
    expect(result).toContain("- BUGFIX: fixed something")
  })

  it("includes memory_type when present", () => {
    const allocated = new Map<number, MemoryEntry[]>([
      [0, [{ id: "1", content: "DECISION: Use PostgreSQL", memory_type: "semantic" }]],
      [1, []],
      [2, []],
    ])
    const result = formatTieredProjectKnowledge(allocated, tiers)
    expect(result).toContain("DECISION: Use PostgreSQL (semantic)")
  })

  it("skips empty tiers in output", () => {
    const allocated = new Map<number, MemoryEntry[]>([
      [0, [{ id: "1", content: "DECISION: one" }]],
      [1, []],
      [2, [{ id: "2", content: "Random note" }]],
    ])
    const result = formatTieredProjectKnowledge(allocated, tiers)
    expect(result).toContain("### DECISION / PATTERN")
    expect(result).not.toContain("### TASK")
    expect(result).toContain("### Other")
  })

  it("uses tiered header in output", () => {
    const allocated = new Map<number, MemoryEntry[]>([
      [0, [{ id: "1", content: "PATTERN: repo pattern" }]],
      [1, []],
      [2, []],
    ])
    const result = formatTieredProjectKnowledge(allocated, tiers)
    expect(result).toContain("[MEMORY] Project Knowledge (tiered session guidance):")
  })

  it("formats multiple memories within a tier", () => {
    const allocated = new Map<number, MemoryEntry[]>([
      [0, [
        { id: "1", content: "DECISION: Use PostgreSQL" },
        { id: "2", content: "PATTERN: Repository pattern" },
      ]],
      [1, []],
      [2, []],
    ])
    const result = formatTieredProjectKnowledge(allocated, tiers)
    expect(result).toContain("- DECISION: Use PostgreSQL")
    expect(result).toContain("- PATTERN: Repository pattern")
  })
})
