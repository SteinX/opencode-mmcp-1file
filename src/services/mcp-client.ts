import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { PluginConfig, resolveDataDir } from "../config.js"
import type { MemoryEntry } from "../utils/format.js"
import { logger } from "../utils/logger.js"
import { isConnectionFailed, markConnectionFailed, markConnectionHealthy } from "./connection-state.js"
import { ensureServerRunning, isServerRunning, releaseServerHolder } from "./server-process.js"

export type RetrievalStatus = "ok" | "empty" | "failed" | "unavailable"

export interface RetrievalResult {
  status: RetrievalStatus
  source: "recall" | "search" | "list" | "valid"
  memories: MemoryEntry[]
  reason?: string
}

export interface MemoryOperationContext {
  agentId?: string
  runId?: string
  namespace?: string
  userId?: string
  metadata?: Record<string, unknown>
  metadataFilter?: Record<string, unknown>
  memoryType?: string
  eventAfter?: string
  eventBefore?: string
  ingestionAfter?: string
  ingestionBefore?: string
  validAt?: string
  timestamp?: string
}

export type ProjectInfoReasonCode =
  | "missing"
  | "stale"
  | "partial"
  | "degraded"
  | "invalid_locator"
  | "generation_mismatch"
  | "unsupported"
  | (string & {})

export type ProjectLocatorLookupState = "created" | "resolved" | "missing" | (string & {})

export type ProjectIndexingState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | (string & {})

export type DurableIndexingReasonCode =
  | "active_index_running"
  | "can_resume"
  | "lost_one_shot_indexing_task_after_restart"
  | "checkpoint_generation_missing"
  | "workspace_changed_since_checkpoint"
  | "index_storage_corrupt"
  | (string & {})

interface ProjectInfoSummaryPartial {
  reasonCode?: ProjectInfoReasonCode
  reason?: string
  raw: Record<string, unknown>
}

interface ProjectInfoSummaryEnvelope {
  partial?: ProjectInfoSummaryPartial
  raw: Record<string, unknown>
}

interface ProjectInfoContractEnvelope {
  raw: Record<string, unknown>
}

interface ProjectDurableProgress {
  current?: number
  total?: number
  percent?: number
  completed?: number
  remaining?: number
  stage?: string
  step?: string
  raw: Record<string, unknown>
}

interface ProjectLocatorLookup {
  state?: ProjectLocatorLookupState
  reasonCode?: ProjectInfoReasonCode
  reason?: string
  raw: Record<string, unknown>
}

interface ProjectLocatorLifecycle {
  raw: Record<string, unknown>
}

export interface ProjectInfoLocator {
  token?: string
  lookup: ProjectLocatorLookup
  lifecycle?: ProjectLocatorLifecycle
  raw: Record<string, unknown>
}

interface ParsedProjectInfoBase {
  contract?: ProjectInfoContractEnvelope
  summary?: ProjectInfoSummaryEnvelope
  raw: Record<string, unknown>
}

export interface ProjectListEntry {
  id: string
  status?: string
  chunks?: number
  symbols?: number
  raw: Record<string, unknown>
}

export interface ProjectListInfo extends ParsedProjectInfoBase {
  action: "list"
  projects: ProjectListEntry[]
}

export interface ProjectStatsInfo extends ParsedProjectInfoBase {
  action: "stats"
}

export interface ProjectProjectionInfo extends ParsedProjectInfoBase {
  action: "projection" | "projection_by_locator"
  locator?: ProjectInfoLocator
}

export interface ProjectDurableStatusInfo extends ParsedProjectInfoBase {
  action: "status"
  state?: ProjectIndexingState
  job_id?: string
  operation_id?: string
  can_resume?: boolean
  resume_token?: string
  active_generation?: number
  target_generation?: number
  reason_code?: DurableIndexingReasonCode
  progress?: ProjectDurableProgress
  payload?: Record<string, unknown>
}

export interface KGEntity {
  id: string
  name: string
  entity_type?: string
}

export interface KGRelation {
  from: string
  to: string
  relation_type: string
  weight?: number
}

export interface KGCommunity {
  id: string
  label: string
  size: number
  entities: KGEntity[]
  relations: KGRelation[]
}

export interface KGRelatedResult {
  entity: KGEntity
  distance: number
  related: Array<{ entity: KGEntity; relation?: KGRelation }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch (err) {
    logger.debug("failed to parse JSON record", { error: String(err) })
    return null
  }
}

function extractJsonRecord(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> | null {
  return parseJsonRecord(extractTextResult(result))
}

function parseProjectSummaryPartial(summary: Record<string, unknown> | undefined): ProjectInfoSummaryPartial | undefined {
  if (!summary || !isRecord(summary.partial)) return undefined

  return {
    reasonCode: asString(summary.partial.reason_code) as ProjectInfoReasonCode | undefined,
    reason: asString(summary.partial.reason),
    raw: summary.partial,
  }
}

function parseProjectInfoBase(raw: Record<string, unknown>): ParsedProjectInfoBase {
  const summary = isRecord(raw.summary)
    ? {
        partial: parseProjectSummaryPartial(raw.summary),
        raw: raw.summary,
      }
    : undefined

  return {
    contract: isRecord(raw.contract) ? { raw: raw.contract } : undefined,
    summary,
    raw,
  }
}

function parseProjectDurableIdentityFields(raw: Record<string, unknown>): {
  job_id?: string
  operation_id?: string
  can_resume?: boolean
  resume_token?: string
} {
  return cleanRecord({
    job_id: asString(raw.job_id),
    operation_id: asString(raw.operation_id),
    can_resume: asBoolean(raw.can_resume),
    resume_token: asString(raw.resume_token),
  })
}

function parseProjectDurableGenerationFields(raw: Record<string, unknown>): {
  active_generation?: number
  target_generation?: number
} {
  return cleanRecord({
    active_generation: asNumber(raw.active_generation),
    target_generation: asNumber(raw.target_generation),
  })
}

function parseProjectDurableProgress(progress: unknown): ProjectDurableProgress | undefined {
  if (typeof progress === "number" && Number.isFinite(progress)) {
    return {
      percent: progress,
      raw: { percent: progress },
    }
  }

  if (!isRecord(progress)) return undefined

  return cleanRecord({
    current: asNumber(progress.current),
    total: asNumber(progress.total),
    percent: asNumber(progress.percent),
    completed: asNumber(progress.completed),
    remaining: asNumber(progress.remaining),
    stage: asString(progress.stage),
    step: asString(progress.step),
    raw: progress,
  })
}

function parseLocatorToken(locator: Record<string, unknown>): string | undefined {
  return asString(locator.value)
    ?? asString(locator.id)
    ?? asString(locator.locator)
    ?? asString(locator.token)
    ?? asString(locator.handle)
}

function parseProjectLocator(locator: unknown): ProjectInfoLocator | undefined {
  if (!isRecord(locator)) return undefined

  const lookup = isRecord(locator.lookup)
    ? {
        state: asString(locator.lookup.state) as ProjectLocatorLookupState | undefined,
        reasonCode: asString(locator.lookup.reason_code) as ProjectInfoReasonCode | undefined,
        reason: asString(locator.lookup.reason),
        raw: locator.lookup,
      }
    : { raw: {} }

  return {
    token: parseLocatorToken(locator),
    lookup,
    lifecycle: isRecord(locator.lifecycle) ? { raw: locator.lifecycle } : undefined,
    raw: locator,
  }
}

function parseProjectList(raw: Record<string, unknown>): ProjectListInfo {
  const projects = Array.isArray(raw.projects)
    ? raw.projects.filter(isRecord).map((project) => ({
        id: asString(project.id) ?? "",
        status: asString(project.status),
        chunks: asNumber(project.chunks),
        symbols: asNumber(project.symbols),
        raw: project,
      })).filter((project) => project.id.length > 0)
    : []

  return {
    action: "list",
    ...parseProjectInfoBase(raw),
    projects,
  }
}

function parseProjectStats(raw: Record<string, unknown>): ProjectStatsInfo {
  return {
    action: "stats",
    ...parseProjectInfoBase(raw),
  }
}

function parseProjectProjection(
  action: "projection" | "projection_by_locator",
  raw: Record<string, unknown>,
): ProjectProjectionInfo {
  return {
    action,
    ...parseProjectInfoBase(raw),
    locator: parseProjectLocator(raw.locator),
  }
}

function parseProjectDurableStatus(raw: Record<string, unknown>): ProjectDurableStatusInfo {
  const payload = isRecord(raw.payload) ? raw.payload : undefined

  return cleanRecord({
    action: "status" as const,
    ...parseProjectInfoBase(raw),
    state: asString(raw.state) as ProjectIndexingState | undefined,
    ...parseProjectDurableIdentityFields(raw),
    ...parseProjectDurableGenerationFields(raw),
    reason_code: asString(raw.reason_code) as DurableIndexingReasonCode | undefined,
    progress: parseProjectDurableProgress(raw.progress),
    payload,
  })
}

function parseKGEntity(value: unknown): KGEntity | null {
  if (!isRecord(value)) return null
  const id = asString(value.id)
  const name = asString(value.name)
  if (!id || !name) return null

  return cleanRecord({
    id,
    name,
    entity_type: asString(value.entity_type),
  }) as KGEntity
}

function parseKGRelation(value: unknown): KGRelation | null {
  if (!isRecord(value)) return null
  const from = asString(value.from)
  const to = asString(value.to)
  const relationType = asString(value.relation_type)
  if (!from || !to || !relationType) return null

  return cleanRecord({
    from,
    to,
    relation_type: relationType,
    weight: asNumber(value.weight),
  }) as KGRelation
}

function parseKGCommunities(raw: Record<string, unknown>): KGCommunity[] {
  if (!Array.isArray(raw.communities)) return []

  return raw.communities.filter(isRecord).map((community) => {
    const id = asString(community.id)
    const label = asString(community.label)
    const size = asNumber(community.size)
    if (!id || !label || size == null) return null

    return {
      id,
      label,
      size,
      entities: Array.isArray(community.entities)
        ? community.entities.map(parseKGEntity).filter((entity): entity is KGEntity => entity !== null)
        : [],
      relations: Array.isArray(community.relations)
        ? community.relations.map(parseKGRelation).filter((relation): relation is KGRelation => relation !== null)
        : [],
    }
  }).filter((community): community is KGCommunity => community !== null)
}

function parseKGRelatedResult(raw: Record<string, unknown>): KGRelatedResult | null {
  if (asString(raw.error)) return null

  const entity = parseKGEntity(raw.entity)
  if (!entity || !Array.isArray(raw.related)) return null

  const related = raw.related.filter(isRecord).map((item) => {
    const relatedEntity = parseKGEntity(item.entity)
    if (!relatedEntity) return null


    const relation = parseKGRelation(item.relation)
    return relation ? { entity: relatedEntity, relation } : { entity: relatedEntity }
  }).filter((item): item is { entity: KGEntity; relation?: KGRelation } => item !== null)

  return {
    entity,
    distance: asNumber(raw.distance) ?? 0,
    related,
  }
}

async function callProjectInfo(config: PluginConfig, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const result = await callToolWithRetry(config, "project_info", args)
    return extractJsonRecord(result)
  } catch (err) {
    logger.error("project_info failed", { error: String(err), args })
    return null
  }
}

export async function getProjectListInfo(config: PluginConfig): Promise<ProjectListInfo | null> {
  const raw = await callProjectInfo(config, { action: "list" })
  return raw ? parseProjectList(raw) : null
}

export async function getProjectStatsInfo(
  config: PluginConfig,
  projectId?: string,
): Promise<ProjectStatsInfo | null> {
  const raw = await callProjectInfo(config, cleanRecord({ action: "stats", project_id: projectId }))
  return raw ? parseProjectStats(raw) : null
}

export async function getProjectProjectionInfo(
  config: PluginConfig,
  args: {
    projectId: string
    relationScope?: string
    sortMode?: string
  },
): Promise<ProjectProjectionInfo | null> {
  const raw = await callProjectInfo(config, cleanRecord({
    action: "projection",
    project_id: args.projectId,
    relation_scope: args.relationScope,
    sort_mode: args.sortMode,
  }))
  return raw ? parseProjectProjection("projection", raw) : null
}

export async function getProjectProjectionByLocatorInfo(
  config: PluginConfig,
  args: {
    locator: string
  },
): Promise<ProjectProjectionInfo | null> {
  const raw = await callProjectInfo(config, { action: "projection_by_locator", locator: args.locator })
  return raw ? parseProjectProjection("projection_by_locator", raw) : null
}

export async function getProjectDurableStatus(
  config: PluginConfig,
  path?: string,
  projectId?: string,
): Promise<ProjectDurableStatusInfo | null> {
  const raw = await callProjectInfo(config, cleanRecord({ action: "status", path, project_id: projectId }))
  return raw ? parseProjectDurableStatus(raw) : null
}

export async function detectKnowledgeGraphCommunities(config: PluginConfig): Promise<KGCommunity[]> {
  try {
    const result = await callToolWithRetry(config, "knowledge_graph", { action: "detect_communities" })
    const raw = parseJsonRecord(extractTextResult(result))
    if (!raw || asString(raw.error)) return []
    return parseKGCommunities(raw)
  } catch (err) {
    logger.debug("Failed to detect knowledge graph communities", { error: String(err) })
    return []
  }
}

export async function getRelatedKnowledgeGraphEntities(
  config: PluginConfig,
  entityId: string,
  depth = 1,
  direction: "in" | "out" | "both" = "both",
): Promise<KGRelatedResult | null> {
  try {
    const result = await callToolWithRetry(config, "knowledge_graph", {
      action: "get_related",
      entity_id: entityId,
      depth,
      direction,
    })
    const raw = parseJsonRecord(extractTextResult(result))
    return raw ? parseKGRelatedResult(raw) : null
  } catch (err) {
    logger.debug("Failed to fetch related knowledge graph entities", { error: String(err), entityId })
    return null
  }
}

export function isMissingProjectLocator(locator?: ProjectInfoLocator): boolean {
  const reasonCode = locator?.lookup.reasonCode
  return locator?.lookup.state === "missing"
    || reasonCode === "missing"
    || reasonCode === "invalid_locator"
}

type ScopedToolArgs = Record<string, unknown> & {
  agentId?: string
  runId?: string
  namespace?: string
  userId?: string
  memoryType?: string
  metadata?: Record<string, unknown>
  metadataFilter?: Record<string, unknown>
  eventAfter?: string
  eventBefore?: string
  ingestionAfter?: string
  ingestionBefore?: string
  validAt?: string
  timestamp?: string
  agent_id?: string
  run_id?: string
  user_id?: string
  memory_type?: string
  metadata_filter?: Record<string, unknown>
  event_after?: string
  event_before?: string
  ingestion_after?: string
  ingestion_before?: string
  valid_at?: string
}

let mcpClient: Client | null = null
let connectionPromise: Promise<Client> | null = null
let connectionFailureHandler: (() => void) | null = null
let lastHealthCheckAt = 0
let healthCheckPromise: Promise<boolean> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let heartbeatPromise: Promise<void> | null = null

const HEALTH_CHECK_THROTTLE_MS = 5_000

function collectErrorText(value: unknown, depth = 0, seen = new Set<unknown>()): string {
  if (value == null || depth > 4) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value instanceof Error) {
    return [value.name, value.message, value.stack, collectErrorText((value as any).cause, depth + 1, seen)]
      .filter(Boolean)
      .join(" ")
  }
  if (!isRecord(value) || seen.has(value)) return String(value)

  seen.add(value)
  return Object.values(value)
    .map((entry) => collectErrorText(entry, depth + 1, seen))
    .filter(Boolean)
    .join(" ")
}

function isRecoverableHttpSessionError(err: unknown): boolean {
  const message = collectErrorText(err).toLowerCase()
  return message.includes("session not found")
    || message.includes("mcp-session-id")
    || (message.includes("session") && message.includes("unauthorized"))
}

function isRecoverableConnectionError(config: PluginConfig, err: unknown): boolean {
  if (isRecoverableHttpSessionError(err)) return config.mcpServer.transport === "http"

  const message = collectErrorText(err).toLowerCase()
  const genericSignals = [
    "econnrefused",
    "econnreset",
    "socket hang up",
    "fetch failed",
    "networkerror",
    "network error",
    "transport closed",
    "connection closed",
    "connection lost",
    "other side closed",
    "broken pipe",
    "epipe",
    "terminated",
    "write after end",
    "server unavailable",
    "the operation was aborted",
  ]

  return genericSignals.some((signal) => message.includes(signal))
}

async function disposeClient(): Promise<void> {
  stopHeartbeat()

  if (!mcpClient) return

  try {
    await mcpClient.close()
  } catch (err) {
    logger.debug("mcp client close error during reset", { error: String(err) })
  } finally {
    mcpClient = null
    connectionPromise = null
  }
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  heartbeatPromise = null
}

function startHeartbeat(config: PluginConfig): void {
  stopHeartbeat()

  if (config.mcpServer.transport !== "http" || !mcpClient) return

  heartbeatTimer = setInterval(() => {
    if (!mcpClient || heartbeatPromise) return

    heartbeatPromise = (async () => {
      const healthy = await getCachedClientHealth(config)
      if (healthy || !mcpClient) return

      logger.warn("HTTP MCP heartbeat detected unhealthy server; failing active connection")
      await failActiveConnection()
    })()
      .catch((err) => {
        logger.debug("HTTP MCP heartbeat check failed", { error: String(err) })
      })
      .finally(() => {
        heartbeatPromise = null
      })
  }, config.mcpServer.heartbeatIntervalMs)

  if (heartbeatTimer && typeof heartbeatTimer === "object" && "unref" in heartbeatTimer) {
    heartbeatTimer.unref()
  }
}

async function getCachedClientHealth(config: PluginConfig): Promise<boolean> {
  if (config.mcpServer.transport !== "http") return true

  const now = Date.now()
  if (healthCheckPromise) return healthCheckPromise
  if (now - lastHealthCheckAt < HEALTH_CHECK_THROTTLE_MS) return true

  lastHealthCheckAt = now
  healthCheckPromise = isServerRunning(config)
  try {
    return await healthCheckPromise
  } finally {
    healthCheckPromise = null
  }
}

async function invalidateUnhealthyCachedClient(config: PluginConfig): Promise<void> {
  const healthy = await getCachedClientHealth(config)
  if (healthy || !mcpClient) return

  logger.warn("Cached MCP client failed liveness check; invalidating connection")
  await failActiveConnection()
}

function notifyConnectionFailure(): void {
  markConnectionFailed()
  connectionFailureHandler?.()
}

async function failActiveConnection(): Promise<void> {
  await disposeClient()
  notifyConnectionFailure()
}

async function resetClientConnection(config: PluginConfig): Promise<Client> {
  await disposeClient()

  const client = await connectToServer(config)
  mcpClient = client
  startHeartbeat(config)
  markConnectionHealthy()
  return client
}

async function withConnectionRetry<T>(
  config: PluginConfig,
  operation: (client: Client) => Promise<T>,
  logContext: Record<string, unknown>,
  isRecoverable: (config: PluginConfig, err: unknown) => boolean = isRecoverableConnectionError,
): Promise<T> {
  const client = await getMemoryClient(config)

  try {
    return await operation(client)
  } catch (err) {
    if (!isRecoverable(config, err)) {
      throw err
    }

    logger.warn("Recoverable MCP connection error; reconnecting and retrying once", {
      ...logContext,
      error: String(err),
    })

    try {
      const retryClient = await resetClientConnection(config)
      return await operation(retryClient)
    } catch (retryErr) {
      if (isRecoverable(config, retryErr)) {
        await failActiveConnection()
      }
      throw retryErr
    }
  }
}

function isRecoverableHttpSessionConnectionError(config: PluginConfig, err: unknown): boolean {
  return config.mcpServer.transport === "http" && isRecoverableHttpSessionError(err)
}

async function callToolWithRetry(
  config: PluginConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  return withConnectionRetry(
    config,
    (client) => client.callTool({ name: toolName, arguments: args }),
    { toolName },
  )
}

export function registerConnectionFailureHandler(handler: (() => void) | null): void {
  connectionFailureHandler = handler
}

export async function getMemoryClient(config: PluginConfig): Promise<Client> {
  if (mcpClient) {
    await invalidateUnhealthyCachedClient(config)
    if (mcpClient) return mcpClient
  }
  if (isConnectionFailed()) {
    throw new Error("Memory server unavailable — auto-reconnecting in background")
  }
  if (connectionPromise) return connectionPromise

  connectionPromise = connectToServer(config)
  try {
    mcpClient = await connectionPromise
    startHeartbeat(config)
    markConnectionHealthy()
    return mcpClient
  } catch (err) {
    markConnectionFailed()
    throw err
  } finally {
    connectionPromise = null
  }
}

export async function tryReconnect(config: PluginConfig): Promise<boolean> {
  try {
    await resetClientConnection(config)
    return true
  } catch {
    return false
  }
}

async function connectToServer(config: PluginConfig): Promise<Client> {
  const client = new Client({
    name: "opencode-mmcp-1file",
    version: "0.1.0",
  })

  if (config.mcpServer.transport === "http") {
    const serverUrl = await ensureServerRunning(config)
    const url = new URL("/mcp", serverUrl)
    logger.info(`Connecting to MCP server via HTTP: ${url.href}`)
    const transport = new StreamableHTTPClientTransport(url)
    await client.connect(transport)
  } else {
    const cmdParts = buildStdioCommand(config)
    if (!cmdParts) throw new Error("Cannot build stdio command: no data directory configured")
    const [command, ...args] = cmdParts
    logger.info(`Connecting to MCP server via stdio: ${command} ${args.join(" ")}`)
    const transport = new StdioClientTransport({ command, args, stderr: "pipe" })
    await client.connect(transport)
  }

  return client
}

function buildStdioCommand(config: PluginConfig): string[] | null {
  const dataDir = resolveDataDir(config)
  if (!dataDir) return null

  const { command, commandPath, model } = config.mcpServer
  const fullCommand = commandPath ? [commandPath, "--stdio"] : [...command]

  if (!fullCommand.some((a) => a === "--data-dir")) {
    fullCommand.push("--data-dir", dataDir)
  }
  if (!fullCommand.some((a) => a === "--log-file")) {
    fullCommand.push("--log-file", `${dataDir}/log/mcp-server.log`)
  }
  if (!fullCommand.some((a) => a === "--model") && model) {
    fullCommand.push("--model", model)
  }

  return fullCommand
}

export async function discoverTools(config: PluginConfig): Promise<string[]> {
  try {
    const result = await withConnectionRetry(
      config,
      (client) => client.listTools(),
      { operation: "listTools" },
      isRecoverableHttpSessionConnectionError,
    )
    return result.tools.map((t) => t.name)
  } catch (err) {
    logger.error("discoverTools failed", { error: String(err) })
    return []
  }
}

function extractTextResult(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!result.content || !Array.isArray(result.content)) return ""
  return result.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n")
}

function parseMemories(raw: string): MemoryEntry[] {
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
    if (parsed.memories && Array.isArray(parsed.memories)) return parsed.memories
    if (parsed.results && Array.isArray(parsed.results)) return parsed.results
    if (parsed.data && Array.isArray(parsed.data)) return parsed.data
    if (parsed.items && Array.isArray(parsed.items)) return parsed.items
    if (parsed.response?.memories && Array.isArray(parsed.response.memories)) return parsed.response.memories
    if (parsed.response?.results && Array.isArray(parsed.response.results)) return parsed.response.results
    return []
  } catch (err) {
    logger.debug("failed to parse memories", { error: String(err) })
    return []
  }
}

function cleanRecord<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""),
  ) as T
}

function buildBaseScopeArgs(
  config: PluginConfig,
  context?: MemoryOperationContext,
): Record<string, unknown> {
  const namespace = context?.namespace ?? config.memoryScope.namespace
  const userId = context?.userId ?? config.memoryScope.userId

  return cleanRecord({
    namespace,
    user_id: userId,
    ...(config.memoryScope.shareAcrossAgents ? {} : { agent_id: context?.agentId }),
    run_id: context?.runId,
  })
}

function mergeMetadata(
  config: PluginConfig,
  context?: MemoryOperationContext,
): Record<string, unknown> | undefined {
  const merged = cleanRecord({
    ...(config.memoryScope.defaultMetadata ?? {}),
    ...(context?.metadata ?? {}),
    ...(config.memoryScope.includeAgentMetadata && context?.agentId
      ? { source_agent_id: context.agentId }
      : {}),
    ...(config.memoryScope.includeRunMetadata && context?.runId
      ? { source_run_id: context.runId }
      : {}),
  })

  return Object.keys(merged).length > 0 ? merged : undefined
}

function buildReadArgs(
  config: PluginConfig,
  baseArgs: Record<string, unknown>,
  context?: MemoryOperationContext,
): Record<string, unknown> {
  return cleanRecord({
    ...baseArgs,
    ...buildBaseScopeArgs(config, context),
    memory_type: context?.memoryType,
    metadata_filter: context?.metadataFilter,
    event_after: context?.eventAfter,
    event_before: context?.eventBefore,
    ingestion_after: context?.ingestionAfter,
    ingestion_before: context?.ingestionBefore,
    valid_at: context?.validAt,
    timestamp: context?.timestamp,
  })
}

function buildWriteArgs(
  config: PluginConfig,
  baseArgs: Record<string, unknown>,
  context?: MemoryOperationContext,
): Record<string, unknown> {
  return cleanRecord({
    ...baseArgs,
    ...buildBaseScopeArgs(config, context),
    metadata: mergeMetadata(config, context),
    memory_type: context?.memoryType ?? baseArgs.memory_type,
  })
}

function extractOperationContext(args: ScopedToolArgs): {
  baseArgs: Record<string, unknown>
  context: MemoryOperationContext
} {
  const {
    agentId,
    runId,
    namespace,
    userId,
    memoryType,
    metadata,
    metadataFilter,
    eventAfter,
    eventBefore,
    ingestionAfter,
    ingestionBefore,
    validAt,
    timestamp,
    agent_id,
    run_id,
    user_id,
    memory_type,
    metadata_filter,
    event_after,
    event_before,
    ingestion_after,
    ingestion_before,
    valid_at,
    ...baseArgs
  } = args

  return {
    baseArgs,
    context: cleanRecord({
      agentId: agentId ?? agent_id,
      runId: runId ?? run_id,
      namespace,
      userId: userId ?? user_id,
      memoryType: memoryType ?? memory_type,
      metadata,
      metadataFilter: metadataFilter ?? metadata_filter,
      eventAfter: eventAfter ?? event_after,
      eventBefore: eventBefore ?? event_before,
      ingestionAfter: ingestionAfter ?? ingestion_after,
      ingestionBefore: ingestionBefore ?? ingestion_before,
      validAt: validAt ?? valid_at,
      timestamp,
    }),
  }
}

function classifyFailure(err: unknown): RetrievalStatus {
  const message = String(err)
  if (message.includes("Memory server unavailable")) return "unavailable"
  return "failed"
}

async function readMemories(
  config: PluginConfig,
  source: RetrievalResult["source"],
  toolName: string,
  args: Record<string, unknown>,
  context?: MemoryOperationContext,
): Promise<RetrievalResult> {
  try {
    const finalArgs = buildReadArgs(config, args, context)
    const result = await callToolWithRetry(config, toolName, finalArgs)
    const memories = parseMemories(extractTextResult(result))
    return {
      status: memories.length > 0 ? "ok" : "empty",
      source,
      memories,
    }
  } catch (err) {
    const status = classifyFailure(err)
    logger.error(`${toolName} failed`, { error: String(err), args: buildReadArgs(config, args, context) })
    return {
      status,
      source,
      memories: [],
      reason: String(err),
    }
  }
}

export async function recallMemories(
  config: PluginConfig,
  query: string,
  limit = 5,
  context?: MemoryOperationContext,
): Promise<RetrievalResult> {
  return readMemories(config, "recall", "recall", { query, limit }, context)
}

export async function searchMemoryResult(
  config: PluginConfig,
  query: string,
  mode: "vector" | "bm25" = "bm25",
  limit = 5,
  context?: MemoryOperationContext,
): Promise<RetrievalResult> {
  return readMemories(config, "search", "search_memory", { query, mode, limit }, context)
}

export async function listProjectMemories(
  config: PluginConfig,
  limit = 10,
  validOnly = false,
  context?: MemoryOperationContext,
): Promise<RetrievalResult> {
  if (validOnly) {
    return readMemories(config, "valid", "get_valid", { limit }, context)
  }
  return readMemories(config, "list", "list_memories", { limit }, context)
}

export async function recall(
  config: PluginConfig,
  query: string,
  limit = 5,
  context?: MemoryOperationContext,
): Promise<MemoryEntry[]> {
  const result = await recallMemories(config, query, limit, context)
  return result.memories
}

export async function searchMemory(
  config: PluginConfig,
  query: string,
  mode: "vector" | "bm25" = "bm25",
  limit = 5,
  context?: MemoryOperationContext,
): Promise<MemoryEntry[]> {
  const result = await searchMemoryResult(config, query, mode, limit, context)
  return result.memories
}

export async function storeMemory(
  config: PluginConfig,
  content: string,
  memoryType?: string,
  context?: MemoryOperationContext,
): Promise<boolean> {
  try {
    await callToolWithRetry(config, "store_memory", buildWriteArgs(config, {
        content,
        ...(memoryType && { memory_type: memoryType }),
      }, { ...context, memoryType: context?.memoryType ?? memoryType }))
    return true
  } catch (err) {
    logger.error("storeMemory failed", { error: String(err) })
    return false
  }
}

export async function listMemories(
  config: PluginConfig,
  limit = 10,
  context?: MemoryOperationContext,
): Promise<MemoryEntry[]> {
  const result = await listProjectMemories(config, limit, false, context)
  return result.memories
}

export async function callMemoryTool(
  config: PluginConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const shouldApplyReadScope = ["recall", "search_memory", "list_memories", "get_valid"].includes(toolName)
  const shouldApplyWriteScope = ["store_memory", "update_memory"].includes(toolName)
  const { baseArgs, context } = extractOperationContext(args as ScopedToolArgs)
  const finalArgs = shouldApplyReadScope
    ? buildReadArgs(config, baseArgs, context)
    : shouldApplyWriteScope
      ? buildWriteArgs(config, baseArgs, context)
      : baseArgs
  const result = await callToolWithRetry(config, toolName, finalArgs)
  return extractTextResult(result)
}

export async function disconnectMemoryClient(config?: PluginConfig): Promise<void> {
  await disposeClient()
  lastHealthCheckAt = 0
  healthCheckPromise = null
  if (config?.mcpServer.transport === "http") {
    try {
      await releaseServerHolder(config)
    } catch (err) {
      logger.debug("failed to release HTTP MCP server holder during disconnect", { error: String(err) })
    }
  }
}

export async function resetMemoryClientForServerControl(): Promise<void> {
  await disposeClient()
  lastHealthCheckAt = 0
  healthCheckPromise = null
}
