import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { buildToolRegistry } from "../../src/services/tool-registry.js"
import type { PluginConfig } from "../../src/config.js"

vi.mock("../../src/services/mcp-client.js", () => ({
  callMemoryTool: vi.fn().mockResolvedValue("ok"),
  getMemoryClient: vi.fn().mockResolvedValue({}),
  resetMemoryClientForServerControl: vi.fn().mockResolvedValue(undefined),
  getProjectProjectionInfo: vi.fn().mockResolvedValue({ action: "projection", raw: { ok: true } }),
  getProjectProjectionByLocatorInfo: vi.fn().mockResolvedValue({ action: "projection_by_locator", raw: { ok: true } }),
  isMissingProjectLocator: vi.fn().mockReturnValue(false),
  getProjectDurableStatus: vi.fn().mockResolvedValue(null),
}))

vi.mock("../../src/services/server-process.js", () => ({
  ensureServerRunning: vi.fn().mockResolvedValue("http://127.0.0.1:23817"),
  isServerRunning: vi.fn().mockResolvedValue(true),
  getServerUrl: vi.fn().mockReturnValue("http://127.0.0.1:23817"),
  stopServer: vi.fn().mockResolvedValue(undefined),
  getServerRuntimeStatus: vi.fn().mockResolvedValue({
    transport: "http",
    url: "http://127.0.0.1:23817",
    running: true,
    lockPresent: true,
    pid: 123,
    holders: [111],
    unknownHolders: 0,
    holderCount: 1,
    message: "ok",
  }),
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

vi.mock("../../src/services/memory-migration.js", () => ({
  migrateMemory: vi.fn().mockResolvedValue({
    status: "dry_run_passed",
    exportedCount: 1,
    importedCount: 0,
    dryRun: true,
  }),
}))

vi.mock("../../src/services/learning-memory-client.js", () => ({
  listLearningMemories: vi.fn().mockResolvedValue({ status: "ok", records: [] }),
  getLearningMemory: vi.fn().mockResolvedValue({ status: "ok", record: { id: "abc", content: "test" } }),
  promoteLearningMemory: vi.fn().mockResolvedValue({ status: "ok" }),
  rejectLearningMemory: vi.fn().mockResolvedValue({ status: "ok" }),
  archiveLearningMemory: vi.fn().mockResolvedValue({ status: "ok" }),
  supersedeLearningMemory: vi.fn().mockResolvedValue({ status: "ok" }),
  updateLearningMemory: vi.fn().mockResolvedValue({ status: "ok" }),
  migrateLegacyLearningMemories: vi.fn().mockResolvedValue({ status: "ok", dry_run: true, counts: {} }),
  deleteLearningMemory: vi.fn().mockResolvedValue({ status: "ok" }),
}))

const {
  callMemoryTool,
  getMemoryClient,
  getProjectDurableStatus,
  resetMemoryClientForServerControl,
  getProjectProjectionInfo,
  getProjectProjectionByLocatorInfo,
  isMissingProjectLocator,
} = await import("../../src/services/mcp-client.js")
const {
  ensureServerRunning,
  isServerRunning: isHttpServerRunning,
  getServerUrl,
  stopServer,
  getServerRuntimeStatus,
} = await import("../../src/services/server-process.js")
const { stripPrivateContent } = await import("../../src/utils/privacy.js")
const { applyConfig } = await import("../../src/config.js")
const { isConnectionFailed, getConnectionStatus } = await import("../../src/services/connection-state.js")
const { migrateMemory } = await import("../../src/services/memory-migration.js")
const {
  listLearningMemories,
  getLearningMemory,
  promoteLearningMemory,
  rejectLearningMemory,
  archiveLearningMemory,
  supersedeLearningMemory,
  updateLearningMemory,
  migrateLegacyLearningMemories,
  deleteLearningMemory,
} = await import("../../src/services/learning-memory-client.js")

function makeConfig(
  overrides?: Partial<Omit<PluginConfig, "codeIndexSync">> & { codeIndexSync?: Partial<PluginConfig["codeIndexSync"]> },
): PluginConfig {
  const codeIndexSync = {
    enabled: true,
    debounceMs: 10000,
    minReindexIntervalMs: 300000,
    ...overrides?.codeIndexSync,
  }
  return {
    chatMessage: { enabled: true, maxMemories: 5, maxProjectMemories: 10, maxInjectedMemories: 6, injectOn: "first", shortQueryMinLength: 3, minScore: 0.35 },
    autoCapture: { enabled: true, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    codeIndexSync,
    captureModel: { provider: "openai", model: "gpt-4o-mini", apiUrl: "", apiKey: "" },
    memoryScope: { namespace: "", shareAcrossAgents: true, includeAgentMetadata: true, includeRunMetadata: false, userId: "", defaultMetadata: {} },
    mcpServer: { command: [], tag: "default", model: "qwen3", mcpServerName: "memory-mcp-1file", transport: "stdio", port: 23817, bind: "127.0.0.1", reconnectIntervalMs: 30000, heartbeatIntervalMs: 20000 },
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

  it("returns 28 unified tools", () => {
    const tools = buildToolRegistry(makeConfig())
    const toolNames = Object.keys(tools)
    expect(toolNames).toEqual([
      "memory_query",
      "memory_migrate",
      "memory_save",
      "memory_manage",
      "code_search",
      "project_index",
      "project_ensure_index",
      "project_recover_index",
      "project_projection",
      "project_status",
      "knowledge_graph",
      "get_status",
      "reload_config",
      "memory_learning_list",
      "memory_learning_retrieve",
      "memory_learning_confirm",
      "memory_learning_promote",
      "memory_learning_reject",
      "memory_learning_archive",
      "memory_learning_supersede",
      "memory_learning_update",
      "memory_learning_migrate_legacy",
      "memory_learning_delete",
      "learning_memory_reject",
      "learning_memory_archive",
      "learning_memory_supersede",
      "learning_memory_migrate_legacy",
      "mcp_server_control",
    ])
  })

  it("each tool has an execute function", () => {
    const tools = buildToolRegistry(makeConfig())
    for (const t of Object.values(tools)) {
      expect(typeof t.execute).toBe("function")
    }
  })
})

describe("memory_migrate tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("delegates to migrateMemory and returns a JSON report", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    const result = await tools.memory_migrate.execute({
      source_tag: "old-project",
      source_project_id: "proj-123",
      dry_run: true,
    }, mockContext)

    expect(migrateMemory).toHaveBeenCalledWith(config, {
      source_tag: "old-project",
      source_project_id: "proj-123",
      dry_run: true,
    })
    expect(JSON.parse(result)).toMatchObject({
      status: "dry_run_passed",
      exportedCount: 1,
      dryRun: true,
    })
  })
})

describe("memory_query tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("describes minimal parameter usage for memory_query", () => {
    const tools = buildToolRegistry(makeConfig())
    expect(tools.memory_query.description).toContain("Start with query only")
    expect(tools.memory_query.description).toContain("Only pass namespace, agent/run IDs, metadata filters, or time filters")
    expect(tools.memory_query.description).toContain("omit empty optional fields entirely")
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

  it("routes to get_valid in explicit valid mode", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.memory_query.execute({ query: "show valid memories", mode: "valid" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "get_valid",
      expect.objectContaining({ limit: 5 }),
    )
  })

  it("passes scope filters and execution provenance through memory_query", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.memory_query.execute({ query: "test", namespace: "workspace-a", metadata_filter_json: '{"kind":"decision"}' }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "recall",
      expect.objectContaining({
        query: "test",
        namespace: "workspace-a",
        agentId: "test",
        runId: "test-session",
        metadataFilter: { kind: "decision" },
      }),
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

  it("passes metadata_json and context provenance through memory_save", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: false } }))
    await tools.memory_save.execute({ content: "test", metadata_json: '{"capture_tags":["auth"]}' }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "store_memory",
      expect.objectContaining({
        content: expect.any(String),
        agentId: "test",
        runId: "test-session",
        metadata: { capture_tags: ["auth"] },
      }),
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

  it("passes scoped context through update action", async () => {
    const tools = buildToolRegistry(makeConfig({ privacy: { enabled: false } }))
    await tools.memory_manage.execute({ action: "update", id: "mem-1", content: "new content", namespace: "workspace-a", metadata_json: '{"source":"manual"}' }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "update_memory",
      expect.objectContaining({
        id: "mem-1",
        content: "new content",
        namespace: "workspace-a",
        agentId: "test",
        runId: "test-session",
        metadata: { source: "manual" },
      }),
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

  it("describes semantic code intelligence and symbol graph guidance", () => {
    const tools = buildToolRegistry(makeConfig())
    expect(tools.code_search.description).toContain("semantic code intelligence, not exact literal grep/search")
    expect(tools.code_search.description).toContain("search_type: \"symbol\"")
    expect(tools.code_search.description).toContain("search_type: \"callers\" | \"callees\" | \"related\"")
    expect(tools.code_search.description).toContain('code_search({ search_type: "intent"')
    expect(tools.code_search.description).toContain('code_search({ search_type: "symbol"')
    expect(tools.code_search.description).toContain('code_search({ search_type: "callers"')
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

  it("annotates stale partial intent results with a hint", async () => {
    vi.mocked(callMemoryTool).mockResolvedValueOnce(
      JSON.stringify({
        summary: { partial: { is_partial: true, reason_code: "stale" } },
      }),
    )
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.code_search.execute({ query: "authentication handler" }, mockContext)
    expect(result).toContain("[HINT] 索引更新中")
  })

  it("passes through code search output when no partial summary is present", async () => {
    const raw = JSON.stringify({ items: [{ id: "x", name: "handleRequest" }] })
    vi.mocked(callMemoryTool).mockResolvedValueOnce(raw)
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.code_search.execute({ query: "handleRequest", search_type: "symbol" }, mockContext)
    expect(result).toBe(raw)
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
    expect(result).toContain('First call code_search({ search_type: "symbol", query: "<name>" })')
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

  it("describes the readiness path from list to index to stats", () => {
    const tools = buildToolRegistry(makeConfig())
    expect(tools.project_status.description).toContain("Start with 'list' to see indexed projects")
    expect(tools.project_status.description).toContain("use 'status' to inspect durable state")
    expect(tools.project_status.description).toContain("use 'ensure_index' for normal readiness workflows")
    expect(tools.project_status.description).toContain("Use project_projection for ordinary projection/readback workflows")
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

  it("annotates list output when capability status is degraded", async () => {
    vi.mocked(callMemoryTool).mockResolvedValueOnce(
      JSON.stringify({
        capability_status: { index: "serving", search: "degraded" },
      }),
    )
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.project_status.execute({ action: "list" }, mockContext)
    expect(result).toContain("[Capability Status]")
  })

  it("passes through project status list output without capability status", async () => {
    const raw = JSON.stringify({ projects: [{ id: "proj-1" }] })
    vi.mocked(callMemoryTool).mockResolvedValueOnce(raw)
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.project_status.execute({ action: "list" }, mockContext)
    expect(result).toBe(raw)
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

  it("calls project_info for status action", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.project_status.execute({ action: "status", project_id: "proj-1", path: "/project" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "project_info",
      expect.objectContaining({ action: "status", project_id: "proj-1", path: "/project" }),
    )
  })

  it("calls project_info for cancel action", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.project_status.execute({ action: "cancel", project_id: "proj-1", path: "/project", job_id: "job-9" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "project_info",
      expect.objectContaining({ action: "cancel_index", project_id: "proj-1", path: "/project", job_id: "job-9" }),
    )
  })

  it("calls project_info for cleanup action", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.project_status.execute({ action: "cleanup", project_id: "proj-1", path: "/project" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "project_info",
      expect.objectContaining({ action: "cleanup_abandoned_index_jobs", project_id: "proj-1", path: "/project" }),
    )
  })

  it("calls index_project with resume=true for resume action with job_id and resume_token", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.project_status.execute({
      action: "resume",
      path: "/project",
      job_id: "job-42",
      resume_token: "tok-99",
    }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "index_project",
      expect.objectContaining({
        path: "/project",
        resume: true,
        job_id: "job-42",
        resume_token: "tok-99",
      }),
    )
  })

  it("returns error string for resume action missing job_id", async () => {
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.project_status.execute({
      action: "resume",
      path: "/project",
      resume_token: "tok-99",
    }, mockContext)
    expect(result).toContain("job_id is required")
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("returns error string for resume action missing path", async () => {
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.project_status.execute({
      action: "resume",
      job_id: "job-42",
      resume_token: "tok-99",
    }, mockContext)
    expect(result).toContain("path is required")
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("returns error string for resume action missing resume_token", async () => {
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.project_status.execute({
      action: "resume",
      path: "/project",
      job_id: "job-42",
    }, mockContext)
    expect(result).toContain("resume_token is required")
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("requests projection via project_status with default relation_scope and sort_mode", async () => {
    const tools = buildToolRegistry(makeConfig())
    vi.mocked(getProjectProjectionInfo).mockResolvedValueOnce({
      action: "projection",
      raw: { action: "projection", locator: { lookup: { state: "created", raw: {} }, raw: {} } },
    })

    const result = await tools.project_status.execute({ action: "projection", project_id: "proj-1" }, mockContext)

    expect(getProjectProjectionInfo).toHaveBeenCalledWith(expect.anything(), {
      projectId: "proj-1",
      relationScope: "all",
      sortMode: "canonical",
    })
    expect(result).toBe(JSON.stringify({ action: "projection", locator: { lookup: { state: "created", raw: {} }, raw: {} } }))
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("passes explicit projection relation_scope and sort_mode", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.project_status.execute({
      action: "projection",
      project_id: "proj-1",
      relation_scope: "imports",
      sort_mode: "custom",
    }, mockContext)

    expect(getProjectProjectionInfo).toHaveBeenCalledWith(expect.anything(), {
      projectId: "proj-1",
      relationScope: "imports",
      sortMode: "custom",
    })
  })

  it("uses locator readback for projection_by_locator when locator resolves", async () => {
    const tools = buildToolRegistry(makeConfig())
    vi.mocked(getProjectProjectionByLocatorInfo).mockResolvedValueOnce({
      action: "projection_by_locator",
      locator: { lookup: { state: "resolved", raw: {} }, raw: {} },
      raw: { action: "projection_by_locator", ok: true },
    })
    vi.mocked(isMissingProjectLocator).mockReturnValueOnce(false)

    const result = await tools.project_status.execute({
      action: "projection_by_locator",
      project_id: "proj-1",
      locator: "loc-1",
    }, mockContext)

    expect(getProjectProjectionByLocatorInfo).toHaveBeenCalledWith(expect.anything(), { locator: "loc-1" })
    expect(getProjectProjectionInfo).not.toHaveBeenCalled()
    expect(result).toBe(JSON.stringify({ action: "projection_by_locator", ok: true }))
  })

  it("falls back to fresh projection when locator readback is missing or invalid", async () => {
    const tools = buildToolRegistry(makeConfig())
    vi.mocked(getProjectProjectionByLocatorInfo).mockResolvedValueOnce({
      action: "projection_by_locator",
      locator: { lookup: { state: "missing", reasonCode: "invalid_locator", raw: {} }, raw: {} },
      raw: { action: "projection_by_locator", ok: false },
    })
    vi.mocked(isMissingProjectLocator).mockReturnValueOnce(true)
    vi.mocked(getProjectProjectionInfo).mockResolvedValueOnce({
      action: "projection",
      raw: { action: "projection", locator: { lookup: { state: "created", raw: {} }, raw: {} } },
    })

    const result = await tools.project_status.execute({
      action: "projection_by_locator",
      project_id: "proj-1",
      locator: "loc-1",
      relation_scope: "calls",
    }, mockContext)

    expect(getProjectProjectionByLocatorInfo).toHaveBeenCalledWith(expect.anything(), { locator: "loc-1" })
    expect(getProjectProjectionInfo).toHaveBeenCalledWith(expect.anything(), {
      projectId: "proj-1",
      relationScope: "calls",
      sortMode: "canonical",
    })
    expect(result).toBe(JSON.stringify({ action: "projection", locator: { lookup: { state: "created", raw: {} }, raw: {} } }))
  })

  it("falls back to fresh projection when locator readback returns null", async () => {
    const tools = buildToolRegistry(makeConfig())
    vi.mocked(getProjectProjectionByLocatorInfo).mockResolvedValueOnce(null)
    vi.mocked(getProjectProjectionInfo).mockResolvedValueOnce({
      action: "projection",
      raw: { action: "projection", ok: true },
    })

    const result = await tools.project_status.execute({
      action: "projection_by_locator",
      project_id: "proj-1",
      locator: "loc-1",
    }, mockContext)

    expect(getProjectProjectionInfo).toHaveBeenCalledWith(expect.anything(), {
      projectId: "proj-1",
      relationScope: "all",
      sortMode: "canonical",
    })
    expect(result).toBe(JSON.stringify({ action: "projection", ok: true }))
  })

  it("requires project_id for projection action", async () => {
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.project_status.execute({ action: "projection" }, mockContext)
    expect(result).toContain("project_id is required")
    expect(getProjectProjectionInfo).not.toHaveBeenCalled()
  })

  it("requires project_id for missing locator fallback", async () => {
    const tools = buildToolRegistry(makeConfig())
    vi.mocked(getProjectProjectionByLocatorInfo).mockResolvedValueOnce(null)
    const result = await tools.project_status.execute({ action: "projection_by_locator", locator: "loc-1" }, mockContext)
    expect(result).toContain("project_id is required")
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

  it("forwards config defaults when index filters are omitted", async () => {
    const tools = buildToolRegistry(makeConfig({
      codeIndexSync: {
        enabled: true,
        autoRefresh: false,
        debounceMs: 10000,
        minReindexIntervalMs: 300000,
        includePatterns: ["src/**/*"],
        excludePatterns: ["**/*.log"],
      },
    }))
    await tools.project_status.execute({ action: "index", path: "/project" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "index_project",
      expect.objectContaining({
        path: "/project",
        include_patterns: ["src/**/*"],
        exclude_patterns: ["**/*.log"],
      }),
    )
  })

  it("lets call-time index filters override config defaults", async () => {
    const tools = buildToolRegistry(makeConfig({
      codeIndexSync: {
        enabled: true,
        autoRefresh: false,
        debounceMs: 10000,
        minReindexIntervalMs: 300000,
        includePatterns: ["src/**/*"],
        excludePatterns: ["**/*.log"],
      },
    }))
    await tools.project_status.execute({ action: "index", path: "/project", include_patterns: ["tests/**/*"], exclude_patterns: [] }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "index_project",
      expect.objectContaining({
        include_patterns: ["tests/**/*"],
        exclude_patterns: [],
      }),
    )
  })

  it("forwards empty include patterns", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.project_status.execute({ action: "index", path: "/project", include_patterns: [] }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "index_project",
      expect.objectContaining({ include_patterns: [] }),
    )
  })

  it("omits filter keys when index filters are not provided and config has none", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.project_status.execute({ action: "index", path: "/project" }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledTimes(1)
    const thirdArg = vi.mocked(callMemoryTool).mock.calls[0]?.[2] as Record<string, unknown>
    expect(thirdArg).not.toHaveProperty("include_patterns")
    expect(thirdArg).not.toHaveProperty("exclude_patterns")
  })

  it("returns an error for invalid index filters without calling MCP", async () => {
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.project_status.execute({ action: "index", path: "/project", include_patterns: ["/absolute/path"] }, mockContext)
    expect(result).toContain("Error:")
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("passes additive resume flags for index", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.project_status.execute({
      action: "index",
      path: "/project",
      resume: true,
      job_id: "job-1",
      resume_token: "token-1",
      allow_full_restart_fallback: true,
      confirm_failed_restart: true,
    }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "index_project",
      expect.objectContaining({
        path: "/project",
        resume: true,
        job_id: "job-1",
        resume_token: "token-1",
        allow_full_restart_fallback: true,
        confirm_failed_restart: true,
      }),
    )
  })

  it("rejects filters for resume action without calling MCP", async () => {
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.project_status.execute({ action: "resume", path: "/p", job_id: "j", resume_token: "t", include_patterns: ["src/**/*"] }, mockContext)
    expect(result).toContain("Error:")
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("rejects filters for resume-continuation index without calling MCP", async () => {
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.project_status.execute({ action: "index", path: "/p", job_id: "j", resume_token: "t", include_patterns: ["src/**/*"] }, mockContext)
    expect(result).toContain("Error:")
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("calls index_project for resume action", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.project_status.execute({
      action: "resume",
      path: "/project",
      job_id: "job-1",
      resume_token: "token-1",
      allow_full_restart_fallback: true,
    }, mockContext)
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "index_project",
      expect.objectContaining({
        path: "/project",
        resume: true,
        job_id: "job-1",
        resume_token: "token-1",
        allow_full_restart_fallback: true,
      }),
    )
  })

  it("requires path, job_id, and resume_token for resume action", async () => {
    const tools = buildToolRegistry(makeConfig())
    await expect(tools.project_status.execute({ action: "resume" }, mockContext)).resolves.toContain("path is required")
    await expect(tools.project_status.execute({ action: "resume", path: "/project" }, mockContext)).resolves.toContain("job_id is required")
    await expect(tools.project_status.execute({ action: "resume", path: "/project", job_id: "job-1" }, mockContext)).resolves.toContain("resume_token is required")
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

})

describe("project_projection tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("requests a fresh projection with defaults when locator is omitted", async () => {
    const tools = buildToolRegistry(makeConfig())
    vi.mocked(getProjectProjectionInfo).mockResolvedValueOnce({
      action: "projection",
      raw: { action: "projection", ok: true },
    })

    const result = await tools.project_projection.execute({ project_id: "proj-1" }, mockContext)

    expect(getProjectProjectionInfo).toHaveBeenCalledWith(expect.anything(), {
      projectId: "proj-1",
      relationScope: "all",
      sortMode: "canonical",
    })
    expect(result).toBe(JSON.stringify({ action: "projection", ok: true }))
  })

  it("uses locator readback when locator resolves", async () => {
    const tools = buildToolRegistry(makeConfig())
    vi.mocked(getProjectProjectionByLocatorInfo).mockResolvedValueOnce({
      action: "projection_by_locator",
      locator: { lookup: { state: "resolved", raw: {} }, raw: {} },
      raw: { action: "projection_by_locator", ok: true },
    })
    vi.mocked(isMissingProjectLocator).mockReturnValueOnce(false)

    const result = await tools.project_projection.execute({ project_id: "proj-1", locator: "loc-1" }, mockContext)

    expect(getProjectProjectionByLocatorInfo).toHaveBeenCalledWith(expect.anything(), { locator: "loc-1" })
    expect(getProjectProjectionInfo).not.toHaveBeenCalled()
    expect(result).toBe(JSON.stringify({ action: "projection_by_locator", ok: true }))
  })

  it("falls back to fresh projection when locator readback returns null", async () => {
    const tools = buildToolRegistry(makeConfig())
    vi.mocked(getProjectProjectionByLocatorInfo).mockResolvedValueOnce(null)
    vi.mocked(getProjectProjectionInfo).mockResolvedValueOnce({
      action: "projection",
      raw: { action: "projection", ok: true },
    })

    const result = await tools.project_projection.execute({ project_id: "proj-1", locator: "loc-1" }, mockContext)

    expect(getProjectProjectionInfo).toHaveBeenCalledWith(expect.anything(), {
      projectId: "proj-1",
      relationScope: "all",
      sortMode: "canonical",
    })
    expect(result).toBe(JSON.stringify({ action: "projection", ok: true }))
  })

  it("falls back to fresh projection when locator is missing", async () => {
    const tools = buildToolRegistry(makeConfig())
    vi.mocked(getProjectProjectionByLocatorInfo).mockResolvedValueOnce({
      action: "projection_by_locator",
      locator: { lookup: { state: "missing", reasonCode: "invalid_locator", raw: {} }, raw: {} },
      raw: { action: "projection_by_locator", ok: false },
    })
    vi.mocked(isMissingProjectLocator).mockReturnValueOnce(true)
    vi.mocked(getProjectProjectionInfo).mockResolvedValueOnce({
      action: "projection",
      raw: { action: "projection", ok: true },
    })

    const result = await tools.project_projection.execute({ project_id: "proj-1", locator: "loc-1" }, mockContext)

    expect(getProjectProjectionInfo).toHaveBeenCalledWith(expect.anything(), {
      projectId: "proj-1",
      relationScope: "all",
      sortMode: "canonical",
    })
    expect(result).toBe(JSON.stringify({ action: "projection", ok: true }))
  })

  it("returns an error when a fresh projection fails", async () => {
    const tools = buildToolRegistry(makeConfig())
    vi.mocked(getProjectProjectionInfo).mockResolvedValueOnce(null)

    const result = await tools.project_projection.execute({ project_id: "proj-1" }, mockContext)

    expect(result).toBe("Error: projection request failed")
  })
})

describe("project_ensure_index tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("describes readiness-only behavior", () => {
    const tools = buildToolRegistry(makeConfig())
    expect(tools.project_ensure_index.description).toContain("Ensure a project is indexed for readiness checks")
    expect(tools.project_ensure_index.description).toContain("without exposing filter or resume identity fields")
  })

  it("starts a fresh index when durable status is unavailable", async () => {
    vi.mocked(getProjectDurableStatus).mockResolvedValueOnce(null)
    const tools = buildToolRegistry(makeConfig())

    const result = await tools.project_ensure_index.execute({ path: "/project" }, mockContext)

    expect(getProjectDurableStatus).toHaveBeenCalledWith(expect.anything(), "/project")
    expect(callMemoryTool).toHaveBeenCalledWith(expect.anything(), "index_project", { path: "/project" })
    const payload = vi.mocked(callMemoryTool).mock.calls[0]?.[2] as Record<string, unknown>
    expect(payload).not.toHaveProperty("include_patterns")
    expect(payload).not.toHaveProperty("exclude_patterns")
    expect(payload).not.toHaveProperty("job_id")
    expect(payload).not.toHaveProperty("resume_token")
    expect(result).toBe("ok")
  })

  it("returns already_running without calling index_project", async () => {
    vi.mocked(getProjectDurableStatus).mockResolvedValueOnce({
      state: "running",
      reason_code: "active_index_running",
      progress: { percent: 42 },
      raw: {},
    } as any)
    const tools = buildToolRegistry(makeConfig())

    const result = await tools.project_ensure_index.execute({ path: "/project" }, mockContext)

    expect(result).toBe(JSON.stringify({
      status: "already_running",
      state: "running",
      reason_code: "active_index_running",
      progress: { percent: 42 },
    }))
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("returns already_ready when durable status is completed", async () => {
    vi.mocked(getProjectDurableStatus).mockResolvedValueOnce({
      state: "completed",
      reason_code: "can_resume",
      raw: {},
    } as any)
    const tools = buildToolRegistry(makeConfig())

    const result = await tools.project_ensure_index.execute({ path: "/project" }, mockContext)

    expect(result).toBe(JSON.stringify({
      status: "already_ready",
      state: "completed",
      reason_code: "can_resume",
    }))
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("returns blocked when resume identity is missing", async () => {
    vi.mocked(getProjectDurableStatus).mockResolvedValueOnce({
      state: "interrupted",
      can_resume: true,
      reason_code: "can_resume",
      raw: {},
    } as any)
    const tools = buildToolRegistry(makeConfig())

    const result = await tools.project_ensure_index.execute({ path: "/project" }, mockContext)

    expect(result).toBe(JSON.stringify({
      status: "blocked",
      reason: "missing_resume_identity",
      state: "interrupted",
      reason_code: "can_resume",
    }))
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("resumes with a clean payload when resume identity exists", async () => {
    vi.mocked(getProjectDurableStatus).mockResolvedValueOnce({
      state: "interrupted",
      can_resume: true,
      job_id: "job-7",
      resume_token: "token-7",
      reason_code: "can_resume",
      raw: {},
    } as any)
    const tools = buildToolRegistry(makeConfig())

    const result = await tools.project_ensure_index.execute({ path: "/project" }, mockContext)

    expect(callMemoryTool).toHaveBeenCalledWith(expect.anything(), "index_project", {
      path: "/project",
      resume: true,
      job_id: "job-7",
      resume_token: "token-7",
      allow_full_restart_fallback: false,
    })
    const payload = vi.mocked(callMemoryTool).mock.calls[0]?.[2] as Record<string, unknown>
    expect(payload).not.toHaveProperty("include_patterns")
    expect(payload).not.toHaveProperty("exclude_patterns")
    expect(result).toBe("ok")
  })

  it("starts a fresh index when durable status is not resumable", async () => {
    vi.mocked(getProjectDurableStatus).mockResolvedValueOnce({
      state: "failed",
      can_resume: false,
      reason_code: "workspace_changed_since_checkpoint",
      raw: {},
    } as any)
    const tools = buildToolRegistry(makeConfig())

    const result = await tools.project_ensure_index.execute({ path: "/project" }, mockContext)

    expect(callMemoryTool).toHaveBeenCalledWith(expect.anything(), "index_project", { path: "/project" })
    expect(result).toBe("ok")
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

describe("project_index tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("proxies a clean payload for path-only indexing", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.project_index.execute({ path: "/project" }, mockContext)

    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "index_project",
      expect.objectContaining({ path: "/project" }),
    )
    const payload = vi.mocked(callMemoryTool).mock.calls[0]?.[2] as Record<string, unknown>
    expect(payload).not.toHaveProperty("resume")
    expect(payload).not.toHaveProperty("include_patterns")
    expect(payload).not.toHaveProperty("exclude_patterns")
    expect(payload).not.toHaveProperty("job_id")
    expect(payload).not.toHaveProperty("resume_token")
  })

  it("adds force only when requested", async () => {
    const tools = buildToolRegistry(makeConfig())
    await tools.project_index.execute({ path: "/project", force: true }, mockContext)

    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "index_project",
      expect.objectContaining({ path: "/project", force: true }),
    )
    const payload = vi.mocked(callMemoryTool).mock.calls[0]?.[2] as Record<string, unknown>
    expect(payload).not.toHaveProperty("resume")
    expect(payload).not.toHaveProperty("include_patterns")
    expect(payload).not.toHaveProperty("exclude_patterns")
    expect(payload).not.toHaveProperty("job_id")
    expect(payload).not.toHaveProperty("resume_token")
  })
})

describe("project_recover_index tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("resumes with a clean payload when durable status can resume", async () => {
    vi.mocked(getProjectDurableStatus).mockResolvedValueOnce({
      action: "status",
      can_resume: true,
      job_id: "job-1",
      resume_token: "token-1",
      raw: {},
    })
    const tools = buildToolRegistry(makeConfig())
    await tools.project_recover_index.execute({ path: "/project" }, mockContext)

    expect(getProjectDurableStatus).toHaveBeenCalledWith(expect.anything(), "/project")
    expect(callMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "index_project",
      {
        path: "/project",
        resume: true,
        job_id: "job-1",
        resume_token: "token-1",
        allow_full_restart_fallback: false,
      },
    )
    const payload = vi.mocked(callMemoryTool).mock.calls[0]?.[2] as Record<string, unknown>
    expect(payload).not.toHaveProperty("include_patterns")
    expect(payload).not.toHaveProperty("exclude_patterns")
  })

  it("returns already_running without calling MCP when index is active", async () => {
    vi.mocked(getProjectDurableStatus).mockResolvedValueOnce({
      action: "status",
      state: "running",
      reason_code: "active_index_running",
      raw: {},
    })
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.project_recover_index.execute({ path: "/project" }, mockContext)

    expect(JSON.parse(result as string)).toMatchObject({ status: "already_running" })
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("returns already_completed without calling MCP when index is complete", async () => {
    vi.mocked(getProjectDurableStatus).mockResolvedValueOnce({
      action: "status",
      state: "completed",
      raw: {},
    })
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.project_recover_index.execute({ path: "/project" }, mockContext)

    expect(JSON.parse(result as string)).toMatchObject({ status: "already_completed" })
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("returns blocked when resume identity is incomplete", async () => {
    vi.mocked(getProjectDurableStatus).mockResolvedValueOnce({
      action: "status",
      can_resume: true,
      job_id: "job-1",
      raw: {},
    })
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.project_recover_index.execute({ path: "/project" }, mockContext)

    expect(JSON.parse(result as string)).toMatchObject({ status: "blocked", reason: "missing_resume_identity" })
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("returns not_resumable for non-resumable status", async () => {
    vi.mocked(getProjectDurableStatus).mockResolvedValueOnce({
      action: "status",
      can_resume: false,
      reason_code: "workspace_changed_since_checkpoint",
      raw: {},
    })
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.project_recover_index.execute({ path: "/project" }, mockContext)

    expect(JSON.parse(result as string)).toMatchObject({
      status: "not_resumable",
      reason_code: "workspace_changed_since_checkpoint",
      can_resume: false,
    })
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("returns unsupported when durable status is unavailable", async () => {
    vi.mocked(getProjectDurableStatus).mockResolvedValueOnce(null)
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.project_recover_index.execute({ path: "/project" }, mockContext)

    expect(JSON.parse(result as string)).toMatchObject({ status: "unsupported" })
    expect(callMemoryTool).not.toHaveBeenCalled()
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
    expect(result).toContain("restart the editor")
  })

  it("warns with manage-mcp-server restart for HTTP transport", async () => {
    vi.mocked(applyConfig).mockReturnValue(["mcpServer"])
    const tools = buildToolRegistry(makeConfig({
      mcpServer: {
        ...makeConfig().mcpServer,
        transport: "http",
      },
    }))
    const result = await tools.reload_config.execute({}, mockContext)
    expect(result).toContain("/manage-mcp-server restart")
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

describe("mcp_server_control tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns stdio no-op for status without lifecycle calls", async () => {
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.mcp_server_control.execute({ action: "status" }, mockContext)
    const parsed = JSON.parse(result as string)
    expect(parsed).toMatchObject({
      ok: true,
      action: "status",
      transport: "stdio",
      running: false,
    })
    expect(parsed.message).toContain("does not use a shared HTTP MCP server")
    expect(getServerRuntimeStatus).not.toHaveBeenCalled()
    expect(stopServer).not.toHaveBeenCalled()
    expect(ensureServerRunning).not.toHaveBeenCalled()
    expect(resetMemoryClientForServerControl).not.toHaveBeenCalled()
    expect(getMemoryClient).not.toHaveBeenCalled()
  })

  it("returns stdio no-op for stop without lifecycle calls", async () => {
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.mcp_server_control.execute({ action: "stop" }, mockContext)
    const parsed = JSON.parse(result as string)
    expect(parsed).toMatchObject({
      ok: true,
      action: "stop",
      transport: "stdio",
      running: false,
    })
    expect(stopServer).not.toHaveBeenCalled()
    expect(ensureServerRunning).not.toHaveBeenCalled()
    expect(resetMemoryClientForServerControl).not.toHaveBeenCalled()
    expect(getMemoryClient).not.toHaveBeenCalled()
  })

  it("returns stdio no-op for restart without lifecycle calls", async () => {
    const tools = buildToolRegistry(makeConfig())
    const result = await tools.mcp_server_control.execute({ action: "restart" }, mockContext)
    const parsed = JSON.parse(result as string)
    expect(parsed).toMatchObject({
      ok: true,
      action: "restart",
      transport: "stdio",
      running: false,
    })
    expect(stopServer).not.toHaveBeenCalled()
    expect(ensureServerRunning).not.toHaveBeenCalled()
    expect(resetMemoryClientForServerControl).not.toHaveBeenCalled()
    expect(getMemoryClient).not.toHaveBeenCalled()
  })

  it("returns HTTP status via getServerRuntimeStatus without mutating calls", async () => {
    const status = {
      transport: "http",
      url: "http://127.0.0.1:23817",
      running: true,
      lockPresent: true,
      pid: 123,
      holders: [111],
      unknownHolders: 0,
      holderCount: 1,
      message: "healthy",
    }
    vi.mocked(getServerRuntimeStatus).mockResolvedValueOnce(status as any)

    const tools = buildToolRegistry(makeConfig({
      mcpServer: {
        ...makeConfig().mcpServer,
        transport: "http",
      },
    }))
    const result = await tools.mcp_server_control.execute({ action: "status" }, mockContext)
    const parsed = JSON.parse(result as string)

    expect(getServerRuntimeStatus).toHaveBeenCalledWith(expect.anything())
    expect(parsed).toMatchObject({ ok: true, action: "status", ...status })
    expect(stopServer).not.toHaveBeenCalled()
    expect(ensureServerRunning).not.toHaveBeenCalled()
  })

  it("stops HTTP server with reset + stopServer exactly once", async () => {
    vi.mocked(getServerRuntimeStatus)
      .mockResolvedValueOnce({
        transport: "http",
        url: "http://127.0.0.1:23817",
        running: true,
        lockPresent: true,
        pid: 123,
        holders: [111],
        unknownHolders: 0,
        holderCount: 1,
        message: "before",
      } as any)
      .mockResolvedValueOnce({
        transport: "http",
        url: "http://127.0.0.1:23817",
        running: false,
        lockPresent: false,
        pid: null,
        holders: [],
        unknownHolders: 0,
        holderCount: 0,
        message: "after",
      } as any)

    const tools = buildToolRegistry(makeConfig({
      mcpServer: {
        ...makeConfig().mcpServer,
        transport: "http",
      },
    }))
    const result = await tools.mcp_server_control.execute({ action: "stop" }, mockContext)
    const parsed = JSON.parse(result as string)

    expect(resetMemoryClientForServerControl).toHaveBeenCalledTimes(1)
    expect(stopServer).toHaveBeenCalledTimes(1)
    expect(stopServer).toHaveBeenCalledWith(expect.anything())
    expect(parsed.ok).toBe(true)
    expect(parsed.action).toBe("stop")
    expect(parsed.stopped).toBe(true)
  })

  it("restarts HTTP server and eagerly reconnects when health passes", async () => {
    vi.mocked(getServerRuntimeStatus)
      .mockResolvedValueOnce({
        transport: "http",
        url: "http://127.0.0.1:23817",
        running: true,
        lockPresent: true,
        pid: 123,
        holders: [111],
        unknownHolders: 0,
        holderCount: 1,
        message: "before",
      } as any)
      .mockResolvedValueOnce({
        transport: "http",
        url: "http://127.0.0.1:23817",
        running: false,
        lockPresent: false,
        pid: null,
        holders: [],
        unknownHolders: 0,
        holderCount: 0,
        message: "afterStop",
      } as any)
      .mockResolvedValueOnce({
        transport: "http",
        url: "http://127.0.0.1:23817",
        running: true,
        lockPresent: true,
        pid: 456,
        holders: [222],
        unknownHolders: 0,
        holderCount: 1,
        message: "afterStart",
      } as any)

    const tools = buildToolRegistry(makeConfig({
      mcpServer: {
        ...makeConfig().mcpServer,
        transport: "http",
      },
    }))
    const result = await tools.mcp_server_control.execute({ action: "restart" }, mockContext)
    const parsed = JSON.parse(result as string)

    expect(resetMemoryClientForServerControl).toHaveBeenCalledTimes(1)
    expect(stopServer).toHaveBeenCalledTimes(1)
    expect(ensureServerRunning).toHaveBeenCalledTimes(1)
    expect(isHttpServerRunning).toHaveBeenCalledTimes(1)
    expect(getMemoryClient).toHaveBeenCalledTimes(1)
    expect(parsed.ok).toBe(true)
    expect(parsed.action).toBe("restart")
    expect(parsed.running).toBe(true)
    expect(parsed.url).toBe("http://127.0.0.1:23817")
  })

  it("returns ok:false on restart failure instead of throwing", async () => {
    vi.mocked(getServerRuntimeStatus)
      .mockResolvedValueOnce({
        transport: "http",
        url: "http://127.0.0.1:23817",
        running: true,
        lockPresent: true,
        pid: 123,
        holders: [111],
        unknownHolders: 0,
        holderCount: 1,
        message: "before",
      } as any)
      .mockResolvedValueOnce({
        transport: "http",
        url: "http://127.0.0.1:23817",
        running: false,
        lockPresent: false,
        pid: null,
        holders: [],
        unknownHolders: 0,
        holderCount: 0,
        message: "afterStop",
      } as any)
    vi.mocked(ensureServerRunning).mockRejectedValueOnce(new Error("spawn failed"))

    const tools = buildToolRegistry(makeConfig({
      mcpServer: {
        ...makeConfig().mcpServer,
        transport: "http",
      },
    }))
    const result = await tools.mcp_server_control.execute({ action: "restart" }, mockContext)
    const parsed = JSON.parse(result as string)

    expect(parsed.ok).toBe(false)
    expect(parsed.action).toBe("restart")
    expect(parsed.error).toContain("spawn failed")
  })

  it("returns ok:false when post-start health check fails", async () => {
    vi.mocked(getServerRuntimeStatus)
      .mockResolvedValueOnce({
        transport: "http",
        url: "http://127.0.0.1:23817",
        running: true,
        lockPresent: true,
        pid: 123,
        holders: [111],
        unknownHolders: 0,
        holderCount: 1,
        message: "before",
      } as any)
      .mockResolvedValueOnce({
        transport: "http",
        url: "http://127.0.0.1:23817",
        running: false,
        lockPresent: false,
        pid: null,
        holders: [],
        unknownHolders: 0,
        holderCount: 0,
        message: "afterStop",
      } as any)
    vi.mocked(isHttpServerRunning).mockResolvedValueOnce(false)

    const tools = buildToolRegistry(makeConfig({
      mcpServer: {
        ...makeConfig().mcpServer,
        transport: "http",
      },
    }))
    const result = await tools.mcp_server_control.execute({ action: "restart" }, mockContext)
    const parsed = JSON.parse(result as string)

    expect(parsed.ok).toBe(false)
    expect(parsed.action).toBe("restart")
    expect(parsed.error).toContain("Health verification failed")
    expect(getMemoryClient).not.toHaveBeenCalled()
  })

  it("includes URL from getServerUrl in restart failure payload", async () => {
    vi.mocked(getServerRuntimeStatus).mockResolvedValueOnce({
      transport: "http",
      url: "http://127.0.0.1:23817",
      running: true,
      lockPresent: true,
      pid: 123,
      holders: [111],
      unknownHolders: 0,
      holderCount: 1,
      message: "before",
    } as any)
    vi.mocked(ensureServerRunning).mockRejectedValueOnce(new Error("boom"))

    const tools = buildToolRegistry(makeConfig({
      mcpServer: {
        ...makeConfig().mcpServer,
        transport: "http",
      },
    }))
    const result = await tools.mcp_server_control.execute({ action: "restart" }, mockContext)
    const parsed = JSON.parse(result as string)

    expect(getServerUrl).toHaveBeenCalledTimes(1)
    expect(parsed.url).toBe("http://127.0.0.1:23817")
    expect(parsed.ok).toBe(false)
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

describe("memory_learning_list tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls listLearningMemories with no filters when none provided", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    const result = await tools.memory_learning_list.execute({}, mockContext)
    expect(listLearningMemories).toHaveBeenCalledWith(config, {})
    expect(JSON.parse(result)).toMatchObject({ status: "ok", records: [] })
  })

  it("forwards kind filter to listLearningMemories", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    await tools.memory_learning_list.execute({ kind: "user_preference" }, mockContext)
    expect(listLearningMemories).toHaveBeenCalledWith(config, expect.objectContaining({ kind: "user_preference" }))
  })

  it("forwards status as include_status array", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    await tools.memory_learning_list.execute({ status: "candidate" }, mockContext)
    expect(listLearningMemories).toHaveBeenCalledWith(config, expect.objectContaining({ include_status: ["candidate"] }))
  })

  it("parses metadata_filter_json and forwards as metadata_filter", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    await tools.memory_learning_list.execute({ metadata_filter_json: '{"project":"foo"}' }, mockContext)
    expect(listLearningMemories).toHaveBeenCalledWith(config, expect.objectContaining({ metadata_filter: { project: "foo" } }))
  })

  it("does not call callMemoryTool directly", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    await tools.memory_learning_list.execute({}, mockContext)
    expect(callMemoryTool).not.toHaveBeenCalled()
  })
})

describe("memory_learning_reject tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls rejectLearningMemory with id and optional reason", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    await tools.memory_learning_reject.execute({ id: "mem-1", reason: "not accurate" }, mockContext)
    expect(rejectLearningMemory).toHaveBeenCalledWith(config, { id: "mem-1", reason: "not accurate" })
  })

  it("does not call callMemoryTool directly", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    await tools.memory_learning_reject.execute({ id: "mem-1" }, mockContext)
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("returns error when id is missing", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    const result = await tools.memory_learning_reject.execute({ id: "" }, mockContext)
    expect(result).toContain("Error")
    expect(rejectLearningMemory).not.toHaveBeenCalled()
  })
})

describe("memory_learning_confirm tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls promoteLearningMemory with target_status confirmed", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    await tools.memory_learning_confirm.execute({ id: "mem-1" }, mockContext)
    expect(promoteLearningMemory).toHaveBeenCalledWith(config, { id: "mem-1", target_status: "confirmed" })
  })

  it("does not call callMemoryTool directly", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    await tools.memory_learning_confirm.execute({ id: "mem-1" }, mockContext)
    expect(callMemoryTool).not.toHaveBeenCalled()
  })
})

describe("memory_learning_promote tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls promoteLearningMemory with target_status rule", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    await tools.memory_learning_promote.execute({ id: "mem-1", target_status: "rule" }, mockContext)
    expect(promoteLearningMemory).toHaveBeenCalledWith(config, { id: "mem-1", target_status: "rule" })
  })
})

describe("memory_learning_archive tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls archiveLearningMemory with id", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    await tools.memory_learning_archive.execute({ id: "mem-1" }, mockContext)
    expect(archiveLearningMemory).toHaveBeenCalledWith(config, { id: "mem-1" })
    expect(callMemoryTool).not.toHaveBeenCalled()
  })
})

describe("memory_learning_supersede tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls supersedeLearningMemory with id and replacement_id", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    await tools.memory_learning_supersede.execute({ id: "mem-1", replacement_id: "mem-2" }, mockContext)
    expect(supersedeLearningMemory).toHaveBeenCalledWith(config, { id: "mem-1", replacement_id: "mem-2" })
    expect(callMemoryTool).not.toHaveBeenCalled()
  })
})

describe("memory_learning_update tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls updateLearningMemory with content and confidence", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    await tools.memory_learning_update.execute({ id: "mem-1", content: "new content", confidence: 0.9 }, mockContext)
    expect(updateLearningMemory).toHaveBeenCalledWith(config, { id: "mem-1", content: "new content", confidence: 0.9 })
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("parses metadata_json and passes as metadata", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    await tools.memory_learning_update.execute({ id: "mem-1", metadata_json: '{"tag":"v2"}' }, mockContext)
    expect(updateLearningMemory).toHaveBeenCalledWith(config, { id: "mem-1", metadata: { tag: "v2" } })
  })
})

describe("memory_learning_retrieve tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls getLearningMemory with id", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    await tools.memory_learning_retrieve.execute({ id: "mem-1" }, mockContext)
    expect(getLearningMemory).toHaveBeenCalledWith(config, { id: "mem-1" })
    expect(callMemoryTool).not.toHaveBeenCalled()
  })
})

describe("memory_learning_migrate_legacy tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("defaults dry_run to true", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    await tools.memory_learning_migrate_legacy.execute({}, mockContext)
    expect(migrateLegacyLearningMemories).toHaveBeenCalledWith(config, expect.objectContaining({ dry_run: true }))
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("passes dry_run=false when explicitly set", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    await tools.memory_learning_migrate_legacy.execute({ dry_run: false }, mockContext)
    expect(migrateLegacyLearningMemories).toHaveBeenCalledWith(config, expect.objectContaining({ dry_run: false }))
  })
})

describe("memory_learning_delete tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls deleteLearningMemory with id (deprecated shim)", async () => {
    const config = makeConfig()
    const tools = buildToolRegistry(config)
    await tools.memory_learning_delete.execute({ id: "mem-1" }, mockContext)
    expect(deleteLearningMemory).toHaveBeenCalledWith(config, { id: "mem-1" })
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("description mentions DEPRECATED", () => {
    const tools = buildToolRegistry(makeConfig())
    expect(tools.memory_learning_delete.description).toContain("DEPRECATED")
  })
})

describe("all learning memory tools exist in registry", () => {
  it("all 14 learning tools are present (10 memory_learning_* + 4 canonical learning_memory_*)", () => {
    const tools = buildToolRegistry(makeConfig())
    const learningTools = [
      "memory_learning_list",
      "memory_learning_retrieve",
      "memory_learning_confirm",
      "memory_learning_promote",
      "memory_learning_reject",
      "memory_learning_archive",
      "memory_learning_supersede",
      "memory_learning_update",
      "memory_learning_migrate_legacy",
      "memory_learning_delete",
      "learning_memory_reject",
      "learning_memory_archive",
      "learning_memory_supersede",
      "learning_memory_migrate_legacy",
    ]
    for (const name of learningTools) {
      expect(tools).toHaveProperty(name)
      expect(typeof tools[name].execute).toBe("function")
    }
  })
})
