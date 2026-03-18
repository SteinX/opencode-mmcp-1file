/**
 * Registers MCP server tools as plugin tools so the agent can call them directly.
 * Each tool has a hardcoded Zod schema (matching the MCP server's JSON Schema)
 * and an execute function that proxies to the MCP server via callMemoryTool().
 *
 * We register core memory tools (CRUD, search, knowledge graph) but skip:
 * - reset_all_memory (dangerous)
 * - how_to_use (agent has system prompt guidance)
 * - Code intelligence tools (index_project, recall_code, search_symbols, symbol_graph,
 *   project_info, delete_project) — specialized, registered separately if needed
 */

import { tool } from "@opencode-ai/plugin/tool"
import type { PluginConfig } from "../config.js"
import { callMemoryTool } from "./mcp-client.js"
import { stripPrivateContent, isFullyPrivate } from "../utils/privacy.js"
import { logger } from "../utils/logger.js"

type ToolMap = Record<string, ReturnType<typeof tool>>

export function buildToolRegistry(config: PluginConfig): ToolMap {
  const proxy = async (name: string, args: Record<string, unknown>): Promise<string> => {
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
      execute: async () => proxy("get_status", {}),
    }),
  }

  return tools
}
