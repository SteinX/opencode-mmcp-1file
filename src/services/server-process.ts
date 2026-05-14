import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, renameSync, openSync, closeSync } from "node:fs"
import { join, dirname } from "node:path"
import { randomBytes } from "node:crypto"
import type { PluginConfig } from "../config.js"
import { resolveDataDir } from "../config.js"
import { logger } from "../utils/logger.js"

interface LockFileData {
  pid: number
  port: number
  bind: string
  holders: number[]
  unknownHolders: number
  startedAt: string
}

interface RawLockFileData {
  pid?: number
  port?: number
  bind?: string
  holders?: number[]
  unknownHolders?: number
  refCount?: number
  startedAt?: string
}

interface StartupLockData {
  ownerPid: number
  ownerId: string
  port: number
  bind: string
  createdAt: string
  staleAfterMs: number
}

interface RawStartupLockData {
  ownerPid?: number
  ownerId?: string
  port?: number
  bind?: string
  createdAt?: string
  staleAfterMs?: number
}

export interface ServerRuntimeStatus {
  transport: PluginConfig["mcpServer"]["transport"] | null
  url: string | null
  running: boolean
  lockPresent: boolean
  pid: number | null
  holders: number[]
  unknownHolders: number
  holderCount: number
  message: string
  error?: string
}

const STARTUP_LOCK_STALE_AFTER_MS = 10000
const STARTUP_LOCK_WAIT_MS = 15000
const STARTUP_LOCK_POLL_MS = 500
const inFlightStartups = new Map<string, Promise<string>>()

function getLockFilePath(config: PluginConfig): string | null {
  const dataDir = resolveDataDir(config)
  if (!dataDir) return null
  return join(dataDir, ".server-lock")
}

function getStartupLockFilePath(config: PluginConfig): string | null {
  const dataDir = resolveDataDir(config)
  if (!dataDir) return null
  return join(dataDir, ".server-startup-lock")
}

function getStartupKey(config: PluginConfig): string | null {
  const dataDir = resolveDataDir(config)
  if (!dataDir) return null
  return `${dataDir}|${config.mcpServer.bind}|${config.mcpServer.port}`
}

function readLockFile(lockPath: string): LockFileData | null {
  try {
    if (!existsSync(lockPath)) return null
    const raw = JSON.parse(readFileSync(lockPath, "utf-8")) as RawLockFileData
    return normalizeLockData(raw)
  } catch {
    return null
  }
}

function normalizeLockData(raw: RawLockFileData | null | undefined): LockFileData | null {
  if (!raw || typeof raw.pid !== "number") return null

  const holders: number[] =
    Array.isArray(raw.holders)
      ? (raw.holders as unknown[]).filter((h): h is number => typeof h === "number")
      : []

  const unknownHolders =
    typeof raw.unknownHolders === "number" && raw.unknownHolders > 0
      ? raw.unknownHolders
      : typeof raw.refCount === "number" && raw.refCount > 0
        ? raw.refCount
        : 0

  return {
    pid: raw.pid,
    port: raw.port ?? 0,
    bind: raw.bind ?? "",
    holders,
    unknownHolders,
    startedAt: raw.startedAt ?? new Date().toISOString(),
  }
}

function buildNoopRuntimeStatus(config: PluginConfig | undefined, message: string): ServerRuntimeStatus {
  return {
    transport: config?.mcpServer.transport ?? null,
    url: config?.mcpServer.transport === "http" ? getServerUrl(config) : null,
    running: false,
    lockPresent: false,
    pid: null,
    holders: [],
    unknownHolders: 0,
    holderCount: 0,
    message,
  }
}

function formatRuntimeStatusMessage(status: Pick<ServerRuntimeStatus, "running" | "lockPresent" | "holderCount" | "pid" | "unknownHolders">): string {
  if (!status.lockPresent) {
    return status.running ? "HTTP server is healthy but no lock file is present." : "HTTP server is not healthy and no lock file is present."
  }

  const holderLabel = status.holderCount === 1 ? "holder" : "holders"
  const pidLabel = status.pid && status.pid > 0 ? `pid=${status.pid}` : "pid=unknown"
  const stateLabel = status.running ? "healthy" : "unhealthy"
  return `HTTP server lock found (${pidLabel}, ${status.holderCount} ${holderLabel}, ${status.unknownHolders} unknown, ${stateLabel}).`
}

async function readRuntimeLockStatus(lockPath: string): Promise<{ lock: LockFileData | null; error: string | null }> {
  try {
    if (!existsSync(lockPath)) return { lock: null, error: null }
    const raw = JSON.parse(readFileSync(lockPath, "utf-8")) as RawLockFileData
    const lock = normalizeLockData(raw)
    if (!lock) return { lock: null, error: "Malformed server lock file." }
    return { lock, error: null }
  } catch (err) {
    return { lock: null, error: err instanceof Error ? err.message : String(err) }
  }
}

function writeLockFileAtomic(lockPath: string, data: LockFileData): void {
  const dir = dirname(lockPath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.server-lock.${randomBytes(4).toString("hex")}.tmp`)
  const serialized = {
    pid: data.pid,
    port: data.port,
    bind: data.bind,
    holders: data.holders,
    ...(data.unknownHolders > 0 ? { unknownHolders: data.unknownHolders } : {}),
    startedAt: data.startedAt,
  }
  writeFileSync(tmpPath, JSON.stringify(serialized, null, 2), "utf-8")
  renameSync(tmpPath, lockPath)
}

function readStartupLockFile(lockPath: string): StartupLockData | null {
  try {
    if (!existsSync(lockPath)) return null
    const raw = JSON.parse(readFileSync(lockPath, "utf-8")) as RawStartupLockData
    if (typeof raw.ownerPid !== "number" || typeof raw.ownerId !== "string") return null
    return {
      ownerPid: raw.ownerPid,
      ownerId: raw.ownerId,
      port: raw.port ?? 0,
      bind: raw.bind ?? "",
      createdAt: raw.createdAt ?? new Date(0).toISOString(),
      staleAfterMs: raw.staleAfterMs ?? STARTUP_LOCK_STALE_AFTER_MS,
    }
  } catch {
    return null
  }
}

function isStartupLockStale(lock: StartupLockData, now = Date.now()): boolean {
  const createdAtMs = Date.parse(lock.createdAt)
  if (!Number.isFinite(createdAtMs)) return true
  return now - createdAtMs >= lock.staleAfterMs
}

function removeStartupLock(lockPath: string, ownerId?: string): void {
  try {
    if (ownerId) {
      const current = readStartupLockFile(lockPath)
      if (!current || current.ownerId !== ownerId) return
    }
    unlinkSync(lockPath)
  } catch {}
}

function tryAcquireStartupLock(lockPath: string, config: PluginConfig): StartupLockData | null {
  const lock: StartupLockData = {
    ownerPid: process.pid,
    ownerId: `${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
    port: config.mcpServer.port,
    bind: config.mcpServer.bind,
    createdAt: new Date().toISOString(),
    staleAfterMs: STARTUP_LOCK_STALE_AFTER_MS,
  }

  const dir = dirname(lockPath)
  mkdirSync(dir, { recursive: true })
  try {
    const fd = openSync(lockPath, "wx")
    try {
      writeFileSync(fd, JSON.stringify(lock, null, 2), "utf-8")
    } finally {
      closeSync(fd)
    }
    return lock
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

function getProcessCommandLine(pid: number): string | null {
  if (pid <= 0) return null
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim()
  } catch {
    return null
  }
}

function isExpectedServerProcess(config: PluginConfig, lock: LockFileData): boolean {
  if (lock.pid <= 0 || !isProcessAlive(lock.pid)) return false

  const commandLine = getProcessCommandLine(lock.pid)
  if (!commandLine) return false

  const dataDir = resolveDataDir(config)
  const expectedFragments = [
    "memory-mcp",
    String(config.mcpServer.port),
    config.mcpServer.bind,
    dataDir ?? "",
  ].filter(Boolean)

  return expectedFragments.every((fragment) => commandLine.includes(fragment))
}

function pruneDeadHolders(holders: number[]): number[] {
  return holders.filter((pid) => pid > 0 && isProcessAlive(pid))
}

function applyHolderRelease(lock: LockFileData, myPid: number): LockFileData {
  const knownHolders = pruneDeadHolders(lock.holders)
  const hadKnownOwnership = knownHolders.includes(myPid)
  const liveHolders = knownHolders.filter((pid) => pid !== myPid)
  const unknownHolders = !hadKnownOwnership && lock.unknownHolders > 0
    ? lock.unknownHolders - 1
    : lock.unknownHolders

  return { ...lock, holders: liveHolders, unknownHolders }
}

export async function shouldCoordinateCodeIndexSync(config: PluginConfig): Promise<boolean> {
  if (config.mcpServer.transport !== "http") return true

  try {
    await ensureServerRunning(config)
  } catch (err) {
    logger.debug("Falling back to local code index coordination after HTTP server check failed", {
      error: String(err),
    })
    return true
  }

  const lockPath = getLockFilePath(config)
  if (!lockPath) return true

  const lock = readLockFile(lockPath)
  if (!lock) return true

  const liveHolders = pruneDeadHolders(lock.holders)
  if (liveHolders.length === 0) return true

  if (liveHolders.length !== lock.holders.length) {
    writeLockFileAtomic(lockPath, { ...lock, holders: liveHolders })
  }

  return liveHolders[0] === process.pid
}

export function getServerUrl(config: PluginConfig): string {
  return `http://${config.mcpServer.bind}:${config.mcpServer.port}`
}

export async function isServerRunning(config: PluginConfig): Promise<boolean> {
  const url = `${getServerUrl(config)}/health`
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return false
    const body = await res.json() as { status?: string }
    return body.status === "ok"
  } catch {
    return false
  }
}

export async function getServerRuntimeStatus(config?: PluginConfig): Promise<ServerRuntimeStatus> {
  if (!config) {
    return buildNoopRuntimeStatus(config, "Server status unavailable without configuration.")
  }

  if (config.mcpServer.transport !== "http") {
    return buildNoopRuntimeStatus(config, `Server status unavailable for ${config.mcpServer.transport} transport.`)
  }

  const lockPath = getLockFilePath(config)
  if (!lockPath) {
    return buildNoopRuntimeStatus(config, "Server status unavailable because the data directory is disabled.")
  }

  try {
    const running = await isServerRunning(config)
    const { lock, error } = await readRuntimeLockStatus(lockPath)

    if (error) {
      return {
        transport: config.mcpServer.transport,
        url: getServerUrl(config),
        running: false,
        lockPresent: false,
        pid: null,
        holders: [],
        unknownHolders: 0,
        holderCount: 0,
        message: `HTTP server lock unavailable: ${error}`,
        error,
      }
    }

    if (!lock) {
      return {
        transport: config.mcpServer.transport,
        url: getServerUrl(config),
        running,
        lockPresent: false,
        pid: null,
        holders: [],
        unknownHolders: 0,
        holderCount: 0,
        message: error
          ? `HTTP server lock unavailable: ${error}`
          : formatRuntimeStatusMessage({ running, lockPresent: false, holderCount: 0, pid: null, unknownHolders: 0 }),
        ...(error ? { error } : {}),
      }
    }

    const holders = pruneDeadHolders(lock.holders)
    const holderCount = holders.length + lock.unknownHolders

    return {
      transport: config.mcpServer.transport,
      url: getServerUrl(config),
      running,
      lockPresent: true,
      pid: lock.pid,
      holders,
      unknownHolders: lock.unknownHolders,
      holderCount,
      message: formatRuntimeStatusMessage({
        running,
        lockPresent: true,
        holderCount,
        pid: lock.pid,
        unknownHolders: lock.unknownHolders,
      }),
    }
  } catch (err) {
    return {
      transport: config.mcpServer.transport,
      url: getServerUrl(config),
      running: false,
      lockPresent: false,
      pid: null,
      holders: [],
      unknownHolders: 0,
      holderCount: 0,
      message: "HTTP server status check failed.",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function waitForHealth(config: PluginConfig, maxWaitMs = 15000): Promise<boolean> {
  const interval = 500
  const maxAttempts = Math.ceil(maxWaitMs / interval)
  for (let i = 0; i < maxAttempts; i++) {
    if (await isServerRunning(config)) return true
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}

function buildHttpCommand(config: PluginConfig): { command: string; args: string[] } | null {
  const dataDir = resolveDataDir(config)
  if (!dataDir) return null

  const { command, commandPath, model, port, bind } = config.mcpServer

  let cmd: string
  let args: string[]

  if (commandPath) {
    cmd = commandPath
    args = []
  } else {
    ;[cmd, ...args] = command
  }

  if (!args.some((a) => a === "--port")) {
    args.push("--port", String(port))
  }
  if (!args.some((a) => a === "--bind")) {
    args.push("--bind", bind)
  }
  if (!args.some((a) => a === "--data-dir")) {
    args.push("--data-dir", dataDir)
  }
  if (!args.some((a) => a === "--log-file")) {
    args.push("--log-file", `${dataDir}/log/mcp-server.log`)
  }
  if (!args.some((a) => a === "--model") && model) {
    args.push("--model", model)
  }

  return { command: cmd, args }
}

function spawnServerProcess(config: PluginConfig): ChildProcess | null {
  const cmdParts = buildHttpCommand(config)
  if (!cmdParts) return null

  logger.info(`Spawning MCP server: ${cmdParts.command} ${cmdParts.args.join(" ")}`)

  const child = spawn(cmdParts.command, cmdParts.args, {
    stdio: "ignore",
    detached: true,
  })

  child.unref()
  return child
}

export async function ensureServerRunning(config: PluginConfig): Promise<string> {
  const startupKey = getStartupKey(config)
  if (!startupKey) throw new Error("Cannot resolve data directory for server lock file")

  const existingStartup = inFlightStartups.get(startupKey)
  if (existingStartup) return existingStartup

  const startup = ensureServerRunningUnshared(config)
  inFlightStartups.set(startupKey, startup)
  try {
    return await startup
  } finally {
    if (inFlightStartups.get(startupKey) === startup) {
      inFlightStartups.delete(startupKey)
    }
  }
}

async function ensureServerRunningUnshared(config: PluginConfig): Promise<string> {
  const lockPath = getLockFilePath(config)
  if (!lockPath) throw new Error("Cannot resolve data directory for server lock file")
  const startupLockPath = getStartupLockFilePath(config)
  if (!startupLockPath) throw new Error("Cannot resolve data directory for server startup lock file")

  const url = getServerUrl(config)
  const myPid = process.pid

  if (await isServerRunning(config)) {
    const lock = readLockFile(lockPath)
    if (lock) {
      const liveHolders = pruneDeadHolders(lock.holders)
      if (!liveHolders.includes(myPid)) {
        liveHolders.push(myPid)
      }
      writeLockFileAtomic(lockPath, { ...lock, holders: liveHolders })
      logger.info(`Joined existing MCP server (pid=${lock.pid}, holders=${liveHolders.length})`)
    } else {
      writeLockFileAtomic(lockPath, {
        pid: 0,
        port: config.mcpServer.port,
        bind: config.mcpServer.bind,
        holders: [myPid],
        unknownHolders: 0,
        startedAt: new Date().toISOString(),
      })
    }
    return url
  }

  const startupDeadline = Date.now() + STARTUP_LOCK_WAIT_MS
  let startupOwner = tryAcquireStartupLock(startupLockPath, config)
  while (!startupOwner) {
    const lock = readStartupLockFile(startupLockPath)
    if (!lock || isStartupLockStale(lock) || !isProcessAlive(lock.ownerPid)) {
      removeStartupLock(startupLockPath)
      startupOwner = tryAcquireStartupLock(startupLockPath, config)
      if (startupOwner) break
    } else {
      if (await isServerRunning(config)) {
        const existingLock = readLockFile(lockPath)
        if (existingLock) {
          const liveHolders = pruneDeadHolders(existingLock.holders)
          if (!liveHolders.includes(myPid)) {
            liveHolders.push(myPid)
          }
          writeLockFileAtomic(lockPath, { ...existingLock, holders: liveHolders })
          logger.info(`Joined existing MCP server (pid=${existingLock.pid}, holders=${liveHolders.length})`)
        } else {
          writeLockFileAtomic(lockPath, {
            pid: 0,
            port: config.mcpServer.port,
            bind: config.mcpServer.bind,
            holders: [myPid],
            unknownHolders: 0,
            startedAt: new Date().toISOString(),
          })
        }
        return url
      }
      if (Date.now() >= startupDeadline) {
        throw new Error(`Timed out waiting for MCP server startup lock owner (pid=${lock.ownerPid})`)
      }
      await new Promise((r) => setTimeout(r, STARTUP_LOCK_POLL_MS))
    }
  }

  if (await isServerRunning(config)) {
    removeStartupLock(startupLockPath, startupOwner.ownerId)
    const existingLock = readLockFile(lockPath)
    if (existingLock) {
      const liveHolders = pruneDeadHolders(existingLock.holders)
      if (!liveHolders.includes(myPid)) {
        liveHolders.push(myPid)
      }
      writeLockFileAtomic(lockPath, { ...existingLock, holders: liveHolders })
      logger.info(`Joined existing MCP server (pid=${existingLock.pid}, holders=${liveHolders.length})`)
    } else {
      writeLockFileAtomic(lockPath, {
        pid: 0,
        port: config.mcpServer.port,
        bind: config.mcpServer.bind,
        holders: [myPid],
        unknownHolders: 0,
        startedAt: new Date().toISOString(),
      })
    }
    return url
  }

  const staleLock = readLockFile(lockPath)
  if (staleLock) {
    if (isExpectedServerProcess(config, staleLock)) {
      try { process.kill(staleLock.pid, "SIGTERM") } catch {}
    } else if (staleLock.pid > 0 && isProcessAlive(staleLock.pid)) {
      logger.warn("Refusing to terminate stale MCP lock pid because process identity did not match expected server", {
        pid: staleLock.pid,
        port: staleLock.port,
        bind: staleLock.bind,
      })
    }
    try { unlinkSync(lockPath) } catch {}
  }

  const child = spawnServerProcess(config)
  if (!child || !child.pid) {
    removeStartupLock(startupLockPath, startupOwner.ownerId)
    throw new Error("Failed to spawn MCP server process")
  }

  const healthy = await waitForHealth(config)
  if (!healthy) {
    try { process.kill(child.pid, "SIGKILL") } catch {}
    removeStartupLock(startupLockPath, startupOwner.ownerId)
    throw new Error(`MCP server failed to become healthy within timeout (port ${config.mcpServer.port})`)
  }

  writeLockFileAtomic(lockPath, {
    pid: child.pid,
    port: config.mcpServer.port,
    bind: config.mcpServer.bind,
    holders: [myPid],
    unknownHolders: 0,
    startedAt: new Date().toISOString(),
  })
  removeStartupLock(startupLockPath, startupOwner.ownerId)

  logger.info(`Spawned MCP server (pid=${child.pid}, port=${config.mcpServer.port})`)
  return url
}

export async function stopServer(config?: PluginConfig): Promise<void> {
  if (!config || config.mcpServer.transport !== "http") return

  const lockPath = getLockFilePath(config)
  if (!lockPath) return

  const lock = readLockFile(lockPath)
  if (!lock) return

  const updatedLock = applyHolderRelease(lock, process.pid)
  const { holders: liveHolders, unknownHolders } = updatedLock

  if (liveHolders.length === 0 && unknownHolders === 0) {
    logger.info(`Last client disconnecting — shutting down MCP server (pid=${lock.pid})`)
    if (lock.pid > 0 && isProcessAlive(lock.pid)) {
      try { process.kill(lock.pid, "SIGTERM") } catch {}

      const deadline = Date.now() + 5000
      while (Date.now() < deadline && isProcessAlive(lock.pid)) {
        await new Promise((r) => setTimeout(r, 200))
      }
      if (isProcessAlive(lock.pid)) {
        try { process.kill(lock.pid, "SIGKILL") } catch {}
      }
    }
    try { unlinkSync(lockPath) } catch {}
  } else {
    writeLockFileAtomic(lockPath, updatedLock)
    logger.info(`Removed from holders; ${liveHolders.length} known holder(s) and ${unknownHolders} unknown holder(s) remain`)
  }
}

export async function releaseServerHolder(config?: PluginConfig): Promise<void> {
  if (!config || config.mcpServer.transport !== "http") return

  const lockPath = getLockFilePath(config)
  if (!lockPath) return

  const lock = readLockFile(lockPath)
  if (!lock) return

  const updatedLock = applyHolderRelease(lock, process.pid)
  writeLockFileAtomic(lockPath, updatedLock)
  logger.info(`Released HTTP holder; ${updatedLock.holders.length} known holder(s) and ${updatedLock.unknownHolders} unknown holder(s) remain`)
}
