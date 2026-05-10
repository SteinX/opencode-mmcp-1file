import { describe, it, expect } from "vitest"
import { formatLearningMemoryInjection } from "../../src/services/learning-memory-format.js"
import type { LearningRecord } from "../../src/services/learning-memory-client.js"

function makeRecord(overrides: {
  id?: string
  kind: string
  status: string
  content: string
  sourceLabel?: { created_from: string; client: string; source_memory_ids: string[] }
  evidence?: string
  valid_until?: string | null
  invalidation_reason?: string | null
  superseded_by?: string | null
  raw?: Record<string, unknown>
}): LearningRecord {
  return {
    id: overrides.id ?? "memory-1",
    content: overrides.content,
    metadata: {
      learning: {
        schema_version: 1,
        kind: overrides.kind,
        status: overrides.status,
        lifecycle_state: "active",
        confidence: 0.9,
        source: overrides.sourceLabel ?? { created_from: "unit-test", client: "vitest", source_memory_ids: ["src-1"] },
        ...(overrides.evidence ? { evidence: overrides.evidence } : {}),
      },
    },
    valid_until: overrides.valid_until ?? null,
    invalidation_reason: overrides.invalidation_reason ?? null,
    superseded_by: overrides.superseded_by ?? null,
    raw: overrides.raw ?? {},
  }
}

describe("formatLearningMemoryInjection", () => {
  it("formats mixed memory classes in ordered sections", () => {
    const output = formatLearningMemoryInjection(
      {
        learning_summary: { injectable_by_default: true, raw: {} },
        records: [
          makeRecord({ kind: "workflow_rule", status: "rule", content: "Always run the build before merging" }),
          makeRecord({ kind: "user_preference", status: "confirmed", content: "Use concise Chinese replies" }),
          makeRecord({ kind: "project_lesson", status: "confirmed", content: "Build failures usually come from stale caches" }),
          makeRecord({ kind: "project_pattern", status: "confirmed", content: "Prefer parallel tool calls for independent work" }),
        ],
      },
      { includeEvidence: false, includeCandidates: false },
    )

    expect(output).not.toBeNull()
    const formatted = output ?? ""

    expect(formatted).toContain("[MEMORY] Learned Memory")
    expect(formatted).toContain("## Hard Rules")
    expect(formatted).toContain("## Confirmed User Preferences")
    expect(formatted).toContain("## Relevant Project Lessons")
    expect(formatted).toContain("## Relevant Patterns/Pitfalls")
    expect(formatted).toContain("Always run the build before merging")
    expect(formatted).toContain("Use concise Chinese replies")
    expect(formatted).toContain("Build failures usually come from stale caches")
    expect(formatted).toContain("Prefer parallel tool calls for independent work")
    expect(formatted).toContain("Source: unit-test / vitest / ids:src-1")

    const hardRulesIndex = formatted.indexOf("## Hard Rules")
    const prefsIndex = formatted.indexOf("## Confirmed User Preferences")
    const lessonsIndex = formatted.indexOf("## Relevant Project Lessons")
    const patternsIndex = formatted.indexOf("## Relevant Patterns/Pitfalls")

    expect(hardRulesIndex).toBeGreaterThan(-1)
    expect(prefsIndex).toBeGreaterThan(hardRulesIndex)
    expect(lessonsIndex).toBeGreaterThan(prefsIndex)
    expect(patternsIndex).toBeGreaterThan(lessonsIndex)
  })

  it("omits candidate records by default", () => {
    const output = formatLearningMemoryInjection(
      {
        learning_summary: { injectable_by_default: true, raw: {} },
        records: [
          makeRecord({ kind: "user_preference", status: "candidate", content: "Maybe prefer short answers" }),
          makeRecord({ kind: "user_preference", status: "confirmed", content: "Use direct language" }),
        ],
      },
      { includeEvidence: false, includeCandidates: false },
    )

    expect(output).not.toBeNull()
    const formatted = output ?? ""

    expect(formatted).toContain("Use direct language")
    expect(formatted).not.toContain("Maybe prefer short answers")
    expect(formatted).not.toContain("Candidate Signals")
  })

  it("includes evidence only when requested", () => {
    const records = [makeRecord({
      kind: "project_lesson",
      status: "confirmed",
      content: "Use the build step before the test step",
      evidence: "Two regressions happened when skipping build",
    })]

    const withoutEvidence = formatLearningMemoryInjection(
      { learning_summary: { injectable_by_default: true, raw: {} }, records },
      { includeEvidence: false, includeCandidates: false },
    )
    const withEvidence = formatLearningMemoryInjection(
      { learning_summary: { injectable_by_default: true, raw: {} }, records },
      { includeEvidence: true, includeCandidates: false },
    )

    expect(withoutEvidence).not.toBeNull()
    expect(withEvidence).not.toBeNull()
    const plain = withoutEvidence ?? ""
    const rich = withEvidence ?? ""
    expect(plain).not.toContain("Evidence:")
    expect(rich).toContain("Evidence: Two regressions happened when skipping build")
  })

  it("does not copy aggregate learning summary onto every record", () => {
    const output = formatLearningMemoryInjection(
      {
        learning_summary: {
          injectable_by_default: true,
          kind: "user_preference",
          status: "confirmed",
          lifecycle_state: "active",
          result_count: 99,
          raw: {},
        },
        records: [
          makeRecord({ kind: "project_lesson", status: "rule", content: "Keep tests close to the code" }),
        ],
      },
      { includeEvidence: false, includeCandidates: false },
    )

    expect(output).toContain("Kind: project_lesson")
    expect(output).toContain("Status: rule")
    expect(output).not.toContain("Kind: user_preference")
    expect(output).not.toContain("Status: confirmed")
  })

  it("formats records even when lifecycle fields indicate archival or supersession", () => {
    const output = formatLearningMemoryInjection(
      {
        learning_summary: { injectable_by_default: true, raw: {} },
        records: [
          makeRecord({
            kind: "project_lesson",
            status: "confirmed",
            content: "Keep the cache warm",
            valid_until: "2025-01-01T00:00:00.000Z",
          }),
          makeRecord({
            kind: "project_pattern",
            status: "confirmed",
            content: "Avoid reloading the index twice",
            superseded_by: "memory-2",
          }),
        ],
      },
      { includeEvidence: false, includeCandidates: false },
    )

    expect(output).not.toBeNull()
    const formatted = output ?? ""

    expect(formatted).toContain("Keep the cache warm")
    expect(formatted).toContain("Avoid reloading the index twice")
    expect(formatted).toContain("Status: confirmed")
  })
})
