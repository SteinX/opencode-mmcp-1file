import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildToolRegistry } from "../../src/services/tool-registry.js"
import type { PluginConfig } from "../../src/config.js"

vi.mock("../../src/services/mcp-client.js", () => ({
  callMemoryTool: vi.fn().mockResolvedValue("ok"),
}))

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock("../../src/utils/privacy.js", () => ({
  stripPrivateContent: vi.fn((s: string) => s.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]")),
  isFullyPrivate: vi.fn((s: string) => {
    const stripped = s.replace(/<private>[\s\S]*?<\/private>/gi, "").trim()
    return stripped.length < 10
  }),
}))

const { callMemoryTool } = await import("../../src/services/mcp-client.js")
const { stripPrivateContent, isFullyPrivate } = await import("../../src/utils/privacy.js")

function makeConfig(overrides?: Partial<PluginConfig>): PluginConfig {
  return {
    chatMessage: { enabled: true, maxMemories: 5, injectOn: "first" },
    autoCapture: { enabled: true, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    captureModel: { provider: "openai", model: "gpt-4o-mini", apiUrl: "", apiKey: "" },
    mcpServer: { command: [], tag: "default", model: "qwen3", mcpServerName: "memory-mcp-1file" },
    systemPrompt: { enabled: true },
    ...overrides,
  } as PluginConfig
}

const mockContext = {
  sessionID: "test-session",
  messageID: "test-msg",
  agent: "test",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata: vi.fn(),
  ask: vi.fn(),
} as any

describe("buildToolRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns all 11 expected tools", () => {
    const tools = buildToolRegistry(makeConfig())
    const toolNames = Object.keys(tools)
    expect(toolNames).toEqual([
      "store_memory",
      "update_memory",
      "delete_memory",
      "get_memory",
      "list_memories",
      "recall",
      "search_memory",
      "invalidate",
      "get_valid",
      "knowledge_graph",
      "get_status",
    ])
  })

  it("each tool has an execute function", () => {
    const tools = buildToolRegistry(makeConfig())
    for (const t of Object.values(tools)) {
      expect(typeof t.execute).toBe("function")
    }
  })
})

describe("store_memory tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls callMemoryTool with content", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: false } }))
    await tools.store_memory.execute({ content: "DECISION: use postgres" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "store_memory",
      expect.objectContaining({ content: "DECISION: use postgres" }),
    )
  })

  it("applies privacy filter when enabled", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: true } }))
    await tools.store_memory.execute({ content: "save <private>secret-key</private> and other public info here" }, mockContext)

    expect(stripPrivateContent).toHaveBeenCalled()
    const callArgs = vi.mocked(callMemoryTool).mock.calls[0]?.[2]
    expect(callArgs?.content).not.toContain("secret-key")
    expect(callArgs?.content).toContain("[REDACTED]")
  })

  it("blocks fully private content", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: true } }))
    const result = await tools.store_memory.execute({ content: "<private>all secret</private>" }, mockContext)
    expect(result).toContain("entirely private")
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("skips privacy filter when privacy disabled", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: false } }))
    await tools.store_memory.execute({ content: "<private>secret</private> data" }, mockContext)
    expect(isFullyPrivate).not.toHaveBeenCalled()
    expect(stripPrivateContent).not.toHaveBeenCalled()
  })

  it("passes memory_type when provided", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: false } }))
    await tools.store_memory.execute({ content: "test", memory_type: "procedural" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "store_memory",
      expect.objectContaining({ content: "test", memory_type: "procedural" }),
    )
  })

  it("parses JSON metadata string", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: false } }))
    await tools.store_memory.execute({ content: "test", metadata: '{"tags": ["a"]}' }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "store_memory",
      expect.objectContaining({ metadata: { tags: ["a"] } }),
    )
  })

  it("passes non-JSON metadata as-is", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: false } }))
    await tools.store_memory.execute({ content: "test", metadata: "plain text" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "store_memory",
      expect.objectContaining({ metadata: "plain text" }),
    )
  })
})

describe("update_memory tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls callMemoryTool with id", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: false } }))
    await tools.update_memory.execute({ id: "mem-1", content: "updated content" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "update_memory",
      expect.objectContaining({ id: "mem-1", content: "updated content" }),
    )
  })

  it("applies privacy filter on content update", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: true } }))
    await tools.update_memory.execute({ id: "mem-1", content: "public <private>secret</private> content here for update" }, mockContext)

    const callArgs = vi.mocked(callMemoryTool).mock.calls[0]?.[2]
    expect(callArgs?.content).toContain("[REDACTED]")
  })

  it("blocks update when content is fully private", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: true } }))
    const result = await tools.update_memory.execute({ id: "mem-1", content: "<private>all secret</private>" }, mockContext)
    expect(result).toContain("entirely private")
    expect(callMemoryTool).not.toHaveBeenCalled()
  })
})

describe("proxy tools (simple passthrough)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("delete_memory passes id", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.delete_memory.execute({ id: "mem-1" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(expect.anything(), "delete_memory", { id: "mem-1" })
  })

  it("get_memory passes id", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.get_memory.execute({ id: "mem-1" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(expect.anything(), "get_memory", { id: "mem-1" })
  })

  it("recall passes query and optional limit", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.recall.execute({ query: "test query", limit: 5 }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(expect.anything(), "recall", { query: "test query", limit: 5 })
  })

  it("recall omits limit when not provided", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.recall.execute({ query: "test" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(expect.anything(), "recall", { query: "test" })
  })

  it("get_status passes empty args", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.get_status.execute({}, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(expect.anything(), "get_status", {})
  })

  it("returns error string when callMemoryTool throws", async () => {
    vi.mocked(callMemoryTool).mockRejectedValueOnce(new Error("connection failed"))
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.get_status.execute({}, mockContext)
    expect(result).toContain("Error:")
    expect(result).toContain("connection failed")
  })
})
