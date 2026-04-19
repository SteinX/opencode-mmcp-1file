import type { createOpencodeClient } from "@opencode-ai/sdk"
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"

type Client = ReturnType<typeof createOpencodeClient>

const SERVICE_NAME = "opencode-mmcp-1file"
const LOG_FILE = "plugin.log"
const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_BACKUP_FILES = 5

let _client: Client | null = null
let _logDir: string | null = null

export function initLogger(client: Client, logDir?: string): void {
  _client = client
  if (logDir) {
    _logDir = logDir
    try {
      if (!existsSync(_logDir)) {
        mkdirSync(_logDir, { recursive: true })
      }
    } catch {
      // Swallow to prevent circular errors
    }
  }
}

function formatLogEntry(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
): string {
  const timestamp = new Date().toISOString()
  const extraStr = extra ? ` ${JSON.stringify(extra)}` : ""
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${extraStr}\n`
}

function getLogFilePath(backupIndex?: number): string {
  if (!_logDir) return ""
  const suffix = backupIndex !== undefined ? `.${backupIndex}` : ""
  return join(_logDir, `${LOG_FILE}${suffix}`)
}

function rotateLogFiles(): void {
  if (!_logDir) return

  try {
    const oldestBackup = getLogFilePath(MAX_BACKUP_FILES)
    if (existsSync(oldestBackup)) {
      unlinkSync(oldestBackup)
    }

    for (let i = MAX_BACKUP_FILES - 1; i >= 1; i--) {
      const src = getLogFilePath(i)
      const dst = getLogFilePath(i + 1)
      if (existsSync(src)) {
        renameSync(src, dst)
      }
    }

    const currentLog = getLogFilePath()
    if (existsSync(currentLog)) {
      renameSync(currentLog, getLogFilePath(1))
    }
  } catch {
    // Swallow to prevent circular errors
  }
}

function shouldRotate(): boolean {
  if (!_logDir) return false
  try {
    const currentLog = getLogFilePath()
    if (!existsSync(currentLog)) return false
    const stats = statSync(currentLog)
    return stats.size >= MAX_FILE_SIZE
  } catch {
    return false
  }
}

function writeToFile(level: "debug" | "info" | "warn" | "error", formattedMessage: string): void {
  if (!_logDir) return

  try {
    if (shouldRotate()) {
      rotateLogFiles()
    }

    const logFile = getLogFilePath()
    appendFileSync(logFile, formattedMessage, "utf-8")
  } catch {
    // Swallow to prevent circular errors
  }
}

function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
): void {
  const formattedMessage = formatLogEntry(level, message, extra)
  writeToFile(level, formattedMessage)

  if (!_client) return
  _client.app
    .log({
      body: {
        service: SERVICE_NAME,
        level,
        message,
        ...(extra && { extra }),
      },
    })
    .catch(() => {
      // Swallow to prevent circular errors
    })
}

export const logger = {
  debug: (message: string, extra?: Record<string, unknown>) => log("debug", message, extra),
  info: (message: string, extra?: Record<string, unknown>) => log("info", message, extra),
  warn: (message: string, extra?: Record<string, unknown>) => log("warn", message, extra),
  error: (message: string, extra?: Record<string, unknown>) => log("error", message, extra),
}