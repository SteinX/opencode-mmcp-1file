import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { PluginConfig } from "../config.js"
import type { MemoryEntry } from "../utils/format.js"
import { logger } from "../utils/logger.js"

let mcpClient: Client | null = null
let connectionPromise: Promise<Client> | null = null

export async function getMemoryClient(config: PluginConfig): Promise<Client> {
  if (mcpClient) return mcpClient

  if (connectionPromise) return connectionPromise

  connectionPromise = connectToServer(config)
  try {
    mcpClient = await connectionPromise
    return mcpClient
  } finally {
    connectionPromise = null
  }
}

async function connectToServer(config: PluginConfig): Promise<Client> {
  const client = new Client({
    name: "opencode-mmcp-1file",
    version: "0.1.0",
  })

  const [command, ...args] = buildCommand(config)

  const transport = new StdioClientTransport({
    command,
    args,
    stderr: "pipe",
  })

  await client.connect(transport)
  return client
}

function buildCommand(config: PluginConfig): string[] {
  const { command, dataDir, model } = config.mcpServer
  const fullCommand = [...command]

  if (!fullCommand.some((a) => a === "--data-dir") && dataDir) {
    fullCommand.push("--data-dir", dataDir)
  }
  if (!fullCommand.some((a) => a === "--model") && model) {
    fullCommand.push("--model", model)
  }

  return fullCommand
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
