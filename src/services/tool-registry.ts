/**
 * Unified tool registry — consolidates 17 memory tools into 8 ergonomic tools.
 * Each tool automatically routes to the appropriate underlying MCP operation.
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
    // --- Unified Memory Operations ---

    /**
     * Unified memory search — replaces recall, search_memory, list_memories, get_valid
     * Auto-detects intent: semantic search, keyword search, or list recent memories
     */
    memory_query: tool({
      description:
        "Search your memory. Automatically selects the best search strategy based on your query. " +
        "Use natural language for semantic search, keywords for exact matches, or 'recent' to list latest memories. " +
        "This is your primary tool for retrieving stored knowledge.",
      args: {
        query: tool.schema.string(),
        limit: tool.schema.number().optional(),
        mode: tool.schema.enum(["auto", "semantic", "keyword", "recent"]).optional(),
      },
      execute: async (args) => {
        const mode = args.mode || "auto"
        const limit = args.limit ?? 5

        // Route to appropriate underlying tool
        if (mode === "recent" || args.query.toLowerCase().includes("recent")) {
          return proxy("list_memories", { limit })
        }

        if (mode === "keyword") {
          return proxy("search_memory", { query: args.query, mode: "bm25", limit })
        }

        if (mode === "semantic") {
          return proxy("search_memory", { query: args.query, mode: "vector", limit })
        }

        // Auto mode: check for validity queries, otherwise use recall (hybrid search)
        const lowerQuery = args.query.toLowerCase()
        if (lowerQuery.includes("valid") || lowerQuery.includes("not invalidated")) {
          return proxy("get_valid", { limit })
        }

        return proxy("recall", { query: args.query, limit })
      },
    }),

    /**
     * Smart memory storage — replaces store_memory
     * Auto-categorizes based on content patterns
     */
    memory_save: tool({
      description:
        "Save important information to memory. Use for decisions, tasks, patterns, bug fixes, and discoveries. " +
        "Auto-categorizes based on content. Always call this after making decisions or discovering reusable knowledge.",
      args: {
        content: tool.schema.string(),
        category: tool.schema
          .enum(["auto", "DECISION", "TASK", "PATTERN", "BUGFIX", "CONTEXT", "RESEARCH", "USER"])
          .optional(),
        memory_type: tool.schema.enum(["semantic", "episodic", "procedural"]).optional(),
      },
      execute: async (args) => {
        const filtered = privacyFilter(args.content)
        if (filtered === null) return "Content is entirely private — nothing stored."

        let content = filtered
        const category = args.category || "auto"

        // Auto-prefix based on category or content detection
        if (category !== "auto" && !content.startsWith(category)) {
          content = `${category}: ${content}`
        } else if (category === "auto") {
          // Detect common patterns
          if (/\b(decide|decision|choose|opt for)\b/i.test(content) && !content.startsWith("DECISION")) {
            content = `DECISION: ${content}`
          } else if (/\b(task|todo|implement|create)\b/i.test(content) && !content.startsWith("TASK")) {
            content = `TASK: ${content}`
          } else if (/\b(pattern|convention|standard)\b/i.test(content) && !content.startsWith("PATTERN")) {
            content = `PATTERN: ${content}`
          } else if (/\b(bug|fix|error|issue)\b/i.test(content) && !content.startsWith("BUGFIX")) {
            content = `BUGFIX: ${content}`
          }
        }

        const callArgs: Record<string, unknown> = { content }
        if (args.memory_type) callArgs.memory_type = args.memory_type

        return proxy("store_memory", callArgs)
      },
    }),

    /**
     * Memory lifecycle management — replaces update_memory, delete_memory, invalidate, get_memory
     */
    memory_manage: tool({
      description:
        "Manage existing memories: update, delete, invalidate, or retrieve by ID. " +
        "Use 'get' to view a specific memory, 'update' to modify content, 'delete' to remove, 'invalidate' to mark as outdated.",
      args: {
        action: tool.schema.enum(["get", "update", "delete", "invalidate"]),
        id: tool.schema.string(),
        content: tool.schema.string().optional(),
        reason: tool.schema.string().optional(),
      },
      execute: async (args) => {
        switch (args.action) {
          case "get":
            return proxy("get_memory", { id: args.id })

          case "delete":
            return proxy("delete_memory", { id: args.id })

          case "invalidate":
            return proxy("invalidate", { id: args.id, reason: args.reason })

          case "update": {
            if (!args.content) return "Error: content is required for update action"
            const filtered = privacyFilter(args.content)
            if (filtered === null) return "Content is entirely private — update aborted."
            return proxy("update_memory", { id: args.id, content: filtered })
          }

          default:
            return `Error: Unknown action ${args.action}`
        }
      },
    }),

    /**
     * Unified code search — replaces recall_code, search_symbols, symbol_graph
     */
    code_search: tool({
      description:
        "Search and understand code. Use natural language to find code by intent/concept (e.g., 'how is auth handled?'). " +
        "Use symbol_name when you know the exact function/class name. Results include symbol IDs for exploring call relationships.",
      args: {
        query: tool.schema.string(),
        search_type: tool.schema.enum(["intent", "symbol", "callers", "callees", "related"]).optional(),
        symbol_id: tool.schema.string().optional(),
        project_id: tool.schema.string().optional(),
        limit: tool.schema.number().optional(),
      },
      execute: async (args) => {
        const searchType = args.search_type || "intent"

        switch (searchType) {
          case "intent":
            return proxy("recall_code", {
              query: args.query,
              projectId: args.project_id,
              limit: args.limit ?? 10,
            })

          case "symbol":
            return proxy("search_symbols", {
              query: args.query,
              project_id: args.project_id,
              limit: args.limit ?? 10,
            })

          case "callers":
          case "callees":
          case "related": {
            if (!args.symbol_id) {
              return `Error: symbol_id is required for ${searchType} search. First use search_type="symbol" to find the symbol ID.`
            }
            return proxy("symbol_graph", {
              action: searchType,
              symbol_id: args.symbol_id,
            })
          }

          default:
            return `Error: Unknown search_type ${searchType}`
        }
      },
    }),

    /**
     * Project operations — replaces project_info, index_project
     */
    project_status: tool({
      description:
        "Check project indexing status or index a new project. Use 'list' to see indexed projects, 'index' to add a project, 'stats' for code statistics.",
      args: {
        action: tool.schema.enum(["list", "index", "stats"]),
        path: tool.schema.string().optional(),
        project_id: tool.schema.string().optional(),
        force: tool.schema.boolean().optional(),
      },
      execute: async (args) => {
        switch (args.action) {
          case "list":
            return proxy("project_info", { action: "list" })

          case "stats":
            return proxy("project_info", {
              action: "stats",
              project_id: args.project_id,
            })

          case "index": {
            if (!args.path) return "Error: path is required for index action"
            const callArgs: Record<string, unknown> = { path: args.path }
            if (args.force !== undefined) callArgs.force = args.force
            return proxy("index_project", callArgs)
          }

          default:
            return `Error: Unknown action ${args.action}`
        }
      },
    }),

    // --- Specialized Tools (retained) ---

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
        for (const [key, val] of Object.entries(args)) {
          if (key !== "action" && val !== undefined) {
            callArgs[key] = val
          }
        }
        return proxy("knowledge_graph", callArgs)
      },
    }),

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
