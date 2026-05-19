import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginConfig } from "../../src/config.js"
import type { TierConfig } from "../../src/config.js"

vi.mock("../../src/services/mcp-client.js", () => ({
  recallMemories: vi.fn(),
  listProjectMemories: vi.fn(),
  getProjectListInfo: vi.fn(),
  detectKnowledgeGraphCommunities: vi.fn(),
  getRelatedKnowledgeGraphEntities: vi.fn(),
}))

vi.mock("../../src/services/learning-memory-orchestrator.js", () => ({
  learnFromChatMessage: vi.fn(),
  retrieveRecordsForInjection: vi.fn(),
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

const { learnFromChatMessage, retrieveRecordsForInjection } = await import("../../src/services/learning-memory-orchestrator.js")

const { fetchCodeIntelContext, fetchKnowledgeGraphContext, fetchProjectKnowledge, fetchAndFormatMemories } = await import("../../src/services/context-inject.js")
const { clearProjectInfoCache } = await import("../../src/services/context-inject.js")

const DEFAULT_TIERS: TierConfig[] = [
  { categories: ["USER"], limit: 5 },
  { categories: ["DECISION", "PATTERN"], limit: 5 },
  { categories: ["CONTEXT"], limit: 5 },
]

const TIMEOUT_MS = 40

function makeConfig(overrides?: { chatMessage?: Partial<PluginConfig["chatMessage"]> }): PluginConfig {
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
    codeIndexSync: { enabled: true, autoRefresh: false, debounceMs: 10000, minReindexIntervalMs: 300000 },
    captureModel: { provider: "openai", model: "gpt-4o-mini", apiUrl: "", apiKey: "" },
    memoryScope: {
      namespace: "",
      shareAcrossAgents: true,
      includeAgentMetadata: true,
      includeRunMetadata: false,
      userId: "",
      defaultMetadata: {},
    },
    mcpServer: {
      command: ["npx", "-y", "@steinx/memory-mcp-1file"],
      tag: "default",
      model: "qwen3",
      transport: "http",
      port: 23817,
      bind: "127.0.0.1",
      reconnectIntervalMs: 30000,
      heartbeatIntervalMs: 20000,
      mcpServerName: "memory-mcp-1file",
    },
    systemPrompt: { enabled: true },
    performance: {
      recallTimeoutMs: 20,
      projectInfoTimeoutMs: 20,
      knowledgeGraphTimeoutMs: 20,
      projectKnowledgeTimeoutMs: 20,
      learningMemoryTimeoutMs: 20,
      projectInfoCacheTtlMs: 1000,
    },
  } as PluginConfig
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T>
async function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T | "__timeout__">
async function withTimeout<T>(promise: Promise<T>, timeoutMs = TIMEOUT_MS, fallback: T | "__timeout__" = "__timeout__"): Promise<T | "__timeout__"> {
  return Promise.race([
    promise,
    new Promise<typeof fallback>((resolve) => {
      setTimeout(() => resolve(fallback), timeoutMs)
    }),
  ])
}

async function collectInjectionBatch(config: PluginConfig, userText: string) {
  void learnFromChatMessage(config, userText, { source: "chat.message" }).catch(() => {})

  const perf = config.performance
  const results = await Promise.allSettled([
    withTimeout(fetchAndFormatMemories(config, userText), perf.recallTimeoutMs, null),
    withTimeout(fetchProjectKnowledge(config), perf.projectKnowledgeTimeoutMs, null),
    withTimeout(fetchCodeIntelContext(config), perf.projectInfoTimeoutMs, null),
    withTimeout(fetchKnowledgeGraphContext(config, userText), perf.knowledgeGraphTimeoutMs, null),
    withTimeout(
      (retrieveRecordsForInjection as ReturnType<typeof vi.fn>)(config, { source: "chat.message", sessionId: "s1", query: userText })
        .then((r: any) => (r ? "learned" : null)).catch(() => null),
      perf.learningMemoryTimeoutMs,
      null,
    ),
  ])

  const [formatted, projectKnowledge, codeIntelContext, knowledgeGraphContext, learnedPreferences] =
    results.map((r) => (r.status === "fulfilled" ? r.value : null))

  return { formatted, projectKnowledge, codeIntelContext, knowledgeGraphContext, learnedPreferences }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearProjectInfoCache()
})

describe("context injection performance scaffolds", () => {
  it("returns partial results when one source times out", async () => {
    const config = makeConfig()
    ;(recallMemories as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}))
    ;(listProjectMemories as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "ok", source: "list", memories: [{ id: "p1", content: "USER: x", score: 1 }] })
    ;(getProjectListInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ action: "list", projects: [{ id: "proj", status: "completed" }] })
    ;(detectKnowledgeGraphCommunities as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(learnFromChatMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(retrieveRecordsForInjection as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    const result = await withTimeout(collectInjectionBatch(config, "please summarize the project"), TIMEOUT_MS)

    expect(result).not.toBe("__timeout__")
    expect((result as any).formatted).toBeNull()
    expect((result as any).projectKnowledge).not.toBeNull()
  })

  it("returns all nulls when all sources time out", async () => {
    const config = makeConfig()
    ;(recallMemories as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}))
    ;(listProjectMemories as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}))
    ;(getProjectListInfo as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}))
    ;(detectKnowledgeGraphCommunities as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}))
    ;(learnFromChatMessage as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}))
    ;(retrieveRecordsForInjection as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}))

    const result = await withTimeout(collectInjectionBatch(config, "please summarize the project"), TIMEOUT_MS)

    expect(result).toEqual({ formatted: null, projectKnowledge: null, codeIntelContext: null, knowledgeGraphContext: null, learnedPreferences: null })
  })

  it("one rejected source does not block others", async () => {
    const config = makeConfig()
    ;(recallMemories as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("recall failed"))
    ;(listProjectMemories as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "ok", source: "list", memories: [{ id: "p1", content: "USER: x", score: 1 }] })
    ;(getProjectListInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ action: "list", projects: [{ id: "proj", status: "completed" }] })
    ;(detectKnowledgeGraphCommunities as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(learnFromChatMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(retrieveRecordsForInjection as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    const result = await collectInjectionBatch(config, "please summarize the project")

    expect((result as any).error).toBeUndefined()
    expect((result as any).formatted).toBeNull()
    expect((result as any).projectKnowledge).not.toBeNull()
  })

  it("project_info uses cache on second call", async () => {
    const config = makeConfig()
    ;(getProjectListInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ action: "list", projects: [{ id: "proj", status: "completed" }] })

    const first = await fetchCodeIntelContext(config)
    const second = await fetchCodeIntelContext(config)

    expect(first).toEqual(second)
    expect(getProjectListInfo).toHaveBeenCalledTimes(1)
  })

  it("knowledge graph entity lookups run in parallel", async () => {
    const config = makeConfig({ chatMessage: { knowledgeGraphEntityMatch: true } })
    ;(detectKnowledgeGraphCommunities as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: "c1", entities: [{ id: "e1", name: "Alpha" }, { id: "e2", name: "Beta" }] },
    ])
    ;(getRelatedKnowledgeGraphEntities as ReturnType<typeof vi.fn>).mockImplementation(async (_config, entityId) => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return { entity: { id: entityId, name: entityId }, related: [] }
    })

    const startedAt = Date.now()
    await fetchKnowledgeGraphContext(config, "Alpha and Beta both matter")
    const elapsed = Date.now() - startedAt

    expect(elapsed).toBeLessThan(80)
    expect(getRelatedKnowledgeGraphEntities).toHaveBeenCalledTimes(2)
  })

  it("learnFromChatMessage does not block injection", async () => {
    const config = makeConfig()
    ;(recallMemories as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "ok", source: "recall", memories: [] })
    ;(listProjectMemories as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "ok", source: "list", memories: [{ id: "p1", content: "USER: x", score: 1 }] })
    ;(getProjectListInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ action: "list", projects: [{ id: "proj", status: "completed" }] })
    ;(detectKnowledgeGraphCommunities as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(learnFromChatMessage as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}))
    ;(retrieveRecordsForInjection as ReturnType<typeof vi.fn>).mockResolvedValue({ records: [{ id: "r1", type: "preference", content: "use tabs" }], learning_summary: null })

    const result = await withTimeout(collectInjectionBatch(config, "please summarize the project"), TIMEOUT_MS)

    expect(result).not.toBe("__timeout__")
    expect((result as any).learnedPreferences).not.toBeNull()
  })
})
