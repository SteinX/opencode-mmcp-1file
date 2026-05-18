import type { PluginConfig } from "../config.js"
import { withTimeout } from "../utils/timeout.js"
import {
  callMemoryToolJson,
  discoverTools,
  getMemoryConnectionKey,
  registerMemoryClientLifecycleHandler,
  storeMemory,
  type MemoryOperationContext,
} from "./mcp-client.js"
import { logger } from "../utils/logger.js"

const ORCHESTRATION_TOOLS = [
  "memory_bootstrap",
  "memory_observation_create",
  "memory_audit",
  "memory_search_trace",
] as const

const LEGAL_MEMORY_PREFIXES = [
  "PROJECT:",
  "EPIC:",
  "TASK:",
  "RESEARCH:",
  "DECISION:",
  "CONTEXT:",
  "USER:",
]

export type ServerOrchestrationTool = typeof ORCHESTRATION_TOOLS[number]

export interface BootstrapRequest {
  prompt?: string
  compactSummary?: string
  limit?: number
  tokenBudget?: number
  context?: MemoryOperationContext & {
    projectId?: string
  }
}

export interface BootstrapContextResult {
  text: string
  count: number
  usedFallback: boolean
  raw: Record<string, unknown>
}

export interface HookObservationRequest {
  content: string
  source: string
  eventType: string
  confidence?: number
  redactionState?: string
  memoryType?: string
  context?: MemoryOperationContext
  metadata?: Record<string, unknown>
}

const capabilityCache = new Map<string, Set<string>>()
const capabilityPromises = new Map<string, Promise<Set<string>>>()

registerMemoryClientLifecycleHandler(({ connectionKey }) => {
  clearServerCapabilityCache(connectionKey)
})

export function clearServerCapabilityCache(connectionKey?: string): void {
  if (connectionKey) {
    capabilityCache.delete(connectionKey)
    capabilityPromises.delete(connectionKey)
  } else {
    capabilityCache.clear()
    capabilityPromises.clear()
  }
}

export async function getServerCapabilities(config: PluginConfig): Promise<Set<string>> {
  const key = getMemoryConnectionKey(config)
  const cached = capabilityCache.get(key)
  if (cached) return new Set(cached)

  const pending = capabilityPromises.get(key)
  if (pending) return new Set(await pending)

  const promise = (async () => {
    const tools = await discoverTools(config)
    const capabilities = new Set(tools)
    if (tools.length > 0) {
      capabilityCache.set(key, capabilities)
    }
    return capabilities
  })()

  capabilityPromises.set(key, promise)
  try {
    return new Set(await promise)
  } finally {
    if (capabilityPromises.get(key) === promise) {
      capabilityPromises.delete(key)
    }
  }
}

export async function buildBootstrapContext(
  config: PluginConfig,
  request: BootstrapRequest = {},
): Promise<BootstrapContextResult | null> {
  const capabilities = await getServerCapabilities(config)
  if (!capabilities.has("memory_bootstrap")) return null

  const limit = request.limit ?? config.chatMessage.bootstrapLimit ?? 10
  const tokenBudget = request.tokenBudget ?? config.chatMessage.bootstrapTokenBudget ?? 4000
  const args = cleanRecord({
    prompt: request.prompt,
    compact_summary: request.compactSummary,
    ...buildScopeArgs(config, request.context),
    project_id: request.context?.projectId,
    limit,
    token_budget: tokenBudget,
  })

  const raw = await safeJsonToolCall(config, "memory_bootstrap", args, config.performance.bootstrapTimeoutMs)
  if (!raw || partialReasonCode(raw) === "unsupported") return null

  const activeTasks = readRecordArray(raw.active_tasks)
  const stableContext = readStableContext(raw.stable_context)
  const recovery = readRecordArray(raw.recovery)
  const count = activeTasks.length + stableContext.reduce((sum, group) => sum + group.entries.length, 0) + recovery.length
  const reasonCode = partialReasonCode(raw)

  const parts = [
    renderEntrySection("[MEMORY BOOTSTRAP] Active Tasks", activeTasks),
    renderStableContext(stableContext),
    renderEntrySection("[MEMORY BOOTSTRAP] Recovery", recovery),
    renderRecordSection("[MEMORY BOOTSTRAP] Project Readiness", raw.project),
    renderHealthSection(raw, reasonCode),
    renderPartialSection(raw.summary, reasonCode),
    renderSelectionSummary(raw.selection_summary),
  ].filter((part): part is string => Boolean(part))

  if (parts.length === 0) return null

  return {
    text: parts.join("\n\n"),
    count,
    usedFallback: false,
    raw,
  }
}

export async function createHookObservation(
  config: PluginConfig,
  request: HookObservationRequest,
): Promise<boolean> {
  const capabilities = await getServerCapabilities(config)
  const content = ensureLegalPrefix(request.content)

  if (!capabilities.has("memory_observation_create")) {
    return storeObservationFallback(config, request, content)
  }

  const args = cleanRecord({
    content,
    source: request.source,
    event_type: request.eventType,
    ...buildScopeArgs(config, request.context),
    confidence: request.confidence,
    redaction_state: request.redactionState,
    metadata: mergeObservationMetadata(config, request),
    memory_type: request.memoryType,
  })

  const result = await jsonToolCallResult(config, "memory_observation_create", args, config.performance.observationTimeoutMs)
  if (result.status === "timeout") return true
  if (result.status === "ok" && result.raw && partialReasonCode(result.raw) !== "unsupported") return true

  return storeObservationFallback(config, request, content)
}

export async function getMemoryAudit(
  config: PluginConfig,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const capabilities = await getServerCapabilities(config)
  if (!capabilities.has("memory_audit")) return unsupportedResponse("memory_audit")

  const raw = await safeJsonToolCall(config, "memory_audit", args, config.performance.auditTimeoutMs)
  return raw ?? degradedResponse("memory_audit")
}

export async function getMemorySearchTrace(
  config: PluginConfig,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const capabilities = await getServerCapabilities(config)
  if (!capabilities.has("memory_search_trace")) return unsupportedResponse("memory_search_trace")

  const raw = await safeJsonToolCall(config, "memory_search_trace", args, config.performance.searchTraceTimeoutMs)
  return raw ?? degradedResponse("memory_search_trace")
}

async function safeJsonToolCall(
  config: PluginConfig,
  toolName: ServerOrchestrationTool,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const result = await jsonToolCallResult(config, toolName, args, timeoutMs)
  return result.status === "ok" ? result.raw : null
}

type JsonToolCallResult =
  | { status: "ok"; raw: Record<string, unknown> | null }
  | { status: "timeout" }
  | { status: "failed" }

async function jsonToolCallResult(
  config: PluginConfig,
  toolName: ServerOrchestrationTool,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<JsonToolCallResult> {
  const timeoutSentinel = Symbol(toolName)
  try {
    const raw = await withTimeout<Record<string, unknown> | null | typeof timeoutSentinel>(
      callMemoryToolJson(config, toolName, args),
      timeoutMs,
      { fallback: timeoutSentinel, label: toolName },
    )
    if (raw === timeoutSentinel) return { status: "timeout" }
    return { status: "ok", raw }
  } catch (err) {
    logger.debug(`${toolName} failed`, { error: String(err) })
    return { status: "failed" }
  }
}

function storeObservationFallback(
  config: PluginConfig,
  request: HookObservationRequest,
  content: string,
): Promise<boolean> {
  return storeMemory(config, content, request.memoryType, {
    ...request.context,
    memoryType: request.context?.memoryType ?? request.memoryType,
    metadata: mergeObservationMetadata(config, request),
  })
}

function ensureLegalPrefix(content: string): string {
  const trimmed = content.trim()
  const upper = trimmed.toUpperCase()
  if (LEGAL_MEMORY_PREFIXES.some((prefix) => upper.startsWith(prefix))) return trimmed
  return `CONTEXT: ${trimmed}`
}

function buildScopeArgs(
  config: PluginConfig,
  context?: MemoryOperationContext,
): Record<string, unknown> {
  return cleanRecord({
    namespace: context?.namespace ?? config.memoryScope.namespace,
    user_id: context?.userId ?? config.memoryScope.userId,
    ...(config.memoryScope.shareAcrossAgents ? {} : { agent_id: context?.agentId }),
    run_id: context?.runId,
  })
}

function mergeObservationMetadata(config: PluginConfig, request: HookObservationRequest): Record<string, unknown> | undefined {
  const merged = cleanRecord({
    ...(config.memoryScope.defaultMetadata ?? {}),
    ...request.context?.metadata,
    ...request.metadata,
    ...(config.memoryScope.includeAgentMetadata && request.context?.agentId
      ? { source_agent_id: request.context.agentId }
      : {}),
    ...(config.memoryScope.includeRunMetadata && request.context?.runId
      ? { source_run_id: request.context.runId }
      : {}),
  })

  return Object.keys(merged).length > 0 ? merged : undefined
}

function partialReasonCode(raw: Record<string, unknown>): string | undefined {
  if (!isRecord(raw.summary) || !isRecord(raw.summary.partial)) return undefined
  return asString(raw.summary.partial.reason_code)
}

function unsupportedResponse(tool: ServerOrchestrationTool): Record<string, unknown> {
  return {
    status: "unsupported",
    reason_code: "unsupported",
    tool,
  }
}

function degradedResponse(tool: ServerOrchestrationTool): Record<string, unknown> {
  return {
    status: "degraded",
    reason_code: "degraded",
    tool,
  }
}

function renderEntrySection(title: string, entries: Record<string, unknown>[]): string | null {
  if (entries.length === 0) return null
  return [title, ...entries.map((entry) => `- ${renderEntry(entry)}`)].join("\n")
}

function renderStableContext(groups: Array<{ label: string; entries: Record<string, unknown>[] }>): string | null {
  if (groups.length === 0) return null

  const lines = ["[MEMORY BOOTSTRAP] Stable Context"]
  for (const group of groups) {
    lines.push(`${group.label}:`)
    for (const entry of group.entries) {
      lines.push(`- ${ensureEntryPrefix(group.label, renderEntry(entry))}`)
    }
  }
  return lines.join("\n")
}

function renderHealthSection(raw: Record<string, unknown>, reasonCode?: string): string | null {
  if (!isRecord(raw.memory_health)) return null
  const status = asString(raw.memory_health.status)
  const actionableReason = Boolean(reasonCode && !["fresh", "ok"].includes(reasonCode))
  const actionable = actionableReason
    || status === "degraded"
    || status === "partial"
    || raw.memory_health.degraded === true
    || raw.memory_health.partial === true
  return actionable ? renderRecordSection("[MEMORY BOOTSTRAP] Memory Health", raw.memory_health) : null
}

function renderRecordSection(title: string, value: unknown): string | null {
  if (!isRecord(value)) return null
  const lines = Object.entries(value)
    .map(([key, entry]) => `- ${key}: ${renderValue(entry)}`)
  return lines.length > 0 ? [title, ...lines].join("\n") : null
}

function renderPartialSection(summary: unknown, reasonCode?: string): string | null {
  if (!isRecord(summary) || !isRecord(summary.partial)) return null
  if (!reasonCode || ["fresh", "ok"].includes(reasonCode)) return null
  return renderRecordSection("[MEMORY BOOTSTRAP] Partial Result", summary.partial)
}

function renderSelectionSummary(selectionSummary: unknown): string | null {
  if (!isRecord(selectionSummary)) return null
  const reason = asString(selectionSummary.reason)
  if (selectionSummary.truncated === true && reason) {
    return `[MEMORY BOOTSTRAP] Selection truncated: ${reason}`
  }
  return null
}

function renderEntry(entry: Record<string, unknown>): string {
  return asString(entry.content)
    ?? asString(entry.summary)
    ?? asString(entry.text)
    ?? renderValue(entry)
}

function ensureEntryPrefix(group: string, content: string): string {
  const trimmed = content.trim()
  if (LEGAL_MEMORY_PREFIXES.some((prefix) => trimmed.toUpperCase().startsWith(prefix))) return trimmed

  const normalized = group.trim().replace(/[:：]+$/, "").toUpperCase()
  const prefix = LEGAL_MEMORY_PREFIXES.find((candidate) => candidate.slice(0, -1) === normalized)
  return prefix ? `${prefix} ${trimmed}` : trimmed
}

function renderValue(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function readStableContext(value: unknown): Array<{ label: string; entries: Record<string, unknown>[] }> {
  if (Array.isArray(value)) {
    const entries = value.filter(isRecord)
    return entries.length > 0 ? [{ label: "memories", entries }] : []
  }
  if (!isRecord(value)) return []

  return Object.entries(value)
    .map(([label, entries]) => ({
      label,
      entries: readRecordArray(entries),
    }))
    .filter((group) => group.entries.length > 0)
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function cleanRecord<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""),
  ) as T
}
