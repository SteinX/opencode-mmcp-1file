import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { parse as parseJsonc } from "jsonc-parser"
import { logger } from "./utils/logger.js"

export interface PluginConfig {
  chatMessage: {
    enabled: boolean
    maxMemories: number
    injectOn: "first" | "always"

  }
  autoCapture: {
    enabled: boolean
    debounceMs: number
    language: string
  }
  compaction: {
    enabled: boolean
    memoryLimit: number
  }
  keywordDetection: {
    enabled: boolean
    extraPatterns: string[]
  }
  preemptiveCompaction: {
    enabled: boolean
    thresholdPercent: number
    modelContextLimit: number
    autoContinue: boolean
  }
  privacy: {
    enabled: boolean
  }
  compactionSummaryCapture: {
    enabled: boolean
  }
  captureModel: {
    provider: string
    model: string
    apiUrl: string
    apiKey: string
  }
  mcpServer: {
    command: string[]
    tag: string
    dataDir?: string
    model: string
    mcpServerName: string
  }
  systemPrompt: {
    enabled: boolean
  }
}

const DEFAULT_CONFIG: PluginConfig = {
  chatMessage: {
    enabled: true,
    maxMemories: 5,
    injectOn: "first",
  },
  autoCapture: {
    enabled: true,
    debounceMs: 10_000,
    language: "en",
  },
  compaction: {
    enabled: true,
    memoryLimit: 10,
  },
  keywordDetection: {
    enabled: true,
    extraPatterns: [],
  },
  preemptiveCompaction: {
    enabled: true,
    thresholdPercent: 80,
    modelContextLimit: 200_000,
    autoContinue: true,
  },
  privacy: {
    enabled: true,
  },
  compactionSummaryCapture: {
    enabled: true,
  },
  captureModel: {
    provider: "openai",
    model: "gpt-4o-mini",
    apiUrl: "https://api.openai.com/v1",
    apiKey: "",
  },
  mcpServer: {
    command: ["npm", "exec", "-y", "memory-mcp-1file", "--"],
    tag: "",
    model: "qwen3",
    mcpServerName: "memory-mcp-1file",
  },
  systemPrompt: {
    enabled: true,
  },
}

export function resolveDataDir(config: PluginConfig): string | null {
  if (config.mcpServer.dataDir) {
    return config.mcpServer.dataDir
  }
  if (config.mcpServer.tag) {
    return join(homedir(), ".local/share/opencode-mmcp-1file", config.mcpServer.tag)
  }
  return null
}

export function loadConfig(directory?: string): PluginConfig {
  const candidates = [
    directory && join(directory, "opencode-mmcp-1file.jsonc"),
    directory && join(directory, "opencode-mmcp-1file.json"),
    join(homedir(), ".config", "opencode", "opencode-mmcp-1file.jsonc"),
    join(homedir(), ".config", "opencode", "opencode-mmcp-1file.json"),
  ].filter(Boolean) as string[]

  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf-8")
        const parsed = parseJsonc(raw, [], { allowTrailingComma: true })
        return mergeConfig(DEFAULT_CONFIG, parsed)
      } catch (err) {
        logger.warn(`Failed to parse config at ${path}`, { error: String(err) })
      }
    }
  }

  return DEFAULT_CONFIG
}

function mergeConfig(defaults: PluginConfig, overrides: Partial<any>): PluginConfig {
  return {
    chatMessage: { ...defaults.chatMessage, ...overrides.chatMessage },
    autoCapture: { ...defaults.autoCapture, ...overrides.autoCapture },
    compaction: { ...defaults.compaction, ...overrides.compaction },
    keywordDetection: { ...defaults.keywordDetection, ...overrides.keywordDetection },
    preemptiveCompaction: { ...defaults.preemptiveCompaction, ...overrides.preemptiveCompaction },
    privacy: { ...defaults.privacy, ...overrides.privacy },
    compactionSummaryCapture: { ...defaults.compactionSummaryCapture, ...overrides.compactionSummaryCapture },
    captureModel: { ...defaults.captureModel, ...overrides.captureModel },
    mcpServer: { ...defaults.mcpServer, ...overrides.mcpServer },
    systemPrompt: { ...defaults.systemPrompt, ...overrides.systemPrompt },
  }
}

/**
 * Reload config from disk and apply changes in-place to the existing config object.
 * All closures holding a reference to `target` will see the updated values immediately.
 * Returns a list of section names that changed.
 */
export function applyConfig(target: PluginConfig, directory?: string): string[] {
  const fresh = loadConfig(directory)
  const changed: string[] = []
  const sections = Object.keys(fresh) as (keyof PluginConfig)[]

  for (const section of sections) {
    if (JSON.stringify(target[section]) !== JSON.stringify(fresh[section])) {
      changed.push(section)
      Object.assign(target[section], fresh[section])
    }
  }
  return changed
}
