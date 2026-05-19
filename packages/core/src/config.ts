import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { parse as parseJsonc } from "jsonc-parser"
import { logger } from "./utils/logger.js"

export interface TierConfig {
  /** Category prefixes to match (e.g. ["DECISION", "PATTERN"]) */
  categories: string[]
  /** Max memories to inject from this tier */
  limit: number
}

export interface PluginConfig {
  chatMessage: {
    enabled: boolean
    maxMemories: number
    maxProjectMemories: number
    maxInjectedMemories?: number
    injectOn: "first" | "always"
    shortQueryMinLength?: number
    minScore?: number
    projectKnowledgeInjectOn?: "first" | "always" | "compaction" | "never"
    codeIntelInjectOn?: "first" | "always" | "compaction" | "never"
    knowledgeGraphInjectOn?: "first" | "always" | "compaction" | "never"
    maxKnowledgeGraphItems?: number
    knowledgeGraphRelatedDepth?: number
    knowledgeGraphEntityMatch?: boolean
    projectKnowledgeValidOnly?: boolean
    /** Preferred server-side bootstrap result limit for normal prompt context. */
    bootstrapLimit?: number
    /** Preferred server-side bootstrap token budget for normal prompt context. */
    bootstrapTokenBudget?: number
    /** Tiered injection: prioritize important categories over recency. Set to null/undefined to disable (flat list fallback). */
    projectKnowledgeTiers?: TierConfig[] | null
  }
  autoCapture: {
    enabled: boolean
    debounceMs: number
    language: string
  }
  compaction: {
    enabled: boolean
    memoryLimit: number
    /** Preferred server-side bootstrap result limit for compaction recovery. */
    bootstrapLimit?: number
    /** Preferred server-side bootstrap token budget for compaction recovery. */
    bootstrapTokenBudget?: number
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
  codeIndexSync: {
    enabled: boolean
    /** Automatically refresh stale code indexes on startup/session idle. When false, manual project_index/project_ensure_index tools still work. */
    autoRefresh: boolean
    debounceMs: number
    minReindexIntervalMs: number
    includePatterns?: string[]
    excludePatterns?: string[]
    resume?: {
      enabled?: boolean
      pollIntervalMs?: number
      maxPollMs?: number
      allowFullRestartFallback?: boolean
      allowDestructiveRecovery?: boolean
    }
  }
  preferenceLearning: {
    enabled: boolean
    learnOnCorrections: boolean
    learnOnNegations: boolean
    learnOnMessageUpdated: boolean
    injectOn: "first" | "always" | "compaction" | "never"
    scope: "project" | "global"
    minConfidence: number
    candidateConfidence: number
    maxPreferences: number
    maxCandidates: number
    debounceMs: number
    maxInputChars: number
    maxStoredPreferences: number
  }
  learningMemory?: {
    enabled?: boolean
    preferences?: { enabled?: boolean }
    lessons?: { enabled?: boolean }
    rules?: { enabled?: boolean }
    injection?: {
      mode?: "auto" | "manual"
      maxPinned?: number
      maxRetrieved?: number
      includeEvidence?: boolean
    }
    fallback?: {
      legacyPreferences?: boolean
    }
  }
  captureModel: {
    provider: string
    model: string
    apiUrl: string
    apiKey: string
  }
  memoryScope: {
    /** Optional logical namespace inside the current dataDir/tag shard. */
    namespace?: string
    /** Keep memories shared across collaborating agents by default. */
    shareAcrossAgents: boolean
    /** Record agent identity on writes for observability, without filtering reads by default. */
    includeAgentMetadata: boolean
    /** Record run/session identity on writes when available. */
    includeRunMetadata: boolean
    /** Optional default user scope for all memory operations. */
    userId?: string
    /** Optional metadata merged into every write and used as default read filter only when explicitly configured by callers. */
    defaultMetadata?: Record<string, unknown>
  }
  mcpServer: {
    command: string[]
    tag: string
    dataDir?: string
    model: string
    mcpServerName: string
    /** Override binary path — when set, replaces the `command` array with this single binary. Plugin still appends managed flags (--data-dir, --model, --stdio/--port/--bind). */
    commandPath?: string
    /** Transport mode: "stdio" (default) or "http" (shared server via Streamable HTTP) */
    transport: "stdio" | "http"
    /** Port for HTTP transport (default: 23817) */
    port: number
    /** Bind address for HTTP transport (default: "127.0.0.1") */
    bind: string
    /** Background reconnect interval after a connection failure (default: 30000) */
    reconnectIntervalMs: number
    /** HTTP-only keepalive interval while a client connection is active (default: 20000) */
    heartbeatIntervalMs: number
  }
  systemPrompt: {
    enabled: boolean
  }
  performance: {
    /** Timeout for recall/semantic search MCP calls (ms). Default: 15000 */
    recallTimeoutMs: number
    /** Timeout for project_info/list MCP calls (ms). Default: 10000 */
    projectInfoTimeoutMs: number
    /** Timeout for knowledge_graph MCP calls (ms). Default: 10000 */
    knowledgeGraphTimeoutMs: number
    /** Timeout for project knowledge (list_memories/get_valid) MCP calls (ms). Default: 15000 */
    projectKnowledgeTimeoutMs: number
    /** Timeout for learning memory retrieval MCP calls (ms). Default: 10000 */
    learningMemoryTimeoutMs: number
    /** Timeout for memory_bootstrap MCP calls (ms). Default: 10000 */
    bootstrapTimeoutMs: number
    /** Timeout for memory_observation_create MCP calls (ms). Default: 10000 */
    observationTimeoutMs: number
    /** Timeout for memory_audit MCP calls (ms). Default: 10000 */
    auditTimeoutMs: number
    /** Timeout for memory_search_trace MCP calls (ms). Default: 10000 */
    searchTraceTimeoutMs: number
    /** TTL for project_info cache (ms). Default: 300000 (5 min) */
    projectInfoCacheTtlMs: number
  }
}

export const DEFAULT_CONFIG: PluginConfig = {
  chatMessage: {
    enabled: true,
    maxMemories: 5,
    maxProjectMemories: 30,
    maxInjectedMemories: 6,
    injectOn: "first",
    shortQueryMinLength: 3,
    minScore: 0.35,
    projectKnowledgeInjectOn: "compaction",
    codeIntelInjectOn: "compaction",
    knowledgeGraphInjectOn: "compaction",
    maxKnowledgeGraphItems: 10,
    knowledgeGraphRelatedDepth: 1,
    knowledgeGraphEntityMatch: true,
    projectKnowledgeValidOnly: false,
    bootstrapLimit: 10,
    bootstrapTokenBudget: 4000,
    projectKnowledgeTiers: [
      { categories: ["USER"], limit: 5 },
      { categories: ["DECISION", "PATTERN"], limit: 5 },
      { categories: ["CONTEXT"], limit: 5 },
    ],
  },
  autoCapture: {
    enabled: false,
    debounceMs: 10_000,
    language: "en",
  },
  compaction: {
    enabled: true,
    memoryLimit: 10,
    bootstrapLimit: 5,
    bootstrapTokenBudget: 1500,
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
  codeIndexSync: {
    enabled: true,
    autoRefresh: false,
    debounceMs: 10_000,
    minReindexIntervalMs: 300_000,
    resume: {
      enabled: true,
      pollIntervalMs: 5_000,
      maxPollMs: 300_000,
      allowFullRestartFallback: false,
      allowDestructiveRecovery: false,
    },
  },
  preferenceLearning: {
    enabled: false,
    learnOnCorrections: true,
    learnOnNegations: true,
    learnOnMessageUpdated: true,
    injectOn: "first",
    scope: "project",
    minConfidence: 0.7,
    candidateConfidence: 0.4,
    maxPreferences: 5,
    maxCandidates: 3,
    debounceMs: 10_000,
    maxInputChars: 4_000,
    maxStoredPreferences: 50,
  },
  learningMemory: {
    enabled: false,
    preferences: { enabled: false },
    lessons: { enabled: false },
    rules: { enabled: false },
    injection: {
      mode: "auto",
      maxPinned: 3,
      maxRetrieved: 10,
      includeEvidence: false,
    },
    fallback: {
      legacyPreferences: true,
    },
  },
  captureModel: {
    provider: "",
    model: "",
    apiUrl: "",
    apiKey: "",
  },
  memoryScope: {
    namespace: "",
    shareAcrossAgents: true,
    includeAgentMetadata: true,
    includeRunMetadata: false,
    userId: "",
    defaultMetadata: {},
  },
  mcpServer: {
    command: ["npm", "exec", "-y", "@steinx/memory-mcp-1file", "--"],
    tag: "",
    model: "qwen3",
    mcpServerName: "memory-mcp-1file",
    transport: "stdio",
    port: 23817,
    bind: "127.0.0.1",
    reconnectIntervalMs: 30_000,
    heartbeatIntervalMs: 20_000,
  },
  systemPrompt: {
    enabled: true,
  },
  performance: {
    recallTimeoutMs: 15_000,
    projectInfoTimeoutMs: 10_000,
    knowledgeGraphTimeoutMs: 10_000,
    projectKnowledgeTimeoutMs: 15_000,
    learningMemoryTimeoutMs: 10_000,
    bootstrapTimeoutMs: 10_000,
    observationTimeoutMs: 10_000,
    auditTimeoutMs: 10_000,
    searchTraceTimeoutMs: 10_000,
    projectInfoCacheTtlMs: 300_000,
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
    codeIndexSync: {
      ...defaults.codeIndexSync,
      ...overrides.codeIndexSync,
      resume: {
        ...defaults.codeIndexSync.resume,
        ...overrides.codeIndexSync?.resume,
      },
    },
    preferenceLearning: { ...defaults.preferenceLearning, ...overrides.preferenceLearning },
    learningMemory: {
      ...defaults.learningMemory,
      ...overrides.learningMemory,
      preferences: {
        ...defaults.learningMemory?.preferences,
        ...overrides.learningMemory?.preferences,
      },
      lessons: {
        ...defaults.learningMemory?.lessons,
        ...overrides.learningMemory?.lessons,
      },
      rules: {
        ...defaults.learningMemory?.rules,
        ...overrides.learningMemory?.rules,
      },
      injection: {
        ...defaults.learningMemory?.injection,
        ...overrides.learningMemory?.injection,
      },
      fallback: {
        ...defaults.learningMemory?.fallback,
        ...overrides.learningMemory?.fallback,
      },
    },
    captureModel: { ...defaults.captureModel, ...overrides.captureModel },
    memoryScope: { ...defaults.memoryScope, ...overrides.memoryScope },
    mcpServer: { ...defaults.mcpServer, ...overrides.mcpServer },
    systemPrompt: { ...defaults.systemPrompt, ...overrides.systemPrompt },
    performance: { ...defaults.performance, ...overrides.performance },
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
      if (target[section] != null && typeof target[section] === "object") {
        Object.assign(target[section] as object, fresh[section])
      } else {
        ;(target as any)[section] = fresh[section]
      }
    }
  }
  return changed
}
