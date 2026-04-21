import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { PluginConfig, resolveDataDir } from "../config.js"
import type { MemoryEntry } from "../utils/format.js"
import { logger } from "../utils/logger.js"
import { isConnectionFailed, markConnectionFailed, markConnectionHealthy } from "./connection-state.js"
import { ensureServerRunning, stopServer } from "./server-process.js"

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

function isRecoverableHttpSessionError(config: PluginConfig, err: unknown): boolean {
  if (config.mcpServer.transport !== "http") return false

  const message = String(err).toLowerCase()
  return message.includes("session not found")
    || message.includes("mcp-session-id")
    || (message.includes("session") && message.includes("unauthorized"))
}

async function resetClientConnection(config: PluginConfig): Promise<Client> {
  if (mcpClient) {
    try {
      await mcpClient.close()
    } catch (err) {
      logger.debug("mcp client close error during reset", { error: String(err) })
    }
  }

  mcpClient = null
  connectionPromise = null

  const client = await connectToServer(config)
  mcpClient = client
  markConnectionHealthy()
  return client
}

async function callToolWithRetry(
  config: PluginConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const client = await getMemoryClient(config)

  try {
    return await client.callTool({ name: toolName, arguments: args })
  } catch (err) {
    if (!isRecoverableHttpSessionError(config, err)) {
      throw err
    }

    logger.warn("Recoverable HTTP MCP session error; reconnecting and retrying once", {
      toolName,
      error: String(err),
    })

    const retryClient = await resetClientConnection(config)
    return retryClient.callTool({ name: toolName, arguments: args })
  }
}

export async function getMemoryClient(config: PluginConfig): Promise<Client> {
  if (mcpClient) return mcpClient
  if (isConnectionFailed()) {
    throw new Error("Memory server unavailable — auto-reconnecting in background")
  }
  if (connectionPromise) return connectionPromise

  connectionPromise = connectToServer(config)
  try {
    mcpClient = await connectionPromise
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
    const client = await getMemoryClient(config)
    const result = await client.listTools()
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
  if (mcpClient) {
    try {
      await mcpClient.close()
    } catch (err) {
      logger.debug("mcp client close error", { error: String(err) })
    }
    mcpClient = null
  }
  if (config?.mcpServer.transport === "http") {
    await stopServer(config)
  }
}
