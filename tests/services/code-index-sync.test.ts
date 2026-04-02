import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { PluginConfig } from "../../src/config.js"

vi.mock("../../src/services/mcp-client.js", () => ({
  callMemoryTool: vi.fn().mockResolvedValue('{"status":"ok"}'),
}))

vi.mock("../../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const { callMemoryTool } = await import("../../src/services/mcp-client.js")
const {
  __testOnly,
  computeWorkspaceFingerprint,
  ensureCodeIndexFresh,
  resetCodeIndexSyncState,
} = await import("../../src/services/code-index-sync.js")

function makeConfig(dataDir: string): PluginConfig {
  return {
    chatMessage: { enabled: true, maxMemories: 5, maxProjectMemories: 30, injectOn: "first" },
    autoCapture: { enabled: false, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    codeIndexSync: { enabled: true, debounceMs: 50, minReindexIntervalMs: 300000 },
    captureModel: { provider: "", model: "", apiUrl: "", apiKey: "" },
    mcpServer: {
      command: ["npm", "exec", "-y", "memory-mcp-1file", "--"],
      tag: "",
      dataDir,
      model: "qwen3",
      mcpServerName: "memory-mcp-1file",
      transport: "stdio",
      port: 23817,
      bind: "127.0.0.1",
    },
    systemPrompt: { enabled: true },
  }
}

describe("code-index-sync", () => {
  let rootDir: string
  let workspaceDir: string
  let dataDir: string

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    rootDir = mkdtempSync(join(tmpdir(), "mmcp-code-index-sync-"))
    workspaceDir = join(rootDir, "workspace")
    dataDir = join(rootDir, "data")
    mkdirSync(workspaceDir, { recursive: true })
    mkdirSync(join(workspaceDir, "src"), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(workspaceDir, "package.json"), '{"name":"fixture"}')
    writeFileSync(join(workspaceDir, "src", "index.ts"), "export const value = 1\n")
  })

  afterEach(() => {
    resetCodeIndexSyncState()
    vi.useRealTimers()
    rmSync(rootDir, { recursive: true, force: true })
  })

  it("tracks relevant source and config paths", () => {
    const helpers = __testOnly()
    expect(helpers.shouldTrackPathForCodeIndex("src/index.ts")).toBe(true)
    expect(helpers.shouldTrackPathForCodeIndex("package.json")).toBe(true)
    expect(helpers.shouldTrackPathForCodeIndex("assets/logo.png")).toBe(false)
  })

  it("computes a fingerprint for tracked workspace files", () => {
    const fingerprint = computeWorkspaceFingerprint(workspaceDir)
    expect(typeof fingerprint).toBe("string")
    expect(fingerprint).toHaveLength(40)
  })

  it("reindexes after debounce when workspace fingerprint is new", async () => {
    const config = makeConfig(dataDir)

    await ensureCodeIndexFresh(config, workspaceDir, "startup")
    expect(callMemoryTool).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(50)

    expect(callMemoryTool).toHaveBeenCalledWith(config, "index_project", {
      path: workspaceDir,
      force: true,
    })

    const statePath = __testOnly().getIndexStatePath(config)
    expect(statePath).toBeTruthy()
    const saved = JSON.parse(readFileSync(statePath!, "utf-8")) as {
      fingerprint: string
      lastReindexAt: number
    }
    expect(saved.fingerprint).toBe(computeWorkspaceFingerprint(workspaceDir))
    expect(saved.lastReindexAt).toBeGreaterThan(0)
  })

  it("skips reindex when fingerprint matches saved state", async () => {
    const config = makeConfig(dataDir)

    await ensureCodeIndexFresh(config, workspaceDir, "startup")
    await vi.advanceTimersByTimeAsync(50)
    vi.mocked(callMemoryTool).mockClear()

    await ensureCodeIndexFresh(config, workspaceDir, "session.idle")
    await vi.advanceTimersByTimeAsync(50)

    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("respects cooldown before reindexing changed workspace again", async () => {
    const config = makeConfig(dataDir)

    await ensureCodeIndexFresh(config, workspaceDir, "startup")
    await vi.advanceTimersByTimeAsync(50)
    vi.mocked(callMemoryTool).mockClear()

    writeFileSync(join(workspaceDir, "src", "index.ts"), "export const value = 2\n")
    utimesSync(join(workspaceDir, "src", "index.ts"), new Date(), new Date(Date.now() + 1000))

    await ensureCodeIndexFresh(config, workspaceDir, "session.idle")
    await vi.advanceTimersByTimeAsync(50)

    expect(callMemoryTool).not.toHaveBeenCalled()
  })
})
