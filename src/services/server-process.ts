import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, renameSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import type { PluginConfig } from "../config.js"
import { resolveDataDir } from "../config.js"
import { logger } from "../utils/logger.js"

interface LockFileData {
  pid: number
  port: number
  bind: string
  refCount: number
  startedAt: string
}

function getLockFilePath(config: PluginConfig): string | null {
  const dataDir = resolveDataDir(config)
  if (!dataDir) return null
  return join(dataDir, ".server-lock")
}

function readLockFile(lockPath: string): LockFileData | null {
  try {
    if (!existsSync(lockPath)) return null
    const raw = readFileSync(lockPath, "utf-8")
    return JSON.parse(raw) as LockFileData
  } catch {
    return null
  }
}

function writeLockFileAtomic(lockPath: string, data: LockFileData): void {
  const dir = dirname(lockPath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.server-lock.${randomBytes(4).toString("hex")}.tmp`)
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8")
  renameSync(tmpPath, lockPath)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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
  const lockPath = getLockFilePath(config)
  if (!lockPath) throw new Error("Cannot resolve data directory for server lock file")

  const url = getServerUrl(config)

  if (await isServerRunning(config)) {
    const lock = readLockFile(lockPath)
    if (lock) {
      lock.refCount += 1
      writeLockFileAtomic(lockPath, lock)
      logger.info(`Joined existing MCP server (pid=${lock.pid}, refCount=${lock.refCount})`)
    } else {
      writeLockFileAtomic(lockPath, {
        pid: 0,
        port: config.mcpServer.port,
        bind: config.mcpServer.bind,
        refCount: 1,
        startedAt: new Date().toISOString(),
      })
    }
    return url
  }

  const staleLock = readLockFile(lockPath)
  if (staleLock) {
    if (staleLock.pid > 0 && isProcessAlive(staleLock.pid)) {
      try { process.kill(staleLock.pid, "SIGTERM") } catch {}
    }
    try { unlinkSync(lockPath) } catch {}
  }

  const child = spawnServerProcess(config)
  if (!child || !child.pid) {
    throw new Error("Failed to spawn MCP server process")
  }

  const healthy = await waitForHealth(config)
  if (!healthy) {
    try { process.kill(child.pid, "SIGKILL") } catch {}
    throw new Error(`MCP server failed to become healthy within timeout (port ${config.mcpServer.port})`)
  }

  writeLockFileAtomic(lockPath, {
    pid: child.pid,
    port: config.mcpServer.port,
    bind: config.mcpServer.bind,
    refCount: 1,
    startedAt: new Date().toISOString(),
  })

  logger.info(`Spawned MCP server (pid=${child.pid}, port=${config.mcpServer.port})`)
  return url
}

export async function stopServer(config?: PluginConfig): Promise<void> {
  if (!config || config.mcpServer.transport !== "http") return

  const lockPath = getLockFilePath(config)
  if (!lockPath) return

  const lock = readLockFile(lockPath)
  if (!lock) return

  lock.refCount -= 1

  if (lock.refCount <= 0) {
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
    writeLockFileAtomic(lockPath, lock)
    logger.info(`Decremented server refCount to ${lock.refCount}`)
  }
}
