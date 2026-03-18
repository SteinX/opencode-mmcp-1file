import { describe, it, expect, vi, beforeEach } from "vitest"
import { performAutoCapture, getLastCapturedId } from "../../src/services/auto-capture.js"
import type { PluginConfig } from "../../src/config.js"

vi.mock("../../src/services/mcp-client.js", () => ({
  storeMemory: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { storeMemory } = await import("../../src/services/mcp-client.js")

function makeConfig(overrides?: Partial<PluginConfig>): PluginConfig {
  return {
    chatMessage: { enabled: true, maxMemories: 5, injectOn: "first" },
    autoCapture: { enabled: true, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: false },
    compactionSummaryCapture: { enabled: true },
    captureModel: { provider: "openai", model: "gpt-4o-mini", apiUrl: "", apiKey: "" },
    mcpServer: { command: ["npx", "-y", "memory-mcp-1file"], tag: "default", model: "qwen3", transport: "http", port: 23817, registerInOpencode: true, mcpServerName: "memory-mcp-1file" },
    systemPrompt: { enabled: true },
    ...overrides,
  } as PluginConfig
}

function makeMessages(messages: Array<{ id: string; role: string; text: string }>) {
  return messages.map((m) => ({
    info: { id: m.id, role: m.role },
    parts: [{ type: "text", text: m.text }],
  }))
}

describe("performAutoCapture", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns false when fewer than 2 uncaptured messages", async () => {
    const config = makeConfig()
    const messages = makeMessages([{ id: "1", role: "user", text: "hello" }])
    const callLLM = vi.fn()

    const result = await performAutoCapture(config, "test-session-single", messages, callLLM)
    expect(result).toBe(false)
    expect(callLLM).not.toHaveBeenCalled()
  })

  it("returns false when no user messages", async () => {
    const config = makeConfig()
    const messages = makeMessages([
      { id: "1", role: "assistant", text: "hi" },
      { id: "2", role: "assistant", text: "there" },
    ])
    const callLLM = vi.fn()

    const result = await performAutoCapture(config, "test-session-no-user", messages, callLLM)
    expect(result).toBe(false)
  })

  it("returns false when no assistant messages", async () => {
    const config = makeConfig()
    const messages = makeMessages([
      { id: "1", role: "user", text: "hi" },
      { id: "2", role: "user", text: "there" },
    ])
    const callLLM = vi.fn()

    const result = await performAutoCapture(config, "test-session-no-asst", messages, callLLM)
    expect(result).toBe(false)
  })

  it("calls LLM and stores memory on valid exchange", async () => {
    const config = makeConfig()
    const messages = makeMessages([
      { id: "1", role: "user", text: "How do I configure ESLint?" },
      { id: "2", role: "assistant", text: "You need to create an .eslintrc file..." },
    ])
    const callLLM = vi.fn().mockResolvedValue(
      JSON.stringify({
        summary: "ESLint configuration guide",
        prefix: "CONTEXT:",
        memory_type: "procedural",
        tags: ["eslint"],
      }),
    )

    const result = await performAutoCapture(config, "test-session-valid", messages, callLLM)
    expect(result).toBe(true)
    expect(callLLM).toHaveBeenCalledOnce()
    expect(storeMemory).toHaveBeenCalledWith(config, "CONTEXT: ESLint configuration guide", "procedural")
  })

  it("returns false when LLM returns SKIP prefix", async () => {
    const config = makeConfig()
    const messages = makeMessages([
      { id: "1", role: "user", text: "hi" },
      { id: "2", role: "assistant", text: "hello!" },
    ])
    const callLLM = vi.fn().mockResolvedValue(
      JSON.stringify({
        summary: "",
        prefix: "SKIP",
        memory_type: "semantic",
        tags: [],
      }),
    )

    const result = await performAutoCapture(config, "test-session-skip", messages, callLLM)
    expect(result).toBe(false)
    expect(storeMemory).not.toHaveBeenCalled()
  })

  it("returns false when LLM throws error", async () => {
    const config = makeConfig()
    const messages = makeMessages([
      { id: "1", role: "user", text: "help" },
      { id: "2", role: "assistant", text: "sure" },
    ])
    const callLLM = vi.fn().mockRejectedValue(new Error("LLM down"))

    const result = await performAutoCapture(config, "test-session-error", messages, callLLM)
    expect(result).toBe(false)
  })

  it("strips private content when privacy is enabled", async () => {
    const config = makeConfig({ privacy: { enabled: true } })
    const messages = makeMessages([
      { id: "1", role: "user", text: "Store my <private>api-key-123</private> config" },
      { id: "2", role: "assistant", text: "Done!" },
    ])
    const callLLM = vi.fn().mockResolvedValue(
      JSON.stringify({
        summary: "Stored <private>api-key-123</private> configuration details for the project",
        prefix: "CONTEXT:",
        memory_type: "semantic",
        tags: ["config"],
      }),
    )

    await performAutoCapture(config, "test-session-privacy", messages, callLLM)

    const storedContent = vi.mocked(storeMemory).mock.calls[0]?.[1]
    expect(storedContent).not.toContain("api-key-123")
    expect(storedContent).toContain("[REDACTED]")
  })

  it("skips already-captured messages using lastCapturedMessageId", async () => {
    const config = makeConfig()
    const sessionID = "test-session-incremental"

    const messages1 = makeMessages([
      { id: "m1", role: "user", text: "first question" },
      { id: "m2", role: "assistant", text: "first answer" },
    ])

    const callLLM = vi.fn().mockResolvedValue(
      JSON.stringify({ summary: "first capture", prefix: "CONTEXT:", memory_type: "semantic", tags: [] }),
    )

    await performAutoCapture(config, sessionID, messages1, callLLM)
    expect(getLastCapturedId(sessionID)).toBe("m2")

    vi.clearAllMocks()
    callLLM.mockResolvedValue(
      JSON.stringify({ summary: "second capture", prefix: "CONTEXT:", memory_type: "semantic", tags: [] }),
    )

    const messages2 = makeMessages([
      { id: "m1", role: "user", text: "first question" },
      { id: "m2", role: "assistant", text: "first answer" },
      { id: "m3", role: "user", text: "second question" },
      { id: "m4", role: "assistant", text: "second answer" },
    ])

    await performAutoCapture(config, sessionID, messages2, callLLM)

    const llmPrompt = callLLM.mock.calls[0][0] as string
    expect(llmPrompt).toContain("second question")
    expect(llmPrompt).not.toContain("first question")
  })

  it("handles malformed LLM JSON response gracefully", async () => {
    const config = makeConfig()
    const messages = makeMessages([
      { id: "1", role: "user", text: "test" },
      { id: "2", role: "assistant", text: "reply" },
    ])
    const callLLM = vi.fn().mockResolvedValue("not valid json at all")

    const result = await performAutoCapture(config, "test-session-bad-json", messages, callLLM)
    expect(result).toBe(false)
  })
})
