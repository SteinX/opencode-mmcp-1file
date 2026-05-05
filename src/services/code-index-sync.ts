import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { dirname, join, relative } from "node:path"
import type { PluginConfig } from "../config.js"
import { resolveDataDir } from "../config.js"
import { callMemoryTool } from "./mcp-client.js"
import { shouldCoordinateCodeIndexSync } from "./server-process.js"
import { logger } from "../utils/logger.js"

type SyncReason = "startup" | "session.idle"

interface SyncMetadata {
  workspaceDir: string
  fingerprint: string
  lastReindexAt: number
}

interface SyncStateFile {
  version: 2
  workspaces: Record<string, SyncMetadata>
}

interface LockMetadata {
  pid: number
  startedAt: number
}

const INDEX_STATE_FILE = ".code-index-sync.json"
const INDEX_LOCK_FILE_PREFIX = ".code-index-sync"
const LOCK_STALE_MS = 15 * 60_000
const scheduledRuns = new Map<string, ReturnType<typeof setTimeout>>()
const inFlightRuns = new Set<string>()

const TRACKED_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".dart",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".kts",
  ".m",
  ".mm",
  ".mjs",
  ".mts",
  ".php",
  ".plist",
  ".properties",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sql",
  ".storyboard",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".xcconfig",
  ".xib",
  ".xml",
  ".yaml",
  ".yml",
  ".pbxproj",
])

const TRACKED_FILENAMES = new Set([
  "AGENTS.md",
  "AndroidManifest.xml",
  "Cargo.lock",
  "Cargo.toml",
  "Cartfile",
  "Cartfile.resolved",
  "Fastfile",
  "Gemfile",
  "Gemfile.lock",
  "Package.resolved",
  "Package.swift",
  "Podfile",
  "Podfile.lock",
  "README.md",
  "analysis_options.yaml",
  "build.gradle",
  "build.gradle.kts",
  "gradle.properties",
  "gradlew",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "pubspec.lock",
  "pubspec.yaml",
  "settings.gradle",
  "settings.gradle.kts",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  "yarn.lock",
])

const IGNORED_DIRECTORIES = new Set([
  ".build",
  ".dart_tool",
  ".git",
  ".gradle",
  ".idea",
  ".next",
  ".turbo",
  ".vscode",
  "Carthage",
  "DerivedData",
  "Pods",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
])

function getIndexStatePath(config: PluginConfig): string | null {
  const dataDir = resolveDataDir(config)
  if (!dataDir) return null
  return join(dataDir, INDEX_STATE_FILE)
}

function getWorkspaceStateKey(workspaceDir: string): string {
  return createHash("sha1").update(workspaceDir).digest("hex")
}

function getIndexLockPath(config: PluginConfig, workspaceDir: string): string | null {
  const dataDir = resolveDataDir(config)
  if (!dataDir) return null
  return join(dataDir, `${INDEX_LOCK_FILE_PREFIX}.${getWorkspaceStateKey(workspaceDir)}.lock`)
}

function getWorkspaceKey(config: PluginConfig, workspaceDir: string): string {
  return `${resolveDataDir(config) || "no-data-dir"}:${workspaceDir}`
}

function isSyncMetadata(raw: unknown): raw is SyncMetadata {
  if (!raw || typeof raw !== "object") return false
  const candidate = raw as Partial<SyncMetadata>
  return (
    typeof candidate.workspaceDir === "string"
    && typeof candidate.fingerprint === "string"
    && typeof candidate.lastReindexAt === "number"
  )
}

function readSyncState(config: PluginConfig): SyncStateFile | null {
  const statePath = getIndexStatePath(config)
  if (!statePath || !existsSync(statePath)) return null

  try {
    const raw = JSON.parse(readFileSync(statePath, "utf-8")) as unknown

    if (isSyncMetadata(raw)) {
      const migratedState: SyncStateFile = {
        version: 2,
        workspaces: {
          [getWorkspaceStateKey(raw.workspaceDir)]: raw,
        },
      }
      writeSyncState(config, migratedState)
      return migratedState
    }

    if (!raw || typeof raw !== "object") return null
    const candidate = raw as Partial<SyncStateFile>
    const rawWorkspaces = candidate.workspaces
    if (candidate.version !== 2 || !rawWorkspaces || typeof rawWorkspaces !== "object") return null

    const workspaces: Record<string, SyncMetadata> = {}
    for (const [key, value] of Object.entries(rawWorkspaces)) {
      if (!isSyncMetadata(value)) continue
      workspaces[key] = value
    }

    return {
      version: 2,
      workspaces,
    }
  } catch (err) {
    logger.debug("Failed to read code index sync metadata", { error: String(err) })
    return null
  }
}

function writeSyncState(config: PluginConfig, state: SyncStateFile): void {
  const statePath = getIndexStatePath(config)
  if (!statePath) return

  mkdirSync(dirname(statePath), { recursive: true })
  const tmpPath = `${statePath}.${randomBytes(4).toString("hex")}.tmp`
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8")
  renameSync(tmpPath, statePath)
}

function readWorkspaceSyncMetadata(config: PluginConfig, workspaceDir: string): SyncMetadata | null {
  const state = readSyncState(config)
  if (!state) return null
  return state.workspaces[getWorkspaceStateKey(workspaceDir)] ?? null
}

function writeWorkspaceSyncMetadata(config: PluginConfig, workspaceDir: string, metadata: SyncMetadata): void {
  const state = readSyncState(config) ?? { version: 2 as const, workspaces: {} }
  state.workspaces[getWorkspaceStateKey(workspaceDir)] = metadata
  writeSyncState(config, state)
}

function hasIgnoredDirectorySegment(path: string): boolean {
  return path.split("/").some((segment) => IGNORED_DIRECTORIES.has(segment))
}

function shouldTrackPathForCodeIndex(path: string): boolean {
  if (hasIgnoredDirectorySegment(path)) return false

  const baseName = path.split("/").pop() || path
  if (TRACKED_FILENAMES.has(baseName)) return true

  const dotIndex = baseName.lastIndexOf(".")
  if (dotIndex === -1) return false
  return TRACKED_EXTENSIONS.has(baseName.slice(dotIndex))
}

function walkTrackedFiles(rootDir: string, currentDir: string, output: string[]): void {
  const entries = readdirSync(currentDir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name)
    const relPath = relative(rootDir, fullPath)

    if (entry.isDirectory()) {
      if (hasIgnoredDirectorySegment(fullPath)) continue
      walkTrackedFiles(rootDir, fullPath, output)
      continue
    }

    if (!entry.isFile()) continue
    if (!shouldTrackPathForCodeIndex(relPath)) continue
    output.push(fullPath)
  }
}

export function computeWorkspaceFingerprint(workspaceDir: string): string | null {
  try {
    const stat = statSync(workspaceDir)
    if (!stat.isDirectory()) return null
  } catch {
    return null
  }

  const files: string[] = []
  walkTrackedFiles(workspaceDir, workspaceDir, files)
  files.sort()

  const hash = createHash("sha1")
  hash.update("v1\n")
  for (const filePath of files) {
    const fileStat = statSync(filePath)
    hash.update(relative(workspaceDir, filePath))
    hash.update(":")
    hash.update(String(fileStat.size))
    hash.update(":")
    hash.update(String(fileStat.mtimeMs))
    hash.update("\n")
  }

  return hash.digest("hex")
}

function readLockMetadata(lockPath: string): LockMetadata | null {
  try {
    if (!existsSync(lockPath)) return null
    const raw = JSON.parse(readFileSync(lockPath, "utf-8")) as Partial<LockMetadata>
    if (typeof raw.pid !== "number") return null
    if (typeof raw.startedAt !== "number") return null
    return { pid: raw.pid, startedAt: raw.startedAt }
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function acquireLock(lockPath: string): boolean {
  mkdirSync(dirname(lockPath), { recursive: true })

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx")
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
      closeSync(fd)
      return true
    } catch {
      const existing = readLockMetadata(lockPath)
      const stale = !existing || !isProcessAlive(existing.pid) || Date.now() - existing.startedAt > LOCK_STALE_MS
      if (!stale) return false
      try {
        unlinkSync(lockPath)
      } catch {
        return false
      }
    }
  }

  return false
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath)
  } catch {}
}

async function runReindex(config: PluginConfig, workspaceDir: string, reason: SyncReason): Promise<void> {
  const workspaceKey = getWorkspaceKey(config, workspaceDir)
  if (inFlightRuns.has(workspaceKey)) return

  const lockPath = getIndexLockPath(config, workspaceDir)
  if (!lockPath) return
  if (!acquireLock(lockPath)) {
    logger.debug("Skipping code index sync because another process holds the lock", {
      workspaceDir,
      reason,
    })
    return
  }

  inFlightRuns.add(workspaceKey)

  try {
    const fingerprint = computeWorkspaceFingerprint(workspaceDir)
    if (!fingerprint) return

    const metadata = readWorkspaceSyncMetadata(config, workspaceDir)
    if (metadata?.fingerprint === fingerprint) return

    logger.info("Refreshing code intelligence index", { workspaceDir, reason })
    await callMemoryTool(config, "index_project", { path: workspaceDir, force: true })
    writeWorkspaceSyncMetadata(config, workspaceDir, {
      workspaceDir,
      fingerprint,
      lastReindexAt: Date.now(),
    })
  } catch (err) {
    logger.warn("Code index sync failed", {
      workspaceDir,
      reason,
      error: String(err),
    })
  } finally {
    inFlightRuns.delete(workspaceKey)
    releaseLock(lockPath)
  }
}

export async function ensureCodeIndexFresh(
  config: PluginConfig,
  workspaceDir?: string,
  reason: SyncReason = "session.idle",
): Promise<void> {
  if (!config.codeIndexSync.enabled || !workspaceDir) return

  const shouldCoordinate = await shouldCoordinateCodeIndexSync(config)
  if (!shouldCoordinate) {
    logger.debug("Skipping code index sync coordination in non-leader HTTP client", {
      workspaceDir,
      reason,
    })
    return
  }

  const fingerprint = computeWorkspaceFingerprint(workspaceDir)
  if (!fingerprint) return

  const metadata = readWorkspaceSyncMetadata(config, workspaceDir)
  if (metadata?.fingerprint === fingerprint) return

  const timeSinceLastReindex = metadata
    ? Date.now() - metadata.lastReindexAt
    : Number.POSITIVE_INFINITY
  if (timeSinceLastReindex < config.codeIndexSync.minReindexIntervalMs) {
    logger.debug("Skipping code index sync due to cooldown", {
      workspaceDir,
      reason,
      waitMs: config.codeIndexSync.minReindexIntervalMs - timeSinceLastReindex,
    })
    return
  }

  const workspaceKey = getWorkspaceKey(config, workspaceDir)
  if (scheduledRuns.has(workspaceKey) || inFlightRuns.has(workspaceKey)) return

  const timer = setTimeout(() => {
    scheduledRuns.delete(workspaceKey)
    void runReindex(config, workspaceDir, reason)
  }, config.codeIndexSync.debounceMs)

  scheduledRuns.set(workspaceKey, timer)
}

export function resetCodeIndexSyncState(): void {
  for (const timer of scheduledRuns.values()) {
    clearTimeout(timer)
  }
  scheduledRuns.clear()
  inFlightRuns.clear()
}

export function __testOnly(): {
  getIndexStatePath: typeof getIndexStatePath
  getIndexLockPath: typeof getIndexLockPath
  getWorkspaceStateKey: typeof getWorkspaceStateKey
  shouldTrackPathForCodeIndex: typeof shouldTrackPathForCodeIndex
} {
  return {
    getIndexStatePath,
    getIndexLockPath,
    getWorkspaceStateKey,
    shouldTrackPathForCodeIndex,
  }
}
