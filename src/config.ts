import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"

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
    dataDir: string
    model: string
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
    command: ["npx", "-y", "memory-mcp-1file"],
    dataDir: join(
      homedir(),
      ".local/share/opencode-mmcp-1file/default",
    ),
    model: "qwen3",
  },
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
        // Strip JSONC comments (// and /* */)
        const stripped = raw
          .replace(/\/\/.*$/gm, "")
          .replace(/\/\*[\s\S]*?\*\//g, "")
        const parsed = JSON.parse(stripped)
        return mergeConfig(DEFAULT_CONFIG, parsed)
      } catch {
        // ignore parse errors, use defaults
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
  }
}
