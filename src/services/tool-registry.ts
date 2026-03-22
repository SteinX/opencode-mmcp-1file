/**
 * Registers MCP server tools as plugin tools so the agent can call them directly.
 * Each tool has a hardcoded Zod schema (matching the MCP server's JSON Schema)
 * and an execute function that proxies to the MCP server via callMemoryTool().
 *
 * We register core memory tools (CRUD, search, knowledge graph) and code intelligence
 * tools (index_project, recall_code, search_symbols, project_info, symbol_graph) but skip:
 * - reset_all_memory (dangerous)
 * - how_to_use (agent has system prompt guidance)
 * - delete_project (dangerous — no undo)
 */

import { tool } from "@opencode-ai/plugin/tool"
import type { PluginConfig } from "../config.js"
import { applyConfig } from "../config.js"
import { callMemoryTool } from "./mcp-client.js"
import { stripPrivateContent, isFullyPrivate } from "../utils/privacy.js"
import { logger } from "../utils/logger.js"
import { isConnectionFailed, getConnectionStatus } from "./connection-state.js"

const UNAVAILABLE_MESSAGE =
  "Memory server temporarily unavailable — auto-reconnecting. " +
  "Try again in ~30s. Do not retry memory tools until the system prompt confirms the connection is restored."

type ToolMap = Record<string, ReturnType<typeof tool>>

export function buildToolRegistry(config: PluginConfig, directory?: string): ToolMap {
  const proxy = async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (isConnectionFailed()) {
      return UNAVAILABLE_MESSAGE
    }
    try {
      return await callMemoryTool(config, name, args)
    } catch (err) {
      logger.error(`Tool ${name} failed`, { error: String(err) })
      return `Error: ${String(err)}`
    }
  }

  const privacyFilter = (content: string): string | null => {
    if (!config.privacy.enabled) return content
    if (isFullyPrivate(content)) return null
    return stripPrivateContent(content)
  }

  const tools: ToolMap = {
    // --- Core CRUD ---
    store_memory: tool({
      description:
        "Store a new memory. Prefix content with DECISION:, TASK:, PATTERN:, BUGFIX:, CONTEXT:, RESEARCH:, PROJECT:, EPIC:, or USER: for categorization.",
      args: {
        content: tool.schema.string(),
        memory_type: tool.schema
          .enum(["semantic", "episodic", "procedural"])
          .optional(),
        metadata: tool.schema.string().optional(),
      },
      execute: async (args) => {
        const filtered = privacyFilter(args.content)
        if (filtered === null) return "Content is entirely private — nothing stored."
        const callArgs: Record<string, unknown> = { content: filtered }
        if (args.memory_type) callArgs.memory_type = args.memory_type
        if (args.metadata) {
          try {
            callArgs.metadata = JSON.parse(args.metadata)
          } catch {
            callArgs.metadata = args.metadata
          }
        }
        return proxy("store_memory", callArgs)
      },
    }),

    update_memory: tool({
      description: "Update memory fields by ID.",
      args: {
        id: tool.schema.string(),
        content: tool.schema.string().optional(),
        memory_type: tool.schema
          .enum(["semantic", "episodic", "procedural"])
          .optional(),
        metadata: tool.schema.string().optional(),
      },
      execute: async (args) => {
        const callArgs: Record<string, unknown> = { id: args.id }
        if (args.content) {
          const filtered = privacyFilter(args.content)
          if (filtered === null) return "Content is entirely private — update aborted."
          callArgs.content = filtered
        }
        if (args.memory_type) callArgs.memory_type = args.memory_type
        if (args.metadata) {
          try {
            callArgs.metadata = JSON.parse(args.metadata)
          } catch {
            callArgs.metadata = args.metadata
          }
        }
        return proxy("update_memory", callArgs)
      },
    }),

    delete_memory: tool({
      description: "Delete memory by ID.",
      args: {
        id: tool.schema.string(),
      },
      execute: async (args) => proxy("delete_memory", { id: args.id }),
    }),

    get_memory: tool({
      description: "Get full memory by ID.",
      args: {
        id: tool.schema.string(),
      },
      execute: async (args) => proxy("get_memory", { id: args.id }),
    }),

    list_memories: tool({
      description: "List memories (newest first).",
      args: {
        limit: tool.schema.number().optional(),
        offset: tool.schema.number().optional(),
      },
      execute: async (args) => {
        const callArgs: Record<string, unknown> = {}
        if (args.limit !== undefined) callArgs.limit = args.limit
        if (args.offset !== undefined) callArgs.offset = args.offset
        return proxy("list_memories", callArgs)
      },
    }),

    // --- Search & Retrieval ---
    recall: tool({
      description:
        "Best memory retrieval. Combines vector+BM25+graph via RRF fusion. Use as default search.",
      args: {
        query: tool.schema.string(),
        limit: tool.schema.number().optional(),
      },
      execute: async (args) => {
        const callArgs: Record<string, unknown> = { query: args.query }
        if (args.limit !== undefined) callArgs.limit = args.limit
        return proxy("recall", callArgs)
      },
    }),

    search_memory: tool({
      description:
        "Search memories. mode=vector for semantic similarity, mode=bm25 for exact keyword match.",
      args: {
        query: tool.schema.string(),
        mode: tool.schema.enum(["vector", "bm25"]).optional(),
        limit: tool.schema.number().optional(),
      },
      execute: async (args) => {
        const callArgs: Record<string, unknown> = { query: args.query }
        if (args.mode) callArgs.mode = args.mode
        if (args.limit !== undefined) callArgs.limit = args.limit
        return proxy("search_memory", callArgs)
      },
    }),

    // --- Lifecycle ---
    invalidate: tool({
      description:
        "Soft-delete memory, optionally linking replacement. Use when stored information becomes outdated.",
      args: {
        id: tool.schema.string(),
        reason: tool.schema.string().optional(),
        superseded_by: tool.schema.string().optional(),
      },
      execute: async (args) => {
        const callArgs: Record<string, unknown> = { id: args.id }
        if (args.reason) callArgs.reason = args.reason
        if (args.superseded_by) callArgs.superseded_by = args.superseded_by
        return proxy("invalidate", callArgs)
      },
    }),

    get_valid: tool({
      description:
        "Get valid (non-invalidated) memories. Optional ISO 8601 timestamp for point-in-time query.",
      args: {
        timestamp: tool.schema.string().optional(),
        limit: tool.schema.number().optional(),
      },
      execute: async (args) => {
        const callArgs: Record<string, unknown> = {}
        if (args.timestamp) callArgs.timestamp = args.timestamp
        if (args.limit !== undefined) callArgs.limit = args.limit
        return proxy("get_valid", callArgs)
      },
    }),

    // --- Knowledge Graph ---
    knowledge_graph: tool({
      description:
        "Knowledge graph operations. Actions: create_entity(name, entity_type?, description?) | create_relation(from_entity, to_entity, relation_type, weight?) | get_related(entity_id, depth?, direction?) | detect_communities()",
      args: {
        action: tool.schema.enum([
          "create_entity",
          "create_relation",
          "get_related",
          "detect_communities",
        ]),
        name: tool.schema.string().optional(),
        entity_type: tool.schema.string().optional(),
        description: tool.schema.string().optional(),
        from_entity: tool.schema.string().optional(),
        to_entity: tool.schema.string().optional(),
        relation_type: tool.schema.string().optional(),
        weight: tool.schema.number().optional(),
        entity_id: tool.schema.string().optional(),
        depth: tool.schema.number().optional(),
        direction: tool.schema.enum(["in", "out", "both"]).optional(),
      },
      execute: async (args) => {
        const callArgs: Record<string, unknown> = { action: args.action }
        // Pass through all provided optional args
        for (const [key, val] of Object.entries(args)) {
          if (key !== "action" && val !== undefined) {
            callArgs[key] = val
          }
        }
        return proxy("knowledge_graph", callArgs)
      },
    }),

    // --- System ---
    get_status: tool({
      description: "Get memory system status and startup progress.",
      args: {},
      execute: async () => {
        if (isConnectionFailed()) {
          const status = getConnectionStatus()
          return JSON.stringify({
            status: "disconnected",
            failureCount: status.failureCount,
            lastFailureTime: status.lastFailureTime
              ? new Date(status.lastFailureTime).toISOString()
              : null,
            retrying: status.retrying,
            message: "Memory server offline — auto-reconnecting in background.",
          })
        }
        return proxy("get_status", {})
      },
    }),

    // --- Code Intelligence ---
    index_project: tool({
      description:
        "Index a codebase directory for code search. Run this before using recall_code or search_symbols on a project.",
      args: {
        path: tool.schema.string(),
        force: tool.schema.boolean().optional(),
      },
      execute: async (args) => {
        const callArgs: Record<string, unknown> = { path: args.path }
        if (args.force !== undefined) callArgs.force = args.force
        return proxy("index_project", callArgs)
      },
    }),

    recall_code: tool({
      description:
        "Search indexed code using hybrid retrieval (vector + BM25 + graph fusion). Filter by path prefix, language, or chunk type.",
      args: {
        query: tool.schema.string(),
        project_id: tool.schema.string().optional(),
        limit: tool.schema.number().optional(),
        mode: tool.schema.string().optional(),
        vector_weight: tool.schema.number().optional(),
        bm25_weight: tool.schema.number().optional(),
        ppr_weight: tool.schema.number().optional(),
        path_prefix: tool.schema.string().optional(),
        language: tool.schema.string().optional(),
        chunk_type: tool.schema.string().optional(),
      },
      execute: async (args) => {
        // recall_code uses camelCase JSON keys (Rust serde rename_all = "camelCase")
        const callArgs: Record<string, unknown> = { query: args.query }
        if (args.project_id) callArgs.projectId = args.project_id
        if (args.limit !== undefined) callArgs.limit = args.limit
        if (args.mode) callArgs.mode = args.mode
        if (args.vector_weight !== undefined) callArgs.vectorWeight = args.vector_weight
        if (args.bm25_weight !== undefined) callArgs.bm25Weight = args.bm25_weight
        if (args.ppr_weight !== undefined) callArgs.pprWeight = args.ppr_weight
        if (args.path_prefix) callArgs.pathPrefix = args.path_prefix
        if (args.language) callArgs.language = args.language
        if (args.chunk_type) callArgs.chunkType = args.chunk_type
        return proxy("recall_code", callArgs)
      },
    }),

    search_symbols: tool({
      description:
        "Search code symbols (functions, classes, types, etc.) by name across indexed projects.",
      args: {
        query: tool.schema.string(),
        project_id: tool.schema.string().optional(),
        limit: tool.schema.number().optional(),
        offset: tool.schema.number().optional(),
        symbol_type: tool.schema.string().optional(),
        path_prefix: tool.schema.string().optional(),
      },
      execute: async (args) => {
        const callArgs: Record<string, unknown> = { query: args.query }
        if (args.project_id) callArgs.project_id = args.project_id
        if (args.limit !== undefined) callArgs.limit = args.limit
        if (args.offset !== undefined) callArgs.offset = args.offset
        if (args.symbol_type) callArgs.symbol_type = args.symbol_type
        if (args.path_prefix) callArgs.path_prefix = args.path_prefix
        return proxy("search_symbols", callArgs)
      },
    }),

    project_info: tool({
      description:
        "Get project indexing info. Actions: list (all projects), status (indexing status), stats (code statistics). Requires project_id for status/stats.",
      args: {
        action: tool.schema.string(),
        project_id: tool.schema.string().optional(),
      },
      execute: async (args) => {
        const callArgs: Record<string, unknown> = { action: args.action }
        if (args.project_id) callArgs.project_id = args.project_id
        return proxy("project_info", callArgs)
      },
    }),

    symbol_graph: tool({
      description:
        "Navigate symbol call graph. Actions: callers(symbol_id) | callees(symbol_id) | related(symbol_id, depth?, direction?)",
      args: {
        action: tool.schema.enum(["callers", "callees", "related"]),
        symbol_id: tool.schema.string(),
        depth: tool.schema.number().optional(),
        direction: tool.schema.enum(["in", "out", "both"]).optional(),
      },
      execute: async (args) => {
        const callArgs: Record<string, unknown> = {
          action: args.action,
          symbol_id: args.symbol_id,
        }
        if (args.depth !== undefined) callArgs.depth = args.depth
        if (args.direction) callArgs.direction = args.direction
        return proxy("symbol_graph", callArgs)
      },
    }),

    // --- Config ---
    reload_config: tool({
      description:
        "Reload plugin configuration from disk. Call after editing opencode-mmcp-1file.jsonc to apply changes without restart. Note: mcpServer changes require a full restart.",
      args: {},
      execute: async () => {
        try {
          const changed = applyConfig(config, directory)
          if (changed.length === 0) {
            return "Config reloaded — no changes detected."
          }
          const mcpChanged = changed.includes("mcpServer")
          let msg = `Config reloaded. Updated sections: ${changed.join(", ")}.`
          if (mcpChanged) {
            msg += "\n⚠️ mcpServer settings changed — restart the editor for server changes to take effect."
          }
          return msg
        } catch (err) {
          return `Config reload failed: ${String(err)}`
        }
      },
    }),
  }

  return tools
}
