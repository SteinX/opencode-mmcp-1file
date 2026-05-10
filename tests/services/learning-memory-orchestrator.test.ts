import { describe, it, expect, vi, beforeEach } from "vitest"
import { DEFAULT_CONFIG } from "../../src/config.js"
import type { PluginConfig } from "../../src/config.js"

vi.mock("../../src/services/learning-memory-client.js", () => ({
  createLearningMemory: vi.fn().mockResolvedValue({ status: "ok" }),
  listLearningMemories: vi.fn().mockResolvedValue({ status: "ok", records: [] }),
  searchLearningMemories: vi.fn().mockResolvedValue({ status: "ok", records: [] }),
}))

vi.mock("../../src/services/learning-memory-legacy.js", () => ({
  listLegacyPreferences: vi.fn().mockResolvedValue({ status: "ok", memories: [] }),
  formatLegacyPreferencesForInjection: vi.fn().mockReturnValue(null),
}))

vi.mock("../../src/services/preference-learning.js", () => ({
  detectPreferenceSignal: vi.fn(),
  extractPreferenceCandidates: vi.fn().mockResolvedValue([]),
}))

vi.mock("../../src/services/lesson-learning.js", () => ({
  extractLessonCandidates: vi.fn().mockResolvedValue([]),
}))

vi.mock("../../src/utils/privacy.js", () => ({
  stripPrivateContent: vi.fn((text: string) => text),
  isFullyPrivate: vi.fn(() => false),
}))

import {
  learnFromChatMessage,
  learnFromMessageUpdated,
  learnFromSessionIdleSummary,
  learnFromCompactionSummary,
  retrieveForInjection,
} from "../../src/services/learning-memory-orchestrator.js"
import { createLearningMemory, listLearningMemories, searchLearningMemories } from "../../src/services/learning-memory-client.js"
import { detectPreferenceSignal, extractPreferenceCandidates } from "../../src/services/preference-learning.js"
import { extractLessonCandidates } from "../../src/services/lesson-learning.js"
import { stripPrivateContent, isFullyPrivate } from "../../src/utils/privacy.js"
import { listLegacyPreferences, formatLegacyPreferencesForInjection } from "../../src/services/learning-memory-legacy.js"

function makeConfig(overrides: Partial<PluginConfig["learningMemory"]> = {}): PluginConfig {
  return {
    ...DEFAULT_CONFIG,
    learningMemory: {
      enabled: true,
      preferences: { enabled: true },
      lessons: { enabled: true },
      ...overrides,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(stripPrivateContent).mockImplementation((text: string) => text)
  vi.mocked(isFullyPrivate).mockReturnValue(false)
  vi.mocked(createLearningMemory).mockResolvedValue({ status: "ok" })
  vi.mocked(listLearningMemories).mockResolvedValue({ status: "ok", records: [] })
  vi.mocked(searchLearningMemories).mockResolvedValue({ status: "ok", records: [] })
  vi.mocked(extractLessonCandidates).mockResolvedValue([])
  vi.mocked(detectPreferenceSignal).mockReturnValue(null)
  vi.mocked(extractPreferenceCandidates).mockResolvedValue([])
  vi.mocked(listLegacyPreferences).mockResolvedValue({ status: "ok", memories: [] })
  vi.mocked(formatLegacyPreferencesForInjection).mockReturnValue(null)
})

describe("learnFromChatMessage", () => {
  it("skips when learningMemory disabled", async () => {
    const config = makeConfig({ enabled: false })
    await learnFromChatMessage(config, "I prefer tabs", { source: "chat.message" })
    expect(createLearningMemory).not.toHaveBeenCalled()
  })

  it("skips when preferences sub-feature disabled", async () => {
    const config = makeConfig({ preferences: { enabled: false } })
    await learnFromChatMessage(config, "I prefer tabs", { source: "chat.message" })
    expect(createLearningMemory).not.toHaveBeenCalled()
  })

  it("skips when text is fully private", async () => {
    vi.mocked(isFullyPrivate).mockReturnValue(true)
    const config = makeConfig()
    await learnFromChatMessage(config, "<!-- private -->secret", { source: "chat.message" })
    expect(createLearningMemory).not.toHaveBeenCalled()
  })

  it("skips when no preference signal detected", async () => {
    vi.mocked(detectPreferenceSignal).mockReturnValue(null)
    const config = makeConfig()
    await learnFromChatMessage(config, "hello world", { source: "chat.message" })
    expect(createLearningMemory).not.toHaveBeenCalled()
  })

  it("calls createLearningMemory when signal and candidates found", async () => {
    vi.mocked(detectPreferenceSignal).mockReturnValue({
      signalType: "explicit_preference",
      excerpt: "I prefer tabs",
    })
    vi.mocked(extractPreferenceCandidates).mockResolvedValue([
      { content: "Use tabs", confidence: 0.9, importance: 0.8, signalType: "explicit_preference", status: "confirmed" },
    ])
    const config = makeConfig()
    await learnFromChatMessage(config, "I prefer tabs", { source: "chat.message" })
    expect(createLearningMemory).toHaveBeenCalledOnce()
    const args = vi.mocked(createLearningMemory).mock.calls[0][1]
    expect(args.kind).toBe("user_preference")
    expect(args.content).toBe("Use tabs")
    expect(args.status).toBe("confirmed")
  })

  it("sets status to candidate when confidence < 0.7", async () => {
    vi.mocked(detectPreferenceSignal).mockReturnValue({
      signalType: "explicit_preference",
      excerpt: "maybe tabs",
    })
    vi.mocked(extractPreferenceCandidates).mockResolvedValue([
      { content: "Maybe tabs", confidence: 0.5, importance: 0.5, signalType: "explicit_preference", status: "candidate" },
    ])
    const config = makeConfig()
    await learnFromChatMessage(config, "maybe tabs", { source: "chat.message" })
    const args = vi.mocked(createLearningMemory).mock.calls[0][1]
    expect(args.status).toBe("candidate")
  })
})

describe("learnFromMessageUpdated", () => {
  it("skips when learningMemory disabled", async () => {
    const config = makeConfig({ enabled: false })
    await learnFromMessageUpdated(config, "I prefer spaces", { source: "message.updated" })
    expect(createLearningMemory).not.toHaveBeenCalled()
  })

  it("calls createLearningMemory when signal found", async () => {
    vi.mocked(detectPreferenceSignal).mockReturnValue({
      signalType: "correction",
      excerpt: "actually spaces",
    })
    vi.mocked(extractPreferenceCandidates).mockResolvedValue([
      { content: "Use spaces", confidence: 0.8, importance: 0.7, signalType: "correction", status: "confirmed" },
    ])
    const config = makeConfig()
    await learnFromMessageUpdated(config, "actually spaces", { source: "message.updated", eventType: "message.updated" })
    expect(createLearningMemory).toHaveBeenCalledOnce()
  })
})

describe("learnFromSessionIdleSummary", () => {
  it("skips when learningMemory disabled", async () => {
    const config = makeConfig({ enabled: false })
    await learnFromSessionIdleSummary(config, "We learned X", { source: "session.idle" })
    expect(extractLessonCandidates).not.toHaveBeenCalled()
  })

  it("skips when lessons sub-feature disabled", async () => {
    const config = makeConfig({ lessons: { enabled: false } })
    await learnFromSessionIdleSummary(config, "We learned X", { source: "session.idle" })
    expect(extractLessonCandidates).not.toHaveBeenCalled()
  })

  it("skips when text is fully private", async () => {
    vi.mocked(isFullyPrivate).mockReturnValue(true)
    const config = makeConfig()
    await learnFromSessionIdleSummary(config, "<!-- private -->secret", { source: "session.idle" })
    expect(extractLessonCandidates).not.toHaveBeenCalled()
  })

  it("calls extractLessonCandidates and stores results", async () => {
    vi.mocked(extractLessonCandidates).mockResolvedValue([
      { kind: "project_lesson", content: "Always run tests", confidence: 0.9, importance: 0.8, source: "lesson-learning" },
    ])
    const config = makeConfig()
    await learnFromSessionIdleSummary(config, "We always run tests before merging", { source: "session.idle" })
    expect(extractLessonCandidates).toHaveBeenCalledOnce()
    expect(createLearningMemory).toHaveBeenCalledOnce()
    const args = vi.mocked(createLearningMemory).mock.calls[0][1]
    expect(args.kind).toBe("project_lesson")
    expect(args.content).toBe("Always run tests")
  })

  it("does not call createLearningMemory when no candidates extracted", async () => {
    vi.mocked(extractLessonCandidates).mockResolvedValue([])
    const config = makeConfig()
    await learnFromSessionIdleSummary(config, "Nothing interesting happened", { source: "session.idle" })
    expect(createLearningMemory).not.toHaveBeenCalled()
  })
})

describe("learnFromCompactionSummary", () => {
  it("skips when learningMemory disabled", async () => {
    const config = makeConfig({ enabled: false })
    await learnFromCompactionSummary(config, "Summary text", { source: "compaction" })
    expect(extractLessonCandidates).not.toHaveBeenCalled()
  })

  it("calls extractLessonCandidates and stores results", async () => {
    vi.mocked(extractLessonCandidates).mockResolvedValue([
      { kind: "project_pitfall", content: "Don't import from dist/", confidence: 0.85, importance: 0.9, source: "lesson-learning" },
    ])
    const config = makeConfig()
    await learnFromCompactionSummary(config, "We hit a pitfall with dist imports", { source: "compaction" })
    expect(createLearningMemory).toHaveBeenCalledOnce()
    const args = vi.mocked(createLearningMemory).mock.calls[0][1]
    expect(args.kind).toBe("project_pitfall")
  })
})

describe("retrieveForInjection", () => {
  it("returns empty array when learningMemory disabled", async () => {
    const config = makeConfig({ enabled: false })
    const result = await retrieveForInjection(config, { source: "inject" })
    expect(result).toEqual([])
    expect(listLearningMemories).not.toHaveBeenCalled()
  })

  it("uses list when no query provided", async () => {
    vi.mocked(listLearningMemories).mockResolvedValue({
      status: "ok",
      records: [
        {
          id: "r1",
          content: "Use tabs",
          metadata: { learning: { schema_version: 1, kind: "user_preference", confidence: 0.9 } },
          valid_until: null,
          invalidation_reason: null,
          superseded_by: null,
          raw: {},
        },
      ],
    })
    const config = makeConfig()
    const result = await retrieveForInjection(config, { source: "inject" })
    expect(listLearningMemories).toHaveBeenCalledOnce()
    expect(searchLearningMemories).not.toHaveBeenCalled()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("r1")
    expect(result[0].kind).toBe("user_preference")
  })

  it("uses search when query provided", async () => {
    const config = makeConfig()
    await retrieveForInjection(config, { source: "inject", query: "tabs vs spaces" })
    expect(searchLearningMemories).toHaveBeenCalledOnce()
    expect(listLearningMemories).not.toHaveBeenCalled()
  })

  it("returns empty array when server returns unsupported", async () => {
    vi.mocked(listLearningMemories).mockResolvedValue({ status: "unsupported", records: [] })
    const config = makeConfig()
    const result = await retrieveForInjection(config, { source: "inject" })
    expect(result).toEqual([])
  })

  it("falls back to legacy preferences when server is unsupported and fallback enabled", async () => {
    vi.mocked(listLearningMemories).mockResolvedValue({ status: "unsupported", records: [] })
    vi.mocked(listLegacyPreferences).mockResolvedValue({
      status: "ok",
      memories: [{ id: "m1", content: "USER — Preference: Use tabs", metadata: { status: "confirmed" } }],
    })
    vi.mocked(formatLegacyPreferencesForInjection).mockReturnValue("## Legacy User Preferences\n- Use tabs")
    const config = makeConfig({ fallback: { legacyPreferences: true } })
    const result = await retrieveForInjection(config, { source: "inject" })
    expect(listLegacyPreferences).toHaveBeenCalledOnce()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("legacy-preferences")
    expect(result[0].kind).toBe("user_preference")
    expect(result[0].content).toContain("Use tabs")
  })

  it("does not fall back to legacy preferences when fallback disabled", async () => {
    vi.mocked(listLearningMemories).mockResolvedValue({ status: "unsupported", records: [] })
    const config = makeConfig({ fallback: { legacyPreferences: false } })
    const result = await retrieveForInjection(config, { source: "inject" })
    expect(listLegacyPreferences).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })

  it("falls back to legacy preferences on unsupported search response", async () => {
    vi.mocked(searchLearningMemories).mockResolvedValue({ status: "unsupported", records: [] })
    vi.mocked(listLegacyPreferences).mockResolvedValue({
      status: "ok",
      memories: [{ id: "m2", content: "USER — Preference: Use spaces", metadata: { status: "confirmed" } }],
    })
    vi.mocked(formatLegacyPreferencesForInjection).mockReturnValue("## Legacy User Preferences\n- Use spaces")
    const config = makeConfig({ fallback: { legacyPreferences: true } })
    const result = await retrieveForInjection(config, { source: "inject", query: "indentation" })
    expect(listLegacyPreferences).toHaveBeenCalledOnce()
    expect(result).toHaveLength(1)
    expect(result[0].content).toContain("Use spaces")
  })

  it("returns empty array and does not inject on degraded status", async () => {
    vi.mocked(listLearningMemories).mockResolvedValue({ status: "degraded", records: [] })
    const config = makeConfig({ fallback: { legacyPreferences: true } })
    const result = await retrieveForInjection(config, { source: "inject" })
    expect(listLegacyPreferences).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })

  it("returns empty array and does not inject on stale status", async () => {
    vi.mocked(listLearningMemories).mockResolvedValue({ status: "stale", records: [] })
    const config = makeConfig({ fallback: { legacyPreferences: true } })
    const result = await retrieveForInjection(config, { source: "inject" })
    expect(listLegacyPreferences).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })

  it("returns empty array when legacy fallback enabled but no legacy memories exist", async () => {
    vi.mocked(listLearningMemories).mockResolvedValue({ status: "unsupported", records: [] })
    vi.mocked(listLegacyPreferences).mockResolvedValue({ status: "empty", memories: [] })
    vi.mocked(formatLegacyPreferencesForInjection).mockReturnValue(null)
    const config = makeConfig({ fallback: { legacyPreferences: true } })
    const result = await retrieveForInjection(config, { source: "inject" })
    expect(result).toEqual([])
  })

  it("passes queryText as the search query to the server", async () => {
    const config = makeConfig()
    await retrieveForInjection(config, { source: "chat.message", queryText: "how do I format code?" })
    expect(searchLearningMemories).toHaveBeenCalledOnce()
    const args = vi.mocked(searchLearningMemories).mock.calls[0][1]
    expect(args.query).toBe("how do I format code?")
    expect(listLearningMemories).not.toHaveBeenCalled()
  })

  it("passes context_hints with source, session_id, namespace, user_id to server search", async () => {
    const config = {
      ...makeConfig(),
      memoryScope: { shareAcrossAgents: false, includeAgentMetadata: false, includeRunMetadata: false, namespace: "ns1", userId: "u1" },
    }
    await retrieveForInjection(config, {
      source: "chat.message",
      sessionId: "sess-abc",
      queryText: "tabs or spaces",
    })
    expect(searchLearningMemories).toHaveBeenCalledOnce()
    const args = vi.mocked(searchLearningMemories).mock.calls[0][1]
    expect(args.context_hints).toMatchObject({
      source: "chat.message",
      session_id: "sess-abc",
      namespace: "ns1",
      user_id: "u1",
    })
  })

  it("preserves server-returned record ordering without resorting", async () => {
    const makeRecord = (id: string, content: string) => ({
      id,
      content,
      metadata: { learning: { schema_version: 1, kind: "project_lesson" as const, confidence: 0.8 } },
      valid_until: null,
      invalidation_reason: null,
      superseded_by: null,
      raw: {},
    })
    vi.mocked(searchLearningMemories).mockResolvedValue({
      status: "ok",
      records: [makeRecord("b", "Record B"), makeRecord("a", "Record A")],
    })
    const config = makeConfig()
    const result = await retrieveForInjection(config, { source: "chat.message", queryText: "anything" })
    expect(result[0].id).toBe("b")
    expect(result[1].id).toBe("a")
  })

  it("does not broaden project-scoped search to global without explicit config", async () => {
    const config = makeConfig()
    await retrieveForInjection(config, { source: "chat.message", queryText: "something" })
    expect(searchLearningMemories).toHaveBeenCalledOnce()
    const args = vi.mocked(searchLearningMemories).mock.calls[0][1]
    expect(args.scope?.level).toBe("project")
    expect(args.fallback?.include_global).toBeFalsy()
  })

  it("does not broaden project-scoped list to global without explicit config", async () => {
    const config = makeConfig()
    await retrieveForInjection(config, { source: "inject" })
    expect(listLearningMemories).toHaveBeenCalledOnce()
    const args = vi.mocked(listLearningMemories).mock.calls[0][1]
    expect(args.scope?.level).toBe("project")
    expect(args.fallback?.include_global).toBeFalsy()
  })
})
