import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { PluginConfig } from "../../src/config.js"
import {
  detectCommunitiesEmptyResponse,
  detectCommunitiesPopulatedResponse,
  getRelatedNotFoundResponse,
  getRelatedPopulatedResponse,
  malformedKnowledgeGraphResponse,
} from "../fixtures/kg-responses.js"

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-04-22T00:00:00Z"))
})

afterEach(() => {
  vi.useRealTimers()
})

function makeConfig(transportOverride?: "stdio" | "http"): PluginConfig {
  return {
    chatMessage: { enabled: true, maxMemories: 5, maxProjectMemories: 30, maxInjectedMemories: 6, injectOn: "first", shortQueryMinLength: 3, minScore: 0.35 },
    autoCapture: { enabled: true, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    codeIndexSync: { enabled: true, debounceMs: 10000, minReindexIntervalMs: 300000 },
    preferenceLearning: { enabled: false, learnOnCorrections: true, learnOnNegations: true, learnOnMessageUpdated: true, injectOn: "first", scope: "project", minConfidence: 0.7, candidateConfidence: 0.4, maxPreferences: 5, maxCandidates: 3, debounceMs: 10000, maxInputChars: 4000, maxStoredPreferences: 50 },
    captureModel: { provider: "openai", model: "gpt-4o-mini", apiUrl: "", apiKey: "" },
    memoryScope: { namespace: "", shareAcrossAgents: true, includeAgentMetadata: true, includeRunMetadata: false, userId: "", defaultMetadata: {} },
    mcpServer: { command: ["npx", "-y", "memory-mcp-1file"], tag: "default", model: "qwen3", transport: transportOverride ?? "stdio", port: 23817, bind: "127.0.0.1", reconnectIntervalMs: 30000, heartbeatIntervalMs: 20000, mcpServerName: "memory-mcp-1file" },
    systemPrompt: { enabled: true },
  } as PluginConfig
}

let mockConnectionState: {
  isConnectionFailed: ReturnType<typeof vi.fn>
  markConnectionFailed: ReturnType<typeof vi.fn>
  markConnectionHealthy: ReturnType<typeof vi.fn>
}

function createMockClient() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
  }
}

async function setupModule() {
  vi.resetModules()

  const mockClient = createMockClient()
  let connectionFailed = false

  mockConnectionState = {
    isConnectionFailed: vi.fn(() => connectionFailed),
    markConnectionFailed: vi.fn(() => {
      connectionFailed = true
    }),
    markConnectionHealthy: vi.fn(() => {
      connectionFailed = false
    }),
  }

  vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
    Client: function () { return mockClient },
  }))
  vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
    StdioClientTransport: vi.fn(),
  }))
  vi.doMock("@modelcontextprotocol/sdk/client/sse.js", () => ({
    SSEClientTransport: vi.fn(),
  }))
  vi.doMock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
    StreamableHTTPClientTransport: vi.fn(),
  }))
  vi.doMock("../../src/services/server-process.js", () => ({
    getServerUrl: vi.fn(() => "http://127.0.0.1:23817"),
    isServerRunning: vi.fn(() => Promise.resolve(false)),
    ensureServerRunning: vi.fn(() => Promise.resolve("http://127.0.0.1:23817")),
    stopServer: vi.fn(() => Promise.resolve()),
  }))
  vi.doMock("../../src/utils/logger.js", () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }))
  vi.doMock("../../src/config.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../src/config.js")>()
    return { ...original, resolveDataDir: vi.fn(() => "/tmp/test-data") }
  })
  vi.doMock("../../src/services/connection-state.js", () => mockConnectionState)

  const mod = await import("../../src/services/mcp-client.js")
  return { mod, mockClient }
}

async function setupModuleWithClientFactory(clients: ReturnType<typeof createMockClient>[]) {
  vi.resetModules()

  let connectionFailed = false
  const mockHttpTransport = vi.fn(function (this: { url?: URL }, url: URL) {
    this.url = url
  })
  const mockStdioTransport = vi.fn(function (this: { options?: unknown }, options: unknown) {
    this.options = options
  })

  mockConnectionState = {
    isConnectionFailed: vi.fn(() => connectionFailed),
    markConnectionFailed: vi.fn(() => {
      connectionFailed = true
    }),
    markConnectionHealthy: vi.fn(() => {
      connectionFailed = false
    }),
  }

  const mockClientConstructor = vi.fn(function () {
      const client = clients.shift()
      if (!client) throw new Error("unexpected extra Client construction")
      return client
  })

  vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
    Client: mockClientConstructor,
  }))
  vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
    StdioClientTransport: mockStdioTransport,
  }))
  vi.doMock("@modelcontextprotocol/sdk/client/sse.js", () => ({
    SSEClientTransport: vi.fn(),
  }))
  vi.doMock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
    StreamableHTTPClientTransport: mockHttpTransport,
  }))
  vi.doMock("../../src/services/server-process.js", () => ({
    getServerUrl: vi.fn(() => "http://127.0.0.1:23817"),
    isServerRunning: vi.fn(() => Promise.resolve(false)),
    ensureServerRunning: vi.fn(() => Promise.resolve("http://127.0.0.1:23817")),
    stopServer: vi.fn(() => Promise.resolve()),
  }))
  vi.doMock("../../src/utils/logger.js", () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }))
  vi.doMock("../../src/config.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../src/config.js")>()
    return { ...original, resolveDataDir: vi.fn(() => "/tmp/test-data") }
  })
  vi.doMock("../../src/services/connection-state.js", () => mockConnectionState)

  const mod = await import("../../src/services/mcp-client.js")
  return { mod, mockHttpTransport, mockStdioTransport }
}

describe("mcp-client", () => {
  it("recall returns parsed memories from MCP response", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    const memories = [{ id: "1", content: "test memory", score: 0.9 }]
    mockClient.callTool.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(memories) }],
    })

    const result = await mod.recall(config, "test query", 5)
    expect(result).toEqual(memories)
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "recall",
      arguments: { query: "test query", limit: 5 },
    })
  })

  it("recall returns empty array on error", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockRejectedValue(new Error("connection failed"))

    const result = await mod.recall(config, "test", 5)
    expect(result).toEqual([])
  })

  it("storeMemory returns true on success", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockResolvedValue({ content: [] })

    const result = await mod.storeMemory(config, "test content", "semantic")
    expect(result).toBe(true)
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "store_memory",
      arguments: { content: "test content", memory_type: "semantic" },
    })
  })

  it("storeMemory omits memory_type when not provided", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockResolvedValue({ content: [] })

    await mod.storeMemory(config, "test content")
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "store_memory",
      arguments: { content: "test content" },
    })
  })

  it("storeMemory returns false on error", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockRejectedValue(new Error("store failed"))

    const result = await mod.storeMemory(config, "test")
    expect(result).toBe(false)
  })

  it("searchMemory passes mode parameter", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
    })

    await mod.searchMemory(config, "test", "vector", 10)
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "search_memory",
      arguments: { query: "test", mode: "vector", limit: 10 },
    })
  })

  it("listMemories returns parsed memories", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    const memories = [{ id: "1", content: "item" }]
    mockClient.callTool.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ memories }) }],
    })

    const result = await mod.listMemories(config, 10)
    expect(result).toEqual(memories)
  })

  it("listMemories returns empty array on error", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockRejectedValue(new Error("list failed"))

    const result = await mod.listMemories(config)
    expect(result).toEqual([])
  })

  it("discoverTools returns tool names", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.listTools.mockResolvedValue({
      tools: [{ name: "recall" }, { name: "store_memory" }],
    })

    const result = await mod.discoverTools(config)
    expect(result).toEqual(["recall", "store_memory"])
  })

  it("discoverTools returns empty array on error", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.listTools.mockRejectedValue(new Error("list failed"))

    const result = await mod.discoverTools(config)
    expect(result).toEqual([])
  })

  it("disconnectMemoryClient closes connection", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    await mod.getMemoryClient(config)
    await mod.disconnectMemoryClient()
    expect(mockClient.close).toHaveBeenCalled()
  })

  it("resetMemoryClientForServerControl closes connection and allows recreating the client without server lifecycle calls", async () => {
    vi.resetModules()
    const firstClient = createMockClient()
    const secondClient = createMockClient()
    const mockReleaseServerHolder = vi.fn().mockResolvedValue(undefined)
    const mockStopServer = vi.fn().mockResolvedValue(undefined)
    const mockHttpTransport = vi.fn(function (this: { url?: URL }, url: URL) {
      this.url = url
    })

    mockConnectionState = {
      isConnectionFailed: vi.fn().mockReturnValue(false),
      markConnectionFailed: vi.fn(),
      markConnectionHealthy: vi.fn(),
    }

    const mockClientConstructor = vi.fn(function () {
      if (mockClientConstructor.mock.calls.length === 1) return firstClient
      if (mockClientConstructor.mock.calls.length === 2) return secondClient
      throw new Error("unexpected extra Client construction")
    })

    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: mockClientConstructor,
    }))
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      StdioClientTransport: vi.fn(),
    }))
    vi.doMock("@modelcontextprotocol/sdk/client/sse.js", () => ({
      SSEClientTransport: vi.fn(),
    }))
    vi.doMock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
      StreamableHTTPClientTransport: mockHttpTransport,
    }))
    vi.doMock("../../src/services/server-process.js", () => ({
      getServerUrl: vi.fn(() => "http://127.0.0.1:23817"),
      isServerRunning: vi.fn(() => Promise.resolve(false)),
      ensureServerRunning: vi.fn(() => Promise.resolve("http://127.0.0.1:23817")),
      releaseServerHolder: mockReleaseServerHolder,
      stopServer: mockStopServer,
    }))
    vi.doMock("../../src/utils/logger.js", () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }))
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: vi.fn(() => "/tmp/test-data") }
    })
    vi.doMock("../../src/services/connection-state.js", () => mockConnectionState)

    const mod = await import("../../src/services/mcp-client.js")
    const config = makeConfig("http")

    await mod.getMemoryClient(config)
    await mod.resetMemoryClientForServerControl()
    await mod.getMemoryClient(config)

    expect(firstClient.close).toHaveBeenCalledTimes(1)
    expect(secondClient.close).not.toHaveBeenCalled()
    expect(mockHttpTransport).toHaveBeenCalledTimes(2)
    expect(mockReleaseServerHolder).not.toHaveBeenCalled()
    expect(mockStopServer).not.toHaveBeenCalled()
  })

  it("getMemoryClient reuses existing connection (singleton)", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    const client1 = await mod.getMemoryClient(config)
    const client2 = await mod.getMemoryClient(config)
    expect(client1).toBe(client2)
    expect(mockClient.connect).toHaveBeenCalledTimes(1)
  })

  it("parseMemories handles {results: [...]} format", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    const memories = [{ id: "1", content: "via results" }]
    mockClient.callTool.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ results: memories }) }],
    })

    const result = await mod.recall(config, "query")
    expect(result).toEqual(memories)
  })

  it("parseMemories handles nested response envelope", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    const memories = [{ id: "1", content: "nested envelope" }]
    mockClient.callTool.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ response: { results: memories } }) }],
    })

    const result = await mod.recall(config, "query")
    expect(result).toEqual(memories)
  })

  it("recall applies configured namespace and user scope", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()
    config.memoryScope.namespace = "workspace-a"
    config.memoryScope.userId = "user-1"

    mockClient.callTool.mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
    })

    await mod.recall(config, "test query", 5)
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "recall",
      arguments: { query: "test query", limit: 5, namespace: "workspace-a", user_id: "user-1" },
    })
  })

  it("storeMemory merges configured metadata and optional provenance", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()
    config.memoryScope.defaultMetadata = { source: "plugin" }
    config.memoryScope.includeAgentMetadata = true
    config.memoryScope.includeRunMetadata = true

    mockClient.callTool.mockResolvedValue({ content: [] })

    await mod.storeMemory(config, "test content", "semantic", {
      namespace: "workspace-a",
      agentId: "hephaestus",
      runId: "session-1",
      metadata: { capture_tags: ["eslint"] },
    })

    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "store_memory",
      arguments: {
        content: "test content",
        memory_type: "semantic",
        namespace: "workspace-a",
        run_id: "session-1",
        metadata: {
          source: "plugin",
          capture_tags: ["eslint"],
          source_agent_id: "hephaestus",
          source_run_id: "session-1",
        },
      },
    })
  })

  it("callMemoryTool normalizes scoped camelCase arguments for reads", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockResolvedValue({ content: [{ type: "text", text: "[]" }] })

    await mod.callMemoryTool(config, "search_memory", {
      query: "test",
      mode: "bm25",
      limit: 3,
      namespace: "workspace-a",
      userId: "user-1",
      agentId: "hephaestus",
      runId: "session-1",
      metadataFilter: { source_agent_id: "hephaestus" },
      eventAfter: "2026-04-01T00:00:00Z",
    })

    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "search_memory",
      arguments: {
        query: "test",
        mode: "bm25",
        limit: 3,
        namespace: "workspace-a",
        user_id: "user-1",
        run_id: "session-1",
        metadata_filter: { source_agent_id: "hephaestus" },
        event_after: "2026-04-01T00:00:00Z",
      },
    })
  })

  it("getProjectListInfo parses typed project list data and ignores additive fields", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          projects: [
            {
              id: "proj-1",
              status: "completed",
              chunks: 12,
              symbols: 5,
              unknown_future_field: { keep: true },
            },
          ],
          contract: { version: "1" },
          summary: { partial: { reason_code: "partial", reason: "legacy text", extra: true } },
          future_root: "ignored",
        }),
      }],
    })

    const result = await mod.getProjectListInfo(config)

    expect(result).toMatchObject({
      action: "list",
      projects: [{ id: "proj-1", status: "completed", chunks: 12, symbols: 5 }],
      summary: { partial: { reasonCode: "partial", reason: "legacy text" } },
    })
    expect(result?.projects[0]?.raw).toMatchObject({ unknown_future_field: { keep: true } })
    expect(result?.raw).toMatchObject({ future_root: "ignored" })
  })

  it("getProjectProjectionInfo parses locator created state and canonical reason_code", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          contract: { version: "1" },
          summary: { partial: { reason_code: "stale", reason: "projection_stale" } },
          locator: {
            locator: "loc-123",
            lookup: { state: "created", reason_code: "stale", reason: "projection_stale", extra: 1 },
            lifecycle: { persistence: "ephemeral", ttl_hint: 0 },
            extra_locator_field: true,
          },
          projection: { nodes: [] },
        }),
      }],
    })

    const result = await mod.getProjectProjectionInfo(config, {
      projectId: "proj-1",
      relationScope: "all",
      sortMode: "canonical",
    })

    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "project_info",
      arguments: {
        action: "projection",
        project_id: "proj-1",
        relation_scope: "all",
        sort_mode: "canonical",
      },
    })
    expect(result).toMatchObject({
      action: "projection",
      summary: { partial: { reasonCode: "stale", reason: "projection_stale" } },
      locator: {
        token: "loc-123",
        lookup: { state: "created", reasonCode: "stale", reason: "projection_stale" },
      },
    })
    expect(result?.locator?.raw).toMatchObject({ extra_locator_field: true })
  })

  it("getProjectProjectionByLocatorInfo parses resolved locator state", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          locator: {
            token: "loc-123",
            lookup: { state: "resolved" },
          },
        }),
      }],
    })

    const result = await mod.getProjectProjectionByLocatorInfo(config, { locator: "loc-123" })

    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "project_info",
      arguments: { action: "projection_by_locator", locator: "loc-123" },
    })
    expect(result?.locator?.lookup.state).toBe("resolved")
  })

  it("isMissingProjectLocator treats missing and invalid_locator as fallback states", async () => {
    const { mod } = await setupModule()

    expect(mod.isMissingProjectLocator({ lookup: { state: "missing", raw: {} }, raw: {} })).toBe(true)
    expect(mod.isMissingProjectLocator({ lookup: { state: "resolved", reasonCode: "invalid_locator", raw: {} }, raw: {} })).toBe(true)
    expect(mod.isMissingProjectLocator({ lookup: { state: "resolved", reasonCode: "stale", raw: {} }, raw: {} })).toBe(false)
  })

  it("detectKnowledgeGraphCommunities parses populated KG response without memory scope", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()
    config.memoryScope.namespace = "workspace-a"
    config.memoryScope.userId = "user-1"

    mockClient.callTool.mockResolvedValue(detectCommunitiesPopulatedResponse)

    const result = await mod.detectKnowledgeGraphCommunities(config)

    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "knowledge_graph",
      arguments: { action: "detect_communities" },
    })
    expect(result).toEqual([
      {
        id: "community-auth",
        label: "Auth + Session",
        size: 3,
        entities: [
          { id: "svc-auth", name: "Auth Service", entity_type: "service" },
          { id: "svc-session", name: "Session Service", entity_type: "service" },
          { id: "mod-login", name: "Login Flow", entity_type: "module" },
        ],
        relations: [
          { from: "svc-auth", to: "svc-session", relation_type: "depends_on", weight: 0.9 },
          { from: "mod-login", to: "svc-auth", relation_type: "uses", weight: 0.8 },
        ],
      },
    ])
  })

  it("detectKnowledgeGraphCommunities returns empty array on empty, malformed, error, and connection failure", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockResolvedValueOnce(detectCommunitiesEmptyResponse)
    await expect(mod.detectKnowledgeGraphCommunities(config)).resolves.toEqual([])

    mockClient.callTool.mockResolvedValueOnce(malformedKnowledgeGraphResponse)
    await expect(mod.detectKnowledgeGraphCommunities(config)).resolves.toEqual([])

    mockClient.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({ error: "kg_failed" }) }] })
    await expect(mod.detectKnowledgeGraphCommunities(config)).resolves.toEqual([])

    mockConnectionState.isConnectionFailed.mockReturnValue(true)
    await expect(mod.detectKnowledgeGraphCommunities(config)).resolves.toEqual([])
  })

  it("getRelatedKnowledgeGraphEntities parses populated KG response with default args and no memory scope", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()
    config.memoryScope.namespace = "workspace-a"

    mockClient.callTool.mockResolvedValue(getRelatedPopulatedResponse)

    const result = await mod.getRelatedKnowledgeGraphEntities(config, "svc-auth")

    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "knowledge_graph",
      arguments: { action: "get_related", entity_id: "svc-auth", depth: 1, direction: "both" },
    })
    expect(result).toEqual({
      entity: { id: "svc-auth", name: "Auth Service", entity_type: "service" },
      distance: 0,
      related: [
        {
          entity: { id: "svc-session", name: "Session Service", entity_type: "service" },
          relation: { from: "svc-auth", to: "svc-session", relation_type: "depends_on", weight: 0.9 },
        },
        {
          entity: { id: "mod-login", name: "Login Flow", entity_type: "module" },
          relation: { from: "mod-login", to: "svc-auth", relation_type: "uses", weight: 0.8 },
        },
      ],
    })
  })

  it("getRelatedKnowledgeGraphEntities passes explicit depth and direction", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockResolvedValue(getRelatedPopulatedResponse)

    await mod.getRelatedKnowledgeGraphEntities(config, "svc-auth", 2, "out")

    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "knowledge_graph",
      arguments: { action: "get_related", entity_id: "svc-auth", depth: 2, direction: "out" },
    })
  })

  it("getRelatedKnowledgeGraphEntities returns null on not-found, malformed, error, and connection failure", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockResolvedValueOnce(getRelatedNotFoundResponse)
    await expect(mod.getRelatedKnowledgeGraphEntities(config, "missing-entity")).resolves.toBeNull()

    mockClient.callTool.mockResolvedValueOnce(malformedKnowledgeGraphResponse)
    await expect(mod.getRelatedKnowledgeGraphEntities(config, "svc-auth")).resolves.toBeNull()

    mockClient.callTool.mockRejectedValueOnce(new Error("kg failed"))
    await expect(mod.getRelatedKnowledgeGraphEntities(config, "svc-auth")).resolves.toBeNull()

    mockConnectionState.isConnectionFailed.mockReturnValue(true)
    await expect(mod.getRelatedKnowledgeGraphEntities(config, "svc-auth")).resolves.toBeNull()
  })

  it("getMemoryClient throws immediately when connection is flagged as failed", async () => {
    const { mod } = await setupModule()
    const config = makeConfig()

    mockConnectionState.isConnectionFailed.mockReturnValue(true)

    await expect(mod.getMemoryClient(config)).rejects.toThrow("Memory server unavailable")
  })

  it("getMemoryClient calls markConnectionFailed on connection error", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.connect.mockRejectedValue(new Error("ENOENT"))

    await expect(mod.getMemoryClient(config)).rejects.toThrow("ENOENT")
    expect(mockConnectionState.markConnectionFailed).toHaveBeenCalled()
  })

  it("getMemoryClient calls markConnectionHealthy on success", async () => {
    const { mod } = await setupModule()
    const config = makeConfig()

    await mod.getMemoryClient(config)
    expect(mockConnectionState.markConnectionHealthy).toHaveBeenCalled()
  })

  it("retries once on recoverable runtime connection error and succeeds", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool
      .mockRejectedValueOnce(new Error("ECONNREFUSED: server unavailable"))
      .mockResolvedValueOnce({ content: [] })

    const result = await mod.storeMemory(config, "test content", "semantic")

    expect(result).toBe(true)
    expect(mockClient.close).toHaveBeenCalledTimes(1)
    expect(mockClient.connect).toHaveBeenCalledTimes(2)
    expect(mockConnectionState.markConnectionHealthy).toHaveBeenCalledTimes(2)
    expect(mockConnectionState.markConnectionFailed).not.toHaveBeenCalled()
  })

  it("marks connection failed and notifies handler when recoverable retry also fails", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()
    const handler = vi.fn()

    mod.registerConnectionFailureHandler(handler)

    mockClient.callTool
      .mockRejectedValueOnce(new Error("transport closed"))
      .mockRejectedValueOnce(new Error("transport closed"))

    const result = await mod.storeMemory(config, "test content", "semantic")

    expect(result).toBe(false)
    expect(mockClient.close).toHaveBeenCalledTimes(2)
    expect(mockClient.connect).toHaveBeenCalledTimes(2)
    expect(mockConnectionState.markConnectionFailed).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("does not retry on non-recoverable runtime tool errors", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockRejectedValue(new Error("validation failed"))

    const result = await mod.storeMemory(config, "test content", "semantic")

    expect(result).toBe(false)
    expect(mockClient.close).not.toHaveBeenCalled()
    expect(mockClient.connect).toHaveBeenCalledTimes(1)
    expect(mockConnectionState.markConnectionFailed).not.toHaveBeenCalled()
  })
})

describe("tryReconnect", () => {
  it("returns true on successful reconnection", async () => {
    const { mod } = await setupModule()
    const config = makeConfig()

    const result = await mod.tryReconnect(config)
    expect(result).toBe(true)
  })

  it("returns false when connection fails", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.connect.mockRejectedValue(new Error("spawn failed"))

    const result = await mod.tryReconnect(config)
    expect(result).toBe(false)
  })

  it("resets internal client state before attempting reconnection", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    await mod.getMemoryClient(config)
    expect(mockClient.connect).toHaveBeenCalledTimes(1)

    await mod.tryReconnect(config)
    expect(mockClient.connect).toHaveBeenCalledTimes(2)
  })
})

describe("commandPath override", () => {
  it("uses commandPath with --stdio flag for stdio transport", async () => {
    vi.resetModules()
    const mockClient = createMockClient()
    const mockStdioTransport = vi.fn()

    mockConnectionState = {
      isConnectionFailed: vi.fn().mockReturnValue(false),
      markConnectionFailed: vi.fn(),
      markConnectionHealthy: vi.fn(),
    }

    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: function () { return mockClient },
    }))
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      StdioClientTransport: mockStdioTransport,
    }))
    vi.doMock("@modelcontextprotocol/sdk/client/sse.js", () => ({
      SSEClientTransport: vi.fn(),
    }))
    vi.doMock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
      StreamableHTTPClientTransport: vi.fn(),
    }))
    vi.doMock("../../src/services/server-process.js", () => ({
      getServerUrl: vi.fn(() => "http://127.0.0.1:23817"),
      isServerRunning: vi.fn(() => Promise.resolve(false)),
      ensureServerRunning: vi.fn(() => Promise.resolve("http://127.0.0.1:23817")),
      releaseServerHolder: vi.fn(() => Promise.resolve()),
      stopServer: vi.fn(() => Promise.resolve()),
    }))
    vi.doMock("../../src/utils/logger.js", () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }))
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: vi.fn(() => "/tmp/test-data") }
    })
    vi.doMock("../../src/services/connection-state.js", () => mockConnectionState)

    const mod = await import("../../src/services/mcp-client.js")
    const config = makeConfig("stdio")
    ;(config.mcpServer as any).commandPath = "/usr/local/bin/memory-mcp-1file"

    await mod.getMemoryClient(config)

    expect(mockStdioTransport).toHaveBeenCalledWith({
      command: "/usr/local/bin/memory-mcp-1file",
      args: ["--stdio", "--data-dir", "/tmp/test-data", "--log-file", "/tmp/test-data/log/mcp-server.log", "--model", "qwen3"],
      stderr: "pipe",
    })
  })
})

describe("HTTP transport", () => {
  it("connects via StreamableHTTPClientTransport when transport is http", async () => {
    const { mod } = await setupModule()
    const config = makeConfig("http")

    const client = await mod.getMemoryClient(config)
    expect(client).toBeDefined()
  })

  it("does not stop the HTTP server on disconnect", async () => {
    vi.resetModules()
    const mockClient = createMockClient()
    const mockStopServer = vi.fn().mockResolvedValue(undefined)
    const mockReleaseServerHolder = vi.fn().mockResolvedValue(undefined)

    mockConnectionState = {
      isConnectionFailed: vi.fn().mockReturnValue(false),
      markConnectionFailed: vi.fn(),
      markConnectionHealthy: vi.fn(),
    }

    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: function () { return mockClient },
    }))
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      StdioClientTransport: vi.fn(),
    }))
    vi.doMock("@modelcontextprotocol/sdk/client/sse.js", () => ({
      SSEClientTransport: vi.fn(),
    }))
    vi.doMock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
      StreamableHTTPClientTransport: vi.fn(),
    }))
    vi.doMock("../../src/services/server-process.js", () => ({
      getServerUrl: vi.fn(() => "http://127.0.0.1:23817"),
      isServerRunning: vi.fn(() => Promise.resolve(false)),
      ensureServerRunning: vi.fn(() => Promise.resolve("http://127.0.0.1:23817")),
      releaseServerHolder: mockReleaseServerHolder,
      stopServer: mockStopServer,
    }))
    vi.doMock("../../src/utils/logger.js", () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }))
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: vi.fn(() => "/tmp/test-data") }
    })
    vi.doMock("../../src/services/connection-state.js", () => mockConnectionState)

    const mod = await import("../../src/services/mcp-client.js")
    const config = makeConfig("http")

    await mod.getMemoryClient(config)
    await mod.disconnectMemoryClient(config)

    expect(mockClient.close).toHaveBeenCalled()
    expect(mockReleaseServerHolder).toHaveBeenCalledTimes(1)
    expect(mockReleaseServerHolder).toHaveBeenCalledWith(config)
    expect(mockStopServer).not.toHaveBeenCalled()
  })

  it("does not call stopServer on disconnect when transport is stdio", async () => {
    vi.resetModules()
    const mockClient = createMockClient()
    const mockStopServer = vi.fn().mockResolvedValue(undefined)
    const mockReleaseServerHolder = vi.fn().mockResolvedValue(undefined)

    mockConnectionState = {
      isConnectionFailed: vi.fn().mockReturnValue(false),
      markConnectionFailed: vi.fn(),
      markConnectionHealthy: vi.fn(),
    }

    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: function () { return mockClient },
    }))
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      StdioClientTransport: vi.fn(),
    }))
    vi.doMock("@modelcontextprotocol/sdk/client/sse.js", () => ({
      SSEClientTransport: vi.fn(),
    }))
    vi.doMock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
      StreamableHTTPClientTransport: vi.fn(),
    }))
    vi.doMock("../../src/services/server-process.js", () => ({
      getServerUrl: vi.fn(() => "http://127.0.0.1:23817"),
      isServerRunning: vi.fn(() => Promise.resolve(false)),
      ensureServerRunning: vi.fn(() => Promise.resolve("http://127.0.0.1:23817")),
      releaseServerHolder: mockReleaseServerHolder,
      stopServer: mockStopServer,
    }))
    vi.doMock("../../src/utils/logger.js", () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }))
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: vi.fn(() => "/tmp/test-data") }
    })
    vi.doMock("../../src/services/connection-state.js", () => mockConnectionState)

    const mod = await import("../../src/services/mcp-client.js")
    const config = makeConfig("stdio")

    await mod.getMemoryClient(config)
    await mod.disconnectMemoryClient(config)

    expect(mockClient.close).toHaveBeenCalled()
    expect(mockReleaseServerHolder).not.toHaveBeenCalled()
    expect(mockStopServer).not.toHaveBeenCalled()
  })

  it("reconnects with a new HTTP client and retries once for recoverable HTTP stale session errors", async () => {
    const staleClient = createMockClient()
    const retryClient = createMockClient()
    const { mod, mockHttpTransport, mockStdioTransport } = await setupModuleWithClientFactory([staleClient, retryClient])
    const config = makeConfig("http")

    staleClient.callTool
      .mockRejectedValueOnce(new Error("Unauthorized: Session not found"))
    retryClient.callTool.mockResolvedValueOnce({ content: [] })

    const result = await mod.storeMemory(config, "test content", "semantic")

    expect(result).toBe(true)
    expect(staleClient.close).toHaveBeenCalledTimes(1)
    expect(staleClient.connect).toHaveBeenCalledTimes(1)
    expect(retryClient.connect).toHaveBeenCalledTimes(1)
    expect(mockHttpTransport).toHaveBeenCalledTimes(2)
    expect(mockStdioTransport).not.toHaveBeenCalled()
    expect(staleClient.callTool).toHaveBeenCalledTimes(1)
    expect(retryClient.callTool).toHaveBeenCalledTimes(1)
    expect(staleClient.callTool).toHaveBeenCalledWith({
      name: "store_memory",
      arguments: { content: "test content", memory_type: "semantic" },
    })
    expect(retryClient.callTool).toHaveBeenCalledWith({
      name: "store_memory",
      arguments: { content: "test content", memory_type: "semantic" },
    })
  })

  it("detects wrapped HTTP stale session error text and reconnects with a new transport", async () => {
    const staleClient = createMockClient()
    const retryClient = createMockClient()
    const { mod, mockHttpTransport } = await setupModuleWithClientFactory([staleClient, retryClient])
    const config = makeConfig("http")

    staleClient.callTool.mockRejectedValueOnce(new Error("MCP error: {\"error\":\"mcp-session-id header rejected\"}"))
    retryClient.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] })

    const result = await mod.callMemoryTool(config, "project_info", { action: "list" })

    expect(result).toBe("ok")
    expect(staleClient.close).toHaveBeenCalledTimes(1)
    expect(staleClient.connect).toHaveBeenCalledTimes(1)
    expect(retryClient.connect).toHaveBeenCalledTimes(1)
    expect(mockHttpTransport).toHaveBeenCalledTimes(2)
    expect(staleClient.callTool).toHaveBeenCalledTimes(1)
    expect(retryClient.callTool).toHaveBeenCalledTimes(1)
  })

  it("detects nested HTTP stale session error fields and reconnects", async () => {
    const staleClient = createMockClient()
    const retryClient = createMockClient()
    const { mod, mockHttpTransport } = await setupModuleWithClientFactory([staleClient, retryClient])
    const config = makeConfig("http")

    staleClient.callTool.mockRejectedValueOnce({
      response: {
        data: {
          error: {
            message: "Session not found",
          },
        },
      },
    })
    retryClient.callTool.mockResolvedValueOnce({ content: [] })

    const result = await mod.storeMemory(config, "test content", "semantic")

    expect(result).toBe(true)
    expect(staleClient.close).toHaveBeenCalledTimes(1)
    expect(staleClient.connect).toHaveBeenCalledTimes(1)
    expect(retryClient.connect).toHaveBeenCalledTimes(1)
    expect(mockHttpTransport).toHaveBeenCalledTimes(2)
    expect(staleClient.callTool).toHaveBeenCalledTimes(1)
    expect(retryClient.callTool).toHaveBeenCalledTimes(1)
  })

  it("does not loop when the HTTP stale session retry also fails", async () => {
    const staleClient = createMockClient()
    const retryClient = createMockClient()
    const { mod, mockHttpTransport } = await setupModuleWithClientFactory([staleClient, retryClient])
    const config = makeConfig("http")
    const handler = vi.fn()

    mod.registerConnectionFailureHandler(handler)
    staleClient.callTool.mockRejectedValueOnce(new Error("Session not found"))
    retryClient.callTool.mockRejectedValueOnce(new Error("Unauthorized: Session not found"))

    const result = await mod.storeMemory(config, "test content", "semantic")

    expect(result).toBe(false)
    expect(staleClient.close).toHaveBeenCalledTimes(1)
    expect(retryClient.close).toHaveBeenCalledTimes(1)
    expect(staleClient.connect).toHaveBeenCalledTimes(1)
    expect(retryClient.connect).toHaveBeenCalledTimes(1)
    expect(mockHttpTransport).toHaveBeenCalledTimes(2)
    expect(staleClient.callTool).toHaveBeenCalledTimes(1)
    expect(retryClient.callTool).toHaveBeenCalledTimes(1)
    expect(mockConnectionState.markConnectionFailed).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("does not retry non-session HTTP errors", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig("http")

    mockClient.callTool.mockRejectedValue(new Error("503 service unavailable"))

    const result = await mod.storeMemory(config, "test content", "semantic")

    expect(result).toBe(false)
    expect(mockClient.connect).toHaveBeenCalledTimes(1)
    expect(mockClient.callTool).toHaveBeenCalledTimes(1)
  })

  it("does not retry stale session looking errors in stdio mode", async () => {
    const stdioClient = createMockClient()
    const unexpectedRetryClient = createMockClient()
    const { mod, mockHttpTransport, mockStdioTransport } = await setupModuleWithClientFactory([stdioClient, unexpectedRetryClient])
    const config = makeConfig("stdio")

    stdioClient.callTool.mockRejectedValue(new Error("Unauthorized: Session not found"))

    const result = await mod.storeMemory(config, "test content", "semantic")

    expect(result).toBe(false)
    expect(stdioClient.connect).toHaveBeenCalledTimes(1)
    expect(stdioClient.close).not.toHaveBeenCalled()
    expect(stdioClient.callTool).toHaveBeenCalledTimes(1)
    expect(unexpectedRetryClient.connect).not.toHaveBeenCalled()
    expect(mockStdioTransport).toHaveBeenCalledTimes(1)
    expect(mockHttpTransport).not.toHaveBeenCalled()
  })

  it("discoverTools reconnects with a new HTTP client and retries once for stale session errors", async () => {
    const staleClient = createMockClient()
    const retryClient = createMockClient()
    const { mod, mockHttpTransport, mockStdioTransport } = await setupModuleWithClientFactory([staleClient, retryClient])
    const config = makeConfig("http")

    staleClient.listTools.mockRejectedValueOnce(new Error("Unauthorized: Session not found"))
    retryClient.listTools.mockResolvedValueOnce({ tools: [{ name: "recall" }, { name: "store_memory" }] })

    const result = await mod.discoverTools(config)

    expect(result).toEqual(["recall", "store_memory"])
    expect(staleClient.close).toHaveBeenCalledTimes(1)
    expect(staleClient.connect).toHaveBeenCalledTimes(1)
    expect(retryClient.connect).toHaveBeenCalledTimes(1)
    expect(mockHttpTransport).toHaveBeenCalledTimes(2)
    expect(mockStdioTransport).not.toHaveBeenCalled()
    expect(staleClient.listTools).toHaveBeenCalledTimes(1)
    expect(retryClient.listTools).toHaveBeenCalledTimes(1)
  })

  it("discoverTools returns empty array and does not loop when stale session retry also fails", async () => {
    const staleClient = createMockClient()
    const retryClient = createMockClient()
    const { mod, mockHttpTransport } = await setupModuleWithClientFactory([staleClient, retryClient])
    const config = makeConfig("http")
    const handler = vi.fn()

    mod.registerConnectionFailureHandler(handler)
    staleClient.listTools.mockRejectedValueOnce(new Error("Session not found"))
    retryClient.listTools.mockRejectedValueOnce(new Error("Unauthorized: Session not found"))

    const result = await mod.discoverTools(config)

    expect(result).toEqual([])
    expect(staleClient.close).toHaveBeenCalledTimes(1)
    expect(retryClient.close).toHaveBeenCalledTimes(1)
    expect(staleClient.connect).toHaveBeenCalledTimes(1)
    expect(retryClient.connect).toHaveBeenCalledTimes(1)
    expect(mockHttpTransport).toHaveBeenCalledTimes(2)
    expect(staleClient.listTools).toHaveBeenCalledTimes(1)
    expect(retryClient.listTools).toHaveBeenCalledTimes(1)
    expect(mockConnectionState.markConnectionFailed).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("discoverTools does not retry non-session HTTP errors", async () => {
    const staleClient = createMockClient()
    const unexpectedRetryClient = createMockClient()
    const { mod, mockHttpTransport } = await setupModuleWithClientFactory([staleClient, unexpectedRetryClient])
    const config = makeConfig("http")

    staleClient.listTools.mockRejectedValueOnce(new Error("503 service unavailable"))

    const result = await mod.discoverTools(config)

    expect(result).toEqual([])
    expect(staleClient.connect).toHaveBeenCalledTimes(1)
    expect(staleClient.close).not.toHaveBeenCalled()
    expect(staleClient.listTools).toHaveBeenCalledTimes(1)
    expect(unexpectedRetryClient.connect).not.toHaveBeenCalled()
    expect(mockHttpTransport).toHaveBeenCalledTimes(1)
  })

  it("discoverTools does not retry generic HTTP transport errors", async () => {
    const staleClient = createMockClient()
    const unexpectedRetryClient = createMockClient()
    const { mod, mockHttpTransport } = await setupModuleWithClientFactory([staleClient, unexpectedRetryClient])
    const config = makeConfig("http")

    staleClient.listTools.mockRejectedValueOnce(new Error("transport closed"))

    const result = await mod.discoverTools(config)

    expect(result).toEqual([])
    expect(staleClient.connect).toHaveBeenCalledTimes(1)
    expect(staleClient.close).not.toHaveBeenCalled()
    expect(staleClient.listTools).toHaveBeenCalledTimes(1)
    expect(unexpectedRetryClient.connect).not.toHaveBeenCalled()
    expect(mockHttpTransport).toHaveBeenCalledTimes(1)
  })

  it("discoverTools does not retry stale session looking errors in stdio mode", async () => {
    const stdioClient = createMockClient()
    const unexpectedRetryClient = createMockClient()
    const { mod, mockHttpTransport, mockStdioTransport } = await setupModuleWithClientFactory([stdioClient, unexpectedRetryClient])
    const config = makeConfig("stdio")

    stdioClient.listTools.mockRejectedValueOnce(new Error("Unauthorized: Session not found"))

    const result = await mod.discoverTools(config)

    expect(result).toEqual([])
    expect(stdioClient.connect).toHaveBeenCalledTimes(1)
    expect(stdioClient.close).not.toHaveBeenCalled()
    expect(stdioClient.listTools).toHaveBeenCalledTimes(1)
    expect(unexpectedRetryClient.connect).not.toHaveBeenCalled()
    expect(mockStdioTransport).toHaveBeenCalledTimes(1)
    expect(mockHttpTransport).not.toHaveBeenCalled()
  })

  it("retries generic tool calls once for recoverable HTTP session errors", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig("http")

    mockClient.callTool
      .mockRejectedValueOnce(new Error("Unauthorized: Session not found"))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] })

    const result = await mod.callMemoryTool(config, "project_info", { action: "list" })

    expect(result).toBe("ok")
    expect(mockClient.connect).toHaveBeenCalledTimes(2)
    expect(mockClient.callTool).toHaveBeenCalledTimes(2)
    expect(mockClient.callTool).toHaveBeenNthCalledWith(1, {
      name: "project_info",
      arguments: { action: "list" },
    })
    expect(mockClient.callTool).toHaveBeenNthCalledWith(2, {
      name: "project_info",
      arguments: { action: "list" },
    })
  })

  it("invalidates cached HTTP client when health check fails", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig("http")
    const handler = vi.fn()

    mod.registerConnectionFailureHandler(handler)
    await mod.getMemoryClient(config)

    const serverProcess = await import("../../src/services/server-process.js")
    vi.mocked(serverProcess.isServerRunning).mockResolvedValueOnce(false)

    await expect(mod.getMemoryClient(config)).rejects.toThrow("Memory server unavailable")

    expect(serverProcess.isServerRunning).toHaveBeenCalledWith(config)
    expect(mockClient.close).toHaveBeenCalledTimes(1)
    expect(mockConnectionState.markConnectionFailed).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("starts a single HTTP heartbeat while connected and stops it on disconnect", async () => {
    const { mod } = await setupModule()
    const config = makeConfig("http")
    config.mcpServer.heartbeatIntervalMs = 10_000

    const serverProcess = await import("../../src/services/server-process.js")
    vi.mocked(serverProcess.isServerRunning).mockResolvedValue(true)

    await mod.getMemoryClient(config)
    expect(serverProcess.isServerRunning).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(serverProcess.isServerRunning).toHaveBeenCalledTimes(1)

    await mod.getMemoryClient(config)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(serverProcess.isServerRunning).toHaveBeenCalledTimes(2)

    await mod.disconnectMemoryClient(config)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(serverProcess.isServerRunning).toHaveBeenCalledTimes(2)
  })

  it("heartbeat fails active HTTP connection through the existing failure path", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig("http")
    config.mcpServer.heartbeatIntervalMs = 10_000
    const handler = vi.fn()

    const serverProcess = await import("../../src/services/server-process.js")
    vi.mocked(serverProcess.isServerRunning).mockResolvedValue(false)

    mod.registerConnectionFailureHandler(handler)
    await mod.getMemoryClient(config)

    await vi.advanceTimersByTimeAsync(10_000)

    expect(mockClient.close).toHaveBeenCalledTimes(1)
    expect(mockConnectionState.markConnectionFailed).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("throttles cached HTTP client health checks within the throttle window", async () => {
    const { mod } = await setupModule()
    const config = makeConfig("http")

    const serverProcess = await import("../../src/services/server-process.js")
    vi.mocked(serverProcess.isServerRunning).mockResolvedValue(true)

    await mod.getMemoryClient(config)
    vi.advanceTimersByTime(5_001)
    await mod.getMemoryClient(config)
    await mod.getMemoryClient(config)

    expect(serverProcess.isServerRunning).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5_001)
    await mod.getMemoryClient(config)

    expect(serverProcess.isServerRunning).toHaveBeenCalledTimes(2)
  })

  it("recovers from heartbeat-failed state and allows bounded stale-session retry for storeMemory", async () => {
    const heartbeatClient = createMockClient()
    const postReconnectClient = createMockClient()
    const retryClient = createMockClient()
    const { mod, mockHttpTransport } = await setupModuleWithClientFactory([
      heartbeatClient,
      postReconnectClient,
      retryClient,
    ])
    const config = makeConfig("http")
    config.mcpServer.heartbeatIntervalMs = 10_000
    const handler = vi.fn()

    const serverProcess = await import("../../src/services/server-process.js")
    vi.mocked(serverProcess.isServerRunning).mockResolvedValue(false)

    mod.registerConnectionFailureHandler(handler)
    await mod.getMemoryClient(config)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockConnectionState.markConnectionFailed).toHaveBeenCalledTimes(1)

    postReconnectClient.callTool.mockRejectedValueOnce(new Error("Unauthorized: Session not found"))
    retryClient.callTool.mockResolvedValueOnce({ content: [] })

    await expect(mod.tryReconnect(config)).resolves.toBe(true)
    await expect(mod.storeMemory(config, "test content", "semantic")).resolves.toBe(true)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(heartbeatClient.close).toHaveBeenCalledTimes(1)
    expect(postReconnectClient.close).toHaveBeenCalledTimes(1)
    expect(retryClient.close).not.toHaveBeenCalled()
    expect(postReconnectClient.callTool).toHaveBeenCalledTimes(1)
    expect(retryClient.callTool).toHaveBeenCalledTimes(1)
    expect(mockHttpTransport).toHaveBeenCalledTimes(3)
    expect(mockConnectionState.markConnectionFailed).toHaveBeenCalledTimes(1)
    expect(mockConnectionState.markConnectionHealthy).toHaveBeenCalledTimes(3)
  })

  it("recoverable callMemoryTool stale-session retry remains bounded to one reconnect", async () => {
    const staleClient = createMockClient()
    const retryClient = createMockClient()
    const { mod, mockHttpTransport } = await setupModuleWithClientFactory([staleClient, retryClient])
    const config = makeConfig("http")

    staleClient.callTool.mockRejectedValueOnce(new Error("Session not found"))
    retryClient.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] })

    await expect(mod.callMemoryTool(config, "project_info", { action: "list" })).resolves.toBe("ok")

    expect(staleClient.callTool).toHaveBeenCalledTimes(1)
    expect(retryClient.callTool).toHaveBeenCalledTimes(1)
    expect(staleClient.close).toHaveBeenCalledTimes(1)
    expect(retryClient.close).not.toHaveBeenCalled()
    expect(mockHttpTransport).toHaveBeenCalledTimes(2)
  })

  it("recoverable discoverTools stale-session retry remains bounded to one reconnect", async () => {
    const staleClient = createMockClient()
    const retryClient = createMockClient()
    const { mod, mockHttpTransport } = await setupModuleWithClientFactory([staleClient, retryClient])
    const config = makeConfig("http")

    staleClient.listTools.mockRejectedValueOnce(new Error("Unauthorized: Session not found"))
    retryClient.listTools.mockResolvedValueOnce({ tools: [{ name: "recall" }] })

    await expect(mod.discoverTools(config)).resolves.toEqual(["recall"])

    expect(staleClient.listTools).toHaveBeenCalledTimes(1)
    expect(retryClient.listTools).toHaveBeenCalledTimes(1)
    expect(staleClient.close).toHaveBeenCalledTimes(1)
    expect(retryClient.close).not.toHaveBeenCalled()
    expect(mockHttpTransport).toHaveBeenCalledTimes(2)
  })
})
