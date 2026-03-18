import { describe, it, expect } from "vitest"
import { formatMemoriesForInjection, formatMemoriesForRecovery } from "../../src/utils/format.js"
import type { MemoryEntry } from "../../src/utils/format.js"

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
    expect(result).toContain("[95%]")
    expect(result).toContain("(semantic)")
  })

  it("formats multiple memories as list items", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "fact one", score: 0.8 },
      { id: "2", content: "fact two", score: 0.6 },
    ]
    const result = formatMemoriesForInjection(memories)
    expect(result).toContain("- fact one [80%]")
    expect(result).toContain("- fact two [60%]")
  })

  it("omits score when not present", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "no score" },
    ]
    const result = formatMemoriesForInjection(memories)
    expect(result).toContain("- no score")
    expect(result).not.toMatch(/\[\d+%\]/)
  })

  it("omits memory_type when not present", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "no type", score: 0.5 },
    ]
    const result = formatMemoriesForInjection(memories)
    expect(result).not.toContain("()")
    expect(result).not.toMatch(/\(semantic\)|\(episodic\)|\(procedural\)/)
  })

  it("rounds score to nearest integer", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "test", score: 0.876 },
    ]
    const result = formatMemoriesForInjection(memories)
    expect(result).toContain("[88%]")
  })

  it("handles zero score", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "test", score: 0 },
    ]
    const result = formatMemoriesForInjection(memories)
    expect(result).toContain("[0%]")
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
