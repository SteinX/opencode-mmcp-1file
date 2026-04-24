import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  shouldInjectMemories,
  markSessionInjected,
  markSessionCompacted,
  fetchAndFormatMemories,
  fetchCodeIntelContext,
  fetchKnowledgeGraphContext,
  fetchProjectKnowledge,
  shouldInjectKnowledgeGraph,
  allocateToTiers,
} from "../../src/services/context-inject.js"
import type { TierConfig } from "../../src/config.js"
import type { MemoryEntry } from "../../src/utils/format.js"
import type { PluginConfig } from "../../src/config.js"

vi.mock("../../src/services/mcp-client.js", () => ({
  recallMemories: vi.fn().mockResolvedValue({ status: "empty", source: "recall", memories: [] }),
  listProjectMemories: vi.fn().mockResolvedValue({ status: "empty", source: "list", memories: [] }),
  getProjectListInfo: vi.fn().mockResolvedValue({ action: "list", projects: [] }),
  detectKnowledgeGraphCommunities: vi.fn().mockResolvedValue([]),
  getRelatedKnowledgeGraphEntities: vi.fn().mockResolvedValue(null),
}))

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const {
  recallMemories,
  listProjectMemories,
  getProjectListInfo,
  detectKnowledgeGraphCommunities,
  getRelatedKnowledgeGraphEntities,
} = await import("../../src/services/mcp-client.js")

const DEFAULT_TIERS: TierConfig[] = [
  { categories: ["USER"], limit: 5 },
  { categories: ["DECISION", "PATTERN"], limit: 5 },
  { categories: ["CONTEXT"], limit: 5 },
]

function makeConfig(overrides?: { chatMessage?: Partial<PluginConfig["chatMessage"]>, memoryScope?: Partial<PluginConfig["memoryScope"]> }): PluginConfig {
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
      projectKnowledgeTiers: DEFAULT_TIERS,
      ...overrides?.chatMessage,
    },
    autoCapture: { enabled: true, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    codeIndexSync: { enabled: true, debounceMs: 10000, minReindexIntervalMs: 300000 },
    captureModel: { provider: "openai", model: "gpt-4o-mini", apiUrl: "", apiKey: "" },
    memoryScope: { namespace: "", shareAcrossAgents: true, includeAgentMetadata: true, includeRunMetadata: false, userId: "", defaultMetadata: {}, ...overrides?.memoryScope },
    mcpServer: { command: ["npx", "-y", "memory-mcp-1file"], tag: "default", model: "qwen3", transport: "http", port: 23817, bind: "127.0.0.1", reconnectIntervalMs: 30000, heartbeatIntervalMs: 20000, mcpServerName: "memory-mcp-1file" },
    systemPrompt: { enabled: true },
  } as PluginConfig
}

describe("shouldInjectMemories", () => {
  it("returns false when chatMessage is disabled", () => {
    const config = makeConfig({ chatMessage: { enabled: false } })
    expect(shouldInjectMemories(config, "s1", false)).toBe(false)
  })

  it("returns true after compaction regardless of injectOn mode", () => {
    const config = makeConfig({ chatMessage: { injectOn: "first" } })
    expect(shouldInjectMemories(config, "s-compact", true)).toBe(true)
  })

  it("returns true on 'always' mode", () => {
    const config = makeConfig({ chatMessage: { injectOn: "always" } })
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

  it("returns true when only knowledge graph source should inject", () => {
    const config = makeConfig({
      chatMessage: {
        injectOn: "never" as any,
        projectKnowledgeInjectOn: "never",
        codeIntelInjectOn: "never",
        knowledgeGraphInjectOn: "first",
      },
    })
    const sessionID = "s-kg-only-" + Date.now()

    expect(shouldInjectMemories(config, sessionID, false)).toBe(true)
  })

  it("tracks knowledge graph injection state in default markSessionInjected", () => {
    const config = makeConfig({
      chatMessage: {
        injectOn: "never" as any,
        projectKnowledgeInjectOn: "never",
        codeIntelInjectOn: "never",
        knowledgeGraphInjectOn: "first",
      },
    })
    const sessionID = "s-kg-default-mark-" + Date.now()

    markSessionInjected(sessionID)

    expect(shouldInjectMemories(config, sessionID, false)).toBe(false)
  })

  it("resets knowledge graph injection state after compaction", () => {
    const config = makeConfig({
      chatMessage: {
        injectOn: "never" as any,
        projectKnowledgeInjectOn: "never",
        codeIntelInjectOn: "never",
        knowledgeGraphInjectOn: "first",
      },
    })
    const sessionID = "s-kg-compact-" + Date.now()

    markSessionInjected(sessionID)
    expect(shouldInjectMemories(config, sessionID, false)).toBe(false)
    markSessionCompacted(sessionID)

    expect(shouldInjectMemories(config, sessionID, false)).toBe(true)
  })

  it("exposes source-specific shouldInjectKnowledgeGraph", () => {
    const config = makeConfig({ chatMessage: { knowledgeGraphInjectOn: "never" } })
    expect(shouldInjectKnowledgeGraph(config, "s-kg-never", false)).toBe(false)
  })
})

describe("fetchAndFormatMemories", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns null for short messages under configured threshold", async () => {
    const config = makeConfig()
    const result = await fetchAndFormatMemories(config, "hi")
    expect(result).toBeNull()
    expect(recallMemories).not.toHaveBeenCalled()
  })

  it("returns null when recall returns no memories", async () => {
    const config = makeConfig()
    vi.mocked(recallMemories).mockResolvedValue({ status: "empty", source: "recall", memories: [] })
    const result = await fetchAndFormatMemories(config, "how do I configure the database?")
    expect(result).toBeNull()
  })

  it("returns formatted memory string when memories exist", async () => {
    const config = makeConfig()
    vi.mocked(recallMemories).mockResolvedValue({
      status: "ok",
      source: "recall",
      memories: [
        { id: "1", content: "Use PostgreSQL for production", score: 0.9, memory_type: "semantic" },
      ],
    })
    const result = await fetchAndFormatMemories(config, "what database should I use?")
    expect(result).toContain("[MEMORY]")
    expect(result).toContain("Use PostgreSQL for production")
    expect(result).toContain("[high match]")
  })

  it("passes maxMemories from config to recall", async () => {
    const config = makeConfig({ chatMessage: { maxMemories: 3 } })
    vi.mocked(recallMemories).mockResolvedValue({ status: "empty", source: "recall", memories: [] })
    await fetchAndFormatMemories(config, "some question about the project")
    expect(recallMemories).toHaveBeenCalledWith(config, "some question about the project", 3, undefined)
  })

  it("passes namespace scope to recall when configured", async () => {
    const config = makeConfig({ memoryScope: { namespace: "workspace-a" } })
    vi.mocked(recallMemories).mockResolvedValue({ status: "empty", source: "recall", memories: [] })
    await fetchAndFormatMemories(config, "some question about the project")
    expect(recallMemories).toHaveBeenCalledWith(config, "some question about the project", 5, { namespace: "workspace-a" })
  })

  it("filters out low-score memories before formatting", async () => {
    const config = makeConfig({ chatMessage: { minScore: 0.7 } })
    vi.mocked(recallMemories).mockResolvedValue({
      status: "ok",
      source: "recall",
      memories: [
        { id: "1", content: "Weak memory", score: 0.4 },
      ],
    })

    const result = await fetchAndFormatMemories(config, "database")
    expect(result).toBeNull()
  })
})

describe("allocateToTiers", () => {
  const tiers: TierConfig[] = [
    { categories: ["USER"], limit: 1 },
    { categories: ["DECISION", "PATTERN"], limit: 2 },
    { categories: ["TASK"], limit: 2 },
    { categories: [], limit: 2 },
  ]

  it("allocates memories to matching tiers by priority", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "USER: Remember deployment constraints" },
      { id: "2", content: "DECISION: Use PostgreSQL" },
      { id: "3", content: "TASK: implement auth" },
      { id: "4", content: "PATTERN: Repository pattern" },
      { id: "5", content: "CONTEXT: Node 20" },
    ]
    const result = allocateToTiers(memories, tiers)
    expect(result.get(0)!.map((m) => m.id)).toEqual(["1"])
    expect(result.get(1)!.map((m) => m.id)).toEqual(["2", "4"])
    expect(result.get(2)!.map((m) => m.id)).toEqual(["3"])
    expect(result.get(3)!.map((m) => m.id)).toEqual(["5"])
  })

  it("respects tier limits", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "DECISION: one" },
      { id: "2", content: "DECISION: two" },
      { id: "3", content: "DECISION: three" },
    ]
    const result = allocateToTiers(memories, tiers)
    expect(result.get(1)!).toHaveLength(2)
  })

  it("prevents duplicate allocation across tiers", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "USER: already used" },
    ]
    const result = allocateToTiers(memories, tiers)
    expect(result.get(0)!).toHaveLength(1) // matched in tier 0
    expect(result.get(3)!).toHaveLength(0) // not re-matched in catch-all
  })

  it("assigns unmatched memories to catch-all tier", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "BUGFIX: fixed null pointer" },
      { id: "2", content: "RESEARCH: investigated caching" },
      { id: "3", content: "Random note" },
    ]
    const result = allocateToTiers(memories, tiers)
    expect(result.get(0)!).toHaveLength(0)
    expect(result.get(1)!).toHaveLength(0)
    expect(result.get(2)!).toHaveLength(0)
    expect(result.get(3)!.map((m) => m.id)).toEqual(["1", "2"]) // limited to 2
  })

  it("is case-insensitive for category matching", () => {
    const memories: MemoryEntry[] = [
      { id: "1", content: "decision: lowercase prefix" },
      { id: "2", content: "Pattern: mixed case" },
    ]
    const result = allocateToTiers(memories, tiers)
    expect(result.get(1)!).toHaveLength(2)
  })

  it("returns empty buckets when no memories provided", () => {
    const result = allocateToTiers([], tiers)
    expect(result.get(0)!).toHaveLength(0)
    expect(result.get(1)!).toHaveLength(0)
    expect(result.get(2)!).toHaveLength(0)
    expect(result.get(3)!).toHaveLength(0)
  })
})

describe("fetchProjectKnowledge", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns null when listMemories returns empty", async () => {
    const config = makeConfig()
    vi.mocked(listProjectMemories).mockResolvedValue({ status: "empty", source: "list", memories: [] })
    const result = await fetchProjectKnowledge(config)
    expect(result).toBeNull()
  })

  it("returns tiered project knowledge when tiers are configured", async () => {
    const config = makeConfig()
    vi.mocked(listProjectMemories).mockResolvedValue({
      status: "ok",
      source: "list",
      memories: [
        { id: "1", content: "USER: Keep deployment notes visible", memory_type: "semantic" },
        { id: "2", content: "DECISION: Use PostgreSQL", memory_type: "semantic" },
        { id: "3", content: "CONTEXT: ESM modules with .js extensions", memory_type: "semantic" },
      ],
    })
    const result = await fetchProjectKnowledge(config)
    expect(result).toContain("[MEMORY] Project Knowledge (tiered session guidance):")
    expect(result).toContain("### USER")
    expect(result).toContain("USER: Keep deployment notes visible")
    expect(result).toContain("### DECISION / PATTERN")
    expect(result).toContain("DECISION: Use PostgreSQL")
    expect(result).toContain("### CONTEXT")
    expect(result).toContain("CONTEXT: ESM modules with .js extensions")
  })

  it("falls back to flat format when tiers are null", async () => {
    const config = makeConfig({ chatMessage: { projectKnowledgeTiers: null } })
    vi.mocked(listProjectMemories).mockResolvedValue({
      status: "ok",
      source: "list",
      memories: [{ id: "1", content: "Some knowledge", memory_type: "semantic" }],
    })
    const result = await fetchProjectKnowledge(config)
    expect(result).toContain("[MEMORY] Project Knowledge (session guidance):")
    expect(result).toContain("Some knowledge")
    expect(result).not.toContain("###")
  })

  it("does not include confidence scores in project knowledge", async () => {
    const config = makeConfig()
    vi.mocked(listProjectMemories).mockResolvedValue({
      status: "ok",
      source: "list",
      memories: [{ id: "1", content: "DECISION: Some knowledge", score: 0.95, memory_type: "semantic" }],
    })
    const result = await fetchProjectKnowledge(config)
    expect(result).not.toContain("[95%]")
    expect(result).toContain("DECISION: Some knowledge")
  })

  it("passes maxProjectMemories from config to listMemories", async () => {
    const config = makeConfig({ chatMessage: { maxProjectMemories: 7 } })
    vi.mocked(listProjectMemories).mockResolvedValue({ status: "empty", source: "list", memories: [] })
    await fetchProjectKnowledge(config)
    expect(listProjectMemories).toHaveBeenCalledWith(config, 7, false, undefined)
  })

  it("uses valid-only project knowledge when configured", async () => {
    const config = makeConfig({ chatMessage: { projectKnowledgeValidOnly: true } })
    vi.mocked(listProjectMemories).mockResolvedValue({ status: "empty", source: "valid", memories: [] })
    await fetchProjectKnowledge(config)
    expect(listProjectMemories).toHaveBeenCalledWith(config, 30, true, undefined)
  })

  it("passes namespace scope to project knowledge when configured", async () => {
    const config = makeConfig({ memoryScope: { namespace: "workspace-a" } })
    vi.mocked(listProjectMemories).mockResolvedValue({ status: "empty", source: "list", memories: [] })
    await fetchProjectKnowledge(config)
    expect(listProjectMemories).toHaveBeenCalledWith(config, 30, false, { namespace: "workspace-a" })
  })

  it("returns null when project knowledge retrieval fails", async () => {
    const config = makeConfig()
    vi.mocked(listProjectMemories).mockResolvedValue({ status: "failed", source: "list", memories: [], reason: "connection refused" })
    const result = await fetchProjectKnowledge(config)
    expect(result).toBeNull()
  })
})

describe("fetchCodeIntelContext", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns null when no projects are indexed", async () => {
    const config = makeConfig()
    vi.mocked(getProjectListInfo).mockResolvedValue({ action: "list", projects: [], raw: {} } as any)
    const result = await fetchCodeIntelContext(config)
    expect(result).toBeNull()
    expect(getProjectListInfo).toHaveBeenCalledWith(config)
  })

  it("returns null when all projects are still indexing", async () => {
    const config = makeConfig()
    vi.mocked(getProjectListInfo).mockResolvedValue({
      action: "list",
      projects: [{ id: "proj-1", status: "indexing", chunks: 0, symbols: 0, raw: {} }],
      raw: {},
    } as any)
    const result = await fetchCodeIntelContext(config)
    expect(result).toBeNull()
  })

  it("returns context string for completed projects", async () => {
    const config = makeConfig()
    vi.mocked(getProjectListInfo).mockResolvedValue({
      action: "list",
      projects: [{ id: "my-project", status: "completed", chunks: 500, symbols: 120, raw: {} }],
      raw: {},
    } as any)
    const result = await fetchCodeIntelContext(config)
    expect(result).not.toBeNull()
    expect(result).toContain("[CODE INTELLIGENCE]")
    expect(result).toContain("my-project")
    expect(result).toContain("120 symbols")
    expect(result).toContain("500 chunks")
    expect(result).toContain("code_search")
    expect(result).toContain("project_status")
  })

  it("filters out non-completed projects", async () => {
    const config = makeConfig()
    vi.mocked(getProjectListInfo).mockResolvedValue({
      action: "list",
      projects: [
        { id: "done-proj", status: "completed", chunks: 100, symbols: 50, raw: {} },
        { id: "wip-proj", status: "indexing", chunks: 10, symbols: 5, raw: {} },
      ],
      raw: {},
    } as any)
    const result = await fetchCodeIntelContext(config)
    expect(result).toContain("done-proj")
    expect(result).not.toContain("wip-proj")
  })

  it("accepts 'indexed' status as completed", async () => {
    const config = makeConfig()
    vi.mocked(getProjectListInfo).mockResolvedValue({
      action: "list",
      projects: [{ id: "indexed-proj", status: "indexed", chunks: 200, symbols: 80, raw: {} }],
      raw: {},
    } as any)
    const result = await fetchCodeIntelContext(config)
    expect(result).not.toBeNull()
    expect(result).toContain("indexed-proj")
  })

  it("returns null and does not throw when project list lookup fails", async () => {
    const config = makeConfig()
    vi.mocked(getProjectListInfo).mockRejectedValue(new Error("connection refused"))
    const result = await fetchCodeIntelContext(config)
    expect(result).toBeNull()
  })

  it("returns null when project list lookup returns null", async () => {
    const config = makeConfig()
    vi.mocked(getProjectListInfo).mockResolvedValue(null as any)
    const result = await fetchCodeIntelContext(config)
    expect(result).toBeNull()
  })
})

describe("fetchKnowledgeGraphContext", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns null when no communities are detected", async () => {
    const config = makeConfig()
    vi.mocked(detectKnowledgeGraphCommunities).mockResolvedValue([])

    const result = await fetchKnowledgeGraphContext(config)

    expect(result).toBeNull()
    expect(detectKnowledgeGraphCommunities).toHaveBeenCalledWith(config)
  })

  it("formats detected communities with configured item limit", async () => {
    const config = makeConfig({ chatMessage: { maxKnowledgeGraphItems: 1 } })
    vi.mocked(detectKnowledgeGraphCommunities).mockResolvedValue([
      {
        id: "c1",
        label: "Runtime",
        size: 2,
        entities: [
          { id: "e1", name: "Plugin Hooks", entity_type: "module" },
          { id: "e2", name: "MCP Client", entity_type: "service" },
        ],
        relations: [],
      },
      {
        id: "c2",
        label: "Storage",
        size: 1,
        entities: [{ id: "e3", name: "Memory Store" }],
        relations: [],
      },
    ])

    const result = await fetchKnowledgeGraphContext(config)

    expect(result).toContain("[KNOWLEDGE GRAPH] Architectural Overview:")
    expect(result).toContain("## Runtime (2 entities)")
    expect(result).toContain("Plugin Hooks [module]")
    expect(result).not.toContain("Storage")
  })

  it("appends related context for exact normalized entity-name matches", async () => {
    const config = makeConfig({ chatMessage: { knowledgeGraphEntityMatch: true } })
    vi.mocked(detectKnowledgeGraphCommunities).mockResolvedValue([
      {
        id: "c1",
        label: "Auth",
        size: 1,
        entities: [{ id: "auth-service", name: "Auth Service", entity_type: "service" }],
        relations: [],
      },
    ])
    vi.mocked(getRelatedKnowledgeGraphEntities).mockResolvedValue({
      entity: { id: "auth-service", name: "Auth Service", entity_type: "service" },
      distance: 0,
      related: [
        {
          entity: { id: "db", name: "User Database", entity_type: "database" },
          relation: { from: "auth-service", to: "db", relation_type: "reads", weight: 1 },
        },
      ],
    })

    const result = await fetchKnowledgeGraphContext(config, "How does the auth service validate users?")

    expect(getRelatedKnowledgeGraphEntities).toHaveBeenCalledWith(config, "auth-service")
    expect(result).toContain("Related context for Auth Service")
    expect(result).toContain("User Database [database]")
    expect(result).toContain("reads")
  })

  it("does not fetch related context without exact normalized entity-name match", async () => {
    const config = makeConfig({ chatMessage: { knowledgeGraphEntityMatch: true } })
    vi.mocked(detectKnowledgeGraphCommunities).mockResolvedValue([
      {
        id: "c1",
        label: "Auth",
        size: 1,
        entities: [{ id: "auth-service", name: "Auth Service", entity_type: "service" }],
        relations: [],
      },
    ])

    const result = await fetchKnowledgeGraphContext(config, "How does authentication work?")

    expect(result).toContain("Auth Service")
    expect(getRelatedKnowledgeGraphEntities).not.toHaveBeenCalled()
  })

  it("returns null when knowledge graph lookup throws", async () => {
    const config = makeConfig()
    vi.mocked(detectKnowledgeGraphCommunities).mockRejectedValue(new Error("connection refused"))

    const result = await fetchKnowledgeGraphContext(config)

    expect(result).toBeNull()
  })
})
