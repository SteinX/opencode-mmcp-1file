import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  trackMessageTokens,
  shouldTriggerCompaction,
  resetSessionState,
  performPreemptiveCompaction,
} from "../../src/services/preemptive-compaction.js"
import type { PluginConfig } from "../../src/config.js"

vi.mock("../../src/services/mcp-client.js", () => ({
  recall: vi.fn().mockResolvedValue([]),
}))

vi.mock("../../src/utils/format.js", () => ({
  formatMemoriesForInjection: vi.fn().mockReturnValue("formatted memories"),
}))

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { recall } = await import("../../src/services/mcp-client.js")

function makeConfig(overrides?: Partial<Pick<PluginConfig, "preemptiveCompaction">>): PluginConfig {
  return {
    chatMessage: { enabled: true, maxMemories: 5, maxProjectMemories: 30, maxInjectedMemories: 6, injectOn: "first", shortQueryMinLength: 3, minScore: 0.35 },
    autoCapture: { enabled: true, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: {
      enabled: true,
      thresholdPercent: 80,
      modelContextLimit: 200000,
      autoContinue: true,
      ...overrides?.preemptiveCompaction,
    },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    codeIndexSync: { enabled: true, debounceMs: 10000, minReindexIntervalMs: 300000 },
    captureModel: { provider: "openai", model: "gpt-4o-mini", apiUrl: "", apiKey: "" },
    mcpServer: { command: ["npx", "-y", "memory-mcp-1file"], tag: "default", model: "qwen3", transport: "http", port: 23817, bind: "127.0.0.1", mcpServerName: "memory-mcp-1file" },
    systemPrompt: { enabled: true },
  } as PluginConfig
}

describe("trackMessageTokens & shouldTriggerCompaction", () => {
  beforeEach(() => {
    resetSessionState("test-preemptive")
  })

  it("does not trigger compaction below minimum token threshold", () => {
    const config = makeConfig()
    trackMessageTokens("test-preemptive", "short message")
    expect(shouldTriggerCompaction(config, "test-preemptive", 200000)).toBe(false)
  })

  it("triggers compaction when tokens exceed threshold percentage", () => {
    const config = makeConfig({ preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true } })
    const longText = "a".repeat(800000)
    trackMessageTokens("test-preemptive", longText)

    expect(shouldTriggerCompaction(config, "test-preemptive", 200000)).toBe(true)
  })

  it("does not trigger when below threshold percentage even with many tokens", () => {
    const config = makeConfig({ preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true } })
    const text = "a".repeat(200000)
    trackMessageTokens("test-preemptive", text)

    expect(shouldTriggerCompaction(config, "test-preemptive", 200000)).toBe(false)
  })

  it("accumulates tokens across multiple calls", () => {
    const config = makeConfig({ preemptiveCompaction: { enabled: true, thresholdPercent: 50, modelContextLimit: 200000, autoContinue: true } })
    for (let i = 0; i < 100; i++) {
      trackMessageTokens("test-preemptive", "a".repeat(4000))
    }
    expect(shouldTriggerCompaction(config, "test-preemptive", 200000)).toBe(true)
  })

  it("handles CJK text token estimation", () => {
    const config = makeConfig({ preemptiveCompaction: { enabled: true, thresholdPercent: 50, modelContextLimit: 200000, autoContinue: true } })
    const cjkText = "中".repeat(400000)
    trackMessageTokens("test-preemptive", cjkText)

    expect(shouldTriggerCompaction(config, "test-preemptive", 200000)).toBe(true)
  })
})

describe("resetSessionState", () => {
  it("resets token count so compaction is no longer triggered", () => {
    const config = makeConfig({ preemptiveCompaction: { enabled: true, thresholdPercent: 50, modelContextLimit: 200000, autoContinue: true } })
    trackMessageTokens("test-reset", "a".repeat(800000))
    expect(shouldTriggerCompaction(config, "test-reset", 200000)).toBe(true)

    resetSessionState("test-reset")
    expect(shouldTriggerCompaction(config, "test-reset", 200000)).toBe(false)
  })
})

describe("performPreemptiveCompaction", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSessionState("test-perform")
  })

  it("returns true on successful compaction with no memories", async () => {
    const config = makeConfig()
    const mockClient = {
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        summarize: vi.fn().mockResolvedValue(undefined),
      },
    }

    const result = await performPreemptiveCompaction(config, mockClient, "test-perform")
    expect(result).toBe(true)
    expect(mockClient.session.prompt).not.toHaveBeenCalled()
    expect(mockClient.session.summarize).toHaveBeenCalledWith({ path: { id: "test-perform" } })
  })

  it("injects memory context when memories are available", async () => {
    vi.mocked(recall).mockResolvedValueOnce([
      { id: "1", content: "test memory", score: 1 },
    ] as any)

    const config = makeConfig()
    const mockClient = {
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        summarize: vi.fn().mockResolvedValue(undefined),
      },
    }

    const result = await performPreemptiveCompaction(config, mockClient, "test-perform")
    expect(result).toBe(true)
    expect(mockClient.session.prompt).toHaveBeenCalledWith({
      path: { id: "test-perform" },
      body: expect.objectContaining({
        parts: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("[COMPACTION CONTEXT]"),
          }),
        ]),
        noReply: true,
      }),
    })
  })

  it("returns false when summarize throws", async () => {
    const config = makeConfig()
    const mockClient = {
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        summarize: vi.fn().mockRejectedValue(new Error("summarize failed")),
      },
    }

    const result = await performPreemptiveCompaction(config, mockClient, "test-perform")
    expect(result).toBe(false)
  })

  it("resets compactionInProgress flag even on failure", async () => {
    const config = makeConfig()
    const mockClient = {
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        summarize: vi.fn().mockRejectedValue(new Error("fail")),
      },
    }

    await performPreemptiveCompaction(config, mockClient, "test-perform")

    trackMessageTokens("test-perform", "a".repeat(800000))
    expect(shouldTriggerCompaction(config, "test-perform", 200000)).toBe(true)
  })

  it("prevents concurrent compaction for same session", async () => {
    const config = makeConfig()
    let resolveFirst: () => void
    const firstPromise = new Promise<void>((r) => { resolveFirst = r })

    const mockClient = {
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        summarize: vi.fn().mockImplementation(() => firstPromise),
      },
    }

    const p1 = performPreemptiveCompaction(config, mockClient, "test-perform")

    trackMessageTokens("test-perform", "a".repeat(800000))
    expect(shouldTriggerCompaction(config, "test-perform", 200000)).toBe(false)

    resolveFirst!()
    await p1
  })
})
