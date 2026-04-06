import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { callChatCompletion, summarizeExchange } from "../../src/services/llm-client.js"
import type { PluginConfig } from "../../src/config.js"

function makeConfig(overrides?: Partial<PluginConfig["captureModel"]>): PluginConfig {
  return {
    chatMessage: { enabled: true, maxMemories: 5, maxProjectMemories: 30, maxInjectedMemories: 6, injectOn: "first", shortQueryMinLength: 3, minScore: 0.35 },
    autoCapture: { enabled: true, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    codeIndexSync: { enabled: true, debounceMs: 10000, minReindexIntervalMs: 300000 },
    captureModel: {
      provider: "openai",
      model: "gpt-4o-mini",
      apiUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      ...overrides,
    },
    mcpServer: { command: [], tag: "default", model: "qwen3", mcpServerName: "memory-mcp-1file", transport: "stdio", port: 23817, bind: "127.0.0.1" },
    systemPrompt: { enabled: true },
  } as PluginConfig
}

describe("callChatCompletion", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("throws when apiKey is empty", async () => {
    const config = makeConfig({ apiKey: "" })
    await expect(
      callChatCompletion(config, [{ role: "user", content: "hello" }]),
    ).rejects.toThrow("captureModel.apiKey is required")
  })

  it("makes correct API request", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "response" } }] }),
    })
    globalThis.fetch = mockFetch

    const config = makeConfig()
    await callChatCompletion(config, [{ role: "user", content: "hello" }])

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
        }),
      }),
    )

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.model).toBe("gpt-4o-mini")
    expect(body.messages).toEqual([{ role: "user", content: "hello" }])
    expect(body.temperature).toBe(0)
    expect(body.max_tokens).toBe(500)
  })

  it("strips trailing slash from apiUrl", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "" } }] }),
    })
    globalThis.fetch = mockFetch

    const config = makeConfig({ apiUrl: "https://api.example.com/v1/" })
    await callChatCompletion(config, [{ role: "user", content: "test" }])

    expect(mockFetch.mock.calls[0][0]).toBe("https://api.example.com/v1/chat/completions")
  })

  it("returns content from API response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "the answer" } }] }),
    })

    const result = await callChatCompletion(makeConfig(), [{ role: "user", content: "question" }])
    expect(result).toBe("the answer")
  })

  it("returns empty string when choices are missing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [] }),
    })

    const result = await callChatCompletion(makeConfig(), [{ role: "user", content: "question" }])
    expect(result).toBe("")
  })

  it("throws on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    })

    await expect(
      callChatCompletion(makeConfig(), [{ role: "user", content: "hello" }]),
    ).rejects.toThrow("LLM API error 429: rate limited")
  })

  it("handles text() failure on error response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => { throw new Error("body error") },
    })

    await expect(
      callChatCompletion(makeConfig(), [{ role: "user", content: "hello" }]),
    ).rejects.toThrow("LLM API error 500: ")
  })
})

describe("summarizeExchange", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("wraps prompt as user message and calls callChatCompletion", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "summary result" } }] }),
    })

    const result = await summarizeExchange(makeConfig(), "Summarize this conversation")
    expect(result).toBe("summary result")

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body)
    expect(body.messages).toEqual([{ role: "user", content: "Summarize this conversation" }])
  })
})
