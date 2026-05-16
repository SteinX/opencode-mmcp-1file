import { describe, it, expect } from "vitest"
import { buildMemorySystemPrompt } from "../../src/services/system-prompt.js"
import type { PluginConfig } from "../../src/config.js"

function makeConfig(overrides?: Partial<PluginConfig>): PluginConfig {
  return {
    chatMessage: { enabled: true, maxMemories: 5, maxProjectMemories: 30, maxInjectedMemories: 6, injectOn: "first", shortQueryMinLength: 3, minScore: 0.35 },
    autoCapture: { enabled: true, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    codeIndexSync: { enabled: true, autoRefresh: false, debounceMs: 10000, minReindexIntervalMs: 300000 },
    captureModel: { provider: "openai", model: "gpt-4o-mini", apiUrl: "", apiKey: "" },
    memoryScope: { namespace: "", shareAcrossAgents: true, includeAgentMetadata: true, includeRunMetadata: false, userId: "", defaultMetadata: {} },
    mcpServer: { command: [], tag: "default", model: "qwen3", mcpServerName: "memory-mcp-1file", transport: "stdio", port: 23817, bind: "127.0.0.1" },
    systemPrompt: { enabled: true },
    ...overrides,
  } as PluginConfig
}

describe("buildMemorySystemPrompt", () => {
  it("returns base MEMORY_PROTOCOL when no tools available", () => {
    const result = buildMemorySystemPrompt(makeConfig(), [])
    expect(result).toContain("## Memory System")
    expect(result).toContain("### Scope Model")
    expect(result).toContain("### Scope Guidance")
    expect(result).toContain("### When to Store Memories")
    expect(result).toContain("### Key Tools")
    expect(result).toContain("### Memory Lifecycle")
    expect(result).toContain("### Prefix Format")
    expect(result).not.toContain("### Available Memory Tools")
  })

  it("documents shared-agent defaults and logical namespace guidance", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["memory_query", "memory_save"])
    expect(result).toContain("mcpServer.tag / dataDir")
    expect(result).toContain("memoryScope.namespace")
    expect(result).toContain("collaborating agents should share memories")
    expect(result).toContain("pass `namespace` to `memory_query`")
    expect(result).toContain("Only pass `agent_id` for explicit per-agent isolation")
  })

  it("documents memory_query parameter filling rules", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["memory_query"])
    expect(result).toContain("### memory_query Parameter Filling Rules")
    expect(result).toContain("Start with the smallest useful call")
    expect(result).toContain("Do **not** send empty strings, empty objects, or placeholder values")
    expect(result).toContain("Only pass `namespace` when you need a narrower retrieval boundary")
    expect(result).toContain("If you are unsure whether a filter is needed, leave it out and start broad")
  })

  it("appends Available Memory Tools section when tools provided", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["memory_save", "memory_query", "memory_manage"])
    expect(result).toContain("### Available Memory Tools")
    expect(result).toContain("`memory_save`")
    expect(result).toContain("`memory_query`")
    expect(result).toContain("`memory_manage`")
  })

  it("formats tools as backtick-wrapped comma-separated list", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["memory_query", "memory_save"])
    expect(result).toContain("`memory_query`, `memory_save`")
  })

  it("includes single tool correctly", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["get_status"])
    expect(result).toContain("### Available Memory Tools")
    expect(result).toContain("`get_status`")
  })

  it("always includes base Memory Protocol content regardless of tools", () => {
    const withTools = buildMemorySystemPrompt(makeConfig(), ["memory_query"])
    const withoutTools = buildMemorySystemPrompt(makeConfig(), [])

    expect(withTools).toContain("DECISION")
    expect(withoutTools).toContain("DECISION")
    expect(withTools).toContain("memory_save")
    expect(withoutTools).toContain("memory_save")
  })

  it("appends Code Intelligence section when code intel tools present", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["memory_query", "code_search", "project_status"])
    expect(result).toContain("### Code Intelligence Tools")
    expect(result).toContain("code_search")
    expect(result).toContain("project_status")
    expect(result).toContain("/init-mcp-memory")
    expect(result).toContain("Unfamiliar code or \"how does X work?\"")
    expect(result).toContain("Known symbol name")
    expect(result).toContain("Call relationships or refactoring impact")
  })

  it("guides local code understanding and debugging to use code_search first", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["code_search", "project_status"])

    expect(result).toContain("use code_search first")
    expect(result).toContain("local code understanding")
    expect(result).toContain("debugging")
    expect(result).toContain("refactoring impact")
    expect(result).toContain("where or how something is implemented")
    expect(result).toContain("before falling back to grep/LSP")
  })

  it("renders the Code Intelligence heading exactly once when code intel tools are available", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["memory_query", "code_search", "project_status"])
    const headingCount = result.match(/### Code Intelligence Tools/g)?.length ?? 0

    expect(headingCount).toBe(1)
  })

  it("uses one-time setup guidance when code index sync is disabled", () => {
    const result = buildMemorySystemPrompt(
      makeConfig({ codeIndexSync: { enabled: false, autoRefresh: false, debounceMs: 10000, minReindexIntervalMs: 300000 } }),
      ["code_search", "project_status"],
    )

    expect(result).toContain("one-time setup")
    expect(result).not.toContain("Background refresh")
  })

  it("does not include Code Intelligence section without code intel tools", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["memory_query", "memory_save"])
    expect(result).not.toContain("### Code Intelligence Tools")
    expect(result).not.toContain("/init-mcp-memory")
    expect(result).not.toContain("Unfamiliar code or \"how does X work?\"")
  })

  it("includes Code Intelligence with code intel tools", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["code_search"])
    expect(result).toContain("### Code Intelligence Tools")
    expect(result).toContain("use code_search with search_type: \"intent\"")
  })

  it("includes connection warning when connectionOk is false", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["memory_query", "memory_save"], false)
    expect(result).toContain("### MEMORY SERVER OFFLINE")
    expect(result).toContain("Do NOT call memory tools")
    expect(result).toContain("get_status")
  })

  it("does not include connection warning when connectionOk is true", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["memory_query", "memory_save"], true)
    expect(result).not.toContain("### MEMORY SERVER OFFLINE")
  })

  it("defaults connectionOk to true (no warning)", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["memory_query"])
    expect(result).not.toContain("### MEMORY SERVER OFFLINE")
  })

  it("does not inject warning when tools list is empty (even if connectionOk=false)", () => {
    const result = buildMemorySystemPrompt(makeConfig(), [], false)
    expect(result).not.toContain("### MEMORY SERVER OFFLINE")
    expect(result).toBe(result)
  })

  it("places warning between base protocol and available tools", () => {
    const result = buildMemorySystemPrompt(makeConfig(), ["memory_query"], false)
    const warningIndex = result.indexOf("### MEMORY SERVER OFFLINE")
    const toolsIndex = result.indexOf("### Available Memory Tools")
    const baseIndex = result.indexOf("### Prefix Format")
    expect(warningIndex).toBeGreaterThan(baseIndex)
    expect(warningIndex).toBeLessThan(toolsIndex)
  })

  it("includes knowledge graph action triggers", () => {
    const result = buildMemorySystemPrompt(makeConfig(), [])
    expect(result).toContain("get_related")
    expect(result).toContain("create_entity")
    expect(result).toContain("create_relation")
  })

  it("includes knowledge graph empty state guidance", () => {
    const result = buildMemorySystemPrompt(makeConfig(), [])
    expect(result).toContain("Empty graph is normal")
    expect(result).toContain("Build it incrementally")
  })

  it("includes knowledge graph anti-patterns", () => {
    const result = buildMemorySystemPrompt(makeConfig(), [])
    expect(result).toContain("Do not store every file as an entity")
  })

  it("knowledge graph section is within token budget", () => {
    const result = buildMemorySystemPrompt(makeConfig(), [])
    const kgStart = result.indexOf("### Knowledge Graph")
    const kgEnd = result.indexOf("### ", kgStart + 1)
    const kgSection = kgEnd === -1
      ? result.slice(kgStart)
      : result.slice(kgStart, kgEnd)
    expect(kgSection.length).toBeLessThanOrEqual(850) // 800 + small margin for section header
  })
})
