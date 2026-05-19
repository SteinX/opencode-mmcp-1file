import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../src/services/mcp-client.js", () => ({
  recallMemories: vi.fn().mockResolvedValue({ status: "empty", source: "recall", memories: [] }),
  searchMemoryResult: vi.fn().mockResolvedValue({ status: "empty", source: "search", memories: [] }),
}))

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock("../../src/services/memory-orchestration.js", () => ({
  buildBootstrapContext: vi.fn().mockResolvedValue(null),
}))

const { recallMemories, searchMemoryResult } = await import("../../src/services/mcp-client.js")
const { buildBootstrapContext } = await import("../../src/services/memory-orchestration.js")
import { buildCompactionRecoveryContext } from "../../src/services/compaction.js"
import type { PluginConfig } from "../../src/config.js"

function makeConfig(overrides?: Partial<Pick<PluginConfig, "compaction">>): PluginConfig {
  return {
    chatMessage: { enabled: true, maxMemories: 5, maxProjectMemories: 30, maxInjectedMemories: 6, injectOn: "first", shortQueryMinLength: 3, minScore: 0.35 },
    autoCapture: { enabled: true, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10, ...overrides?.compaction },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    codeIndexSync: { enabled: true, autoRefresh: false, debounceMs: 10000, minReindexIntervalMs: 300000 },
    captureModel: { provider: "openai", model: "gpt-4o-mini", apiUrl: "", apiKey: "" },
    memoryScope: { namespace: "", shareAcrossAgents: true, includeAgentMetadata: true, includeRunMetadata: false, userId: "", defaultMetadata: {} },
    mcpServer: { command: ["npx", "-y", "@steinx/memory-mcp-1file"], tag: "default", model: "qwen3", transport: "http", port: 23817, bind: "127.0.0.1", reconnectIntervalMs: 30000, heartbeatIntervalMs: 20000, mcpServerName: "memory-mcp-1file" },
    systemPrompt: { enabled: true },
  } as PluginConfig
}

describe("buildCompactionRecoveryContext", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(buildBootstrapContext).mockResolvedValue(null)
  })

  it("returns null when compaction is disabled", async () => {
    const config = makeConfig({ compaction: { enabled: false, memoryLimit: 10 } })
    const result = await buildCompactionRecoveryContext(config)
    expect(result).toBeNull()
  })

  it("returns recovery guidance even with no memories", async () => {
    const config = makeConfig()
    vi.mocked(searchMemoryResult).mockResolvedValue({ status: "empty", source: "search", memories: [] })
    vi.mocked(recallMemories).mockResolvedValue({ status: "empty", source: "recall", memories: [] })

    const result = await buildCompactionRecoveryContext(config)
    expect(result).not.toBeNull()
    expect(result!.count).toBe(0)
    expect(result!.text).toContain("compacted")
  })

  it("prefers memory_bootstrap recovery when available", async () => {
    const config = makeConfig()
    vi.mocked(buildBootstrapContext).mockResolvedValue({
      text: "[MEMORY BOOTSTRAP] Active Tasks\n- TASK: continue migration",
      count: 1,
      usedFallback: false,
      raw: {},
    })

    const result = await buildCompactionRecoveryContext(config, "compact summary")

    expect(result).toEqual({
      text: "[MEMORY BOOTSTRAP] Active Tasks\n- TASK: continue migration",
      count: 1,
      skippedSimilarToSummary: 0,
    })
    expect(buildBootstrapContext).toHaveBeenCalledWith(config, {
      prompt: "continue",
      compactSummary: "compact summary",
      limit: 5,
      tokenBudget: 1500,
      context: undefined,
    })
    expect(searchMemoryResult).not.toHaveBeenCalled()
    expect(recallMemories).not.toHaveBeenCalled()
  })

  it("includes task memories in recovery context", async () => {
    const config = makeConfig()
    vi.mocked(searchMemoryResult).mockResolvedValue({ status: "ok", source: "search", memories: [{ id: "1", content: "TASK: implement auth" }] })
    vi.mocked(recallMemories).mockResolvedValue({ status: "empty", source: "recall", memories: [] })

    const result = await buildCompactionRecoveryContext(config)
    expect(result!.count).toBe(1)
    expect(result!.text).toContain("TASK: implement auth")
    expect(result!.text).toContain("Task state")
  })

  it("includes context memories in recovery", async () => {
    const config = makeConfig()
    vi.mocked(searchMemoryResult).mockResolvedValue({ status: "empty", source: "search", memories: [] })
    vi.mocked(recallMemories).mockResolvedValue({ status: "ok", source: "recall", memories: [{ id: "2", content: "DECISION: use React 18" }] })

    const result = await buildCompactionRecoveryContext(config)
    expect(result!.count).toBe(1)
    expect(result!.text).toContain("DECISION: use React 18")
    expect(result!.text).toContain("Recovery additions")
  })

  it("combines both task and context memories", async () => {
    const config = makeConfig()
    vi.mocked(searchMemoryResult).mockResolvedValue({ status: "ok", source: "search", memories: [{ id: "1", content: "TASK: fix bug" }] })
    vi.mocked(recallMemories).mockResolvedValue({ status: "ok", source: "recall", memories: [{ id: "2", content: "CONTEXT: using v3 API" }] })

    const result = await buildCompactionRecoveryContext(config)
    expect(result!.count).toBe(2)
    expect(result!.text).toContain("TASK: fix bug")
    expect(result!.text).toContain("CONTEXT: using v3 API")
  })

  it("searches with correct parameters", async () => {
    const config = makeConfig({ compaction: { enabled: true, memoryLimit: 7 } })
    vi.mocked(searchMemoryResult).mockResolvedValue({ status: "empty", source: "search", memories: [] })
    vi.mocked(recallMemories).mockResolvedValue({ status: "empty", source: "recall", memories: [] })

    await buildCompactionRecoveryContext(config)
    expect(searchMemoryResult).toHaveBeenCalledWith(config, "TASK: in_progress", "bm25", 5, undefined)
    expect(recallMemories).toHaveBeenCalledWith(config, "recent project context and decisions", 7, undefined)
  })

  it("scopes compaction recovery by logical namespace when configured", async () => {
    const config = makeConfig()
    config.memoryScope.namespace = "workspace-a"
    vi.mocked(searchMemoryResult).mockResolvedValue({ status: "empty", source: "search", memories: [] })
    vi.mocked(recallMemories).mockResolvedValue({ status: "empty", source: "recall", memories: [] })

    await buildCompactionRecoveryContext(config)
    expect(searchMemoryResult).toHaveBeenCalledWith(config, "TASK: in_progress", "bm25", 5, { namespace: "workspace-a" })
    expect(recallMemories).toHaveBeenCalledWith(config, "recent project context and decisions", 10, { namespace: "workspace-a" })
  })
})
