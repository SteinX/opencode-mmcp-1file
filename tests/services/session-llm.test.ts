import { describe, it, expect, vi, beforeEach } from "vitest"
import { callSessionLLM, type SessionClient } from "../../src/services/session-llm.js"
import type { PluginConfig } from "../../src/config.js"

vi.mock("../../src/utils/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

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
      apiKey: "",
      ...overrides,
    },
    mcpServer: { command: [], tag: "default", model: "qwen3", mcpServerName: "memory-mcp-1file", transport: "stdio", port: 23817, bind: "127.0.0.1" },
    systemPrompt: { enabled: true },
  } as PluginConfig
}

function makeClient(overrides?: Partial<{
  createResult: any
  promptResult: any
  deleteResult: any
  createError: Error
  promptError: Error
  deleteError: Error
}>): SessionClient {
  return {
    session: {
      create: overrides?.createError
        ? vi.fn().mockRejectedValue(overrides.createError)
        : vi.fn().mockResolvedValue({
            data: overrides?.createResult ?? { id: "ephemeral-session-123" },
          }),
      prompt: overrides?.promptError
        ? vi.fn().mockRejectedValue(overrides.promptError)
        : vi.fn().mockResolvedValue({
            data: overrides?.promptResult ?? {
              parts: [{ type: "text", text: "LLM response text" }],
            },
          }),
      delete: overrides?.deleteError
        ? vi.fn().mockRejectedValue(overrides.deleteError)
        : vi.fn().mockResolvedValue({ data: true }),
    },
  }
}

describe("callSessionLLM", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("creates session, prompts, extracts text, and deletes session", async () => {
    const client = makeClient()
    const config = makeConfig()

    const result = await callSessionLLM(client, config, "Summarize this", "src-session-1")

    expect(result).toBe("LLM response text")

    expect(client.session.create).toHaveBeenCalledWith({
      body: { title: "[memory-plugin] capture for src-session-1" },
    })

    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: "ephemeral-session-123" },
      body: {
        model: { providerID: "openai", modelID: "gpt-4o-mini" },
        tools: {},
        parts: [{ type: "text", text: "Summarize this" }],
      },
    })

    expect(client.session.delete).toHaveBeenCalledWith({
      path: { id: "ephemeral-session-123" },
    })
  })

  it("uses title without sessionId when sourceSessionId is undefined", async () => {
    const client = makeClient()

    await callSessionLLM(client, makeConfig(), "Summarize this")

    expect(client.session.create).toHaveBeenCalledWith({
      body: { title: "[memory-plugin] capture" },
    })
  })

  it("omits model when provider or model is empty", async () => {
    const client = makeClient()
    const config = makeConfig({ provider: "", model: "" })

    await callSessionLLM(client, config, "Summarize this")

    const promptCall = (client.session.prompt as any).mock.calls[0][0]
    expect(promptCall.body.model).toBeUndefined()
  })

  it("omits model when only provider is empty", async () => {
    const client = makeClient()
    const config = makeConfig({ provider: "", model: "gpt-4o-mini" })

    await callSessionLLM(client, config, "test")

    const promptCall = (client.session.prompt as any).mock.calls[0][0]
    expect(promptCall.body.model).toBeUndefined()
  })

  it("concatenates multiple text parts", async () => {
    const client = makeClient({
      promptResult: {
        parts: [
          { type: "text", text: "Part one. " },
          { type: "reasoning", text: "thinking..." },
          { type: "text", text: "Part two." },
        ],
      },
    })

    const result = await callSessionLLM(client, makeConfig(), "test")
    expect(result).toBe("Part one. Part two.")
  })

  it("throws when session.create returns no ID", async () => {
    const client = makeClient({ createResult: {} })

    await expect(
      callSessionLLM(client, makeConfig(), "test"),
    ).rejects.toThrow("session.create() returned no session ID")

    expect(client.session.delete).not.toHaveBeenCalled()
  })

  it("throws when prompt returns no text content", async () => {
    const client = makeClient({
      promptResult: { parts: [{ type: "reasoning", text: "thinking" }] },
    })

    await expect(
      callSessionLLM(client, makeConfig(), "test"),
    ).rejects.toThrow("session.prompt() returned no text content")

    expect(client.session.delete).toHaveBeenCalled()
  })

  it("throws when prompt returns empty parts", async () => {
    const client = makeClient({
      promptResult: { parts: [] },
    })

    await expect(
      callSessionLLM(client, makeConfig(), "test"),
    ).rejects.toThrow("session.prompt() returned no text content")

    expect(client.session.delete).toHaveBeenCalled()
  })

  it("deletes session even when prompt throws", async () => {
    const client = makeClient({ promptError: new Error("LLM failure") })

    await expect(
      callSessionLLM(client, makeConfig(), "test"),
    ).rejects.toThrow("LLM failure")

    expect(client.session.delete).toHaveBeenCalledWith({
      path: { id: "ephemeral-session-123" },
    })
  })

  it("logs error but does not throw when session delete fails", async () => {
    const { logger } = await import("../../src/utils/logger.js")
    const client = makeClient({ deleteError: new Error("delete failed") })

    await expect(
      callSessionLLM(client, makeConfig(), "test"),
    ).resolves.toBe("LLM response text")

    expect(logger.error).toHaveBeenCalledWith(
      "failed to delete ephemeral capture session",
      expect.objectContaining({ sessionId: "ephemeral-session-123" }),
    )
  })

  it("propagates create error without calling delete", async () => {
    const client = makeClient({ createError: new Error("create failed") })

    await expect(
      callSessionLLM(client, makeConfig(), "test"),
    ).rejects.toThrow("create failed")

    expect(client.session.delete).not.toHaveBeenCalled()
  })
})
