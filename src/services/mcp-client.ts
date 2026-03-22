import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { PluginConfig, resolveDataDir } from "../config.js"
import type { MemoryEntry } from "../utils/format.js"
import { logger } from "../utils/logger.js"
import { isConnectionFailed, markConnectionFailed, markConnectionHealthy } from "./connection-state.js"

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

  const cmdParts = buildStdioCommand(config)
  if (!cmdParts) throw new Error("Cannot build stdio command: no data directory configured")
  const [command, ...args] = cmdParts
  logger.info(`Connecting to MCP server via stdio: ${command} ${args.join(" ")}`)
  const transport = new StdioClientTransport({ command, args, stderr: "pipe" })
  await client.connect(transport)

  return client
}

function buildStdioCommand(config: PluginConfig): string[] | null {
  const dataDir = resolveDataDir(config)
  if (!dataDir) return null

  const { command, model } = config.mcpServer
  const fullCommand = [...command]

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

export async function recall(
  config: PluginConfig,
  query: string,
  limit = 5,
): Promise<MemoryEntry[]> {
  try {
    const client = await getMemoryClient(config)
    const result = await client.callTool({
      name: "recall",
      arguments: { query, limit },
    })
    return parseMemories(extractTextResult(result))
  } catch (err) {
    logger.error("recall failed", { query, error: String(err) })
    return []
  }
}

export async function searchMemory(
  config: PluginConfig,
  query: string,
  mode: "vector" | "bm25" = "bm25",
  limit = 5,
): Promise<MemoryEntry[]> {
  try {
    const client = await getMemoryClient(config)
    const result = await client.callTool({
      name: "search_memory",
      arguments: { query, mode, limit },
    })
    return parseMemories(extractTextResult(result))
  } catch (err) {
    logger.error("searchMemory failed", { query, mode, error: String(err) })
    return []
  }
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
  try {
    const client = await getMemoryClient(config)
    const result = await client.callTool({
      name: "list_memories",
      arguments: { limit },
    })
    return parseMemories(extractTextResult(result))
  } catch (err) {
    logger.error("listMemories failed", { error: String(err) })
    return []
  }
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

export async function disconnectMemoryClient(): Promise<void> {
  if (mcpClient) {
    try {
      await mcpClient.close()
    } catch (err) {
      logger.debug("mcp client close error", { error: String(err) })
    }
    mcpClient = null
  }
}
