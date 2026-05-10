import { describe, it, expect, vi } from "vitest"
import {
  detectPreferenceSignal,
  extractPreferenceCandidates,
  fetchAndFormatLearnedPreferences,
  markLearnedPreferencesCompacted,
  markLearnedPreferencesInjected,
  parsePreferenceCandidates,
  resetPreferenceLearningStoreStateForTests,
  shouldInjectLearnedPreferences,
  storePreferenceCandidates,
  type PreferenceSignal,
} from "../../src/services/preference-learning.js"
import { DEFAULT_CONFIG } from "../../src/config.js"
import type { PluginConfig } from "../../src/config.js"
import type { RetrievalResult } from "../../src/services/mcp-client.js"

function makeConfig(overrides?: Partial<PluginConfig["preferenceLearning"]>): PluginConfig {
  return {
    ...DEFAULT_CONFIG,
    preferenceLearning: {
      ...DEFAULT_CONFIG.preferenceLearning,
      enabled: true,
      ...overrides,
    },
  }
}

describe("detectPreferenceSignal", () => {
  it("detects explicit preference statements", () => {
    const config = makeConfig()
    const signal = detectPreferenceSignal("I prefer short, direct answers.", config.preferenceLearning)

    expect(signal?.signalType).toBe("explicit_preference")
    expect(signal?.excerpt.toLowerCase()).toContain("prefer")
  })

  it("detects correction when enabled", () => {
    const config = makeConfig({ learnOnCorrections: true })
    const signal = detectPreferenceSignal("Actually, that's incorrect. Use pnpm instead.", config.preferenceLearning)

    expect(signal?.signalType).toBe("correction")
  })

  it("does not detect correction when learnOnCorrections is disabled", () => {
    const config = makeConfig({ learnOnCorrections: false })
    const signal = detectPreferenceSignal("Actually, that's incorrect. Use pnpm instead.", config.preferenceLearning)

    expect(signal).toBeNull()
  })

  it("detects negation when enabled", () => {
    const config = makeConfig({ learnOnNegations: true })
    const signal = detectPreferenceSignal("Please don't use emojis in responses.", config.preferenceLearning)

    expect(signal?.signalType).toBe("negation")
  })

  it("does not detect negation when learnOnNegations is disabled", () => {
    const config = makeConfig({ learnOnNegations: false })
    const signal = detectPreferenceSignal("Please don't use emojis in responses.", config.preferenceLearning)

    expect(signal).toBeNull()
  })

  it("detects message_updated events when enabled", () => {
    const config = makeConfig({ learnOnMessageUpdated: true })
    const signal = detectPreferenceSignal(
      "Updated text content",
      config.preferenceLearning,
      { eventType: "message.updated", source: "event" },
    )

    expect(signal?.signalType).toBe("message_updated")
    expect(signal?.eventType).toBe("message.updated")
    expect(signal?.source).toBe("event")
  })

  it("does not detect message_updated events when disabled", () => {
    const config = makeConfig({ learnOnMessageUpdated: false })
    const signal = detectPreferenceSignal(
      "Updated text content",
      config.preferenceLearning,
      { eventType: "message.updated" },
    )

    expect(signal).toBeNull()
  })
})

describe("parsePreferenceCandidates", () => {
  it("returns parsed candidates and maps confidence to candidate/confirmed", () => {
    const output = JSON.stringify([
      { content: "Use concise bullet points", confidence: 0.85, rationale: "Repeated request", category: "style" },
      { content: "Avoid tables unless requested", confidence: 0.5, rationale: "Soft preference", category: "format" },
      { content: "Low confidence item", confidence: 0.2 },
    ])

    const result = parsePreferenceCandidates(output, "explicit_preference", {
      minConfidence: 0.7,
      candidateConfidence: 0.4,
    })

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      content: "Use concise bullet points",
      confidence: 0.85,
      signalType: "explicit_preference",
      status: "confirmed",
      rationale: "Repeated request",
      category: "style",
    })
    expect(result[1].status).toBe("candidate")
  })

  it("returns [] for malformed JSON", () => {
    const result = parsePreferenceCandidates("not-json", "explicit_preference", {
      minConfidence: 0.7,
      candidateConfidence: 0.4,
    })

    expect(result).toEqual([])
  })

  it("returns [] for non-array JSON", () => {
    const result = parsePreferenceCandidates(
      JSON.stringify({ content: "single object" }),
      "explicit_preference",
      {
        minConfidence: 0.7,
        candidateConfidence: 0.4,
      },
    )

    expect(result).toEqual([])
  })
})

describe("learned preference injection helpers", () => {
  it("supports injectOn mode matrix for first/always/compaction/never", () => {
    resetPreferenceLearningStoreStateForTests()
    const sessionID = "s1"

    const firstConfig = makeConfig({ injectOn: "first" })
    expect(shouldInjectLearnedPreferences(firstConfig, sessionID, false)).toBe(true)
    markLearnedPreferencesInjected(sessionID)
    expect(shouldInjectLearnedPreferences(firstConfig, sessionID, false)).toBe(false)
    expect(shouldInjectLearnedPreferences(firstConfig, sessionID, true)).toBe(false)

    const alwaysConfig = makeConfig({ injectOn: "always" })
    expect(shouldInjectLearnedPreferences(alwaysConfig, sessionID, false)).toBe(true)
    expect(shouldInjectLearnedPreferences(alwaysConfig, sessionID, true)).toBe(true)

    const compactionConfig = makeConfig({ injectOn: "compaction" })
    expect(shouldInjectLearnedPreferences(compactionConfig, sessionID, false)).toBe(false)
    expect(shouldInjectLearnedPreferences(compactionConfig, sessionID, true)).toBe(true)

    const neverConfig = makeConfig({ injectOn: "never" })
    expect(shouldInjectLearnedPreferences(neverConfig, sessionID, false)).toBe(false)
    expect(shouldInjectLearnedPreferences(neverConfig, sessionID, true)).toBe(false)
  })

  it("returns false when preference learning is disabled", () => {
    resetPreferenceLearningStoreStateForTests()
    const config = makeConfig({ enabled: false, injectOn: "always" })

    expect(shouldInjectLearnedPreferences(config, "s1", false)).toBe(false)
    expect(shouldInjectLearnedPreferences(config, "s1", true)).toBe(false)
  })

  it("allows first-mode reinjection after compaction reset helper", () => {
    resetPreferenceLearningStoreStateForTests()
    const config = makeConfig({ injectOn: "first" })
    const sessionID = "s-reinject"

    expect(shouldInjectLearnedPreferences(config, sessionID, false)).toBe(true)
    markLearnedPreferencesInjected(sessionID)
    expect(shouldInjectLearnedPreferences(config, sessionID, false)).toBe(false)

    markLearnedPreferencesCompacted(sessionID)
    expect(shouldInjectLearnedPreferences(config, sessionID, false)).toBe(true)
  })

  it("fetches and formats confirmed and candidate preferences with strict prefix filter + dedupe", async () => {
    const config = makeConfig({ maxPreferences: 2, maxCandidates: 1 })
    const memoriesWithMetadata: RetrievalResult["memories"] = [
      { id: "1", content: "USER — Preference: Use concise bullets" },
      { id: "2", content: "USER — Preference: use   concise bullets" },
      { id: "3", content: "USER — Preference: Ask clarifying questions before assumptions" },
      { id: "4", content: "USER — Preference: Keep summaries under 5 bullets" },
      { id: "5", content: "DECISION — This should never be included" },
    ]
    Object.assign(memoriesWithMetadata[0], { metadata: { status: "confirmed" } })
    Object.assign(memoriesWithMetadata[1], { metadata: { status: "candidate" } })
    Object.assign(memoriesWithMetadata[2], { metadata: { status: "candidate" } })
    Object.assign(memoriesWithMetadata[4], { metadata: { status: "confirmed" } })

    const listFn = vi.fn().mockResolvedValue({
      status: "ok",
      source: "list",
      memories: memoriesWithMetadata,
    } satisfies RetrievalResult)

    const formatted = await fetchAndFormatLearnedPreferences(config, undefined, { listFn })

    expect(listFn).toHaveBeenCalledWith(
      config,
      config.preferenceLearning.maxStoredPreferences,
      false,
      expect.objectContaining({ namespace: undefined }),
    )
    expect(formatted).toContain("[MEMORY] Learned User Preferences")
    expect(formatted).toContain("## Confirmed Preferences")
    expect(formatted).toContain("Treat these as strong guidance")
    expect(formatted).toContain("- Use concise bullets")
    expect(formatted).toContain("- Keep summaries under 5 bullets")
    expect(formatted).toContain("## Candidate Preferences")
    expect(formatted).toContain("Tentative hints only")
    expect(formatted).toContain("- Ask clarifying questions before assumptions")
    expect(formatted).not.toContain("DECISION —")
    expect(formatted).not.toContain("- use   concise bullets")
  })

  it("uses global namespace override for learned preference retrieval", async () => {
    const config = makeConfig({ scope: "global" })
    const listFn = vi.fn().mockResolvedValue({
      status: "ok",
      source: "list",
      memories: [{ id: "1", content: "USER — Preference: Prefer pnpm" }],
    } satisfies RetrievalResult)

    await fetchAndFormatLearnedPreferences(
      config,
      { namespace: "project-ns", agentId: "a1" },
      { listFn },
    )

    expect(listFn).toHaveBeenCalledWith(
      config,
      config.preferenceLearning.maxStoredPreferences,
      false,
      expect.objectContaining({ namespace: "global", agentId: "a1" }),
    )
  })

  it("returns null when retrieval is unavailable/empty/invalid/feature-disabled", async () => {
    const unavailable = vi.fn().mockResolvedValue({
      status: "unavailable",
      source: "list",
      memories: [],
    } satisfies RetrievalResult)
    const empty = vi.fn().mockResolvedValue({
      status: "ok",
      source: "list",
      memories: [],
    } satisfies RetrievalResult)
    const invalid = vi.fn().mockResolvedValue({
      status: "ok",
      source: "list",
      memories: [{ id: "x", content: "PATTERN — Not a user preference" }],
    } satisfies RetrievalResult)
    const throwing = vi.fn().mockRejectedValue(new Error("boom"))

    await expect(fetchAndFormatLearnedPreferences(makeConfig(), undefined, { listFn: unavailable })).resolves.toBeNull()
    await expect(fetchAndFormatLearnedPreferences(makeConfig(), undefined, { listFn: empty })).resolves.toBeNull()
    await expect(fetchAndFormatLearnedPreferences(makeConfig(), undefined, { listFn: invalid })).resolves.toBeNull()
    await expect(fetchAndFormatLearnedPreferences(makeConfig(), undefined, { listFn: throwing })).resolves.toBeNull()
    await expect(fetchAndFormatLearnedPreferences(makeConfig({ enabled: false }), undefined, { listFn: empty })).resolves.toBeNull()
  })

  it("formats candidate-only and confirmed-only preference lists cleanly", async () => {
    const candidateOnlyConfig = makeConfig({ maxPreferences: 2, maxCandidates: 2 })
    const candidateOnlyMemories: RetrievalResult["memories"] = [
      {
        id: "c1",
        content: "USER — Preference: Ask before assuming",
      },
    ]
    Object.assign(candidateOnlyMemories[0], { metadata: { status: "candidate" } })
    const candidateOnlyList = vi.fn().mockResolvedValue({
      status: "ok",
      source: "list",
      memories: candidateOnlyMemories,
    } satisfies RetrievalResult)

    const candidateOnlyFormatted = await fetchAndFormatLearnedPreferences(
      candidateOnlyConfig,
      undefined,
      { listFn: candidateOnlyList },
    )

    expect(candidateOnlyFormatted).toContain("[MEMORY] Learned User Preferences")
    expect(candidateOnlyFormatted).toContain("## Candidate Preferences")
    expect(candidateOnlyFormatted).toContain("- Ask before assuming")
    expect(candidateOnlyFormatted).not.toContain("## Confirmed Preferences")

    const confirmedOnlyConfig = makeConfig({ maxPreferences: 2, maxCandidates: 2 })
    const confirmedOnlyMemories: RetrievalResult["memories"] = [
      {
        id: "p1",
        content: "USER — Preference: Keep responses concise",
      },
    ]
    Object.assign(confirmedOnlyMemories[0], { metadata: { status: "confirmed" } })
    const confirmedOnlyList = vi.fn().mockResolvedValue({
      status: "ok",
      source: "list",
      memories: confirmedOnlyMemories,
    } satisfies RetrievalResult)

    const confirmedOnlyFormatted = await fetchAndFormatLearnedPreferences(
      confirmedOnlyConfig,
      undefined,
      { listFn: confirmedOnlyList },
    )

    expect(confirmedOnlyFormatted).toContain("[MEMORY] Learned User Preferences")
    expect(confirmedOnlyFormatted).toContain("## Confirmed Preferences")
    expect(confirmedOnlyFormatted).toContain("- Keep responses concise")
    expect(confirmedOnlyFormatted).not.toContain("## Candidate Preferences")
  })
})

describe("extractPreferenceCandidates", () => {
  it("stores filtered candidates with metadata and project scope context", async () => {
    resetPreferenceLearningStoreStateForTests()
    const config = makeConfig({ scope: "project" })

    const listFn = vi.fn().mockResolvedValue({
      status: "empty",
      source: "list",
      memories: [],
    } satisfies RetrievalResult)
    const storeFn = vi.fn().mockResolvedValue(true)

    const result = await storePreferenceCandidates(
      config,
      [
        {
          content: "Use <private>my name is Alice</private> and concise bullets",
          confidence: 0.92,
          signalType: "explicit_preference",
          status: "confirmed",
          category: "style",
        },
      ],
      { agentId: "agent-1", runId: "run-1", metadata: { origin: "test" } },
      { listFn, storeFn, nowMs: 1000 },
    )

    expect(result).toEqual({
      stored: 1,
      skippedDuplicate: 0,
      skippedPrivate: 0,
      skippedThrottled: 0,
      skippedLimit: 0,
      failed: 0,
    })

    expect(listFn).toHaveBeenCalledWith(
      config,
      config.preferenceLearning.maxStoredPreferences,
      false,
      expect.objectContaining({
        agentId: "agent-1",
        runId: "run-1",
        metadata: { origin: "test" },
      }),
    )

    expect(storeFn).toHaveBeenCalledWith(
      config,
      "USER — Preference: Use [REDACTED] and concise bullets",
      "semantic",
      expect.objectContaining({
        agentId: "agent-1",
        runId: "run-1",
        memoryType: "semantic",
        metadata: expect.objectContaining({
          kind: "preference_learning",
          status: "confirmed",
          signalType: "explicit_preference",
          confidence: 0.92,
          category: "style",
          scope: "project",
          origin: "test",
        }),
      }),
    )
  })

  it("skips fully private or empty-after-filter candidates", async () => {
    resetPreferenceLearningStoreStateForTests()
    const config = makeConfig()

    const listFn = vi.fn().mockResolvedValue({
      status: "empty",
      source: "list",
      memories: [],
    } satisfies RetrievalResult)
    const storeFn = vi.fn().mockResolvedValue(true)

    const result = await storePreferenceCandidates(
      config,
      [
        {
          content: "<private>secret only</private>",
          confidence: 0.95,
          signalType: "explicit_preference",
          status: "confirmed",
        },
        {
          content: "<private>very secret</private>",
          confidence: 0.6,
          signalType: "negation",
          status: "candidate",
        },
      ],
      undefined,
      { listFn, storeFn, nowMs: 1000 },
    )

    expect(result.stored).toBe(0)
    expect(result.skippedPrivate).toBe(2)
    expect(storeFn).not.toHaveBeenCalled()
  })

  it("skips duplicates against existing and same batch normalized content", async () => {
    resetPreferenceLearningStoreStateForTests()
    const config = makeConfig()

    const listFn = vi.fn().mockResolvedValue({
      status: "ok",
      source: "list",
      memories: [{ id: "m1", content: "USER — Preference: Use concise bullets" }],
    } satisfies RetrievalResult)
    const storeFn = vi.fn().mockResolvedValue(true)

    const result = await storePreferenceCandidates(
      config,
      [
        {
          content: "  Use   concise   bullets ",
          confidence: 0.9,
          signalType: "explicit_preference",
          status: "confirmed",
        },
        {
          content: "Avoid tables unless requested",
          confidence: 0.8,
          signalType: "explicit_preference",
          status: "confirmed",
        },
        {
          content: "avoid   tables unless requested",
          confidence: 0.7,
          signalType: "explicit_preference",
          status: "candidate",
        },
      ],
      undefined,
      { listFn, storeFn, nowMs: 1000 },
    )

    expect(result.stored).toBe(1)
    expect(result.skippedDuplicate).toBe(2)
    expect(storeFn).toHaveBeenCalledTimes(1)
    expect(storeFn).toHaveBeenCalledWith(
      config,
      "USER — Preference: Avoid tables unless requested",
      "semantic",
      expect.any(Object),
    )
  })

  it("enforces per-call confirmed/candidate limits before storage", async () => {
    resetPreferenceLearningStoreStateForTests()
    const config = makeConfig({ maxPreferences: 1, maxCandidates: 1 })

    const listFn = vi.fn().mockResolvedValue({
      status: "empty",
      source: "list",
      memories: [],
    } satisfies RetrievalResult)
    const storeFn = vi.fn().mockResolvedValue(true)

    const result = await storePreferenceCandidates(
      config,
      [
        {
          content: "Confirmed A",
          confidence: 0.9,
          signalType: "explicit_preference",
          status: "confirmed",
        },
        {
          content: "Confirmed B",
          confidence: 0.95,
          signalType: "explicit_preference",
          status: "confirmed",
        },
        {
          content: "Candidate A",
          confidence: 0.5,
          signalType: "correction",
          status: "candidate",
        },
        {
          content: "Candidate B",
          confidence: 0.45,
          signalType: "negation",
          status: "candidate",
        },
      ],
      undefined,
      { listFn, storeFn, nowMs: 1000 },
    )

    expect(result.stored).toBe(2)
    expect(result.skippedLimit).toBe(2)
    expect(storeFn).toHaveBeenCalledTimes(2)
  })

  it("applies debounce throttling per stable scope key", async () => {
    resetPreferenceLearningStoreStateForTests()
    const config = makeConfig({ debounceMs: 10000 })

    const listFn = vi.fn().mockResolvedValue({
      status: "empty",
      source: "list",
      memories: [],
    } satisfies RetrievalResult)
    const storeFn = vi.fn().mockResolvedValue(true)

    const candidate = {
      content: "Prefer short answers",
      confidence: 0.9,
      signalType: "explicit_preference" as const,
      status: "confirmed" as const,
    }

    const first = await storePreferenceCandidates(
      config,
      [candidate],
      undefined,
      { listFn, storeFn, nowMs: 1000 },
    )
    const second = await storePreferenceCandidates(
      config,
      [candidate],
      undefined,
      { listFn, storeFn, nowMs: 5000 },
    )

    expect(first.stored).toBe(1)
    expect(second.stored).toBe(0)
    expect(second.skippedThrottled).toBe(1)
    expect(listFn).toHaveBeenCalledTimes(1)
  })

  it("enforces maxStoredPreferences capacity against existing memories", async () => {
    resetPreferenceLearningStoreStateForTests()
    const config = makeConfig({ maxStoredPreferences: 1 })

    const listFn = vi.fn().mockResolvedValue({
      status: "ok",
      source: "list",
      memories: [{ id: "m1", content: "USER — Preference: Existing preference" }],
    } satisfies RetrievalResult)
    const storeFn = vi.fn().mockResolvedValue(true)

    const result = await storePreferenceCandidates(
      config,
      [
        {
          content: "New preference",
          confidence: 0.9,
          signalType: "explicit_preference",
          status: "confirmed",
        },
      ],
      undefined,
      { listFn, storeFn, nowMs: 1000 },
    )

    expect(result.stored).toBe(0)
    expect(result.skippedLimit).toBe(1)
    expect(storeFn).not.toHaveBeenCalled()
  })

  it("counts failed stores and continues processing", async () => {
    resetPreferenceLearningStoreStateForTests()
    const config = makeConfig()

    const listFn = vi.fn().mockResolvedValue({
      status: "empty",
      source: "list",
      memories: [],
    } satisfies RetrievalResult)
    const storeFn = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    const result = await storePreferenceCandidates(
      config,
      [
        {
          content: "First preference",
          confidence: 0.9,
          signalType: "explicit_preference",
          status: "confirmed",
        },
        {
          content: "Second preference",
          confidence: 0.8,
          signalType: "correction",
          status: "confirmed",
        },
      ],
      undefined,
      { listFn, storeFn, nowMs: 1000 },
    )

    expect(result.failed).toBe(1)
    expect(result.stored).toBe(1)
    expect(storeFn).toHaveBeenCalledTimes(2)
  })

  it("uses global namespace context when scope is global", async () => {
    resetPreferenceLearningStoreStateForTests()
    const config = makeConfig({ scope: "global" })

    const listFn = vi.fn().mockResolvedValue({
      status: "empty",
      source: "list",
      memories: [],
    } satisfies RetrievalResult)
    const storeFn = vi.fn().mockResolvedValue(true)

    await storePreferenceCandidates(
      config,
      [
        {
          content: "Prefer pnpm",
          confidence: 0.9,
          signalType: "correction",
          status: "confirmed",
        },
      ],
      { namespace: "project-ns" },
      { listFn, storeFn, nowMs: 1000 },
    )

    expect(listFn).toHaveBeenCalledWith(config, config.preferenceLearning.maxStoredPreferences, false, {
      namespace: "global",
    })
    expect(storeFn).toHaveBeenCalledWith(
      config,
      "USER — Preference: Prefer pnpm",
      "semantic",
      expect.objectContaining({ namespace: "global" }),
    )
  })

  it("truncates input by maxInputChars before prompting", async () => {
    const config = makeConfig({ maxInputChars: 20 })
    const signal: PreferenceSignal = {
      signalType: "explicit_preference",
      excerpt: "prefer",
    }

    const longText = "12345678901234567890EXTRA"
    const llmCaller = vi.fn().mockResolvedValue("[]")

    await extractPreferenceCandidates(config, longText, signal, llmCaller)

    const messages = llmCaller.mock.calls[0][1] as Array<{ role: string; content: string }>
    const userPrompt = messages.find((m) => m.role === "user")?.content ?? ""
    expect(userPrompt).toContain("12345678901234567890")
    expect(userPrompt).not.toContain("EXTRA")
  })

  it("parses valid JSON array output", async () => {
    const config = makeConfig()
    const signal: PreferenceSignal = {
      signalType: "correction",
      excerpt: "Actually",
    }

    const llmCaller = vi.fn().mockResolvedValue(
      JSON.stringify([{ content: "Use pnpm in this repo", confidence: 0.9, category: "tooling" }]),
    )

    const result = await extractPreferenceCandidates(config, "Actually, use pnpm.", signal, llmCaller)
    expect(result).toEqual([
      {
        kind: "user_preference",
        content: "Use pnpm in this repo",
        confidence: 0.9,
        importance: 0.8,
        source: "preference-learning",
        evidence: undefined,
      },
    ])
  })

  it("returns [] when LLM returns malformed JSON", async () => {
    const config = makeConfig()
    const signal: PreferenceSignal = {
      signalType: "negation",
      excerpt: "don't",
    }

    const llmCaller = vi.fn().mockResolvedValue("```json\n{bad\n```")
    const result = await extractPreferenceCandidates(config, "Don't use emojis.", signal, llmCaller)

    expect(result).toEqual([])
  })

  it("returns [] when LLM returns non-array JSON", async () => {
    const config = makeConfig()
    const signal: PreferenceSignal = {
      signalType: "explicit_preference",
      excerpt: "prefer",
    }

    const llmCaller = vi.fn().mockResolvedValue(JSON.stringify({ content: "single" }))
    const result = await extractPreferenceCandidates(config, "I prefer concise answers.", signal, llmCaller)

    expect(result).toEqual([])
  })
})
