import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { PluginConfig } from "../../src/config.js"

vi.mock("../../src/services/mcp-client.js", () => ({
  callMemoryTool: vi.fn().mockResolvedValue('{"status":"ok"}'),
  getProjectDurableStatus: vi.fn().mockResolvedValue(null),
}))

vi.mock("../../src/services/server-process.js", () => ({
  shouldCoordinateCodeIndexSync: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const { callMemoryTool, getProjectDurableStatus } = await import("../../src/services/mcp-client.js")
const { shouldCoordinateCodeIndexSync } = await import("../../src/services/server-process.js")
const {
  __testOnly,
  computeWorkspaceFingerprint,
  ensureCodeIndexFresh,
  resetCodeIndexSyncState,
  decideIndexSyncAction,
} = await import("../../src/services/code-index-sync.js")

function makeConfig(dataDir: string): PluginConfig {
  return {
    chatMessage: { enabled: true, maxMemories: 5, maxProjectMemories: 30, maxInjectedMemories: 6, injectOn: "first", shortQueryMinLength: 3, minScore: 0.35 },
    autoCapture: { enabled: false, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    preferenceLearning: { enabled: false, learnOnCorrections: true, learnOnNegations: true, learnOnMessageUpdated: true, injectOn: "first", scope: "project", minConfidence: 0.7, candidateConfidence: 0.4, maxPreferences: 5, maxCandidates: 3, debounceMs: 10000, maxInputChars: 4000, maxStoredPreferences: 50 },
    codeIndexSync: { enabled: true, autoRefresh: true, debounceMs: 50, minReindexIntervalMs: 300000 },
    captureModel: { provider: "", model: "", apiUrl: "", apiKey: "" },
    memoryScope: { namespace: "", shareAcrossAgents: true, includeAgentMetadata: true, includeRunMetadata: false, userId: "", defaultMetadata: {} },
    mcpServer: {
      command: ["npm", "exec", "-y", "memory-mcp-1file", "--"],
      tag: "",
      dataDir,
      model: "qwen3",
      mcpServerName: "memory-mcp-1file",
      transport: "stdio",
      port: 23817,
      bind: "127.0.0.1",
      reconnectIntervalMs: 30000,
      heartbeatIntervalMs: 20000,
    },
    systemPrompt: { enabled: true },
  }
}

function writeTrackedFile(baseDir: string, relativePath: string, contents: string): string {
  const filePath = join(baseDir, relativePath)
  mkdirSync(join(filePath, ".."), { recursive: true })
  writeFileSync(filePath, contents)
  utimesSync(filePath, new Date(), new Date(Date.now() + 1000))
  return filePath
}

describe("code-index-sync", () => {
  let rootDir: string
  let workspaceDir: string
  let secondWorkspaceDir: string
  let dataDir: string

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    rootDir = mkdtempSync(join(tmpdir(), "mmcp-code-index-sync-"))
    workspaceDir = join(rootDir, "workspace")
    secondWorkspaceDir = join(rootDir, "workspace-2")
    dataDir = join(rootDir, "data")
    mkdirSync(workspaceDir, { recursive: true })
    mkdirSync(secondWorkspaceDir, { recursive: true })
    mkdirSync(join(workspaceDir, "src"), { recursive: true })
    mkdirSync(join(secondWorkspaceDir, "src"), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(workspaceDir, "package.json"), '{"name":"fixture"}')
    writeFileSync(join(workspaceDir, "src", "index.ts"), "export const value = 1\n")
    writeFileSync(join(secondWorkspaceDir, "package.json"), '{"name":"fixture-2"}')
    writeFileSync(join(secondWorkspaceDir, "src", "index.ts"), "export const value = 10\n")
  })

  afterEach(() => {
    resetCodeIndexSyncState()
    vi.useRealTimers()
    rmSync(rootDir, { recursive: true, force: true })
  })

  it("tracks relevant source and config paths", () => {
    const helpers = __testOnly()

    for (const trackedPath of [
      "src/index.ts",
      "package.json",
      "src/main.swift",
      "src/main.kt",
      "src/main.kts",
      "src/main.java",
    ]) {
      expect(helpers.shouldTrackPathForCodeIndex(trackedPath)).toBe(true)
    }

    expect(helpers.shouldTrackPathForCodeIndex("assets/logo.png")).toBe(false)
  })

  it("tracks iOS and Apple workspace files", () => {
    const helpers = __testOnly()

    for (const trackedPath of [
      "App/AppDelegate.m",
      "App/Bridge.mm",
      "App/Info.plist",
      "App/Base.lproj/Main.storyboard",
      "App/Base.lproj/LaunchScreen.xib",
      "Config/Debug.xcconfig",
      "ios/Runner.xcodeproj/project.pbxproj",
      "Package.swift",
      "Package.resolved",
      "Podfile",
      "Podfile.lock",
      "Cartfile",
      "Cartfile.resolved",
      "Gemfile",
      "Gemfile.lock",
      "fastlane/Fastfile",
    ]) {
      expect(helpers.shouldTrackPathForCodeIndex(trackedPath)).toBe(true)
    }
  })

  it("tracks Android workspace files", () => {
    const helpers = __testOnly()

    for (const trackedPath of [
      "app/src/main/AndroidManifest.xml",
      "app/src/main/res/layout/activity_main.xml",
      "build.gradle",
      "settings.gradle",
      "gradle.properties",
      "app/build.gradle.kts",
      "settings.gradle.kts",
      "gradlew",
    ]) {
      expect(helpers.shouldTrackPathForCodeIndex(trackedPath)).toBe(true)
    }
  })

  it("tracks Flutter workspace files", () => {
    const helpers = __testOnly()

    for (const trackedPath of [
      "lib/main.dart",
      "pubspec.yaml",
      "pubspec.lock",
      "analysis_options.yaml",
    ]) {
      expect(helpers.shouldTrackPathForCodeIndex(trackedPath)).toBe(true)
    }
  })

  it("keeps existing tracked behavior and ignores generated mobile directories", () => {
    const helpers = __testOnly()

    for (const trackedPath of [
      "src/index.ts",
      "package.json",
      "src/main.swift",
      "src/main.kt",
      "src/main.kts",
      "src/main.java",
    ]) {
      expect(helpers.shouldTrackPathForCodeIndex(trackedPath)).toBe(true)
    }

    for (const ignoredPath of [
      ".gradle/caches/modules.gradle",
      ".dart_tool/package_config.json",
      ".idea/workspace.xml",
      "DerivedData/App/Build/File.swift",
      "Pods/SomePod/Source/File.m",
      "Carthage/Checkouts/Lib/File.swift",
      ".build/checkouts/Lib/File.swift",
    ]) {
      expect(helpers.shouldTrackPathForCodeIndex(ignoredPath)).toBe(false)
    }

    expect(helpers.shouldTrackPathForCodeIndex("assets/logo.png")).toBe(false)
  })

  it("computes a fingerprint for tracked workspace files", () => {
    const fingerprint = computeWorkspaceFingerprint(workspaceDir)
    expect(typeof fingerprint).toBe("string")
    expect(fingerprint).toHaveLength(40)
  })

  it("changes fingerprint when a tracked mobile file is added", () => {
    const baseline = computeWorkspaceFingerprint(workspaceDir)
    expect(baseline).toBeTruthy()

    writeTrackedFile(workspaceDir, "ios/AppDelegate.swift", "import UIKit\n")

    const updated = computeWorkspaceFingerprint(workspaceDir)
    expect(updated).not.toBe(baseline)
  })

  it("does not change fingerprint for files under ignored mobile directories", () => {
    const baseline = computeWorkspaceFingerprint(workspaceDir)
    expect(baseline).toBeTruthy()

    writeTrackedFile(workspaceDir, ".gradle/caches/modules.gradle", "apply plugin: 'com.android.application'\n")
    writeTrackedFile(workspaceDir, ".dart_tool/package_config.json", "{}\n")
    writeTrackedFile(workspaceDir, ".idea/workspace.xml", "<project />\n")
    writeTrackedFile(workspaceDir, "DerivedData/App/Build/File.swift", "import Foundation\n")
    writeTrackedFile(workspaceDir, "Pods/SomePod/Source/File.swift", "import Foundation\n")
    writeTrackedFile(workspaceDir, "Carthage/Checkouts/Lib/File.swift", "import Foundation\n")
    writeTrackedFile(workspaceDir, ".build/checkouts/Lib/File.swift", "import Foundation\n")

    const updated = computeWorkspaceFingerprint(workspaceDir)
    expect(updated).toBe(baseline)
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
      version: number
      workspaces: Record<string, { fingerprint: string; lastReindexAt: number }>
    }
    const workspaceKey = __testOnly().getWorkspaceStateKey(workspaceDir)
    expect(saved.version).toBe(3)
    expect(saved.workspaces[workspaceKey]?.fingerprint).toBe(computeWorkspaceFingerprint(workspaceDir))
    expect(saved.workspaces[workspaceKey]?.lastReindexAt).toBeGreaterThan(0)
  })

  it("skips automatic refresh when autoRefresh is disabled", async () => {
    const config = makeConfig(dataDir)
    config.codeIndexSync.autoRefresh = false

    await ensureCodeIndexFresh(config, workspaceDir, "startup")
    await vi.advanceTimersByTimeAsync(50)

    expect(shouldCoordinateCodeIndexSync).not.toHaveBeenCalled()
    expect(callMemoryTool).not.toHaveBeenCalled()
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

  it("skips coordination entirely in non-leader HTTP clients", async () => {
    const config = makeConfig(dataDir)
    config.mcpServer.transport = "http"
    vi.mocked(shouldCoordinateCodeIndexSync).mockResolvedValueOnce(false)

    await ensureCodeIndexFresh(config, workspaceDir, "startup")
    await vi.advanceTimersByTimeAsync(50)

    expect(shouldCoordinateCodeIndexSync).toHaveBeenCalledWith(config)
    expect(callMemoryTool).not.toHaveBeenCalled()
  })

  it("migrates legacy single-workspace metadata into v3 workspace-scoped state", async () => {
    const config = makeConfig(dataDir)
    const statePath = __testOnly().getIndexStatePath(config)
    const fingerprint = computeWorkspaceFingerprint(workspaceDir)
    expect(statePath).toBeTruthy()
    expect(fingerprint).toBeTruthy()

    writeFileSync(statePath!, JSON.stringify({
      workspaceDir,
      fingerprint,
      lastReindexAt: Date.now(),
    }, null, 2))

    await ensureCodeIndexFresh(config, workspaceDir, "session.idle")
    await vi.advanceTimersByTimeAsync(50)

    expect(callMemoryTool).not.toHaveBeenCalled()

    const saved = JSON.parse(readFileSync(statePath!, "utf-8")) as {
      version: number
      workspaces: Record<string, { workspaceDir: string; fingerprint: string; lastReindexAt: number }>
    }
    const workspaceKey = __testOnly().getWorkspaceStateKey(workspaceDir)
    expect(saved.version).toBe(3)
    expect(saved.workspaces[workspaceKey]?.workspaceDir).toBe(workspaceDir)
    expect(saved.workspaces[workspaceKey]?.fingerprint).toBe(fingerprint)
  })

  it("migrates v2 workspace-scoped state to v3 preserving fingerprint and lastReindexAt", async () => {
    const config = makeConfig(dataDir)
    const statePath = __testOnly().getIndexStatePath(config)
    const fingerprint = computeWorkspaceFingerprint(workspaceDir)
    const workspaceKey = __testOnly().getWorkspaceStateKey(workspaceDir)
    const lastReindexAt = Date.now() - 1000
    expect(statePath).toBeTruthy()
    expect(fingerprint).toBeTruthy()

    writeFileSync(statePath!, JSON.stringify({
      version: 2,
      workspaces: {
        [workspaceKey]: { workspaceDir, fingerprint, lastReindexAt },
      },
    }, null, 2))

    await ensureCodeIndexFresh(config, workspaceDir, "session.idle")
    await vi.advanceTimersByTimeAsync(50)

    expect(callMemoryTool).not.toHaveBeenCalled()

    const saved = JSON.parse(readFileSync(statePath!, "utf-8")) as {
      version: number
      workspaces: Record<string, { workspaceDir: string; fingerprint: string; lastReindexAt: number }>
    }
    expect(saved.version).toBe(3)
    expect(saved.workspaces[workspaceKey]?.fingerprint).toBe(fingerprint)
    expect(saved.workspaces[workspaceKey]?.lastReindexAt).toBe(lastReindexAt)
  })

  it("returns null and does not delete state file on invalid v3 state", async () => {
    const { logger } = await import("../../src/utils/logger.js")
    const config = makeConfig(dataDir)
    const statePath = __testOnly().getIndexStatePath(config)
    expect(statePath).toBeTruthy()

    const invalidContent = "{ this is not valid json !!!"
    writeFileSync(statePath!, invalidContent)

    const readSyncStateResult = __testOnly().readSyncState(config)
    expect(readSyncStateResult).toBeNull()
    expect(logger.debug).toHaveBeenCalledWith("Failed to read code index sync metadata", expect.objectContaining({ error: expect.any(String) }))
    expect(existsSync(statePath!)).toBe(true)
  })

  it("preserves v3 server orchestration fields on read/write", async () => {
    const config = makeConfig(dataDir)
    const statePath = __testOnly().getIndexStatePath(config)
    const fingerprint = computeWorkspaceFingerprint(workspaceDir)
    const workspaceKey = __testOnly().getWorkspaceStateKey(workspaceDir)
    expect(statePath).toBeTruthy()
    expect(fingerprint).toBeTruthy()

    writeFileSync(statePath!, JSON.stringify({
      version: 3,
      workspaces: {
        [workspaceKey]: {
          workspaceDir,
          fingerprint,
          lastReindexAt: Date.now() - 1000,
          serverProjectId: "proj-123",
          serverJobId: "job-456",
          serverActiveGeneration: 5,
          serverTargetGeneration: 6,
          lastObservedServerState: "running",
          lastObservedReasonCode: "can_resume",
          lastObservedAt: "2024-01-01T00:01:00Z",
        },
      },
    }, null, 2))

    await ensureCodeIndexFresh(config, workspaceDir, "session.idle")
    await vi.advanceTimersByTimeAsync(50)

    expect(callMemoryTool).not.toHaveBeenCalled()

    const saved = JSON.parse(readFileSync(statePath!, "utf-8")) as {
      version: number
      workspaces: Record<string, Record<string, unknown>>
    }
    expect(saved.version).toBe(3)
    const entry = saved.workspaces[workspaceKey]
    expect(entry?.["serverProjectId"]).toBe("proj-123")
    expect(entry?.["serverJobId"]).toBe("job-456")
    expect(entry?.["serverActiveGeneration"]).toBe(5)
    expect(entry?.["lastObservedServerState"]).toBe("running")
  })

  it("tracks cooldown separately for different workspaces in the same dataDir", async () => {
    const config = makeConfig(dataDir)

    await ensureCodeIndexFresh(config, workspaceDir, "startup")
    await vi.advanceTimersByTimeAsync(50)
    vi.mocked(callMemoryTool).mockClear()

    await ensureCodeIndexFresh(config, secondWorkspaceDir, "startup")
    await vi.advanceTimersByTimeAsync(50)

    expect(callMemoryTool).toHaveBeenCalledTimes(1)
    expect(callMemoryTool).toHaveBeenCalledWith(config, "index_project", {
      path: secondWorkspaceDir,
      force: true,
    })
  })

  it("uses different lock files for different workspaces", () => {
    const config = makeConfig(dataDir)
    const firstLockPath = __testOnly().getIndexLockPath(config, workspaceDir)
    const secondLockPath = __testOnly().getIndexLockPath(config, secondWorkspaceDir)

    expect(firstLockPath).toBeTruthy()
    expect(secondLockPath).toBeTruthy()
    expect(firstLockPath).not.toBe(secondLockPath)
    expect(existsSync(firstLockPath!)).toBe(false)
    expect(existsSync(secondLockPath!)).toBe(false)
  })

  describe("decideIndexSyncAction", () => {
    it("returns legacy for null status", () => {
      const config = makeConfig(dataDir)
      expect(decideIndexSyncAction(null, config)).toBe("legacy")
    })

    it("returns legacy for unsupported reason_code", () => {
      const config = makeConfig(dataDir)
      const status = { action: "status" as const, reason_code: "unsupported" as const, raw: {} }
      expect(decideIndexSyncAction(status, config)).toBe("legacy")
    })

    it("returns wait for active_index_running reason_code", () => {
      const config = makeConfig(dataDir)
      const status = { action: "status" as const, reason_code: "active_index_running" as const, raw: {} }
      expect(decideIndexSyncAction(status, config)).toBe("wait")
    })

    it("returns wait for queued state", () => {
      const config = makeConfig(dataDir)
      const status = { action: "status" as const, state: "queued" as const, raw: {} }
      expect(decideIndexSyncAction(status, config)).toBe("wait")
    })

    it("returns complete for completed state", () => {
      const config = makeConfig(dataDir)
      const status = { action: "status" as const, state: "completed" as const, raw: {} }
      expect(decideIndexSyncAction(status, config)).toBe("complete")
    })

    it("returns resume when can_resume=true with job_id and resume_token and resume enabled", () => {
      const config = makeConfig(dataDir)
      const status = {
        action: "status" as const,
        can_resume: true,
        job_id: "job-1",
        resume_token: "tok-1",
        raw: {},
      }
      expect(decideIndexSyncAction(status, config)).toBe("resume")
    })

    it("returns blocked when can_resume=true but missing resume_token", () => {
      const config = makeConfig(dataDir)
      const status = {
        action: "status" as const,
        can_resume: true,
        job_id: "job-1",
        raw: {},
      }
      expect(decideIndexSyncAction(status, config)).toBe("blocked")
    })

    it("returns blocked for workspace_changed_since_checkpoint with default config", () => {
      const config = makeConfig(dataDir)
      const status = {
        action: "status" as const,
        can_resume: false,
        reason_code: "workspace_changed_since_checkpoint" as const,
        raw: {},
      }
      expect(decideIndexSyncAction(status, config)).toBe("blocked")
    })

    it("returns restart for workspace_changed_since_checkpoint when allowFullRestartFallback=true", () => {
      const config = makeConfig(dataDir)
      config.codeIndexSync.resume = { allowFullRestartFallback: true }
      const status = {
        action: "status" as const,
        can_resume: false,
        reason_code: "workspace_changed_since_checkpoint" as const,
        raw: {},
      }
      expect(decideIndexSyncAction(status, config)).toBe("restart")
    })

    it("returns wait for running state", () => {
      const config = makeConfig(dataDir)
      const status = { action: "status" as const, state: "running" as const, raw: {} }
      expect(decideIndexSyncAction(status, config)).toBe("wait")
    })

    it("returns blocked when can_resume=true but missing job_id", () => {
      const config = makeConfig(dataDir)
      const status = {
        action: "status" as const,
        can_resume: true,
        resume_token: "tok-1",
        raw: {},
      }
      expect(decideIndexSyncAction(status, config)).toBe("blocked")
    })

    it("returns blocked for index_storage_corrupt with allowFullRestartFallback=true but allowDestructiveRecovery=false", () => {
      const config = makeConfig(dataDir)
      config.codeIndexSync.resume = { allowFullRestartFallback: true, allowDestructiveRecovery: false }
      const status = {
        action: "status" as const,
        can_resume: false,
        reason_code: "index_storage_corrupt" as const,
        raw: {},
      }
      expect(decideIndexSyncAction(status, config)).toBe("blocked")
    })

    it("returns restart for index_storage_corrupt when both allowFullRestartFallback and allowDestructiveRecovery are true", () => {
      const config = makeConfig(dataDir)
      config.codeIndexSync.resume = { allowFullRestartFallback: true, allowDestructiveRecovery: true }
      const status = {
        action: "status" as const,
        can_resume: false,
        reason_code: "index_storage_corrupt" as const,
        raw: {},
      }
      expect(decideIndexSyncAction(status, config)).toBe("restart")
    })

    it("returns start for status with no active job", () => {
      const config = makeConfig(dataDir)
      const status = { action: "status" as const, state: "failed" as const, raw: {} }
      expect(decideIndexSyncAction(status, config)).toBe("start")
    })

    it("returns start for status with no state or reason_code (stale/missing)", () => {
      const config = makeConfig(dataDir)
      const status = { action: "status" as const, raw: {} }
      expect(decideIndexSyncAction(status, config)).toBe("start")
    })
  })

  it("resumes indexing when server reports can_resume with job_id and resume_token, writes v3 freshness on completion", async () => {
    const config = makeConfig(dataDir)
    config.codeIndexSync.resume = { enabled: true, pollIntervalMs: 10, maxPollMs: 1000 }

    vi.mocked(getProjectDurableStatus)
      .mockResolvedValueOnce({
        action: "status",
        can_resume: true,
        job_id: "job-1",
        resume_token: "tok-1",
        active_generation: 2,
        target_generation: 3,
        raw: {},
      })
      .mockResolvedValueOnce({
        action: "status",
        state: "completed",
        active_generation: 3,
        target_generation: 3,
        raw: {},
      })

    await ensureCodeIndexFresh(config, workspaceDir, "startup")
    await vi.advanceTimersByTimeAsync(50)
    await vi.runAllTimersAsync()

    expect(callMemoryTool).toHaveBeenCalledWith(config, "index_project", {
      path: workspaceDir,
      resume: true,
      job_id: "job-1",
      resume_token: "tok-1",
      allow_full_restart_fallback: false,
    })

    const statePath = __testOnly().getIndexStatePath(config)
    expect(statePath).toBeTruthy()
    const saved = JSON.parse(readFileSync(statePath!, "utf-8")) as {
      version: number
      workspaces: Record<string, Record<string, unknown>>
    }
    const workspaceKey = __testOnly().getWorkspaceStateKey(workspaceDir)
    expect(saved.version).toBe(3)
    expect(saved.workspaces[workspaceKey]?.["fingerprint"]).toBe(computeWorkspaceFingerprint(workspaceDir))
    expect(saved.workspaces[workspaceKey]?.["lastReindexAt"]).toBeGreaterThan(0)
    expect(saved.workspaces[workspaceKey]?.["lastObservedServerState"]).toBe("completed")
  })

  it("does not call force:true and records blocked state for workspace_changed_since_checkpoint with default config", async () => {
    const config = makeConfig(dataDir)

    vi.mocked(getProjectDurableStatus).mockResolvedValueOnce({
      action: "status",
      can_resume: false,
      reason_code: "workspace_changed_since_checkpoint",
      raw: {},
    })

    await ensureCodeIndexFresh(config, workspaceDir, "startup")
    await vi.advanceTimersByTimeAsync(50)

    expect(callMemoryTool).not.toHaveBeenCalled()

    const statePath = __testOnly().getIndexStatePath(config)
    expect(statePath).toBeTruthy()
    const saved = JSON.parse(readFileSync(statePath!, "utf-8")) as {
      version: number
      workspaces: Record<string, Record<string, unknown>>
    }
    const workspaceKey = __testOnly().getWorkspaceStateKey(workspaceDir)
    expect(saved.version).toBe(3)
    expect(saved.workspaces[workspaceKey]?.["fingerprint"]).toBe("")
    expect(saved.workspaces[workspaceKey]?.["lastObservedReasonCode"]).toBe("workspace_changed_since_checkpoint")
  })

  it("calls index_project with force and confirm_failed_restart when allowFullRestartFallback=true and workspace changed", async () => {
    const config = makeConfig(dataDir)
    config.codeIndexSync.resume = { enabled: true, pollIntervalMs: 10, maxPollMs: 1000, allowFullRestartFallback: true }

    vi.mocked(getProjectDurableStatus)
      .mockResolvedValueOnce({
        action: "status",
        can_resume: false,
        reason_code: "workspace_changed_since_checkpoint",
        raw: {},
      })
      .mockResolvedValueOnce({
        action: "status",
        state: "completed",
        raw: {},
      })

    await ensureCodeIndexFresh(config, workspaceDir, "startup")
    await vi.advanceTimersByTimeAsync(50)
    await vi.runAllTimersAsync()

    expect(callMemoryTool).toHaveBeenCalledWith(config, "index_project", {
      path: workspaceDir,
      force: true,
      confirm_failed_restart: true,
    })
  })

  it("calls index_project without force for start decision (no active job)", async () => {
    const config = makeConfig(dataDir)
    config.codeIndexSync.resume = { enabled: true, pollIntervalMs: 10, maxPollMs: 1000 }

    vi.mocked(getProjectDurableStatus)
      .mockResolvedValueOnce({
        action: "status",
        state: "failed",
        raw: {},
      })
      .mockResolvedValueOnce({
        action: "status",
        state: "completed",
        raw: {},
      })

    await ensureCodeIndexFresh(config, workspaceDir, "startup")
    await vi.advanceTimersByTimeAsync(50)
    await vi.runAllTimersAsync()

    expect(callMemoryTool).toHaveBeenCalledWith(config, "index_project", {
      path: workspaceDir,
    })
  })

  it("writes v3 freshness on completed state decision", async () => {
    const config = makeConfig(dataDir)
    config.codeIndexSync.resume = { enabled: true, pollIntervalMs: 10, maxPollMs: 1000 }

    vi.mocked(getProjectDurableStatus).mockResolvedValueOnce({
      action: "status",
      state: "completed",
      raw: {},
    })

    await ensureCodeIndexFresh(config, workspaceDir, "startup")
    await vi.advanceTimersByTimeAsync(50)

    expect(callMemoryTool).not.toHaveBeenCalled()

    const statePath = __testOnly().getIndexStatePath(config)
    expect(statePath).toBeTruthy()
    const saved = JSON.parse(readFileSync(statePath!, "utf-8")) as {
      version: number
      workspaces: Record<string, Record<string, unknown>>
    }
    const workspaceKey = __testOnly().getWorkspaceStateKey(workspaceDir)
    expect(saved.version).toBe(3)
    expect(saved.workspaces[workspaceKey]?.["lastReindexAt"]).toBeGreaterThan(0)
    expect(saved.workspaces[workspaceKey]?.["lastObservedServerState"]).toBe("completed")
  })

  it("includes configured filters in legacy index call", async () => {
    const config = makeConfig(dataDir)
    config.codeIndexSync.includePatterns = ["src/**/*"]
    config.codeIndexSync.excludePatterns = ["**/*.log"]

    await ensureCodeIndexFresh(config, workspaceDir, "startup")
    await vi.advanceTimersByTimeAsync(50)

    expect(callMemoryTool).toHaveBeenCalledWith(
      config,
      "index_project",
      expect.objectContaining({
        path: workspaceDir,
        force: true,
        include_patterns: ["src/**/*"],
        exclude_patterns: ["**/*.log"],
      }),
    )
  })

  it("does not include filters in resume calls", async () => {
    vi.mocked(getProjectDurableStatus).mockResolvedValueOnce({
      state: "indexing",
      reason_code: "in_progress",
      job_id: "job-1",
      resume_token: "token-1",
      active_generation: 1,
      target_generation: 2,
    } as any)

    const config = makeConfig(dataDir)
    config.codeIndexSync.includePatterns = ["src/**/*"]
    config.codeIndexSync.resume = { enabled: true, pollIntervalMs: 10, maxPollMs: 100 }

    await ensureCodeIndexFresh(config, workspaceDir, "startup")
    await vi.advanceTimersByTimeAsync(50)

    const calls = vi.mocked(callMemoryTool).mock.calls
    const resumeCall = calls.find(c => c[2]?.resume === true)
    if (resumeCall) {
      expect(resumeCall[2]).not.toHaveProperty("include_patterns")
      expect(resumeCall[2]).not.toHaveProperty("exclude_patterns")
    }
  })

  it("reindexes when filter config changes even if fingerprint is unchanged", async () => {
    const config = makeConfig(dataDir)

    await ensureCodeIndexFresh(config, workspaceDir, "startup")
    await vi.advanceTimersByTimeAsync(50)
    vi.mocked(callMemoryTool).mockClear()

    config.codeIndexSync.includePatterns = ["src/**/*"]

    await ensureCodeIndexFresh(config, workspaceDir, "session.idle")
    await vi.advanceTimersByTimeAsync(50)

    expect(callMemoryTool).toHaveBeenCalled()
  })

  it("skips index and logs warning when filter config is invalid", async () => {
    const { logger } = await import("../../src/utils/logger.js")
    const config = makeConfig(dataDir)
    config.codeIndexSync.includePatterns = ["/invalid/absolute"]

    await ensureCodeIndexFresh(config, workspaceDir, "startup")
    await vi.advanceTimersByTimeAsync(50)

    expect(callMemoryTool).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      "Code index sync skipped due to invalid filter config",
      expect.objectContaining({ error: expect.stringContaining("Error:") }),
    )
  })
})
