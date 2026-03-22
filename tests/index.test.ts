import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { PluginConfig } from "../src/config.js"

// ─── Mock all dependencies ─────────────────────────────────────────

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
}))

vi.mock("node:os", () => ({
  homedir: vi.fn().mockReturnValue("/mock-home"),
}))

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(),
  resolveDataDir: vi.fn(),
}))

vi.mock("../src/services/context-inject.js", () => ({
  shouldInjectMemories: vi.fn().mockReturnValue(false),
  markSessionInjected: vi.fn(),
  fetchAndFormatMemories: vi.fn().mockResolvedValue(null),
  fetchCodeIntelContext: vi.fn().mockResolvedValue(null),
}))

vi.mock("../src/services/auto-capture.js", () => ({
  performAutoCapture: vi.fn().mockResolvedValue(false),
}))

vi.mock("../src/services/compaction.js", () => ({
  buildCompactionRecoveryContext: vi.fn().mockResolvedValue(null),
}))

vi.mock("../src/services/mcp-client.js", () => ({
  getMemoryClient: vi.fn().mockResolvedValue({}),
  storeMemory: vi.fn().mockResolvedValue(true),
  disconnectMemoryClient: vi.fn().mockResolvedValue(undefined),
  discoverTools: vi.fn().mockResolvedValue(["store_memory", "recall"]),
  tryReconnect: vi.fn().mockResolvedValue(true),
}))

vi.mock("../src/services/connection-state.js", () => ({
  isConnectionFailed: vi.fn().mockReturnValue(false),
  startRetryLoop: vi.fn(),
  stopRetryLoop: vi.fn(),
}))

vi.mock("../src/services/llm-client.js", () => ({
  summarizeExchange: vi.fn().mockResolvedValue("summary"),
}))

vi.mock("../src/services/session-llm.js", () => ({
  callSessionLLM: vi.fn().mockResolvedValue("session-summary"),
}))

vi.mock("../src/utils/keywords.js", () => ({
  detectMemoryKeyword: vi.fn().mockReturnValue(null),
  MEMORY_NUDGE_MESSAGE: "💡 You can use memory tools to store/recall information.",
}))

vi.mock("../src/utils/privacy.js", () => ({
  stripPrivateContent: vi.fn((s: string) => s),
  isFullyPrivate: vi.fn().mockReturnValue(false),
}))

vi.mock("../src/utils/logger.js", () => ({
  initLogger: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock("../src/services/preemptive-compaction.js", () => ({
  trackMessageTokens: vi.fn(),
  shouldTriggerCompaction: vi.fn().mockReturnValue(false),
  performPreemptiveCompaction: vi.fn().mockResolvedValue(false),
  resetSessionState: vi.fn(),
}))

vi.mock("../src/services/server-process.js", () => ({
  stopServer: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../src/services/system-prompt.js", () => ({
  buildMemorySystemPrompt: vi.fn().mockReturnValue("system prompt text"),
}))

vi.mock("../src/services/tool-registry.js", () => ({
  buildToolRegistry: vi.fn().mockReturnValue({}),
}))

// ─── Import mocked modules for assertions ──────────────────────────

const { loadConfig, resolveDataDir } = await import("../src/config.js")
const { shouldInjectMemories, markSessionInjected, fetchAndFormatMemories } = await import("../src/services/context-inject.js")
const { performAutoCapture } = await import("../src/services/auto-capture.js")
const { buildCompactionRecoveryContext } = await import("../src/services/compaction.js")
const { getMemoryClient, storeMemory, disconnectMemoryClient, discoverTools, tryReconnect } = await import("../src/services/mcp-client.js")
const { isConnectionFailed, startRetryLoop, stopRetryLoop } = await import("../src/services/connection-state.js")
const { summarizeExchange } = await import("../src/services/llm-client.js")
const { callSessionLLM } = await import("../src/services/session-llm.js")
const { detectMemoryKeyword, MEMORY_NUDGE_MESSAGE } = await import("../src/utils/keywords.js")
const { stripPrivateContent, isFullyPrivate } = await import("../src/utils/privacy.js")
const { initLogger, logger } = await import("../src/utils/logger.js")
const { trackMessageTokens, shouldTriggerCompaction, performPreemptiveCompaction, resetSessionState } = await import("../src/services/preemptive-compaction.js")
const { buildMemorySystemPrompt } = await import("../src/services/system-prompt.js")
const { buildToolRegistry } = await import("../src/services/tool-registry.js")
const { existsSync, mkdirSync, copyFileSync } = await import("node:fs")

// ─── Import the plugin under test ──────────────────────────────────

const { default: plugin } = await import("../src/index.js")

// ─── Helpers ────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<PluginConfig>): PluginConfig {
  return {
    chatMessage: { enabled: true, maxMemories: 5, injectOn: "first" },
    autoCapture: { enabled: true, debounceMs: 10, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    captureModel: { provider: "openai", model: "gpt-4o-mini", apiUrl: "", apiKey: "test-key" },
    mcpServer: { command: ["npx", "-y", "memory-mcp-1file"], tag: "default", model: "qwen3", mcpServerName: "memory-mcp-1file" },
    systemPrompt: { enabled: true },
    ...overrides,
  } as PluginConfig
}

function makePluginInput(directoryOverride?: string) {
  return {
    directory: directoryOverride || "/test/project",
    client: {
      tui: {
        showToast: vi.fn().mockResolvedValue(undefined),
      },
      session: {
        messages: vi.fn().mockResolvedValue({ data: [] }),
        prompt: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue({ data: { id: "ephemeral-session" } }),
        delete: vi.fn().mockResolvedValue({ data: true }),
      },
    },
  } as any
}

async function initPlugin(configOverrides?: Partial<PluginConfig>, directoryOverride?: string) {
  const config = makeConfig(configOverrides)
  vi.mocked(loadConfig).mockReturnValue(config)
  vi.mocked(resolveDataDir).mockReturnValue("/mock-data-dir")

  const input = makePluginInput(directoryOverride)
  const hooks = await plugin(input)
  // Flush the eager-connect IIFE so its showToast call doesn't leak into later assertions
  await vi.advanceTimersByTimeAsync(0)
  vi.mocked(input.client.tui.showToast).mockClear()
  return { hooks: hooks as any, input, config }
}

// ─── Store original process.on for cleanup ─────────────────────────

const originalProcessOn = process.on.bind(process)
const registeredHandlers: Array<{ event: string; handler: (...args: any[]) => any }> = []

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()

  // Track signal handlers registered by the plugin
  const processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, handler: (...args: any[]) => any) => {
    registeredHandlers.push({ event, handler })
    return process
  }) as any)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  registeredHandlers.length = 0
})

// ─── Tests ──────────────────────────────────────────────────────────

describe("plugin factory", () => {
  it("returns empty object when dataDir is null (plugin disabled)", async () => {
    vi.mocked(loadConfig).mockReturnValue(makeConfig())
    vi.mocked(resolveDataDir).mockReturnValue(null)

    const hooks = await plugin(makePluginInput())
    expect(hooks).toEqual({})
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("disabled"))
  })

  it("initializes logger with input.client", async () => {
    const input = makePluginInput()
    vi.mocked(loadConfig).mockReturnValue(makeConfig())
    vi.mocked(resolveDataDir).mockReturnValue("/data")

    await plugin(input)
    expect(initLogger).toHaveBeenCalledWith(input.client)
  })

  it("eagerly connects to memory server in background", async () => {
    const config = makeConfig()
    vi.mocked(loadConfig).mockReturnValue(config)
    vi.mocked(resolveDataDir).mockReturnValue("/mock-data-dir")
    const input = makePluginInput()
    await plugin(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(getMemoryClient).toHaveBeenCalled()
  })

  it("shows success toast on memory server connection", async () => {
    const config = makeConfig()
    vi.mocked(loadConfig).mockReturnValue(config)
    vi.mocked(resolveDataDir).mockReturnValue("/mock-data-dir")
    const input = makePluginInput()
    await plugin(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(input.client.tui.showToast).toHaveBeenCalledWith({
      body: expect.objectContaining({ variant: "success" }),
    })
  })

  it("shows error toast on memory server connection failure", async () => {
    vi.mocked(getMemoryClient).mockRejectedValueOnce(new Error("connection failed"))
    const config = makeConfig()
    vi.mocked(loadConfig).mockReturnValue(config)
    vi.mocked(resolveDataDir).mockReturnValue("/mock-data-dir")
    const input = makePluginInput()
    await plugin(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(input.client.tui.showToast).toHaveBeenCalledWith({
      body: expect.objectContaining({ variant: "error" }),
    })
  })

  it("starts retry loop on connection failure", async () => {
    vi.mocked(getMemoryClient).mockRejectedValueOnce(new Error("connection failed"))
    const config = makeConfig()
    vi.mocked(loadConfig).mockReturnValue(config)
    vi.mocked(resolveDataDir).mockReturnValue("/mock-data-dir")
    const input = makePluginInput()
    await plugin(input)
    await vi.advanceTimersByTimeAsync(0)

    expect(startRetryLoop).toHaveBeenCalledWith(
      expect.any(Function),
      30_000,
      expect.any(Function),
    )
  })

  it("does not start retry loop on successful connection", async () => {
    const config = makeConfig()
    vi.mocked(loadConfig).mockReturnValue(config)
    vi.mocked(resolveDataDir).mockReturnValue("/mock-data-dir")
    const input = makePluginInput()
    await plugin(input)
    await vi.advanceTimersByTimeAsync(0)

    expect(startRetryLoop).not.toHaveBeenCalled()
  })

  it("registers SIGTERM and SIGINT cleanup handlers", async () => {
    await initPlugin()
    const events = registeredHandlers.map((h) => h.event)
    expect(events).toContain("SIGTERM")
    expect(events).toContain("SIGINT")
  })

  it("cleanup handler calls stopRetryLoop before disconnecting", async () => {
    await initPlugin()
    const sigterm = registeredHandlers.find((h) => h.event === "SIGTERM")
    expect(sigterm).toBeDefined()
    sigterm!.handler()
    await vi.advanceTimersByTimeAsync(0)
    expect(stopRetryLoop).toHaveBeenCalled()
    expect(disconnectMemoryClient).toHaveBeenCalled()
  })

  it("returns all expected hook keys", async () => {
    const { hooks } = await initPlugin()
    expect(hooks).toHaveProperty("chat.message")
    expect(hooks).toHaveProperty("event")
    expect(hooks).toHaveProperty("experimental.chat.system.transform")
    expect(hooks).toHaveProperty("tool.definition")
    expect(hooks).toHaveProperty("experimental.session.compacting")
    expect(hooks).toHaveProperty("tool.execute.before")
    expect(hooks).toHaveProperty("tool")
  })
})

// ─── extractUserText (tested indirectly via chat.message) ──────────

describe("extractUserText (via chat.message)", () => {
  it("extracts text from non-synthetic parts", async () => {
    const { hooks } = await initPlugin({ keywordDetection: { enabled: true, extraPatterns: [] } })
    vi.mocked(detectMemoryKeyword).mockReturnValue("remember")

    const output = {
      message: { id: "msg1" },
      parts: [
        { type: "text", text: "remember this important fact about the project" },
      ],
    }

    await hooks["chat.message"]({ sessionID: "s1" }, output)
    expect(detectMemoryKeyword).toHaveBeenCalledWith("remember this important fact about the project", expect.any(Array))
  })

  it("returns null (skips) for short text under 10 chars", async () => {
    const { hooks } = await initPlugin()
    vi.mocked(shouldInjectMemories).mockReturnValue(true)

    const output = {
      message: { id: "msg1" },
      parts: [{ type: "text", text: "hi" }],
    }

    await hooks["chat.message"]({ sessionID: "s1" }, output)
    expect(fetchAndFormatMemories).not.toHaveBeenCalled()
  })

  it("ignores synthetic parts", async () => {
    const { hooks } = await initPlugin({ keywordDetection: { enabled: true, extraPatterns: [] } })
    vi.mocked(detectMemoryKeyword).mockReturnValue(null)
    vi.mocked(shouldInjectMemories).mockReturnValue(true)

    const output = {
      message: { id: "msg1" },
      parts: [
        { type: "text", text: "some injected context that is synthetic", synthetic: true },
        { type: "text", text: "actual user question that is long enough" },
      ],
    }

    await hooks["chat.message"]({ sessionID: "s1" }, output)
    expect(detectMemoryKeyword).toHaveBeenCalledWith("actual user question that is long enough", expect.any(Array))
  })

  it("returns null for empty parts array", async () => {
    const { hooks } = await initPlugin()
    vi.mocked(shouldInjectMemories).mockReturnValue(true)

    const output = {
      message: { id: "msg1" },
      parts: [],
    }

    await hooks["chat.message"]({ sessionID: "s1" }, output)
    expect(fetchAndFormatMemories).not.toHaveBeenCalled()
  })

  it("joins multiple text parts", async () => {
    const { hooks } = await initPlugin({ keywordDetection: { enabled: true, extraPatterns: [] } })
    vi.mocked(detectMemoryKeyword).mockReturnValue("remember")

    const output = {
      message: { id: "msg1" },
      parts: [
        { type: "text", text: "first part of message" },
        { type: "text", text: "second part continues" },
      ],
    }

    await hooks["chat.message"]({ sessionID: "s1" }, output)
    expect(detectMemoryKeyword).toHaveBeenCalledWith(
      "first part of message\nsecond part continues",
      expect.any(Array),
    )
  })

  it("skips non-text part types", async () => {
    const { hooks } = await initPlugin({ keywordDetection: { enabled: true, extraPatterns: [] } })
    vi.mocked(detectMemoryKeyword).mockReturnValue("remember")

    const output = {
      message: { id: "msg1" },
      parts: [
        { type: "image", url: "http://example.com/img.png" },
        { type: "text", text: "this is a text part long enough" },
      ],
    }

    await hooks["chat.message"]({ sessionID: "s1" }, output)
    expect(detectMemoryKeyword).toHaveBeenCalledWith("this is a text part long enough", expect.any(Array))
  })
})

// ─── chat.message hook ─────────────────────────────────────────────

describe("chat.message hook", () => {
  it("appends nudge part when keyword detected", async () => {
    const { hooks } = await initPlugin({ keywordDetection: { enabled: true, extraPatterns: [] } })
    vi.mocked(detectMemoryKeyword).mockReturnValue("remember")

    const output = {
      message: { id: "msg1" },
      parts: [{ type: "text", text: "remember this fact about memory usage" }],
    }

    await hooks["chat.message"]({ sessionID: "s1" }, output)
    expect(output.parts).toHaveLength(2)
    expect(output.parts[1]).toMatchObject({
      type: "text",
      text: MEMORY_NUDGE_MESSAGE,
      synthetic: true,
    })
  })

  it("does not append nudge when keyword detection disabled", async () => {
    const { hooks } = await initPlugin({ keywordDetection: { enabled: false, extraPatterns: [] } })

    const output = {
      message: { id: "msg1" },
      parts: [{ type: "text", text: "remember this fact about memory usage" }],
    }

    await hooks["chat.message"]({ sessionID: "s1" }, output)
    expect(output.parts).toHaveLength(1)
    expect(detectMemoryKeyword).not.toHaveBeenCalled()
  })

  it("does not append nudge when keyword not matched", async () => {
    const { hooks } = await initPlugin({ keywordDetection: { enabled: true, extraPatterns: [] } })
    vi.mocked(detectMemoryKeyword).mockReturnValue(null)

    const output = {
      message: { id: "msg1" },
      parts: [{ type: "text", text: "just a regular question about code" }],
    }

    await hooks["chat.message"]({ sessionID: "s1" }, output)
    expect(output.parts).toHaveLength(1)
  })

  it("injects memory context when shouldInjectMemories returns true", async () => {
    const { hooks } = await initPlugin()
    vi.mocked(shouldInjectMemories).mockReturnValue(true)
    vi.mocked(fetchAndFormatMemories).mockResolvedValue("[MEMORY] some recalled memory")

    const output = {
      message: { id: "msg1" },
      parts: [{ type: "text", text: "what do you know about this project setup?" }],
    }

    await hooks["chat.message"]({ sessionID: "s1" }, output)
    expect(output.parts[0]).toMatchObject({
      type: "text",
      text: "[MEMORY] some recalled memory",
      synthetic: true,
    })
    expect(markSessionInjected).toHaveBeenCalledWith("s1")
  })

  it("skips injection when shouldInjectMemories returns false", async () => {
    const { hooks } = await initPlugin()
    vi.mocked(shouldInjectMemories).mockReturnValue(false)

    const output = {
      message: { id: "msg1" },
      parts: [{ type: "text", text: "what do you know about the project?" }],
    }

    await hooks["chat.message"]({ sessionID: "s1" }, output)
    expect(fetchAndFormatMemories).not.toHaveBeenCalled()
  })

  it("skips injection when fetchAndFormatMemories returns null", async () => {
    const { hooks } = await initPlugin()
    vi.mocked(shouldInjectMemories).mockReturnValue(true)
    vi.mocked(fetchAndFormatMemories).mockResolvedValue(null)

    const output = {
      message: { id: "msg1" },
      parts: [{ type: "text", text: "tell me about this project setup" }],
    }

    await hooks["chat.message"]({ sessionID: "s1" }, output)
    expect(markSessionInjected).not.toHaveBeenCalled()
    // Original part count unchanged (no unshift happened)
    expect(output.parts).toHaveLength(1)
  })

  it("clears compacted session flag on next chat.message", async () => {
    const { hooks } = await initPlugin({ compaction: { enabled: true, memoryLimit: 10 } })

    // First: simulate compaction event to add to compactedSessions
    await hooks.event({
      event: {
        type: "session.compacted",
        properties: { sessionID: "s-compact" },
      },
    })

    // Now chat.message should pass isAfterCompaction=true
    vi.mocked(shouldInjectMemories).mockReturnValue(false)
    const output = { message: { id: "msg1" }, parts: [{ type: "text", text: "continuing after compaction" }] }
    await hooks["chat.message"]({ sessionID: "s-compact" }, output)

    // shouldInjectMemories called with isAfterCompaction=true
    expect(shouldInjectMemories).toHaveBeenCalledWith(expect.anything(), "s-compact", true)

    // Second call should have isAfterCompaction=false (flag cleared)
    vi.clearAllMocks()
    vi.mocked(shouldInjectMemories).mockReturnValue(false)
    await hooks["chat.message"]({ sessionID: "s-compact" }, output)
    expect(shouldInjectMemories).toHaveBeenCalledWith(expect.anything(), "s-compact", false)
  })

  it("passes extraPatterns to detectMemoryKeyword as RegExp array", async () => {
    const { hooks } = await initPlugin({
      keywordDetection: { enabled: true, extraPatterns: ["my-custom-pattern", "another\\d+"] },
    })
    vi.mocked(detectMemoryKeyword).mockReturnValue(null)

    const output = {
      message: { id: "msg1" },
      parts: [{ type: "text", text: "test message about my custom pattern here" }],
    }

    await hooks["chat.message"]({ sessionID: "s1" }, output)
    const passedPatterns = vi.mocked(detectMemoryKeyword).mock.calls[0]?.[1]
    expect(passedPatterns).toHaveLength(2)
    expect(passedPatterns![0]).toBeInstanceOf(RegExp)
    expect(passedPatterns![1]).toBeInstanceOf(RegExp)
  })
})

// ─── extractEventMessageText (tested indirectly via event handler) ─

describe("extractEventMessageText (via event message.updated)", () => {
  it("extracts text from event parts array", async () => {
    const { hooks } = await initPlugin()

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          sessionID: "s1",
          parts: [{ type: "text", text: "hello world message" }],
        },
      },
    })

    expect(trackMessageTokens).toHaveBeenCalledWith("s1", "hello world message")
  })

  it("skips tracking when parts is not an array", async () => {
    const { hooks } = await initPlugin()

    await hooks.event({
      event: {
        type: "message.updated",
        properties: { sessionID: "s1", parts: "not-an-array" },
      },
    })

    expect(trackMessageTokens).not.toHaveBeenCalled()
  })

  it("skips tracking when no text parts exist", async () => {
    const { hooks } = await initPlugin()

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          sessionID: "s1",
          parts: [{ type: "image", url: "img.png" }],
        },
      },
    })

    expect(trackMessageTokens).not.toHaveBeenCalled()
  })

  it("joins multiple text parts from event", async () => {
    const { hooks } = await initPlugin()

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          sessionID: "s1",
          parts: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      },
    })

    expect(trackMessageTokens).toHaveBeenCalledWith("s1", "first\nsecond")
  })
})

// ─── event handler: session.idle ────────────────────────────────────

describe("event handler: session.idle", () => {
  it("debounces idle capture with configurable delay", async () => {
    const { hooks, input, config } = await initPlugin({
      autoCapture: { enabled: true, debounceMs: 500, language: "en" },
    })

    input.client.session.messages.mockResolvedValue({
      data: [
        { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "question" }] },
        { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "answer" }] },
      ],
    })

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-idle" } },
    })

    // Not called yet (debounce pending)
    expect(performAutoCapture).not.toHaveBeenCalled()

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(500)

    expect(input.client.session.messages).toHaveBeenCalledWith({ path: { id: "s-idle" } })
    expect(performAutoCapture).toHaveBeenCalled()
  })

  it("skips capture when sessionID missing", async () => {
    const { hooks } = await initPlugin()

    await hooks.event({
      event: { type: "session.idle", properties: {} },
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(performAutoCapture).not.toHaveBeenCalled()
  })

  it("skips capture when autoCapture disabled", async () => {
    const { hooks } = await initPlugin({
      autoCapture: { enabled: false, debounceMs: 10, language: "en" },
    })

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(performAutoCapture).not.toHaveBeenCalled()
  })

  it("replaces previous timer on rapid idle events (debounce)", async () => {
    const { hooks, input } = await initPlugin({
      autoCapture: { enabled: true, debounceMs: 200, language: "en" },
    })

    input.client.session.messages.mockResolvedValue({ data: [] })

    // Fire idle twice rapidly
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-debounce" } },
    })
    await vi.advanceTimersByTimeAsync(100)
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-debounce" } },
    })

    // Advance past first timer (200ms from second event start)
    await vi.advanceTimersByTimeAsync(200)

    // Should only fire once (second timer replaced first)
    expect(input.client.session.messages).toHaveBeenCalledTimes(1)
  })

  it("shows toast when capture succeeds", async () => {
    const { hooks, input } = await initPlugin({
      autoCapture: { enabled: true, debounceMs: 10, language: "en" },
    })

    input.client.session.messages.mockResolvedValue({
      data: [
        { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "question" }] },
        { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "answer" }] },
      ],
    })
    vi.mocked(performAutoCapture).mockResolvedValue(true)

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    })
    await vi.advanceTimersByTimeAsync(10)

    expect(input.client.tui.showToast).toHaveBeenCalledWith({
      body: expect.objectContaining({ message: "Memory auto-captured", variant: "info" }),
    })
  })

  it("uses session API for capture when apiKey is empty", async () => {
    const { hooks, input } = await initPlugin({
      autoCapture: { enabled: true, debounceMs: 10, language: "en" },
      captureModel: { provider: "openai", model: "gpt-4o-mini", apiUrl: "", apiKey: "" },
    })

    input.client.session.messages.mockResolvedValue({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "hi" }] },
      ],
    })
    vi.mocked(performAutoCapture).mockResolvedValue(true)

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-nokey" } },
    })
    await vi.advanceTimersByTimeAsync(10)

    expect(performAutoCapture).toHaveBeenCalled()
  })

  it("uses direct HTTP for capture when apiKey is set", async () => {
    const { hooks, input } = await initPlugin({
      autoCapture: { enabled: true, debounceMs: 10, language: "en" },
      captureModel: { provider: "openai", model: "gpt-4o-mini", apiUrl: "https://api.example.com/v1", apiKey: "sk-test" },
    })

    input.client.session.messages.mockResolvedValue({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "hi" }] },
      ],
    })
    vi.mocked(performAutoCapture).mockResolvedValue(true)

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-withkey" } },
    })
    await vi.advanceTimersByTimeAsync(10)

    expect(performAutoCapture).toHaveBeenCalled()
  })

  it("logs error when capture throws", async () => {
    const { hooks, input } = await initPlugin({
      autoCapture: { enabled: true, debounceMs: 10, language: "en" },
    })

    input.client.session.messages.mockRejectedValue(new Error("session fetch failed"))

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-err" } },
    })
    await vi.advanceTimersByTimeAsync(10)

    expect(logger.error).toHaveBeenCalledWith("idle capture failed", expect.objectContaining({ sessionID: "s-err" }))
  })
})

// ─── event handler: session.compacted ──────────────────────────────

describe("event handler: session.compacted", () => {
  it("resets session state and triggers recovery", async () => {
    const { hooks } = await initPlugin()
    vi.mocked(buildCompactionRecoveryContext).mockResolvedValue({
      text: "recovery context text",
      count: 3,
    })

    await hooks.event({
      event: { type: "session.compacted", properties: { sessionID: "s-cmp" } },
    })

    expect(resetSessionState).toHaveBeenCalledWith("s-cmp")
    expect(buildCompactionRecoveryContext).toHaveBeenCalled()
  })

  it("sends recovery prompt to session", async () => {
    const { hooks, input } = await initPlugin()
    vi.mocked(buildCompactionRecoveryContext).mockResolvedValue({
      text: "recovery context text",
      count: 5,
    })

    await hooks.event({
      event: { type: "session.compacted", properties: { sessionID: "s-cmp" } },
    })

    expect(input.client.session.prompt).toHaveBeenCalledWith({
      path: { id: "s-cmp" },
      body: {
        parts: [{ type: "text", text: "recovery context text", synthetic: true }],
        noReply: true,
      },
    })
  })

  it("shows toast with memory count on successful recovery", async () => {
    const { hooks, input } = await initPlugin()
    vi.mocked(buildCompactionRecoveryContext).mockResolvedValue({
      text: "recovered",
      count: 7,
    })

    await hooks.event({
      event: { type: "session.compacted", properties: { sessionID: "s-cmp" } },
    })

    expect(input.client.tui.showToast).toHaveBeenCalledWith({
      body: expect.objectContaining({
        message: "7 memories restored after compaction",
        variant: "success",
      }),
    })
  })

  it("skips recovery when buildCompactionRecoveryContext returns null", async () => {
    const { hooks, input } = await initPlugin()
    vi.mocked(buildCompactionRecoveryContext).mockResolvedValue(null)

    await hooks.event({
      event: { type: "session.compacted", properties: { sessionID: "s-null" } },
    })

    expect(input.client.session.prompt).not.toHaveBeenCalled()
    expect(input.client.tui.showToast).not.toHaveBeenCalled()
  })

  it("skips when compaction disabled", async () => {
    const { hooks } = await initPlugin({ compaction: { enabled: false, memoryLimit: 10 } })

    await hooks.event({
      event: { type: "session.compacted", properties: { sessionID: "s1" } },
    })

    expect(resetSessionState).not.toHaveBeenCalled()
    expect(buildCompactionRecoveryContext).not.toHaveBeenCalled()
  })

  it("skips when sessionID missing", async () => {
    const { hooks } = await initPlugin()

    await hooks.event({
      event: { type: "session.compacted", properties: {} },
    })

    expect(resetSessionState).not.toHaveBeenCalled()
  })

  it("logs error when recovery throws", async () => {
    const { hooks, input } = await initPlugin()
    vi.mocked(buildCompactionRecoveryContext).mockRejectedValue(new Error("recovery boom"))

    await hooks.event({
      event: { type: "session.compacted", properties: { sessionID: "s-err" } },
    })

    expect(logger.error).toHaveBeenCalledWith("compaction recovery failed", expect.objectContaining({ sessionID: "s-err" }))
  })
})

// ─── event handler: message.updated (preemptive compaction) ────────

describe("event handler: message.updated", () => {
  it("tracks tokens when text extracted", async () => {
    const { hooks } = await initPlugin()

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          sessionID: "s1",
          parts: [{ type: "text", text: "hello world" }],
        },
      },
    })

    expect(trackMessageTokens).toHaveBeenCalledWith("s1", "hello world")
  })

  it("triggers preemptive compaction when threshold met", async () => {
    const { hooks, input } = await initPlugin()
    vi.mocked(shouldTriggerCompaction).mockReturnValue(true)
    vi.mocked(performPreemptiveCompaction).mockResolvedValue(true)

    await hooks.event({
      event: {
        type: "message.updated",
        properties: { sessionID: "s-pcomp", parts: [{ type: "text", text: "msg" }] },
      },
    })

    expect(performPreemptiveCompaction).toHaveBeenCalled()
    expect(input.client.tui.showToast).toHaveBeenCalledWith({
      body: expect.objectContaining({ variant: "warning" }),
    })
  })

  it("sends auto-continue prompt when autoContinue enabled and compaction occurs", async () => {
    const { hooks, input } = await initPlugin({
      preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    })
    vi.mocked(shouldTriggerCompaction).mockReturnValue(true)
    vi.mocked(performPreemptiveCompaction).mockResolvedValue(true)

    await hooks.event({
      event: {
        type: "message.updated",
        properties: { sessionID: "s-auto", parts: [{ type: "text", text: "msg" }] },
      },
    })

    expect(input.client.session.prompt).toHaveBeenCalledWith({
      path: { id: "s-auto" },
      body: {
        parts: [{ type: "text", text: "Continue" }],
      },
    })
  })

  it("does not send auto-continue when autoContinue disabled", async () => {
    const { hooks, input } = await initPlugin({
      preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: false },
    })
    vi.mocked(shouldTriggerCompaction).mockReturnValue(true)
    vi.mocked(performPreemptiveCompaction).mockResolvedValue(true)

    await hooks.event({
      event: {
        type: "message.updated",
        properties: { sessionID: "s-noauto", parts: [{ type: "text", text: "msg" }] },
      },
    })

    expect(input.client.session.prompt).not.toHaveBeenCalled()
  })

  it("logs warning when auto-continue prompt fails", async () => {
    const { hooks, input } = await initPlugin({
      preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    })
    vi.mocked(shouldTriggerCompaction).mockReturnValue(true)
    vi.mocked(performPreemptiveCompaction).mockResolvedValue(true)
    input.client.session.prompt.mockRejectedValue(new Error("prompt failed"))

    await hooks.event({
      event: {
        type: "message.updated",
        properties: { sessionID: "s-err", parts: [{ type: "text", text: "msg" }] },
      },
    })

    expect(logger.warn).toHaveBeenCalledWith("auto-continue prompt failed", expect.objectContaining({ sessionID: "s-err" }))
  })

  it("skips when preemptiveCompaction disabled", async () => {
    const { hooks } = await initPlugin({
      preemptiveCompaction: { enabled: false, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    })

    await hooks.event({
      event: {
        type: "message.updated",
        properties: { sessionID: "s1", parts: [{ type: "text", text: "msg" }] },
      },
    })

    expect(trackMessageTokens).not.toHaveBeenCalled()
    expect(shouldTriggerCompaction).not.toHaveBeenCalled()
  })

  it("skips when sessionID missing", async () => {
    const { hooks } = await initPlugin()

    await hooks.event({
      event: { type: "message.updated", properties: {} },
    })

    expect(trackMessageTokens).not.toHaveBeenCalled()
  })
})

// ─── compaction summary capture ────────────────────────────────────

describe("captureCompactionSummary (via message.updated)", () => {
  it("captures summary when info.summary=true and info.finish=true", async () => {
    const { hooks, input } = await initPlugin({
      compactionSummaryCapture: { enabled: true },
      privacy: { enabled: false },
    })

    input.client.session.messages.mockResolvedValue({
      data: [
        {
          info: { summary: true, role: "assistant" },
          parts: [{ type: "text", text: "A".repeat(60) }],
        },
      ],
    })

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          sessionID: "s-summ",
          parts: [{ type: "text", text: "msg" }],
          info: { summary: true, finish: true },
        },
      },
    })

    expect(storeMemory).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("CONTEXT: Session compaction summary"),
      "episodic",
    )
  })

  it("skips capture when compactionSummaryCapture disabled", async () => {
    const { hooks } = await initPlugin({
      compactionSummaryCapture: { enabled: false },
    })

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          sessionID: "s1",
          parts: [{ type: "text", text: "msg" }],
          info: { summary: true, finish: true },
        },
      },
    })

    expect(storeMemory).not.toHaveBeenCalled()
  })

  it("skips when summary text is too short (< 50 chars)", async () => {
    const { hooks, input } = await initPlugin({
      compactionSummaryCapture: { enabled: true },
    })

    input.client.session.messages.mockResolvedValue({
      data: [
        { info: { summary: true }, parts: [{ type: "text", text: "short" }] },
      ],
    })

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          sessionID: "s1",
          parts: [{ type: "text", text: "msg" }],
          info: { summary: true, finish: true },
        },
      },
    })

    expect(storeMemory).not.toHaveBeenCalled()
  })

  it("strips private content when privacy enabled", async () => {
    const { hooks, input } = await initPlugin({
      compactionSummaryCapture: { enabled: true },
      privacy: { enabled: true },
    })

    const summaryText = "Summary with <private>secret</private> data" + "x".repeat(50)
    vi.mocked(stripPrivateContent).mockReturnValue("Summary with [REDACTED] data" + "x".repeat(50))

    input.client.session.messages.mockResolvedValue({
      data: [
        { info: { summary: true, role: "assistant" }, parts: [{ type: "text", text: summaryText }] },
      ],
    })

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          sessionID: "s1",
          parts: [{ type: "text", text: "msg" }],
          info: { summary: true, finish: true },
        },
      },
    })

    expect(stripPrivateContent).toHaveBeenCalled()
    const storedContent = vi.mocked(storeMemory).mock.calls[0]?.[1]
    expect(storedContent).toContain("[REDACTED]")
  })

  it("skips when fully private after stripping", async () => {
    const { hooks, input } = await initPlugin({
      compactionSummaryCapture: { enabled: true },
      privacy: { enabled: true },
    })

    vi.mocked(isFullyPrivate).mockReturnValue(true)

    input.client.session.messages.mockResolvedValue({
      data: [
        { info: { summary: true, role: "assistant" }, parts: [{ type: "text", text: "A".repeat(60) }] },
      ],
    })

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          sessionID: "s1",
          parts: [{ type: "text", text: "msg" }],
          info: { summary: true, finish: true },
        },
      },
    })

    expect(storeMemory).not.toHaveBeenCalled()
  })

  it("logs error when capture throws", async () => {
    const { hooks, input } = await initPlugin({
      compactionSummaryCapture: { enabled: true },
    })

    input.client.session.messages.mockRejectedValue(new Error("fetch failed"))

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          sessionID: "s-err",
          parts: [{ type: "text", text: "msg" }],
          info: { summary: true, finish: true },
        },
      },
    })

    expect(logger.error).toHaveBeenCalledWith("compaction summary capture failed", expect.objectContaining({ sessionID: "s-err" }))
  })

  it("skips when no summary message found in session", async () => {
    const { hooks, input } = await initPlugin({
      compactionSummaryCapture: { enabled: true },
    })

    input.client.session.messages.mockResolvedValue({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "question" }] },
      ],
    })

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          sessionID: "s1",
          parts: [{ type: "text", text: "msg" }],
          info: { summary: true, finish: true },
        },
      },
    })

    expect(storeMemory).not.toHaveBeenCalled()
  })
})

// ─── experimental.chat.system.transform ────────────────────────────

describe("experimental.chat.system.transform", () => {
  it("appends system prompt when enabled", async () => {
    const { hooks } = await initPlugin({ systemPrompt: { enabled: true } })
    vi.mocked(buildMemorySystemPrompt).mockReturnValue("memory system prompt")

    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]({}, output)

    expect(output.system).toEqual(["memory system prompt"])
    expect(discoverTools).toHaveBeenCalled()
  })

  it("skips when systemPrompt disabled", async () => {
    const { hooks } = await initPlugin({ systemPrompt: { enabled: false } })

    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]({}, output)

    expect(output.system).toEqual([])
    expect(buildMemorySystemPrompt).not.toHaveBeenCalled()
  })

  it("caches tool discovery results across calls", async () => {
    const { hooks } = await initPlugin({ systemPrompt: { enabled: true } })

    const output1 = { system: [] as string[] }
    const output2 = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]({}, output1)
    await hooks["experimental.chat.system.transform"]({}, output2)

    expect(discoverTools).toHaveBeenCalledTimes(1)
  })

  it("passes connectionOk=true when connection is healthy", async () => {
    const { hooks } = await initPlugin({ systemPrompt: { enabled: true } })
    vi.mocked(isConnectionFailed).mockReturnValue(false)

    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]({}, output)

    expect(buildMemorySystemPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      true,
    )
  })

  it("passes connectionOk=false when connection has failed", async () => {
    const { hooks } = await initPlugin({ systemPrompt: { enabled: true } })
    vi.mocked(isConnectionFailed).mockReturnValue(true)

    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]({}, output)

    expect(buildMemorySystemPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      false,
    )
  })
})

// ─── tool.definition ───────────────────────────────────────────────

describe("tool.definition", () => {
  it("appends hint for store_memory tool", async () => {
    const { hooks } = await initPlugin()
    const output = { description: "Store a new memory" }

    await hooks["tool.definition"]({ toolID: "memory-mcp-1file_store_memory" }, output)

    expect(output.description).toContain("Prefix content with")
    expect(output.description).toContain("DECISION:")
  })

  it("appends hint for recall tool", async () => {
    const { hooks } = await initPlugin()
    const output = { description: "Search memories" }

    await hooks["tool.definition"]({ toolID: "memory-mcp-1file_recall" }, output)

    expect(output.description).toContain("hybrid search")
  })

  it("appends hint for invalidate tool", async () => {
    const { hooks } = await initPlugin()
    const output = { description: "Invalidate a memory" }

    await hooks["tool.definition"]({ toolID: "memory-mcp-1file_invalidate" }, output)

    expect(output.description).toContain("outdated")
  })

  it("does not modify non-memory tools", async () => {
    const { hooks } = await initPlugin()
    const output = { description: "Run tests" }

    await hooks["tool.definition"]({ toolID: "vitest_run" }, output)

    expect(output.description).toBe("Run tests")
  })

  it("matches tool by server name case-insensitively", async () => {
    const { hooks } = await initPlugin()
    const output = { description: "Store" }

    await hooks["tool.definition"]({ toolID: "Memory-MCP-1file_STORE_MEMORY" }, output)

    expect(output.description).toContain("Prefix content with")
  })

  it("matches tools containing 'memory' in toolID", async () => {
    const { hooks } = await initPlugin()
    const output = { description: "Store" }

    await hooks["tool.definition"]({ toolID: "some_other_memory_store_memory" }, output)

    expect(output.description).toContain("Prefix content with")
  })
})

// ─── experimental.session.compacting ───────────────────────────────

describe("experimental.session.compacting", () => {
  it("pushes recovery context when available", async () => {
    const { hooks } = await initPlugin()
    vi.mocked(buildCompactionRecoveryContext).mockResolvedValue({
      text: "recovery text for compaction",
      count: 5,
    })

    const output = { context: [] as string[] }
    await hooks["experimental.session.compacting"]({}, output)

    expect(output.context).toEqual(["recovery text for compaction"])
  })

  it("does nothing when compaction disabled", async () => {
    const { hooks } = await initPlugin({ compaction: { enabled: false, memoryLimit: 10 } })

    const output = { context: [] as string[] }
    await hooks["experimental.session.compacting"]({}, output)

    expect(output.context).toEqual([])
    expect(buildCompactionRecoveryContext).not.toHaveBeenCalled()
  })

  it("does nothing when recovery returns null", async () => {
    const { hooks } = await initPlugin()
    vi.mocked(buildCompactionRecoveryContext).mockResolvedValue(null)

    const output = { context: [] as string[] }
    await hooks["experimental.session.compacting"]({}, output)

    expect(output.context).toEqual([])
  })
})

// ─── tool.execute.before ───────────────────────────────────────────

describe("tool.execute.before", () => {
  it("strips private content from store_memory args", async () => {
    const { hooks } = await initPlugin({ privacy: { enabled: true } })
    vi.mocked(isFullyPrivate).mockReturnValue(false)
    vi.mocked(stripPrivateContent).mockReturnValue("cleaned content")

    const output = { args: { content: "raw content with <private>secret</private>" } }
    await hooks["tool.execute.before"]({ tool: "memory-mcp-1file_store_memory" }, output)

    expect(stripPrivateContent).toHaveBeenCalledWith("raw content with <private>secret</private>")
    expect(output.args.content).toBe("cleaned content")
  })

  it("strips private content from update_memory args", async () => {
    const { hooks } = await initPlugin({ privacy: { enabled: true } })
    vi.mocked(isFullyPrivate).mockReturnValue(false)
    vi.mocked(stripPrivateContent).mockReturnValue("cleaned")

    const output = { args: { content: "some update" } }
    await hooks["tool.execute.before"]({ tool: "memory-mcp-1file_update_memory" }, output)

    expect(stripPrivateContent).toHaveBeenCalled()
  })

  it("replaces fully private content with redacted message", async () => {
    const { hooks } = await initPlugin({ privacy: { enabled: true } })
    vi.mocked(isFullyPrivate).mockReturnValue(true)

    const output = { args: { content: "<private>all secret</private>" } }
    await hooks["tool.execute.before"]({ tool: "memory-mcp-1file_store_memory" }, output)

    expect(output.args.content).toBe("[REDACTED — fully private content]")
    expect(stripPrivateContent).not.toHaveBeenCalled()
  })

  it("skips when privacy disabled", async () => {
    const { hooks } = await initPlugin({ privacy: { enabled: false } })

    const output = { args: { content: "some <private>data</private>" } }
    await hooks["tool.execute.before"]({ tool: "memory-mcp-1file_store_memory" }, output)

    expect(output.args.content).toBe("some <private>data</private>")
    expect(stripPrivateContent).not.toHaveBeenCalled()
  })

  it("skips for non-memory tools", async () => {
    const { hooks } = await initPlugin({ privacy: { enabled: true } })

    const output = { args: { content: "some data" } }
    await hooks["tool.execute.before"]({ tool: "vitest_run" }, output)

    expect(stripPrivateContent).not.toHaveBeenCalled()
  })

  it("skips when content is not a string", async () => {
    const { hooks } = await initPlugin({ privacy: { enabled: true } })

    const output = { args: { content: 12345 } }
    await hooks["tool.execute.before"]({ tool: "memory-mcp-1file_store_memory" }, output)

    expect(stripPrivateContent).not.toHaveBeenCalled()
  })

  it("skips when args.content is undefined", async () => {
    const { hooks } = await initPlugin({ privacy: { enabled: true } })

    const output = { args: { id: "mem-1" } }
    await hooks["tool.execute.before"]({ tool: "memory-mcp-1file_store_memory" }, output)

    expect(stripPrivateContent).not.toHaveBeenCalled()
  })
})

// ─── installCommand ─────────────────────────────────────────────────

describe("installCommand (called during plugin init)", () => {
  it("copies command files when source exists and target does not", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p)
      // Source files exist
      if (s.includes("commands/init-mcp-memory.md")) return true
      if (s.includes("commands/setup-mcp-memory.md")) return true
      // Target files don't exist
      return false
    })

    await initPlugin()

    expect(mkdirSync).toHaveBeenCalled()
    expect(copyFileSync).toHaveBeenCalledTimes(2)
  })

  it("skips copying when target already exists", async () => {
    vi.mocked(existsSync).mockReturnValue(true) // Both source and target exist

    await initPlugin()

    expect(copyFileSync).not.toHaveBeenCalled()
  })

  it("handles errors gracefully without throwing", async () => {
    vi.mocked(existsSync).mockImplementation(() => {
      throw new Error("fs error")
    })

    // Should not throw — installCommand catches internally
    await expect(initPlugin()).resolves.toBeDefined()
    expect(logger.debug).toHaveBeenCalledWith(
      "Command auto-install failed (manual copy available)",
      expect.any(Object),
    )
  })
})
