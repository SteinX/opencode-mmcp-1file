import { describe, expect, it } from "vitest"
import { selectAdditiveRecoveryMemories } from "../../src/services/recovery-selector.js"
import type { MemoryEntry } from "../../src/utils/format.js"

function memory(content: string): MemoryEntry {
  return { id: content.slice(0, 12), content }
}

describe("selectAdditiveRecoveryMemories", () => {
  it("skips memories that only repeat the compact summary", () => {
    const result = selectAdditiveRecoveryMemories({
      taskMemories: [memory("TASK: implement the Codex plugin Context Router and Task Ledger")],
      contextMemories: [],
      compactSummary: "We are implementing the Codex plugin Context Router and Task Ledger.",
    })

    expect(result.taskMemories).toEqual([])
    expect(result.skippedSimilarToSummary).toBe(1)
  })

  it("keeps concrete operational details from summary-overlapping memories", () => {
    const result = selectAdditiveRecoveryMemories({
      taskMemories: [],
      contextMemories: [memory("We are implementing the Codex plugin Context Router and Task Ledger. Verified `npm run build --workspaces`; changed packages/codex-plugin/src/hooks/user-prompt-submit.ts; user corrected compact recovery to be additive.")],
      compactSummary: "We are implementing the Codex plugin Context Router and Task Ledger.",
    })

    expect(result.contextMemories).toHaveLength(1)
    expect(result.contextMemories[0].content).toContain("npm run build --workspaces")
    expect(result.contextMemories[0].content).toContain("packages/codex-plugin/src/hooks/user-prompt-submit.ts")
    expect(result.contextMemories[0].content).toContain("user corrected")
  })
})
