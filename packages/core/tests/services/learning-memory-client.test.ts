import { describe, it, expect, vi, beforeEach } from "vitest"
import type { PluginConfig } from "../../src/config.js"

function makeConfig(): PluginConfig {
  return {
    chatMessage: { enabled: true, maxMemories: 5, maxProjectMemories: 30, maxInjectedMemories: 6, injectOn: "first", shortQueryMinLength: 3, minScore: 0.35 },
    autoCapture: { enabled: true, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    codeIndexSync: { enabled: true, autoRefresh: false, debounceMs: 10000, minReindexIntervalMs: 300000 },
    preferenceLearning: { enabled: false, learnOnCorrections: true, learnOnNegations: true, learnOnMessageUpdated: true, injectOn: "first", scope: "project", minConfidence: 0.7, candidateConfidence: 0.4, maxPreferences: 5, maxCandidates: 3, debounceMs: 10000, maxInputChars: 4000, maxStoredPreferences: 50 },
    captureModel: { provider: "openai", model: "gpt-4o-mini", apiUrl: "", apiKey: "" },
    memoryScope: { namespace: "", shareAcrossAgents: true, includeAgentMetadata: true, includeRunMetadata: false, userId: "", defaultMetadata: {} },
    mcpServer: { command: ["npx", "-y", "@steinx/memory-mcp-1file"], tag: "default", model: "qwen3", transport: "stdio", port: 23817, bind: "127.0.0.1", reconnectIntervalMs: 30000, heartbeatIntervalMs: 20000, mcpServerName: "memory-mcp-1file" },
    systemPrompt: { enabled: true },
  } as PluginConfig
}

const mockCallMemoryTool = vi.fn()

vi.mock("../../src/services/mcp-client.js", () => ({
  callMemoryTool: (...args: unknown[]) => mockCallMemoryTool(...args),
}))

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

const CANDIDATE_RECORD = {
  id: "memory:create-example",
  content: "Prefer concise Chinese responses without GPT-style filler.",
  memory_type: "semantic",
  metadata: {
    learning: {
      schema_version: 1,
      kind: "user_preference",
      status: "candidate",
      confidence: 0.8,
      scope: { level: "project", project_id: "memory-plugin" },
      source: { created_from: "plugin", client: "opencode-plugin", source_memory_ids: [] },
    },
  },
  valid_until: null,
  invalidation_reason: null,
  superseded_by: null,
}

const CANDIDATE_LEARNING_SUMMARY = {
  schema_version: 1,
  kind: "user_preference",
  status: "candidate",
  lifecycle_state: "candidate",
  included_in_default_list: true,
  included_in_default_search: false,
  injectable_by_default: false,
}

const CONFIRMED_RECORD = {
  id: "memory:confirmed-example",
  content: "Prefer concise Chinese responses without GPT-style filler.",
  memory_type: "semantic",
  metadata: { learning: { schema_version: 1, kind: "user_preference", status: "confirmed" } },
  valid_until: null,
  invalidation_reason: null,
  superseded_by: null,
}

const CONFIRMED_LEARNING_SUMMARY = {
  schema_version: 1,
  kind: "user_preference",
  status: "confirmed",
  lifecycle_state: "active",
  included_in_default_list: true,
  included_in_default_search: true,
  injectable_by_default: true,
}

function makeOkEnvelope(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    contract: { schema_version: 1 },
    summary: { partial: { reason_code: null } },
    ...extra,
  })
}

function makePartialEnvelope(reasonCode: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    contract: { schema_version: 1 },
    summary: { partial: { reason_code: reasonCode } },
    ...extra,
  })
}

describe("createLearningMemory", () => {
  it("returns ok with parsed record on happy path", async () => {
    mockCallMemoryTool.mockResolvedValue(makeOkEnvelope({
      record: CANDIDATE_RECORD,
      learning_summary: CANDIDATE_LEARNING_SUMMARY,
    }))

    const { createLearningMemory } = await import("../../src/services/learning-memory-client.js")
    const result = await createLearningMemory(makeConfig(), {
      content: "Prefer concise Chinese responses without GPT-style filler.",
      kind: "user_preference",
      status: "candidate",
      confidence: 0.8,
    })

    expect(result.status).toBe("ok")
    expect(result.reason_code).toBeNull()
    expect(result.record?.id).toBe("memory:create-example")
    expect(result.record?.metadata.learning.kind).toBe("user_preference")
    expect(result.record?.metadata.learning.status).toBe("candidate")
    expect(result.learning_summary?.injectable_by_default).toBe(false)
    expect(result.learning_summary?.included_in_default_list).toBe(true)
    expect(result.learning_summary?.included_in_default_search).toBe(false)
    expect(result.learning_summary?.lifecycle_state).toBe("candidate")
  })

  it("returns unsupported when server returns unknown tool error", async () => {
    mockCallMemoryTool.mockRejectedValue(new Error("unknown tool: learning_memory_create"))

    const { createLearningMemory } = await import("../../src/services/learning-memory-client.js")
    const result = await createLearningMemory(makeConfig(), { content: "x", kind: "user_preference" })

    expect(result.status).toBe("unsupported")
    expect(result.record).toBeUndefined()
  })

  it("returns failed on unexpected error", async () => {
    mockCallMemoryTool.mockRejectedValue(new Error("connection refused"))

    const { createLearningMemory } = await import("../../src/services/learning-memory-client.js")
    const result = await createLearningMemory(makeConfig(), { content: "x", kind: "user_preference" })

    expect(result.status).toBe("failed")
  })

  it("returns unavailable when server is unavailable", async () => {
    mockCallMemoryTool.mockRejectedValue(new Error("Memory server unavailable — auto-reconnecting in background"))

    const { createLearningMemory } = await import("../../src/services/learning-memory-client.js")
    const result = await createLearningMemory(makeConfig(), { content: "x", kind: "user_preference" })

    expect(result.status).toBe("unavailable")
  })
})

describe("getLearningMemory", () => {
  it("returns ok with confirmed record on happy path", async () => {
    mockCallMemoryTool.mockResolvedValue(makeOkEnvelope({
      record: CONFIRMED_RECORD,
      learning_summary: CONFIRMED_LEARNING_SUMMARY,
    }))

    const { getLearningMemory } = await import("../../src/services/learning-memory-client.js")
    const result = await getLearningMemory(makeConfig(), { id: "memory:confirmed-example" })

    expect(result.status).toBe("ok")
    expect(result.record?.id).toBe("memory:confirmed-example")
    expect(result.learning_summary?.injectable_by_default).toBe(true)
    expect(result.learning_summary?.lifecycle_state).toBe("active")
  })

  it("returns unsupported on unknown tool error", async () => {
    mockCallMemoryTool.mockRejectedValue(new Error("tool not found: learning_memory_get"))

    const { getLearningMemory } = await import("../../src/services/learning-memory-client.js")
    const result = await getLearningMemory(makeConfig(), { id: "memory:x" })

    expect(result.status).toBe("unsupported")
  })
})

describe("listLearningMemories", () => {
  it("returns ok with empty records list", async () => {
    mockCallMemoryTool.mockResolvedValue(makeOkEnvelope({
      records: [],
      learning_summary: { schema_version: 1, result_count: 0, default_included_status: ["candidate", "confirmed", "rule"] },
    }))

    const { listLearningMemories } = await import("../../src/services/learning-memory-client.js")
    const result = await listLearningMemories(makeConfig(), {
      scope: { level: "project", project_id: "memory-plugin" },
      include_status: ["candidate", "confirmed", "rule"],
    })

    expect(result.status).toBe("ok")
    expect(result.records).toHaveLength(0)
    expect(result.learning_summary?.result_count).toBe(0)
    expect(result.learning_summary?.default_included_status).toEqual(["candidate", "confirmed", "rule"])
  })

  it("returns ok with populated records", async () => {
    mockCallMemoryTool.mockResolvedValue(makeOkEnvelope({
      records: [CONFIRMED_RECORD],
      learning_summary: CONFIRMED_LEARNING_SUMMARY,
    }))

    const { listLearningMemories } = await import("../../src/services/learning-memory-client.js")
    const result = await listLearningMemories(makeConfig(), {})

    expect(result.status).toBe("ok")
    expect(result.records).toHaveLength(1)
    expect(result.records[0].id).toBe("memory:confirmed-example")
  })

  it("returns unsupported on unknown tool error", async () => {
    mockCallMemoryTool.mockRejectedValue(new Error("unknown tool: learning_memory_list"))

    const { listLearningMemories } = await import("../../src/services/learning-memory-client.js")
    const result = await listLearningMemories(makeConfig(), {})

    expect(result.status).toBe("unsupported")
    expect(result.records).toHaveLength(0)
  })
})

describe("searchLearningMemories", () => {
  it("returns ok with matching records on happy path", async () => {
    const ruleRecord = {
      id: "memory:rule-example",
      content: "Use concise Chinese for plugin protocol answers.",
      memory_type: "procedural",
      metadata: { learning: { schema_version: 1, kind: "workflow_rule", status: "rule" } },
      valid_until: null,
      invalidation_reason: null,
      superseded_by: null,
    }
    mockCallMemoryTool.mockResolvedValue(makeOkEnvelope({
      records: [ruleRecord],
      learning_summary: { schema_version: 1, default_included_status: ["confirmed", "rule"] },
    }))

    const { searchLearningMemories } = await import("../../src/services/learning-memory-client.js")
    const result = await searchLearningMemories(makeConfig(), {
      query: "response style",
      scope: { level: "project", project_id: "memory-plugin" },
    })

    expect(result.status).toBe("ok")
    expect(result.records).toHaveLength(1)
    expect(result.records[0].metadata.learning.kind).toBe("workflow_rule")
  })

  it("returns unsupported when reason_code is unsupported — no injection", async () => {
    mockCallMemoryTool.mockResolvedValue(makePartialEnvelope("unsupported", {
      records: [],
      learning_summary: { schema_version: 1, result_count: 0, injectable_by_default: false },
    }))

    const { searchLearningMemories } = await import("../../src/services/learning-memory-client.js")
    const result = await searchLearningMemories(makeConfig(), { query: "response style" })

    expect(result.status).toBe("unsupported")
    expect(result.records).toHaveLength(0)
    expect(result.learning_summary?.injectable_by_default).toBe(false)
  })

  it("returns degraded when reason_code is degraded — visible but not injectable", async () => {
    mockCallMemoryTool.mockResolvedValue(makePartialEnvelope("degraded", {
      records: [],
      learning_summary: { schema_version: 1, result_count: 0, injectable_by_default: false },
    }))

    const { searchLearningMemories } = await import("../../src/services/learning-memory-client.js")
    const result = await searchLearningMemories(makeConfig(), { query: "response style" })

    expect(result.status).toBe("degraded")
    expect(result.learning_summary?.injectable_by_default).toBe(false)
  })

  it("returns stale when reason_code is stale — visible but not injectable", async () => {
    mockCallMemoryTool.mockResolvedValue(makePartialEnvelope("stale", {
      records: [],
      learning_summary: { schema_version: 1, result_count: 0, injectable_by_default: false },
    }))

    const { searchLearningMemories } = await import("../../src/services/learning-memory-client.js")
    const result = await searchLearningMemories(makeConfig(), { query: "response style" })

    expect(result.status).toBe("stale")
    expect(result.learning_summary?.injectable_by_default).toBe(false)
  })

  it("returns generation_mismatch when reason_code is generation_mismatch", async () => {
    mockCallMemoryTool.mockResolvedValue(makePartialEnvelope("generation_mismatch", {
      records: [],
      learning_summary: { schema_version: 1, result_count: 0, injectable_by_default: false },
    }))

    const { searchLearningMemories } = await import("../../src/services/learning-memory-client.js")
    const result = await searchLearningMemories(makeConfig(), { query: "response style" })

    expect(result.status).toBe("generation_mismatch")
    expect(result.learning_summary?.injectable_by_default).toBe(false)
  })
})

describe("updateLearningMemory", () => {
  it("returns ok with updated record", async () => {
    const updatedRecord = {
      ...CONFIRMED_RECORD,
      content: "Prefer concise Chinese responses.",
    }
    mockCallMemoryTool.mockResolvedValue(makeOkEnvelope({
      record: updatedRecord,
      learning_summary: CONFIRMED_LEARNING_SUMMARY,
    }))

    const { updateLearningMemory } = await import("../../src/services/learning-memory-client.js")
    const result = await updateLearningMemory(makeConfig(), {
      id: "memory:confirmed-example",
      content: "Prefer concise Chinese responses.",
    })

    expect(result.status).toBe("ok")
    expect(result.record?.content).toBe("Prefer concise Chinese responses.")
  })
})

describe("promoteLearningMemory", () => {
  it("returns ok with promoted record as rule", async () => {
    const promotedRecord = {
      ...CANDIDATE_RECORD,
      memory_type: "procedural",
      metadata: { learning: { schema_version: 1, kind: "user_preference", status: "rule" } },
    }
    mockCallMemoryTool.mockResolvedValue(makeOkEnvelope({
      record: promotedRecord,
      learning_summary: {
        schema_version: 1,
        kind: "user_preference",
        status: "rule",
        lifecycle_state: "active",
        included_in_default_list: true,
        included_in_default_search: true,
        injectable_by_default: true,
      },
    }))

    const { promoteLearningMemory } = await import("../../src/services/learning-memory-client.js")
    const result = await promoteLearningMemory(makeConfig(), {
      id: "memory:create-example",
      target_status: "rule",
    })

    expect(result.status).toBe("ok")
    expect(result.record?.metadata.learning.status).toBe("rule")
    expect(result.learning_summary?.injectable_by_default).toBe(true)
  })
})

describe("rejectLearningMemory", () => {
  it("returns ok with rejected record — not injectable", async () => {
    const rejectedRecord = {
      ...CANDIDATE_RECORD,
      metadata: { learning: { schema_version: 1, kind: "user_preference", status: "rejected" } },
      valid_until: "2026-05-10T00:00:00Z",
      invalidation_reason: "learning_rejected",
    }
    mockCallMemoryTool.mockResolvedValue(makeOkEnvelope({
      record: rejectedRecord,
      learning_summary: {
        schema_version: 1,
        kind: "user_preference",
        status: "rejected",
        lifecycle_state: "rejected",
        included_in_default_list: false,
        included_in_default_search: false,
        injectable_by_default: false,
      },
    }))

    const { rejectLearningMemory } = await import("../../src/services/learning-memory-client.js")
    const result = await rejectLearningMemory(makeConfig(), {
      id: "memory:create-example",
      reason: "User rejected this learning",
    })

    expect(result.status).toBe("ok")
    expect(result.record?.invalidation_reason).toBe("learning_rejected")
    expect(result.record?.valid_until).toBe("2026-05-10T00:00:00Z")
    expect(result.learning_summary?.injectable_by_default).toBe(false)
    expect(result.learning_summary?.lifecycle_state).toBe("rejected")
  })
})

describe("archiveLearningMemory", () => {
  it("returns ok with archived record — not injectable", async () => {
    const archivedRecord = {
      ...CONFIRMED_RECORD,
      metadata: { learning: { schema_version: 1, kind: "user_preference", status: "archived" } },
      valid_until: "2026-05-10T00:00:00Z",
      invalidation_reason: "learning_archived",
    }
    mockCallMemoryTool.mockResolvedValue(makeOkEnvelope({
      record: archivedRecord,
      learning_summary: {
        schema_version: 1,
        kind: "user_preference",
        status: "archived",
        lifecycle_state: "archived",
        included_in_default_list: false,
        included_in_default_search: false,
        injectable_by_default: false,
      },
    }))

    const { archiveLearningMemory } = await import("../../src/services/learning-memory-client.js")
    const result = await archiveLearningMemory(makeConfig(), { id: "memory:confirmed-example" })

    expect(result.status).toBe("ok")
    expect(result.record?.invalidation_reason).toBe("learning_archived")
    expect(result.learning_summary?.lifecycle_state).toBe("archived")
    expect(result.learning_summary?.injectable_by_default).toBe(false)
  })
})

describe("supersedeLearningMemory", () => {
  it("returns ok with superseded record and replacement lineage", async () => {
    const supersededRecord = {
      id: "memory:old-pref",
      content: "Old preference.",
      memory_type: "semantic",
      metadata: { learning: { schema_version: 1, kind: "user_preference", status: "superseded" } },
      valid_until: "2026-05-10T00:00:00Z",
      invalidation_reason: "superseded",
      superseded_by: "memory:new-pref",
    }
    mockCallMemoryTool.mockResolvedValue(makeOkEnvelope({
      record: supersededRecord,
      learning_summary: {
        schema_version: 1,
        kind: "user_preference",
        status: "superseded",
        lifecycle_state: "superseded",
        included_in_default_list: false,
        included_in_default_search: false,
        injectable_by_default: false,
      },
      replacement_lineage: {
        chain_ids: ["memory:new-pref"],
        depth: 1,
        terminal_replacement_id: "memory:new-pref",
        cycle_detected: false,
        truncated: false,
      },
    }))

    const { supersedeLearningMemory } = await import("../../src/services/learning-memory-client.js")
    const result = await supersedeLearningMemory(makeConfig(), {
      id: "memory:old-pref",
      replacement_id: "memory:new-pref",
    })

    expect(result.status).toBe("ok")
    expect(result.record?.superseded_by).toBe("memory:new-pref")
    expect(result.record?.invalidation_reason).toBe("superseded")
    expect(result.replacement_lineage?.terminal_replacement_id).toBe("memory:new-pref")
    expect(result.replacement_lineage?.depth).toBe(1)
    expect(result.replacement_lineage?.cycle_detected).toBe(false)
    expect(result.learning_summary?.lifecycle_state).toBe("superseded")
  })
})

describe("migrateLegacyLearningMemories", () => {
  it("returns ok with dry_run counts and proposed list", async () => {
    mockCallMemoryTool.mockResolvedValue(makeOkEnvelope({
      dry_run: true,
      counts: { scanned: 1, eligible: 1, created: 0, skipped: 0, ambiguous: 0, already_migrated: 0, invalidated_skipped: 0 },
      proposed: [{ source_memory_id: "memory:legacy-123", kind: "user_preference", status: "confirmed" }],
    }))

    const { migrateLegacyLearningMemories } = await import("../../src/services/learning-memory-client.js")
    const result = await migrateLegacyLearningMemories(makeConfig(), {
      dry_run: true,
      source_prefixes: ["USER — Preference:"],
      scope: { level: "project", project_id: "memory-plugin" },
    })

    expect(result.status).toBe("ok")
    expect(result.dry_run).toBe(true)
    expect(result.counts?.scanned).toBe(1)
    expect(result.counts?.eligible).toBe(1)
    expect(result.proposed).toHaveLength(1)
    expect(result.proposed?.[0]).toMatchObject({ source_memory_id: "memory:legacy-123" })
  })

  it("returns unsupported on unknown tool error", async () => {
    mockCallMemoryTool.mockRejectedValue(new Error("unknown tool: learning_memory_migrate_legacy"))

    const { migrateLegacyLearningMemories } = await import("../../src/services/learning-memory-client.js")
    const result = await migrateLegacyLearningMemories(makeConfig(), { dry_run: true })

    expect(result.status).toBe("unsupported")
  })
})

describe("deleteLearningMemory (soft compat shim)", () => {
  it("returns unsupported when server does not expose the tool", async () => {
    mockCallMemoryTool.mockRejectedValue(new Error("unknown tool: learning_memory_delete"))

    const { deleteLearningMemory } = await import("../../src/services/learning-memory-client.js")
    const result = await deleteLearningMemory(makeConfig(), { id: "memory:x" })

    expect(result.status).toBe("unsupported")
  })

  it("returns ok when server exposes the shim", async () => {
    mockCallMemoryTool.mockResolvedValue(makeOkEnvelope({
      record: CONFIRMED_RECORD,
      learning_summary: CONFIRMED_LEARNING_SUMMARY,
    }))

    const { deleteLearningMemory } = await import("../../src/services/learning-memory-client.js")
    const result = await deleteLearningMemory(makeConfig(), { id: "memory:confirmed-example" })

    expect(result.status).toBe("ok")
  })
})

describe("callMemoryTool integration — args passthrough", () => {
  it("passes tool name and args to callMemoryTool", async () => {
    mockCallMemoryTool.mockResolvedValue(makeOkEnvelope({
      record: CANDIDATE_RECORD,
      learning_summary: CANDIDATE_LEARNING_SUMMARY,
    }))

    const { createLearningMemory } = await import("../../src/services/learning-memory-client.js")
    await createLearningMemory(makeConfig(), {
      content: "test content",
      kind: "project_lesson",
      status: "candidate",
    })

    expect(mockCallMemoryTool).toHaveBeenCalledWith(
      expect.anything(),
      "learning_memory_create",
      expect.objectContaining({ content: "test content", kind: "project_lesson" }),
    )
  })
})
