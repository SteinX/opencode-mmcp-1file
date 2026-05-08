import { describe, it, expect, vi, beforeEach } from "vitest"
import type { PluginConfig } from "../../src/config.js"

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

type MockClient = {
  connect: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  callTool: ReturnType<typeof vi.fn>
}

let clientInstances: MockClient[] = []
let nextClientResponses: unknown[][] = []

function makeMockClient(responses: unknown[]): MockClient {
  const callTool = vi.fn()
  for (const r of responses) {
    callTool.mockResolvedValueOnce(r)
  }
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    callTool,
  }
}

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: function MockClient() {
    const responses = nextClientResponses.shift() ?? []
    const instance = makeMockClient(responses)
    clientInstances.push(instance)
    return instance
  },
}))

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: function MockTransport() {
    return {}
  },
}))

let mockIsServerRunning = vi.fn()
let mockEnsureServerRunning = vi.fn()

vi.mock("../../src/services/server-process.js", () => ({
  isServerRunning: (...args: unknown[]) => mockIsServerRunning(...args),
  ensureServerRunning: (...args: unknown[]) => mockEnsureServerRunning(...args),
}))

let httpTransportInstances: { url: URL }[] = []

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: function MockHTTPTransport(url: URL) {
    const instance = { url }
    httpTransportInstances.push(instance)
    return instance
  },
}))

function makeConfig(): PluginConfig {
  return {
    chatMessage: { enabled: true, maxMemories: 5, maxProjectMemories: 30, maxInjectedMemories: 6, injectOn: "first", shortQueryMinLength: 3, minScore: 0.35 },
    autoCapture: { enabled: false, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    codeIndexSync: { enabled: true, debounceMs: 10000, minReindexIntervalMs: 300000 },
    preferenceLearning: { enabled: false, learnOnCorrections: true, learnOnNegations: true, learnOnMessageUpdated: true, injectOn: "first", scope: "project", minConfidence: 0.7, candidateConfidence: 0.4, maxPreferences: 5, maxCandidates: 3, debounceMs: 10000, maxInputChars: 4000, maxStoredPreferences: 50 },
    captureModel: { provider: "", model: "", apiUrl: "", apiKey: "" },
    memoryScope: { namespace: "", shareAcrossAgents: true, includeAgentMetadata: true, includeRunMetadata: false, userId: "", defaultMetadata: {} },
    mcpServer: { command: ["node", "server.js"], tag: "test", model: "qwen3", transport: "stdio", port: 23817, bind: "127.0.0.1", reconnectIntervalMs: 30000, heartbeatIntervalMs: 20000, mcpServerName: "memory-mcp-1file" },
    systemPrompt: { enabled: true },
  } as unknown as PluginConfig
}

function toolResponse(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] }
}

const EXPORT_RESPONSE = {
  jsonl: '{"id":"mem-1","content":"hello"}\n',
  exported_count: 1,
  truncated: false,
}

const DRY_RUN_OK_RESPONSE = {
  imported_count: 0,
  skipped_count: 0,
  failed_count: 0,
  errors: [],
  id_mappings: [],
}

const ACTUAL_IMPORT_RESPONSE = {
  imported_count: 5,
  skipped_count: 0,
  failed_count: 0,
  errors: [],
  id_mappings: [{ old_id: "a", new_id: "b" }],
}

describe("migrateMemory", () => {
  let migrateMemory: typeof import("../../src/services/memory-migration.js").migrateMemory

  beforeEach(async () => {
    clientInstances = []
    nextClientResponses = []
    httpTransportInstances = []
    mockIsServerRunning = vi.fn().mockResolvedValue(false)
    mockEnsureServerRunning = vi.fn().mockResolvedValue("http://127.0.0.1:23817")
    const mod = await import("../../src/services/memory-migration.js")
    migrateMemory = mod.migrateMemory
  })

  describe("selector validation", () => {
    it("blocks when source selector is missing", async () => {
      const report = await migrateMemory(makeConfig(), {
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
        target_tag: "target-shard",
      })
      expect(report.status).toBe("blocked")
      expect(clientInstances).toHaveLength(0)
    })

    it("uses current workspace when no target selector is provided", async () => {
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [toolResponse(DRY_RUN_OK_RESPONSE)],
      ]
      const report = await migrateMemory(makeConfig(), {
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
        source_tag: "source-shard",
      })
      expect(report.status).toBe("dry_run_passed")
      expect(clientInstances).toHaveLength(2)
    })

    it("blocks when both source_tag AND source_data_dir are provided", async () => {
      const report = await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        source_data_dir: "/tmp/test-source",
        target_tag: "target-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
      })
      expect(report.status).toBe("blocked")
      expect(clientInstances).toHaveLength(0)
    })

    it("blocks when source_project_id is missing", async () => {
      const report = await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        target_tag: "target-shard",
        source_project_id: "",
        target_project_id: "proj-tgt",
      })
      expect(report.status).toBe("blocked")
      expect(clientInstances).toHaveLength(0)
    })

    it("proceeds with preserve-source-project mode when target_project_id is empty", async () => {
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [toolResponse(DRY_RUN_OK_RESPONSE)],
      ]
      const report = await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        target_tag: "target-shard",
        source_project_id: "proj-src",
        target_project_id: "",
      })
      expect(report.status).toBe("dry_run_passed")
      expect(clientInstances).toHaveLength(2)
    })
  })

  describe("same shard blocking", () => {
    it("blocks when source_tag and target_tag resolve to the same path", async () => {
      const report = await migrateMemory(makeConfig(), {
        source_tag: "same-shard",
        target_tag: "same-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
      })
      expect(report.status).toBe("blocked")
      expect(clientInstances).toHaveLength(0)
    })

    it("blocks when source_data_dir and target_data_dir resolve to the same path", async () => {
      const report = await migrateMemory(makeConfig(), {
        source_data_dir: "/tmp/test-same",
        target_data_dir: "/tmp/test-same",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
      })
      expect(report.status).toBe("blocked")
      expect(clientInstances).toHaveLength(0)
    })
  })

  describe("dry-run success", () => {
    it("calls export_memory on source and import_memory with dry_run:true on target", async () => {
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [toolResponse(DRY_RUN_OK_RESPONSE)],
      ]

      const report = await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        target_tag: "target-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
      })

      expect(report.status).toBe("dry_run_passed")
      expect(report.dryRun).toBe(true)
      expect(clientInstances).toHaveLength(2)

      const [sourceClient, targetClient] = clientInstances
      expect(sourceClient.callTool).toHaveBeenCalledTimes(1)
      expect(sourceClient.callTool).toHaveBeenCalledWith(expect.objectContaining({ name: "export_memory" }))
      expect(targetClient.callTool).toHaveBeenCalledTimes(1)
      expect(targetClient.callTool.mock.calls[0][0].name).toBe("import_memory")
      expect(targetClient.callTool.mock.calls[0][0].arguments.dry_run).toBe(true)
    })
  })

  describe("actual migration", () => {
    it("dry_run=false, confirm=true calls export, dry-run import, then actual import", async () => {
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [toolResponse(DRY_RUN_OK_RESPONSE), toolResponse(ACTUAL_IMPORT_RESPONSE)],
      ]

      const report = await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        target_tag: "target-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
        dry_run: false,
        confirm: true,
      })

      expect(report.status).toBe("migrated")
      expect(report.dryRun).toBe(false)
      expect(report.importedCount).toBe(5)
      expect(report.idMappings).toEqual([{ old_id: "a", new_id: "b" }])

      const targetClient = clientInstances[1]
      expect(targetClient.callTool).toHaveBeenCalledTimes(2)
      expect(targetClient.callTool.mock.calls[0][0].arguments.dry_run).toBe(true)
      expect(targetClient.callTool.mock.calls[1][0].arguments.dry_run).toBe(false)
    })
  })

  describe("dry-run errors block actual import", () => {
    it("returns dry_run_failed and skips actual import when dry-run has errors", async () => {
      const DRY_RUN_ERROR_RESPONSE = {
        imported_count: 0,
        skipped_count: 0,
        failed_count: 1,
        errors: [{ code: "conflict", message: "duplicate id" }],
        id_mappings: [],
      }
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [toolResponse(DRY_RUN_ERROR_RESPONSE)],
      ]

      const report = await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        target_tag: "target-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
        dry_run: false,
        confirm: true,
      })

      expect(report.status).toBe("dry_run_failed")
      expect(clientInstances[1].callTool).toHaveBeenCalledTimes(1)
      expect(clientInstances[1].callTool.mock.calls[0][0].arguments.dry_run).toBe(true)
    })
  })

  describe("malformed response", () => {
    it("returns dry_run_passed when export_memory returns non-JSON (empty jsonl passed to import)", async () => {
      nextClientResponses = [
        [{ content: [{ type: "text", text: "not-json" }] }],
        [toolResponse(DRY_RUN_OK_RESPONSE)],
      ]

      const report = await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        target_tag: "target-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
      })

      expect(report.status).toBe("dry_run_passed")
    })

    it("returns dry_run_failed when import_memory returns non-JSON", async () => {
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [{ content: [{ type: "text", text: "not-json" }] }],
      ]

      const report = await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        target_tag: "target-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
      })

      expect(report.status).toBe("dry_run_failed")
    })
  })

  describe("archive opt-in", () => {
    it("include_invalidated=true sets valid_only:false and allow_invalidated:true in export/import", async () => {
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [toolResponse(DRY_RUN_OK_RESPONSE)],
      ]

      await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        target_tag: "target-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
        include_invalidated: true,
      })

      const exportArgs = clientInstances[0].callTool.mock.calls[0][0].arguments
      expect(exportArgs.valid_only).toBe(false)
      expect(exportArgs.include_invalidated).toBe(true)

      const importArgs = clientInstances[1].callTool.mock.calls[0][0].arguments
      expect(importArgs.allow_invalidated).toBe(true)
    })
  })

  describe("namespace opt-in", () => {
    it("source_namespace and target_namespace are passed to export/import args", async () => {
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [toolResponse(DRY_RUN_OK_RESPONSE)],
      ]

      await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        target_tag: "target-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
        source_namespace: "ns-src",
        target_namespace: "ns-tgt",
      })

      expect(clientInstances[0].callTool.mock.calls[0][0].arguments.namespace).toBe("ns-src")
      expect(clientInstances[1].callTool.mock.calls[0][0].arguments.namespace).toBe("ns-tgt")
    })

    it("namespace is omitted from args when not provided", async () => {
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [toolResponse(DRY_RUN_OK_RESPONSE)],
      ]

      await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        target_tag: "target-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
      })

      expect(clientInstances[0].callTool.mock.calls[0][0].arguments).not.toHaveProperty("namespace")
      expect(clientInstances[1].callTool.mock.calls[0][0].arguments).not.toHaveProperty("namespace")
    })
  })

  describe("client cleanup", () => {
    it("closes source client in finally block even when export returns unparseable response", async () => {
      nextClientResponses = [
        [{ content: [{ type: "text", text: "not-json-so-export-fails" }] }],
        [],
      ]

      const report = await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        target_tag: "target-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
      })

      expect(report.status).toBe("failed")
      expect(clientInstances[0].close).toHaveBeenCalled()
    })

    it("closes both clients on successful dry-run", async () => {
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [toolResponse(DRY_RUN_OK_RESPONSE)],
      ]

      await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        target_tag: "target-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
      })

      for (const client of clientInstances) {
        expect(client.close).toHaveBeenCalled()
      }
    })
  })

  describe("default args", () => {
    it("export defaults to valid_only:true, include_invalidated:false, limit:1000", async () => {
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [toolResponse(DRY_RUN_OK_RESPONSE)],
      ]

      await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        target_tag: "target-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
      })

      const exportArgs = clientInstances[0].callTool.mock.calls[0][0].arguments
      expect(exportArgs.valid_only).toBe(true)
      expect(exportArgs.include_invalidated).toBe(false)
      expect(exportArgs.limit).toBe(1000)
    })

    it("import defaults to conflict_strategy:remap, preserve_project_id:false, allow_invalidated:false", async () => {
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [toolResponse(DRY_RUN_OK_RESPONSE)],
      ]

      await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        target_tag: "target-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
      })

      const importArgs = clientInstances[1].callTool.mock.calls[0][0].arguments
      expect(importArgs.conflict_strategy).toBe("remap")
      expect(importArgs.preserve_project_id).toBe(false)
      expect(importArgs.allow_invalidated).toBe(false)
    })
  })

  describe("project mode (retarget vs preserve-source-project)", () => {
    it("retarget mode: sends project_id and preserve_project_id:false when target_project_id is provided", async () => {
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [toolResponse(DRY_RUN_OK_RESPONSE)],
      ]

      const report = await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        target_tag: "target-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
      })

      const importArgs = clientInstances[1].callTool.mock.calls[0][0].arguments
      expect(importArgs.project_id).toBe("proj-tgt")
      expect(importArgs.preserve_project_id).toBe(false)
      expect(report.targetProjectMode).toBe("retarget")
    })

    it("preserve-source-project mode: omits project_id and sends preserve_project_id:true when target_project_id is omitted", async () => {
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [toolResponse(DRY_RUN_OK_RESPONSE)],
      ]

      const report = await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        target_tag: "target-shard",
        source_project_id: "proj-src",
      })

      const importArgs = clientInstances[1].callTool.mock.calls[0][0].arguments
      expect(importArgs).not.toHaveProperty("project_id")
      expect(importArgs.preserve_project_id).toBe(true)
      expect(report.targetProjectMode).toBe("preserve-source-project")
    })

    it("preserve-source-project mode: empty string target_project_id treated same as omitted", async () => {
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [toolResponse(DRY_RUN_OK_RESPONSE)],
      ]

      const report = await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        target_tag: "target-shard",
        source_project_id: "proj-src",
        target_project_id: "   ",
      })

      const importArgs = clientInstances[1].callTool.mock.calls[0][0].arguments
      expect(importArgs).not.toHaveProperty("project_id")
      expect(importArgs.preserve_project_id).toBe(true)
      expect(report.targetProjectMode).toBe("preserve-source-project")
    })

    it("dry-run with preserve mode: dry-run import called with preserve_project_id:true and no project_id", async () => {
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [toolResponse(DRY_RUN_OK_RESPONSE)],
      ]

      await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        target_tag: "target-shard",
        source_project_id: "proj-src",
        dry_run: true,
      })

      const importArgs = clientInstances[1].callTool.mock.calls[0][0].arguments
      expect(importArgs.dry_run).toBe(true)
      expect(importArgs).not.toHaveProperty("project_id")
      expect(importArgs.preserve_project_id).toBe(true)
    })
  })

  describe("HTTP target routing", () => {
    function makeHttpConfig(): PluginConfig {
      const cfg = makeConfig()
      return { ...cfg, mcpServer: { ...cfg.mcpServer, transport: "http" } } as unknown as PluginConfig
    }

    it("uses StreamableHTTPClientTransport when target is current-http and server was already running", async () => {
      mockIsServerRunning.mockResolvedValue(true)
      mockEnsureServerRunning.mockResolvedValue("http://127.0.0.1:23817")
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [toolResponse(DRY_RUN_OK_RESPONSE)],
      ]

      const report = await migrateMemory(makeHttpConfig(), {
        source_tag: "source-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
      })

      expect(report.status).toBe("dry_run_passed")
      expect(httpTransportInstances).toHaveLength(1)
      expect(httpTransportInstances[0].url.pathname).toBe("/mcp")
      expect(report.targetRuntimeWasRunning).toBe(true)
      expect(report.targetRuntimeStarted).toBe(false)
      expect(report.targetServerUrl).toBe("http://127.0.0.1:23817")
    })

    it("starts server and sets runtimeStarted:true when server was not running", async () => {
      mockIsServerRunning.mockResolvedValue(false)
      mockEnsureServerRunning.mockResolvedValue("http://127.0.0.1:23817")
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [toolResponse(DRY_RUN_OK_RESPONSE)],
      ]

      const report = await migrateMemory(makeHttpConfig(), {
        source_tag: "source-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
      })

      expect(report.status).toBe("dry_run_passed")
      expect(report.targetRuntimeWasRunning).toBe(false)
      expect(report.targetRuntimeStarted).toBe(true)
      expect(httpTransportInstances).toHaveLength(1)
    })

    it("returns failed status and does not fall back to stdio when ensureServerRunning throws", async () => {
      mockIsServerRunning.mockResolvedValue(false)
      mockEnsureServerRunning.mockRejectedValue(new Error("port in use"))
      nextClientResponses = []

      const report = await migrateMemory(makeHttpConfig(), {
        source_tag: "source-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
      })

      expect(report.status).toBe("failed")
      expect(httpTransportInstances).toHaveLength(0)
    })

    it("uses StdioClientTransport for stdio current target and does not call isServerRunning", async () => {
      nextClientResponses = [
        [toolResponse(EXPORT_RESPONSE)],
        [toolResponse(DRY_RUN_OK_RESPONSE)],
      ]

      const report = await migrateMemory(makeConfig(), {
        source_tag: "source-shard",
        source_project_id: "proj-src",
        target_project_id: "proj-tgt",
      })

      expect(report.status).toBe("dry_run_passed")
      expect(mockIsServerRunning).not.toHaveBeenCalled()
      expect(httpTransportInstances).toHaveLength(0)
    })
  })
})
