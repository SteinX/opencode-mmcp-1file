import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { PluginConfig } from "../../src/config.js"

vi.mock("../../src/services/mcp-client.js", () => ({
  callMemoryTool: vi.fn().mockResolvedValue('{"status":"ok"}'),
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

const { callMemoryTool } = await import("../../src/services/mcp-client.js")
const { shouldCoordinateCodeIndexSync } = await import("../../src/services/server-process.js")
const {
  __testOnly,
  computeWorkspaceFingerprint,
  ensureCodeIndexFresh,
  resetCodeIndexSyncState,
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
    codeIndexSync: { enabled: true, debounceMs: 50, minReindexIntervalMs: 300000 },
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
    expect(saved.version).toBe(2)
    expect(saved.workspaces[workspaceKey]?.fingerprint).toBe(computeWorkspaceFingerprint(workspaceDir))
    expect(saved.workspaces[workspaceKey]?.lastReindexAt).toBeGreaterThan(0)
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

  it("migrates legacy single-workspace metadata into workspace-scoped state", async () => {
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
    expect(saved.version).toBe(2)
    expect(saved.workspaces[workspaceKey]?.workspaceDir).toBe(workspaceDir)
    expect(saved.workspaces[workspaceKey]?.fingerprint).toBe(fingerprint)
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
})
