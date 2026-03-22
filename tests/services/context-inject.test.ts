import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  shouldInjectMemories,
  markSessionInjected,
  markSessionCompacted,
  fetchAndFormatMemories,
  fetchCodeIntelContext,
} from "../../src/services/context-inject.js"
import type { PluginConfig } from "../../src/config.js"

vi.mock("../../src/services/mcp-client.js", () => ({
  recall: vi.fn().mockResolvedValue([]),
  callMemoryTool: vi.fn().mockResolvedValue("{}"),
}))

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { recall, callMemoryTool } = await import("../../src/services/mcp-client.js")

function makeConfig(overrides?: Partial<Pick<PluginConfig, "chatMessage">>): PluginConfig {
  return {
    chatMessage: { enabled: true, maxMemories: 5, injectOn: "first", ...overrides?.chatMessage },
    autoCapture: { enabled: true, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    captureModel: { provider: "openai", model: "gpt-4o-mini", apiUrl: "", apiKey: "" },
    mcpServer: { command: ["npx", "-y", "memory-mcp-1file"], tag: "default", model: "qwen3", transport: "http", port: 23817, registerInOpencode: true, mcpServerName: "memory-mcp-1file" },
    systemPrompt: { enabled: true },
  } as PluginConfig
}

describe("shouldInjectMemories", () => {
  it("returns false when chatMessage is disabled", () => {
    const config = makeConfig({ chatMessage: { enabled: false, maxMemories: 5, injectOn: "first" } })
    expect(shouldInjectMemories(config, "s1", false)).toBe(false)
  })

  it("returns true after compaction regardless of injectOn mode", () => {
    const config = makeConfig({ chatMessage: { enabled: true, maxMemories: 5, injectOn: "first" } })
    expect(shouldInjectMemories(config, "s-compact", true)).toBe(true)
  })

  it("returns true on 'always' mode", () => {
    const config = makeConfig({ chatMessage: { enabled: true, maxMemories: 5, injectOn: "always" } })
    expect(shouldInjectMemories(config, "s-always", false)).toBe(true)
  })

  it("returns true on first call for 'first' mode", () => {
    const config = makeConfig()
    const sessionID = "s-first-" + Date.now()
    expect(shouldInjectMemories(config, sessionID, false)).toBe(true)
  })

  it("returns false on second call for 'first' mode after marking injected", () => {
    const config = makeConfig()
    const sessionID = "s-second-" + Date.now()
    shouldInjectMemories(config, sessionID, false)
    markSessionInjected(sessionID)
    expect(shouldInjectMemories(config, sessionID, false)).toBe(false)
  })

  it("returns true again after marking session compacted (resets injection state)", () => {
    const config = makeConfig()
    const sessionID = "s-recompact-" + Date.now()
    markSessionInjected(sessionID)
    expect(shouldInjectMemories(config, sessionID, false)).toBe(false)
    markSessionCompacted(sessionID)
    expect(shouldInjectMemories(config, sessionID, false)).toBe(true)
  })
})

describe("fetchAndFormatMemories", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns null for short messages (< 10 chars)", async () => {
    const config = makeConfig()
    const result = await fetchAndFormatMemories(config, "hi")
    expect(result).toBeNull()
    expect(recall).not.toHaveBeenCalled()
  })

  it("returns null when recall returns no memories", async () => {
    const config = makeConfig()
    vi.mocked(recall).mockResolvedValue([])
    const result = await fetchAndFormatMemories(config, "how do I configure the database?")
    expect(result).toBeNull()
  })

  it("returns formatted memory string when memories exist", async () => {
    const config = makeConfig()
    vi.mocked(recall).mockResolvedValue([
      { id: "1", content: "Use PostgreSQL for production", score: 0.9, memory_type: "semantic" },
    ])
    const result = await fetchAndFormatMemories(config, "what database should I use?")
    expect(result).toContain("[MEMORY]")
    expect(result).toContain("Use PostgreSQL for production")
    expect(result).toContain("[90%]")
  })

  it("passes maxMemories from config to recall", async () => {
    const config = makeConfig({ chatMessage: { enabled: true, maxMemories: 3, injectOn: "first" } })
    vi.mocked(recall).mockResolvedValue([])
    await fetchAndFormatMemories(config, "some question about the project")
    expect(recall).toHaveBeenCalledWith(config, "some question about the project", 3)
  })
})

describe("fetchCodeIntelContext", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns null when no projects are indexed", async () => {
    const config = makeConfig()
    vi.mocked(callMemoryTool).mockResolvedValue(JSON.stringify({ projects: [], count: 0 }))
    const result = await fetchCodeIntelContext(config)
    expect(result).toBeNull()
    expect(callMemoryTool).toHaveBeenCalledWith(config, "project_info", { action: "list" })
  })

  it("returns null when all projects are still indexing", async () => {
    const config = makeConfig()
    vi.mocked(callMemoryTool).mockResolvedValue(
      JSON.stringify({ projects: [{ id: "proj-1", status: "indexing", chunks: 0, symbols: 0 }], count: 1 }),
    )
    const result = await fetchCodeIntelContext(config)
    expect(result).toBeNull()
  })

  it("returns context string for completed projects", async () => {
    const config = makeConfig()
    vi.mocked(callMemoryTool).mockResolvedValue(
      JSON.stringify({
        projects: [{ id: "my-project", status: "completed", chunks: 500, symbols: 120 }],
        count: 1,
      }),
    )
    const result = await fetchCodeIntelContext(config)
    expect(result).not.toBeNull()
    expect(result).toContain("[CODE INTELLIGENCE]")
    expect(result).toContain("my-project")
    expect(result).toContain("120 symbols")
    expect(result).toContain("500 chunks")
    expect(result).toContain("recall_code")
    expect(result).toContain("symbol_graph")
  })

  it("filters out non-completed projects", async () => {
    const config = makeConfig()
    vi.mocked(callMemoryTool).mockResolvedValue(
      JSON.stringify({
        projects: [
          { id: "done-proj", status: "completed", chunks: 100, symbols: 50 },
          { id: "wip-proj", status: "indexing", chunks: 10, symbols: 5 },
        ],
        count: 2,
      }),
    )
    const result = await fetchCodeIntelContext(config)
    expect(result).toContain("done-proj")
    expect(result).not.toContain("wip-proj")
  })

  it("accepts 'indexed' status as completed", async () => {
    const config = makeConfig()
    vi.mocked(callMemoryTool).mockResolvedValue(
      JSON.stringify({
        projects: [{ id: "indexed-proj", status: "indexed", chunks: 200, symbols: 80 }],
        count: 1,
      }),
    )
    const result = await fetchCodeIntelContext(config)
    expect(result).not.toBeNull()
    expect(result).toContain("indexed-proj")
  })

  it("returns null and does not throw when callMemoryTool fails", async () => {
    const config = makeConfig()
    vi.mocked(callMemoryTool).mockRejectedValue(new Error("connection refused"))
    const result = await fetchCodeIntelContext(config)
    expect(result).toBeNull()
  })

  it("returns null when callMemoryTool returns null", async () => {
    const config = makeConfig()
    vi.mocked(callMemoryTool).mockResolvedValue(null as any)
    const result = await fetchCodeIntelContext(config)
    expect(result).toBeNull()
  })
})
