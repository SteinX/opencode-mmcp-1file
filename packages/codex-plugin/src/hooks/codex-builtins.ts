import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { homedir } from "node:os"

const MAX_SECTION_CHARS = 1200

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex")
}

function readSmallFile(path: string, maxChars = MAX_SECTION_CHARS): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null
    const raw = readFileSync(path, "utf8").trim()
    return raw.length > maxChars ? raw.slice(0, maxChars).trimEnd() : raw
  } catch {
    return null
  }
}

function findNearestFile(cwd: string, fileName: string): string | null {
  let current = cwd
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, fileName)
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

export function readCodexBuiltinMemorySummary(): string | null {
  const summary = readSmallFile(join(codexHome(), "memories", "memory_summary.md"), 900)
  if (!summary) return null
  return `Codex built-in memory summary (read-only):\n${summary}`
}

export function readStableRepoGuidance(cwd: string): string | null {
  const agentsPath = findNearestFile(cwd, "AGENTS.md")
  const agents = agentsPath ? readSmallFile(agentsPath, 900) : null

  const parts: string[] = []
  if (agents) {
    parts.push(`Repo guidance from ${basename(agentsPath || "AGENTS.md")}:\n${agents}`)
  }

  return parts.length > 0 ? parts.join("\n\n") : null
}
