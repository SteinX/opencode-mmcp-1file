import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { buildToolRegistry } from "../../src/services/tool-registry.js"
import type { PluginConfig } from "../../src/config.js"

vi.mock("../../src/services/mcp-client.js", () => ({
  callMemoryTool: vi.fn().mockResolvedValue("ok"),
}))

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock("../../src/config.js", () => ({
  applyConfig: vi.fn().mockReturnValue([]),
}))

vi.mock("../../src/utils/privacy.js", () => ({
  stripPrivateContent: vi.fn((s: string) => s.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]")),
  isFullyPrivate: vi.fn((s: string) => {
    const stripped = s.replace(/<private>[\s\S]*?<\/private>/gi, "").trim()
    return stripped.length < 10
  }),
}))

vi.mock("../../src/services/connection-state.js", () => ({
  isConnectionFailed: vi.fn().mockReturnValue(false),
  getConnectionStatus: vi.fn().mockReturnValue({
    connected: true,
    failureCount: 0,
    lastFailureTime: null,
    retrying: false,
  }),
}))

const { callMemoryTool } = await import("../../src/services/mcp-client.js")
const { stripPrivateContent, isFullyPrivate } = await import("../../src/utils/privacy.js")
const { applyConfig } = await import("../../src/config.js")
const { isConnectionFailed, getConnectionStatus } = await import("../../src/services/connection-state.js")

function makeConfig(overrides?: Partial<PluginConfig>): PluginConfig {
  return {
    chatMessage: { enabled: true, maxMemories: 5, maxProjectMemories: 10, injectOn: "first" },
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

  it("returns 8 unified tools", () => {
    const tools = buildToolRegistry(makeConfig())
    const toolNames = Object.keys(tools)
    expect(toolNames).toEqual([
      "memory_query",
      "memory_save",
      "memory_manage",
      "code_search",
      "project_status",
      "knowledge_graph",
      "get_status",
      "reload_config",
    ])
  })

  it("each tool has an execute function", () => {
    const tools = buildToolRegistry(makeConfig())
    for (const t of Object.values(tools)) {
      expect(typeof t.execute).toBe("function")
    }
  })
})

describe("memory_query tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("uses recall (hybrid search) in auto mode", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.memory_query.execute({ query: "test query" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "recall",
      expect.objectContaining({ query: "test query" }),
    )
  })

  it("uses list_memories for recent queries", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.memory_query.execute({ query: "recent memories" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "list_memories",
      expect.anything(),
    )
  })

  it("uses bm25 search in keyword mode", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.memory_query.execute({ query: "test", mode: "keyword" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "search_memory",
      expect.objectContaining({ query: "test", mode: "bm25" }),
    )
  })

  it("uses vector search in semantic mode", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.memory_query.execute({ query: "test", mode: "semantic" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "search_memory",
      expect.objectContaining({ query: "test", mode: "vector" }),
    )
  })

  it("passes limit parameter", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.memory_query.execute({ query: "test", limit: 10 }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "recall",
      expect.objectContaining({ limit: 10 }),
    )
  })

  it("routes to get_valid when query mentions 'valid'", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.memory_query.execute({ query: "show valid memories" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "get_valid",
      expect.objectContaining({ limit: 5 }),
    )
  })
})

describe("memory_save tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls store_memory with content", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: false } }))
    await tools.memory_save.execute({ content: "use postgres" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "store_memory",
      expect.objectContaining({ content: expect.stringContaining("use postgres") }),
    )
  })

  it("adds DECISION prefix when category is DECISION", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: false } }))
    await tools.memory_save.execute({ content: "use postgres", category: "DECISION" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "store_memory",
      expect.objectContaining({ content: "DECISION: use postgres" }),
    )
  })

  it("auto-detects DECISION from content", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: false } }))
    await tools.memory_save.execute({ content: "I decide to use React" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "store_memory",
      expect.objectContaining({ content: "DECISION: I decide to use React" }),
    )
  })

  it("applies privacy filter when enabled", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: true } }))
    await tools.memory_save.execute({ content: "save <private>secret-key</private> info" }, mockContext)
    expect(stripPrivateContent).toHaveBeenCalled()
    const callArgs = vi.mocked(callMemoryTool).mock.calls[0]?.[2]
    expect(callArgs?.content).not.toContain("secret-key")
  })

  it("blocks fully private content", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: true } }))
    const result = await tools.memory_save.execute({ content: "<private>all secret</private>" }, mockContext)
    expect(result).toContain("entirely private")
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("passes memory_type when provided", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: false } }))
    await tools.memory_save.execute({ content: "test", memory_type: "episodic" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "store_memory",
      expect.objectContaining({ memory_type: "episodic" }),
    )
  })
})

describe("memory_manage tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls get_memory for get action", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.memory_manage.execute({ action: "get", id: "mem-1" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "get_memory",
      expect.objectContaining({ id: "mem-1" }),
    )
  })

  it("calls delete_memory for delete action", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.memory_manage.execute({ action: "delete", id: "mem-1" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "delete_memory",
      expect.objectContaining({ id: "mem-1" }),
    )
  })

  it("calls invalidate for invalidate action", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.memory_manage.execute({ action: "invalidate", id: "mem-1", reason: "outdated" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "invalidate",
      expect.objectContaining({ id: "mem-1", reason: "outdated" }),
    )
  })

  it("calls update_memory for update action", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: false } }))
    await tools.memory_manage.execute({ action: "update", id: "mem-1", content: "new content" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "update_memory",
      expect.objectContaining({ id: "mem-1", content: "new content" }),
    )
  })

  it("requires content for update action", async () => {
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.memory_manage.execute({ action: "update", id: "mem-1" }, mockContext)
    expect(result).toContain("content is required")
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("applies privacy filter on update", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: true } }))
    await tools.memory_manage.execute({ action: "update", id: "mem-1", content: "public <private>secret</private> info" }, mockContext)
    const callArgs = vi.mocked(callMemoryTool).mock.calls[0]?.[2]
    expect(callArgs?.content).toContain("[REDACTED]")
  })
})

describe("code_search tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls recall_code for intent search", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.code_search.execute({ query: "authentication handler" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "recall_code",
      expect.objectContaining({ query: "authentication handler" }),
    )
  })

  it("calls search_symbols for symbol search", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.code_search.execute({ query: "handleRequest", search_type: "symbol" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "search_symbols",
      expect.objectContaining({ query: "handleRequest" }),
    )
  })

  it("calls symbol_graph for callers/callees/related", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.code_search.execute({ query: "", search_type: "callers", symbol_id: "sym-1" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "symbol_graph",
      expect.objectContaining({ action: "callers", symbol_id: "sym-1" }),
    )
  })

  it("requires symbol_id for graph searches", async () => {
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.code_search.execute({ query: "", search_type: "callers" }, mockContext)
    expect(result).toContain("symbol_id is required")
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("passes project_id and limit parameters", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.code_search.execute({ query: "test", project_id: "proj-1", limit: 5 }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "recall_code",
      expect.objectContaining({ projectId: "proj-1", limit: 5 }),
    )
  })
})

describe("project_status tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls project_info for list action", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.project_status.execute({ action: "list" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "project_info",
      expect.objectContaining({ action: "list" }),
    )
  })

  it("calls project_info for stats action", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.project_status.execute({ action: "stats", project_id: "proj-1" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "project_info",
      expect.objectContaining({ action: "stats", project_id: "proj-1" }),
    )
  })

  it("calls index_project for index action", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.project_status.execute({ action: "index", path: "/my/project" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "index_project",
      expect.objectContaining({ path: "/my/project" }),
    )
  })

  it("requires path for index action", async () => {
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.project_status.execute({ action: "index" }, mockContext)
    expect(result).toContain("path is required")
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("passes force parameter for index", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.project_status.execute({ action: "index", path: "/project", force: true }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "index_project",
      expect.objectContaining({ path: "/project", force: true }),
    )
  })
})

describe("knowledge_graph tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("passes action as required arg", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.knowledge_graph.execute({ action: "detect_communities" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "knowledge_graph",
      expect.objectContaining({ action: "detect_communities" }),
    )
  })

  it("passes all optional args", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.knowledge_graph.execute({
      action: "create_entity",
      name: "TestEntity",
      entity_type: "component",
      description: "A test component",
    }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "knowledge_graph",
      expect.objectContaining({
        action: "create_entity",
        name: "TestEntity",
        entity_type: "component",
        description: "A test component",
      }),
    )
  })
})

describe("get_status tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("proxies to MCP when connected", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.get_status.execute({}, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(expect.anything(), "get_status", {})
  })

  it("returns local status when disconnected", async () => {
    vi.mocked(isConnectionFailed).mockReturnValue(true)
    vi.mocked(getConnectionStatus).mockReturnValue({
      connected: false,
      failureCount: 2,
      lastFailureTime: Date.now(),
      retrying: true,
    })

    const tools = buildToolRegistry(makeConfig())
    const result = await tools.get_status.execute({}, mockContext)
    const parsed = JSON.parse(result as string)
    expect(parsed.status).toBe("disconnected")
    expect(parsed.failureCount).toBe(2)
    expect(callMemoryTool).not.toHaveBeenCalled()

    vi.mocked(isConnectionFailed).mockReturnValue(false)
  })
})

describe("reload_config tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns no-change message when config unchanged", async () => {
    vi.mocked(applyConfig).mockReturnValue([])
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.reload_config.execute({}, mockContext)
    expect(result).toContain("no changes detected")
  })

  it("returns changed section names", async () => {
    vi.mocked(applyConfig).mockReturnValue(["chatMessage", "privacy"])
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.reload_config.execute({}, mockContext)
    expect(result).toContain("chatMessage")
    expect(result).toContain("privacy")
  })

  it("warns when mcpServer changed", async () => {
    vi.mocked(applyConfig).mockReturnValue(["mcpServer"])
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.reload_config.execute({}, mockContext)
    expect(result).toContain("mcpServer")
    expect(result).toContain("restart")
  })

  it("returns error message when applyConfig throws", async () => {
    vi.mocked(applyConfig).mockImplementation(() => {
      throw new Error("file read failed")
    })
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.reload_config.execute({}, mockContext)
    expect(result).toContain("Config reload failed")
    expect(result).toContain("file read failed")
  })
})

describe("proxy fast-fail when connection failed", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isConnectionFailed).mockReturnValue(true)
  })

  afterEach(() => {
    vi.mocked(isConnectionFailed).mockReturnValue(false)
  })

  it("returns unavailable message for memory_query when disconnected", async () => {
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.memory_query.execute({ query: "test" }, mockContext)
    expect(result).toContain("Memory server temporarily unavailable")
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("returns unavailable message for memory_save when disconnected", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: false } }))
    const result = await tools.memory_save.execute({ content: "test" }, mockContext)
    expect(result).toContain("Memory server temporarily unavailable")
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("returns unavailable message for memory_manage when disconnected", async () => {
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.memory_manage.execute({ action: "get", id: "mem-1" }, mockContext)
    expect(result).toContain("Memory server temporarily unavailable")
    expect(callMemoryTool).not.toHaveBeenCalled()
  })
})
