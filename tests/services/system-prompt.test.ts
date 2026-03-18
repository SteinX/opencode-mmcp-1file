import { describe, it, expect } from "vitest"
import { buildMemorySystemPrompt } from "../../src/services/system-prompt.js"
import type { PluginConfig } from "../../src/config.js"

function makeConfig(): PluginConfig {
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
  } as PluginConfig
}

describe("buildMemorySystemPrompt", () => {
  it("returns base MEMORY_PROTOCOL when no tools available", () => {
    const result = buildMemorySystemPrompt(makeConfig(), [])
    expect(result).toContain("## Memory System")
    expect(result).toContain("### When to Store Memories")
    expect(result).toContain("### Key Tools")
    expect(result).toContain("### Memory Lifecycle")
    expect(result).toContain("### Prefix Format")
    expect(result).not.toContain("### Available Memory Tools")
  })

  it("appends Available Memory Tools section when tools provided", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["store_memory", "recall", "search_memory"])
    expect(result).toContain("### Available Memory Tools")
    expect(result).toContain("`store_memory`")
    expect(result).toContain("`recall`")
    expect(result).toContain("`search_memory`")
  })

  it("formats tools as backtick-wrapped comma-separated list", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["recall", "store_memory"])
    expect(result).toContain("`recall`, `store_memory`")
  })

  it("includes single tool correctly", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["get_status"])
    expect(result).toContain("### Available Memory Tools")
    expect(result).toContain("`get_status`")
  })

  it("always includes base Memory Protocol content regardless of tools", () => {
    const withTools = buildMemorySystemPrompt(makeConfig(), ["recall"])
    const withoutTools = buildMemorySystemPrompt(makeConfig(), [])

    expect(withTools).toContain("DECISION:")
    expect(withoutTools).toContain("DECISION:")
    expect(withTools).toContain("store_memory")
    expect(withoutTools).toContain("store_memory")
  })
})
