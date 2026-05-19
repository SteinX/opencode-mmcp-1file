import { describe, it, expect, vi, beforeEach } from "vitest"
import type { PluginConfig } from "../../src/config.js"

const mcp = vi.hoisted(() => ({
  discoverTools: vi.fn(),
  callMemoryToolJson: vi.fn(),
  getMemoryConnectionKey: vi.fn(),
  registerMemoryClientLifecycleHandler: vi.fn(),
  storeMemory: vi.fn(),
}))

vi.mock("../../src/services/mcp-client.js", () => ({
  discoverTools: mcp.discoverTools,
  callMemoryToolJson: mcp.callMemoryToolJson,
  getMemoryConnectionKey: mcp.getMemoryConnectionKey,
  registerMemoryClientLifecycleHandler: mcp.registerMemoryClientLifecycleHandler,
  storeMemory: mcp.storeMemory,
}))

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const {
  buildBootstrapContext,
  clearServerCapabilityCache,
  createHookObservation,
  getMemoryAudit,
  getMemorySearchTrace,
  getServerCapabilities,
} = await import("../../src/services/memory-orchestration.js")

function makeConfig(tag = "default"): PluginConfig {
  return {
    chatMessage: {
      enabled: true,
      maxMemories: 5,
      maxProjectMemories: 30,
      maxInjectedMemories: 6,
      injectOn: "first",
      shortQueryMinLength: 3,
      minScore: 0.35,
      bootstrapLimit: 10,
      bootstrapTokenBudget: 4000,
    },
    autoCapture: { enabled: true, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10, bootstrapLimit: 5, bootstrapTokenBudget: 1500 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    codeIndexSync: { enabled: true, autoRefresh: false, debounceMs: 10000, minReindexIntervalMs: 300000 },
    preferenceLearning: { enabled: false, learnOnCorrections: true, learnOnNegations: true, learnOnMessageUpdated: true, injectOn: "first", scope: "project", minConfidence: 0.7, candidateConfidence: 0.4, maxPreferences: 5, maxCandidates: 3, debounceMs: 10000, maxInputChars: 4000, maxStoredPreferences: 50 },
    captureModel: { provider: "", model: "", apiUrl: "", apiKey: "" },
    memoryScope: { namespace: "", shareAcrossAgents: true, includeAgentMetadata: true, includeRunMetadata: false, userId: "", defaultMetadata: {} },
    mcpServer: { command: ["npx", "-y", "@steinx/memory-mcp-1file"], tag, model: "qwen3", transport: "http", port: 23817, bind: "127.0.0.1", reconnectIntervalMs: 30000, heartbeatIntervalMs: 20000, mcpServerName: "memory-mcp-1file" },
    systemPrompt: { enabled: true },
    performance: { recallTimeoutMs: 15000, projectInfoTimeoutMs: 10000, knowledgeGraphTimeoutMs: 10000, projectKnowledgeTimeoutMs: 15000, learningMemoryTimeoutMs: 10000, projectInfoCacheTtlMs: 300000, bootstrapTimeoutMs: 10000, observationTimeoutMs: 10000, auditTimeoutMs: 10000, searchTraceTimeoutMs: 10000 },
  } as PluginConfig
}

describe("memory orchestration capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearServerCapabilityCache()
  })

  it("caches supported server tools by connection key", async () => {
    const config = makeConfig("a")
    mcp.getMemoryConnectionKey.mockReturnValue("key-a")
    mcp.discoverTools.mockResolvedValue(["memory_bootstrap", "memory_audit", "recall"])

    const first = await getServerCapabilities(config)
    const second = await getServerCapabilities(config)

    expect(first.has("memory_bootstrap")).toBe(true)
    expect(first.has("memory_audit")).toBe(true)
    expect(second.has("memory_bootstrap")).toBe(true)
    expect(mcp.discoverTools).toHaveBeenCalledTimes(1)
  })

  it("does not share capability cache across connection keys", async () => {
    const configA = makeConfig("a")
    const configB = makeConfig("b")
    mcp.getMemoryConnectionKey.mockReturnValueOnce("key-a").mockReturnValueOnce("key-b")
    mcp.discoverTools
      .mockResolvedValueOnce(["memory_bootstrap"])
      .mockResolvedValueOnce(["memory_observation_create"])

    const first = await getServerCapabilities(configA)
    const second = await getServerCapabilities(configB)

    expect(first.has("memory_bootstrap")).toBe(true)
    expect(first.has("memory_observation_create")).toBe(false)
    expect(second.has("memory_bootstrap")).toBe(false)
    expect(second.has("memory_observation_create")).toBe(true)
    expect(mcp.discoverTools).toHaveBeenCalledTimes(2)
  })

  it("clears a single connection-key capability cache entry", async () => {
    const config = makeConfig("a")
    mcp.getMemoryConnectionKey.mockReturnValue("key-a")
    mcp.discoverTools.mockResolvedValueOnce(["memory_bootstrap"]).mockResolvedValueOnce(["memory_audit"])

    expect((await getServerCapabilities(config)).has("memory_bootstrap")).toBe(true)
    clearServerCapabilityCache("key-a")
    const second = await getServerCapabilities(config)

    expect(second.has("memory_bootstrap")).toBe(false)
    expect(second.has("memory_audit")).toBe(true)
    expect(mcp.discoverTools).toHaveBeenCalledTimes(2)
  })

  it("does not cache an empty discovery result from transient listTools failure", async () => {
    const config = makeConfig("a")
    mcp.getMemoryConnectionKey.mockReturnValue("key-a")
    mcp.discoverTools.mockResolvedValueOnce([]).mockResolvedValueOnce(["memory_bootstrap"])

    expect((await getServerCapabilities(config)).has("memory_bootstrap")).toBe(false)
    expect((await getServerCapabilities(config)).has("memory_bootstrap")).toBe(true)
    expect(mcp.discoverTools).toHaveBeenCalledTimes(2)
  })

  it("coalesces concurrent capability discovery by connection key", async () => {
    const config = makeConfig("a")
    mcp.getMemoryConnectionKey.mockReturnValue("key-a")
    mcp.discoverTools.mockResolvedValue(["memory_bootstrap"])

    const [first, second] = await Promise.all([
      getServerCapabilities(config),
      getServerCapabilities(config),
    ])

    expect(first.has("memory_bootstrap")).toBe(true)
    expect(second.has("memory_bootstrap")).toBe(true)
    expect(mcp.discoverTools).toHaveBeenCalledTimes(1)
  })
})

describe("buildBootstrapContext", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearServerCapabilityCache()
  })

  it("renders active tasks, stable context, project, and truncation note from memory_bootstrap", async () => {
    const config = makeConfig()
    mcp.getMemoryConnectionKey.mockReturnValue("key-bootstrap")
    mcp.discoverTools.mockResolvedValue(["memory_bootstrap"])
    mcp.callMemoryToolJson.mockResolvedValue({
      active_tasks: [{ content: "TASK: finish bootstrap migration" }],
      stable_context: {
        DECISION: [{ content: "DECISION: keep old server fallback" }],
        USER: [{ content: "USER: prefer concise Chinese replies" }],
      },
      project: { status: "serving", project_id: "memory-plugin" },
      memory_health: { status: "degraded", gc_backlog: 3 },
      selection_summary: { returned: 3, truncated: true, reason: "token_budget" },
      summary: { partial: { reason_code: "partial", reason: "token budget reached" } },
    })

    const result = await buildBootstrapContext(config, {
      prompt: "继续",
      context: { namespace: "workspace-a", runId: "s1" },
    })

    expect(result).not.toBeNull()
    expect(result!.usedFallback).toBe(false)
    expect(result!.count).toBe(3)
    expect(result!.text).toContain("[MEMORY BOOTSTRAP] Active Tasks")
    expect(result!.text).toContain("TASK: finish bootstrap migration")
    expect(result!.text).toContain("DECISION: keep old server fallback")
    expect(result!.text).toContain("USER: prefer concise Chinese replies")
    expect(result!.text).toContain("[MEMORY BOOTSTRAP] Project Readiness")
    expect(result!.text).toContain("memory-plugin")
    expect(result!.text).toContain("reason_code: partial")
    expect(result!.text).toContain("truncated: token_budget")
    expect(mcp.callMemoryToolJson).toHaveBeenCalledWith(config, "memory_bootstrap", {
      prompt: "继续",
      namespace: "workspace-a",
      run_id: "s1",
      limit: 10,
      token_budget: 4000,
    })
  })

  it("returns null when memory_bootstrap is unsupported", async () => {
    const config = makeConfig()
    mcp.getMemoryConnectionKey.mockReturnValue("key-unsupported")
    mcp.discoverTools.mockResolvedValue(["memory_bootstrap"])
    mcp.callMemoryToolJson.mockResolvedValue({
      summary: { partial: { reason_code: "unsupported", reason: "old server" } },
    })

    await expect(buildBootstrapContext(config, { prompt: "hello" })).resolves.toBeNull()
  })

  it("returns null without calling server when capability is missing", async () => {
    const config = makeConfig()
    mcp.getMemoryConnectionKey.mockReturnValue("key-missing")
    mcp.discoverTools.mockResolvedValue(["recall"])

    await expect(buildBootstrapContext(config, { prompt: "hello" })).resolves.toBeNull()
    expect(mcp.callMemoryToolJson).not.toHaveBeenCalled()
  })

  it("returns null when memory_bootstrap call fails", async () => {
    const config = makeConfig()
    mcp.getMemoryConnectionKey.mockReturnValue("key-bootstrap-fail")
    mcp.discoverTools.mockResolvedValue(["memory_bootstrap"])
    mcp.callMemoryToolJson.mockRejectedValue(new Error("boom"))

    await expect(buildBootstrapContext(config, { prompt: "hello" })).resolves.toBeNull()
  })

  it("keeps grouped stable context legal prefixes and omits non-actionable health", async () => {
    const config = makeConfig()
    mcp.getMemoryConnectionKey.mockReturnValue("key-bootstrap-render")
    mcp.discoverTools.mockResolvedValue(["memory_bootstrap"])
    mcp.callMemoryToolJson.mockResolvedValue({
      stable_context: {
        DECISION: [{ content: "keep old server fallback" }],
      },
      memory_health: { status: "healthy" },
      selection_summary: { returned: 1, truncated: false },
      summary: { partial: { reason_code: "fresh" } },
    })

    const result = await buildBootstrapContext(config, { prompt: "hello" })

    expect(result!.text).toContain("- DECISION: keep old server fallback")
    expect(result!.text).not.toContain("[MEMORY BOOTSTRAP] Memory Health")
    expect(result!.text).not.toContain("[MEMORY BOOTSTRAP] Selection Summary")
    expect(result!.text).not.toContain("[MEMORY BOOTSTRAP] Partial Result")
  })
})

describe("createHookObservation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearServerCapabilityCache()
  })

  it("writes hook evidence through memory_observation_create when supported", async () => {
    const config = makeConfig()
    mcp.getMemoryConnectionKey.mockReturnValue("key-observation")
    mcp.discoverTools.mockResolvedValue(["memory_observation_create"])
    mcp.callMemoryToolJson.mockResolvedValue({ id: "obs-1", summary: { status: "ok" } })

    const ok = await createHookObservation(config, {
      content: "TASK: captured implementation follow-up",
      source: "codex-hook",
      eventType: "stop_ledger",
      confidence: 0.8,
      redactionState: "redacted",
      memoryType: "episodic",
      context: { runId: "s1", namespace: "workspace-a" },
      metadata: { hook: "Stop" },
    })

    expect(ok).toBe(true)
    expect(mcp.callMemoryToolJson).toHaveBeenCalledWith(config, "memory_observation_create", {
      content: "TASK: captured implementation follow-up",
      source: "codex-hook",
      event_type: "stop_ledger",
      namespace: "workspace-a",
      run_id: "s1",
      confidence: 0.8,
      redaction_state: "redacted",
      metadata: { hook: "Stop" },
      memory_type: "episodic",
    })
    expect(mcp.storeMemory).not.toHaveBeenCalled()
  })

  it("falls back to storeMemory with CONTEXT prefix when observation is missing", async () => {
    const config = makeConfig()
    mcp.getMemoryConnectionKey.mockReturnValue("key-old")
    mcp.discoverTools.mockResolvedValue(["store_memory"])
    mcp.storeMemory.mockResolvedValue(true)

    const ok = await createHookObservation(config, {
      content: "captured implementation follow-up",
      source: "opencode-hook",
      eventType: "session_idle",
      memoryType: "episodic",
      context: { runId: "s2" },
    })

    expect(ok).toBe(true)
    expect(mcp.callMemoryToolJson).not.toHaveBeenCalled()
    expect(mcp.storeMemory).toHaveBeenCalledWith(
      config,
      "CONTEXT: captured implementation follow-up",
      "episodic",
      expect.objectContaining({ runId: "s2" }),
    )
  })

  it("preserves pattern and bugfix prefixes in legacy fallback writes", async () => {
    const config = makeConfig()
    mcp.getMemoryConnectionKey.mockReturnValue("key-prefixes")
    mcp.discoverTools.mockResolvedValue(["store_memory"])
    mcp.storeMemory.mockResolvedValue(true)

    await createHookObservation(config, {
      content: "PATTERN: keep adapter shared",
      source: "opencode-hook",
      eventType: "session_idle",
      memoryType: "procedural",
    })
    await createHookObservation(config, {
      content: "BUGFIX: retry cache invalidation",
      source: "opencode-hook",
      eventType: "session_idle",
      memoryType: "episodic",
    })

    expect(mcp.storeMemory).toHaveBeenNthCalledWith(
      1,
      config,
      "PATTERN: keep adapter shared",
      "procedural",
      expect.anything(),
    )
    expect(mcp.storeMemory).toHaveBeenNthCalledWith(
      2,
      config,
      "BUGFIX: retry cache invalidation",
      "episodic",
      expect.anything(),
    )
  })

  it("uses legacy storage for pattern and bugfix observations while the server observation contract lacks those prefixes", async () => {
    const config = makeConfig()
    mcp.getMemoryConnectionKey.mockReturnValue("key-observation-prefixes")
    mcp.discoverTools.mockResolvedValue(["memory_observation_create"])
    mcp.storeMemory.mockResolvedValue(true)

    await createHookObservation(config, {
      content: "PATTERN: keep adapter shared",
      source: "codex-hook",
      eventType: "stop_ledger",
      memoryType: "procedural",
    })
    await createHookObservation(config, {
      content: "BUGFIX: retry cache invalidation",
      source: "codex-hook",
      eventType: "stop_ledger",
      memoryType: "episodic",
    })

    expect(mcp.callMemoryToolJson).not.toHaveBeenCalled()
    expect(mcp.storeMemory).toHaveBeenNthCalledWith(
      1,
      config,
      "PATTERN: keep adapter shared",
      "procedural",
      expect.anything(),
    )
    expect(mcp.storeMemory).toHaveBeenNthCalledWith(
      2,
      config,
      "BUGFIX: retry cache invalidation",
      "episodic",
      expect.anything(),
    )
  })

  it("merges default and provenance metadata into observation writes", async () => {
    const config = makeConfig()
    config.memoryScope.defaultMetadata = { workspace: "memory-plugin" }
    config.memoryScope.includeRunMetadata = true
    config.memoryScope.includeAgentMetadata = true
    mcp.getMemoryConnectionKey.mockReturnValue("key-observation-metadata")
    mcp.discoverTools.mockResolvedValue(["memory_observation_create"])
    mcp.callMemoryToolJson.mockResolvedValue({ id: "obs-1" })

    await createHookObservation(config, {
      content: "CONTEXT: captured",
      source: "codex-hook",
      eventType: "stop_ledger",
      context: {
        runId: "s1",
        agentId: "codex",
        metadata: { source: "context" },
      },
      metadata: { hook: "Stop" },
    })

    expect(mcp.callMemoryToolJson).toHaveBeenCalledWith(
      config,
      "memory_observation_create",
      expect.objectContaining({
        metadata: {
          workspace: "memory-plugin",
          source: "context",
          hook: "Stop",
          source_agent_id: "codex",
          source_run_id: "s1",
        },
      }),
    )
  })

  it("falls back to storeMemory when observation returns unsupported", async () => {
    const config = makeConfig()
    mcp.getMemoryConnectionKey.mockReturnValue("key-unsupported-observation")
    mcp.discoverTools.mockResolvedValue(["memory_observation_create"])
    mcp.callMemoryToolJson.mockResolvedValue({
      summary: { partial: { reason_code: "unsupported" } },
    })
    mcp.storeMemory.mockResolvedValue(true)

    await expect(createHookObservation(config, {
      content: "DECISION: keep fallback",
      source: "opencode-hook",
      eventType: "compact_summary",
      memoryType: "episodic",
    })).resolves.toBe(true)

    expect(mcp.storeMemory).toHaveBeenCalledWith(
      config,
      "DECISION: keep fallback",
      "episodic",
      expect.anything(),
    )
  })

  it("falls back to storeMemory when observation returns top-level unsupported", async () => {
    const config = makeConfig()
    mcp.getMemoryConnectionKey.mockReturnValue("key-top-level-unsupported-observation")
    mcp.discoverTools.mockResolvedValue(["memory_observation_create"])
    mcp.callMemoryToolJson.mockResolvedValue({
      status: "unsupported",
      reason_code: "unsupported",
    })
    mcp.storeMemory.mockResolvedValue(true)

    await expect(createHookObservation(config, {
      content: "DECISION: keep fallback for compatibility envelopes",
      source: "codex-hook",
      eventType: "stop_ledger",
      memoryType: "episodic",
    })).resolves.toBe(true)

    expect(mcp.storeMemory).toHaveBeenCalledWith(
      config,
      "DECISION: keep fallback for compatibility envelopes",
      "episodic",
      expect.anything(),
    )
  })
})

describe("audit and trace wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearServerCapabilityCache()
  })

  it("returns unsupported audit response when memory_audit is missing", async () => {
    const config = makeConfig()
    mcp.getMemoryConnectionKey.mockReturnValue("key-no-audit")
    mcp.discoverTools.mockResolvedValue(["recall"])

    await expect(getMemoryAudit(config, { detail: "summary" })).resolves.toEqual({
      status: "unsupported",
      reason_code: "unsupported",
      tool: "memory_audit",
    })
  })

  it("calls memory_search_trace when supported", async () => {
    const config = makeConfig()
    mcp.getMemoryConnectionKey.mockReturnValue("key-trace")
    mcp.discoverTools.mockResolvedValue(["memory_search_trace"])
    mcp.callMemoryToolJson.mockResolvedValue({ query: "memory", steps: [] })

    await expect(getMemorySearchTrace(config, { query: "memory", limit: 3 })).resolves.toEqual({ query: "memory", steps: [] })
    expect(mcp.callMemoryToolJson).toHaveBeenCalledWith(config, "memory_search_trace", { query: "memory", limit: 3 })
  })

  it("returns degraded audit and trace responses when calls fail", async () => {
    const config = makeConfig()
    mcp.getMemoryConnectionKey.mockReturnValue("key-debug-fail")
    mcp.discoverTools.mockResolvedValue(["memory_audit", "memory_search_trace"])
    mcp.callMemoryToolJson.mockRejectedValue(new Error("boom"))

    await expect(getMemoryAudit(config, { detail: "summary" })).resolves.toEqual({
      status: "degraded",
      reason_code: "degraded",
      tool: "memory_audit",
    })
    await expect(getMemorySearchTrace(config, { query: "memory" })).resolves.toEqual({
      status: "degraded",
      reason_code: "degraded",
      tool: "memory_search_trace",
    })
  })
})
