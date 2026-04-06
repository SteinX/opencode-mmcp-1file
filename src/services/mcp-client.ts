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

let mcpClient: Client | null = null
let connectionPromise: Promise<Client> | null = null

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
    mcpClient = null
    connectionPromise = null
    const client = await connectToServer(config)
    mcpClient = client
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
    return []
  } catch (err) {
    logger.debug("failed to parse memories", { error: String(err) })
    return []
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
): Promise<RetrievalResult> {
  try {
    const client = await getMemoryClient(config)
    const result = await client.callTool({ name: toolName, arguments: args })
    const memories = parseMemories(extractTextResult(result))
    return {
      status: memories.length > 0 ? "ok" : "empty",
      source,
      memories,
    }
  } catch (err) {
    const status = classifyFailure(err)
    logger.error(`${toolName} failed`, { error: String(err), args })
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
): Promise<RetrievalResult> {
  return readMemories(config, "recall", "recall", { query, limit })
}

export async function searchMemoryResult(
  config: PluginConfig,
  query: string,
  mode: "vector" | "bm25" = "bm25",
  limit = 5,
): Promise<RetrievalResult> {
  return readMemories(config, "search", "search_memory", { query, mode, limit })
}

export async function listProjectMemories(
  config: PluginConfig,
  limit = 10,
  validOnly = false,
): Promise<RetrievalResult> {
  if (validOnly) {
    return readMemories(config, "valid", "get_valid", { limit })
  }
  return readMemories(config, "list", "list_memories", { limit })
}

export async function recall(
  config: PluginConfig,
  query: string,
  limit = 5,
): Promise<MemoryEntry[]> {
  const result = await recallMemories(config, query, limit)
  return result.memories
}

export async function searchMemory(
  config: PluginConfig,
  query: string,
  mode: "vector" | "bm25" = "bm25",
  limit = 5,
): Promise<MemoryEntry[]> {
  const result = await searchMemoryResult(config, query, mode, limit)
  return result.memories
}

export async function storeMemory(
  config: PluginConfig,
  content: string,
  memoryType?: string,
): Promise<boolean> {
  try {
    const client = await getMemoryClient(config)
    await client.callTool({
      name: "store_memory",
      arguments: {
        content,
        ...(memoryType && { memory_type: memoryType }),
      },
    })
    return true
  } catch (err) {
    logger.error("storeMemory failed", { error: String(err) })
    return false
  }
}

export async function listMemories(
  config: PluginConfig,
  limit = 10,
): Promise<MemoryEntry[]> {
  const result = await listProjectMemories(config, limit)
  return result.memories
}

export async function callMemoryTool(
  config: PluginConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const client = await getMemoryClient(config)
  const result = await client.callTool({ name: toolName, arguments: args })
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
