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

  it("appends Code Intelligence section when code intel tools present", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["recall", "index_project", "recall_code"])
    expect(result).toContain("### Code Intelligence Tools")
    expect(result).toContain("index_project")
    expect(result).toContain("recall_code")
    expect(result).toContain("/init-mcp-memory")
  })

  it("does not include Code Intelligence section without code intel tools", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["recall", "store_memory"])
    expect(result).not.toContain("### Code Intelligence Tools")
    expect(result).not.toContain("/init-mcp-memory")
  })

  it("includes Code Intelligence with any single code intel tool", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["search_symbols"])
    expect(result).toContain("### Code Intelligence Tools")
  })

  it("includes connection warning when connectionOk is false", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["recall", "store_memory"], false)
    expect(result).toContain("### MEMORY SERVER OFFLINE")
    expect(result).toContain("Do NOT call memory tools")
    expect(result).toContain("get_status")
  })

  it("does not include connection warning when connectionOk is true", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["recall", "store_memory"], true)
    expect(result).not.toContain("### MEMORY SERVER OFFLINE")
  })

  it("defaults connectionOk to true (no warning)", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["recall"])
    expect(result).not.toContain("### MEMORY SERVER OFFLINE")
  })

  it("does not inject warning when tools list is empty (even if connectionOk=false)", () => {
    const result = buildMemorySystemPrompt(makeConfig(), [], false)
    expect(result).not.toContain("### MEMORY SERVER OFFLINE")
    expect(result).toBe(result)
  })

  it("places warning between base protocol and available tools", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["recall"], false)
    const warningIndex = result.indexOf("### MEMORY SERVER OFFLINE")
    const toolsIndex = result.indexOf("### Available Memory Tools")
    const baseIndex = result.indexOf("### Prefix Format")
    expect(warningIndex).toBeGreaterThan(baseIndex)
    expect(warningIndex).toBeLessThan(toolsIndex)
  })
})
