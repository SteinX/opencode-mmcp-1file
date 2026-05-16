import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fetchCodeIntelContext, clearProjectInfoCache } from "../../src/services/context-inject.js"
import type { PluginConfig } from "../../src/config.js"

vi.mock("../../src/services/mcp-client.js", () => ({
  recallMemories: vi.fn(),
  listProjectMemories: vi.fn(),
  getProjectListInfo: vi.fn(),
  detectKnowledgeGraphCommunities: vi.fn(),
  getRelatedKnowledgeGraphEntities: vi.fn(),
}))

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { getProjectListInfo } = await import("../../src/services/mcp-client.js")
const mockGetProjectListInfo = vi.mocked(getProjectListInfo)

function makeConfig(ttlMs = 300_000): PluginConfig {
  return {
    chatMessage: {
      enabled: true,
      maxMemories: 5,
      maxProjectMemories: 30,
      maxInjectedMemories: 6,
      injectOn: "first",
      shortQueryMinLength: 3,
      minScore: 0.35,
      projectKnowledgeInjectOn: "first",
      codeIntelInjectOn: "first",
      knowledgeGraphInjectOn: "first",
      maxKnowledgeGraphItems: 10,
      knowledgeGraphEntityMatch: false,
      projectKnowledgeValidOnly: false,
      projectKnowledgeTiers: [],
    },
    autoCapture: { enabled: true, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    codeIndexSync: { enabled: true, autoRefresh: false, debounceMs: 10000, minReindexIntervalMs: 300000 },
    captureModel: { provider: "openai", model: "gpt-4o-mini", apiUrl: "", apiKey: "" },
    memoryScope: { namespace: "", shareAcrossAgents: true, includeAgentMetadata: true, includeRunMetadata: false, userId: "", defaultMetadata: {} },
    mcpServer: { command: ["npx", "-y", "memory-mcp-1file"], tag: "default", model: "qwen3", transport: "http", port: 23817, bind: "127.0.0.1", reconnectIntervalMs: 30000, heartbeatIntervalMs: 20000, mcpServerName: "memory-mcp-1file" },
    systemPrompt: { enabled: true },
    performance: { projectInfoCacheTtlMs: ttlMs },
  } as PluginConfig
}

const INDEXED_PROJECT = {
  action: "list",
  projects: [{ name: "my-project", status: "indexed", path: "/workspace" }],
}

beforeEach(() => {
  clearProjectInfoCache()
  vi.clearAllMocks()
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("fetchCodeIntelContext TTL cache", () => {
  it("first call fetches from MCP, second call returns cached data (MCP called once)", async () => {
    mockGetProjectListInfo.mockResolvedValue(INDEXED_PROJECT)
    const config = makeConfig(300_000)

    const result1 = await fetchCodeIntelContext(config)
    const result2 = await fetchCodeIntelContext(config)

    expect(mockGetProjectListInfo).toHaveBeenCalledTimes(1)
    expect(result1).not.toBeNull()
    expect(result2).toBe(result1)
  })

  it("cache expires after TTL — call after TTL fetches fresh data from MCP", async () => {
    vi.useFakeTimers()
    mockGetProjectListInfo.mockResolvedValue(INDEXED_PROJECT)
    const config = makeConfig(1000)

    await fetchCodeIntelContext(config)
    expect(mockGetProjectListInfo).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1001)

    await fetchCodeIntelContext(config)
    expect(mockGetProjectListInfo).toHaveBeenCalledTimes(2)
  })

  it("error responses are NOT cached — next call retries MCP", async () => {
    mockGetProjectListInfo.mockRejectedValueOnce(new Error("MCP unavailable"))
    mockGetProjectListInfo.mockResolvedValue(INDEXED_PROJECT)
    const config = makeConfig(300_000)

    const result1 = await fetchCodeIntelContext(config)
    expect(result1).toBeNull()
    expect(mockGetProjectListInfo).toHaveBeenCalledTimes(1)

    const result2 = await fetchCodeIntelContext(config)
    expect(result2).not.toBeNull()
    expect(mockGetProjectListInfo).toHaveBeenCalledTimes(2)
  })

  it("clearProjectInfoCache() resets cache immediately — next call fetches fresh", async () => {
    mockGetProjectListInfo.mockResolvedValue(INDEXED_PROJECT)
    const config = makeConfig(300_000)

    await fetchCodeIntelContext(config)
    expect(mockGetProjectListInfo).toHaveBeenCalledTimes(1)

    clearProjectInfoCache()

    await fetchCodeIntelContext(config)
    expect(mockGetProjectListInfo).toHaveBeenCalledTimes(2)
  })

  it("cache returns same data on hit (not stale after clear + re-fetch)", async () => {
    mockGetProjectListInfo.mockResolvedValue(INDEXED_PROJECT)
    const config = makeConfig(300_000)

    clearProjectInfoCache()
    const result1 = await fetchCodeIntelContext(config)
    const result2 = await fetchCodeIntelContext(config)

    expect(result1).not.toBeNull()
    expect(result2).toBe(result1)
    expect(mockGetProjectListInfo).toHaveBeenCalledTimes(1)
  })
})
