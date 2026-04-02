import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../src/services/mcp-client.js", () => ({
  recall: vi.fn().mockResolvedValue([]),
  searchMemory: vi.fn().mockResolvedValue([]),
}))

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { recall, searchMemory } = await import("../../src/services/mcp-client.js")
import { buildCompactionRecoveryContext } from "../../src/services/compaction.js"
import type { PluginConfig } from "../../src/config.js"

function makeConfig(overrides?: Partial<Pick<PluginConfig, "compaction">>): PluginConfig {
  return {
    chatMessage: { enabled: true, maxMemories: 5, maxProjectMemories: 30, injectOn: "first" },
    autoCapture: { enabled: true, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10, ...overrides?.compaction },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    codeIndexSync: { enabled: true, debounceMs: 10000, minReindexIntervalMs: 300000 },
    captureModel: { provider: "openai", model: "gpt-4o-mini", apiUrl: "", apiKey: "" },
    mcpServer: { command: ["npx", "-y", "memory-mcp-1file"], tag: "default", model: "qwen3", transport: "http", port: 23817, bind: "127.0.0.1", mcpServerName: "memory-mcp-1file" },
    systemPrompt: { enabled: true },
  } as PluginConfig
}

describe("buildCompactionRecoveryContext", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns null when compaction is disabled", async () => {
    const config = makeConfig({ compaction: { enabled: false, memoryLimit: 10 } })
    const result = await buildCompactionRecoveryContext(config)
    expect(result).toBeNull()
  })

  it("returns recovery guidance even with no memories", async () => {
    const config = makeConfig()
    vi.mocked(searchMemory).mockResolvedValue([])
    vi.mocked(recall).mockResolvedValue([])

    const result = await buildCompactionRecoveryContext(config)
    expect(result).not.toBeNull()
    expect(result!.count).toBe(0)
    expect(result!.text).toContain("compacted")
  })

  it("includes task memories in recovery context", async () => {
    const config = makeConfig()
    vi.mocked(searchMemory).mockResolvedValue([
      { id: "1", content: "TASK: implement auth" },
    ])
    vi.mocked(recall).mockResolvedValue([])

    const result = await buildCompactionRecoveryContext(config)
    expect(result!.count).toBe(1)
    expect(result!.text).toContain("TASK: implement auth")
    expect(result!.text).toContain("Active Tasks")
  })

  it("includes context memories in recovery", async () => {
    const config = makeConfig()
    vi.mocked(searchMemory).mockResolvedValue([])
    vi.mocked(recall).mockResolvedValue([
      { id: "2", content: "DECISION: use React 18" },
    ])

    const result = await buildCompactionRecoveryContext(config)
    expect(result!.count).toBe(1)
    expect(result!.text).toContain("DECISION: use React 18")
    expect(result!.text).toContain("Recent Project Context")
  })

  it("combines both task and context memories", async () => {
    const config = makeConfig()
    vi.mocked(searchMemory).mockResolvedValue([
      { id: "1", content: "TASK: fix bug" },
    ])
    vi.mocked(recall).mockResolvedValue([
      { id: "2", content: "CONTEXT: using v3 API" },
    ])

    const result = await buildCompactionRecoveryContext(config)
    expect(result!.count).toBe(2)
    expect(result!.text).toContain("TASK: fix bug")
    expect(result!.text).toContain("CONTEXT: using v3 API")
  })

  it("searches with correct parameters", async () => {
    const config = makeConfig({ compaction: { enabled: true, memoryLimit: 7 } })
    vi.mocked(searchMemory).mockResolvedValue([])
    vi.mocked(recall).mockResolvedValue([])

    await buildCompactionRecoveryContext(config)
    expect(searchMemory).toHaveBeenCalledWith(config, "TASK: in_progress", "bm25", 5)
    expect(recall).toHaveBeenCalledWith(config, "recent project context and decisions", 7)
  })
})
