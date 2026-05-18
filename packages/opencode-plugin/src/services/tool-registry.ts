/**
 * Unified tool registry — consolidates 17 memory tools into 14 ergonomic tools.
 * Each tool automatically routes to the appropriate underlying MCP operation.
 */

import { tool } from "@opencode-ai/plugin/tool"
import type { PluginConfig } from "../config.js"
import { applyConfig } from "../config.js"
import {
  callMemoryTool,
  getMemoryClient,
  getMemoryConnectionKey,
  getProjectDurableStatus,
  getProjectProjectionByLocatorInfo,
  getProjectProjectionInfo,
  isMissingProjectLocator,
  resetMemoryClientForServerControl,
} from "./mcp-client.js"
import {
  ensureServerRunning,
  getServerRuntimeStatus,
  getServerUrl,
  isServerRunning,
  stopServer,
} from "./server-process.js"
import { stripPrivateContent, isFullyPrivate } from "../utils/privacy.js"
import { logger } from "../utils/logger.js"
import { isConnectionFailed, getConnectionStatus } from "./connection-state.js"
import type { MemoryOperationContext } from "./mcp-client.js"
import { buildCodeIndexFilterArgs } from "../utils/code-index-filters.js"
import { migrateMemory } from "./memory-migration.js"
import {
  listLearningMemories,
  getLearningMemory,
  promoteLearningMemory,
  rejectLearningMemory,
  archiveLearningMemory,
  supersedeLearningMemory,
  updateLearningMemory,
  migrateLegacyLearningMemories,
  deleteLearningMemory,
} from "./learning-memory-client.js"
import { annotateCodeIntelResponse, annotateProjectStatusResponse } from "../utils/code-intel-annotations.js"
import { getMemoryAudit, getMemorySearchTrace } from "./memory-orchestration.js"

const UNAVAILABLE_MESSAGE =
  "Memory server temporarily unavailable — auto-reconnecting. " +
  "Try again in ~30s. Do not retry memory tools until the system prompt confirms the connection is restored."

type ToolMap = Record<string, ReturnType<typeof tool>>
type ProjectionRelationScope = "all" | "calls" | "imports" | "type_links" | "none"

function parseJsonArg(value?: string): Record<string, unknown> | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function buildOperationContext(
  context: any,
  args: {
    namespace?: string
    user_id?: string
    agent_id?: string
    run_id?: string
    memory_type?: string
    metadata_json?: string
    metadata_filter_json?: string
    event_after?: string
    event_before?: string
    ingestion_after?: string
    ingestion_before?: string
    valid_at?: string
    timestamp?: string
  },
): MemoryOperationContext {
  return {
    agentId: args.agent_id ?? context?.agent,
    runId: args.run_id ?? context?.sessionID,
    namespace: args.namespace,
    userId: args.user_id,
    memoryType: args.memory_type,
    metadata: parseJsonArg(args.metadata_json),
    metadataFilter: parseJsonArg(args.metadata_filter_json),
    eventAfter: args.event_after,
    eventBefore: args.event_before,
    ingestionAfter: args.ingestion_after,
    ingestionBefore: args.ingestion_before,
    validAt: args.valid_at,
    timestamp: args.timestamp,
  }
}

function projectionRequestDefaults(args: {
  relation_scope?: ProjectionRelationScope
  sort_mode?: string
}): { relationScope: ProjectionRelationScope, sortMode: string } {
  return {
    relationScope: args.relation_scope ?? "all",
    sortMode: args.sort_mode ?? "canonical",
  }
}

function traceModeForServer(mode?: "auto" | "semantic" | "keyword"): "recall" | "vector" | "bm25" | undefined {
  if (mode === "auto") return "recall"
  if (mode === "semantic") return "vector"
  if (mode === "keyword") return "bm25"
  return undefined
}

async function getFreshProjectProjection(config: PluginConfig, args: {
  projectId: string
  relationScope: ProjectionRelationScope
  sortMode: string
}): Promise<string> {
  const result = await getProjectProjectionInfo(config, {
    projectId: args.projectId,
    relationScope: args.relationScope,
    sortMode: args.sortMode,
  })
  return result?.raw != null ? JSON.stringify(result.raw) : "Error: projection request failed"
}

export function buildToolRegistry(config: PluginConfig, directory?: string): ToolMap {
  const connectionKey = getMemoryConnectionKey(config)

  const proxy = async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (isConnectionFailed(connectionKey)) {
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
        "Start with query only; add limit or mode when needed. Only pass namespace, agent/run IDs, metadata filters, or time filters when you intentionally want narrower retrieval, and omit empty optional fields entirely. " +
        "This is your primary tool for retrieving stored knowledge.",
      args: {
        query: tool.schema.string(),
        limit: tool.schema.number().optional(),
        mode: tool.schema.enum(["auto", "semantic", "keyword", "recent", "valid"]).optional(),
        namespace: tool.schema.string().optional(),
        user_id: tool.schema.string().optional(),
        agent_id: tool.schema.string().optional(),
        run_id: tool.schema.string().optional(),
        memory_type: tool.schema.string().optional(),
        metadata_filter_json: tool.schema.string().optional(),
        event_after: tool.schema.string().optional(),
        event_before: tool.schema.string().optional(),
        ingestion_after: tool.schema.string().optional(),
        ingestion_before: tool.schema.string().optional(),
        valid_at: tool.schema.string().optional(),
        timestamp: tool.schema.string().optional(),
      },
      execute: async (args, context) => {
        const mode = args.mode || "auto"
        const limit = args.limit ?? 5
        const scopeArgs = buildOperationContext(context, args)

        // Route to appropriate underlying tool
        if (mode === "recent" || args.query.toLowerCase().includes("recent")) {
          return proxy("list_memories", { limit, ...scopeArgs })
        }

        if (mode === "keyword") {
          return proxy("search_memory", { query: args.query, mode: "bm25", limit, ...scopeArgs })
        }

        if (mode === "semantic") {
          return proxy("search_memory", { query: args.query, mode: "vector", limit, ...scopeArgs })
        }

        if (mode === "valid") {
          return proxy("get_valid", { limit, ...scopeArgs })
        }

        return proxy("recall", { query: args.query, limit, ...scopeArgs })
      },
    }),

    memory_audit: tool({
      description:
        "Read a server-owned memory lifecycle/debug audit. Use for support, degraded memory diagnostics, GC backlog, and learning-memory readiness. This is read-only.",
      args: {
        detail: tool.schema.enum(["summary", "full"]).optional(),
      },
      execute: async (args) => {
        if (isConnectionFailed(connectionKey)) return UNAVAILABLE_MESSAGE
        const result = await getMemoryAudit(config, { detail: args.detail ?? "summary" })
        return JSON.stringify(result)
      },
    }),

    memory_trace: tool({
      description:
        "Explain how memory search selected or ranked results. Use when a result looks surprising or when debugging retrieval quality. This is read-only.",
      args: {
        query: tool.schema.string(),
        limit: tool.schema.number().optional(),
        mode: tool.schema.enum(["auto", "semantic", "keyword"]).optional(),
      },
      execute: async (args) => {
        if (isConnectionFailed(connectionKey)) return UNAVAILABLE_MESSAGE
        const callArgs: Record<string, unknown> = { query: args.query }
        if (args.limit !== undefined) callArgs.limit = args.limit
        const mode = traceModeForServer(args.mode)
        if (mode !== undefined) callArgs.mode = mode
        const result = await getMemorySearchTrace(config, callArgs)
        return JSON.stringify(result)
      },
    }),

    /**
     * Safe cross-shard memory migration — wraps export_memory/import_memory with dry-run-first guardrails.
     */
    memory_migrate: tool({
      description:
        "Migrate memories between memory-mcp physical shards using export/import with a dry-run-first safety flow. " +
        "Provide exactly one source selector (source_tag or source_data_dir) and an explicit source_project_id. " +
        "Omit target_tag/target_data_dir to migrate into the current workspace shard. Actual migration requires dry_run=false and confirm=true.",
      args: {
        source_tag: tool.schema.string().optional(),
        source_data_dir: tool.schema.string().optional(),
        target_tag: tool.schema.string().optional(),
        target_data_dir: tool.schema.string().optional(),
        source_project_id: tool.schema.string(),
        target_project_id: tool.schema.string().optional(),
        source_namespace: tool.schema.string().optional(),
        target_namespace: tool.schema.string().optional(),
        include_invalidated: tool.schema.boolean().optional(),
        dry_run: tool.schema.boolean().optional(),
        confirm: tool.schema.boolean().optional(),
      },
      execute: async (args) => {
        const report = await migrateMemory(config, args)
        return JSON.stringify(report)
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
        namespace: tool.schema.string().optional(),
        user_id: tool.schema.string().optional(),
        agent_id: tool.schema.string().optional(),
        run_id: tool.schema.string().optional(),
        metadata_json: tool.schema.string().optional(),
      },
      execute: async (args, context) => {
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

        const callArgs: Record<string, unknown> = {
          content,
          ...buildOperationContext(context, args),
        }
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
        namespace: tool.schema.string().optional(),
        user_id: tool.schema.string().optional(),
        agent_id: tool.schema.string().optional(),
        run_id: tool.schema.string().optional(),
        memory_type: tool.schema.string().optional(),
        metadata_json: tool.schema.string().optional(),
      },
      execute: async (args, context) => {
        const scopeArgs = buildOperationContext(context, args)
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
            return proxy("update_memory", { id: args.id, content: filtered, ...scopeArgs })
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
        "Search and understand code. This is semantic code intelligence, not exact literal grep/search: use natural language to find code by intent/concept (e.g. 'how is auth handled?'). " +
        "Use search_type: \"symbol\" when you know the exact function/class name (e.g. query: \"handleRequest\"). " +
        "Use search_type: \"callers\" | \"callees\" | \"related\" with symbol_id to traverse relationships, and use the symbol IDs returned by symbol lookup to continue exploring. " +
        "Examples: code_search({ search_type: \"intent\", query: \"where do we validate memory privacy?\" }), code_search({ search_type: \"symbol\", query: \"handleRequest\" }), code_search({ search_type: \"callers\", query: \"\", symbol_id: \"sym-123\" }).",
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
            return annotateCodeIntelResponse(await proxy("recall_code", {
              query: args.query,
              projectId: args.project_id,
              limit: args.limit ?? 10,
            }))

          case "symbol":
            return annotateCodeIntelResponse(await proxy("search_symbols", {
              query: args.query,
              project_id: args.project_id,
              limit: args.limit ?? 10,
            }))

          case "callers":
          case "callees":
          case "related": {
            if (!args.symbol_id) {
              return `Error: symbol_id is required for ${searchType} search. First call code_search({ search_type: "symbol", query: "<name>" }) to find the symbol ID.`
            }
            return annotateCodeIntelResponse(await proxy("symbol_graph", {
              action: searchType,
              symbol_id: args.symbol_id,
            }))
          }

          default:
            return `Error: Unknown search_type ${searchType}`
        }
      },
    }),

    /**
     * Project operations — replaces project_info, index_project
     */
    project_index: tool({
      description:
        "Start a fresh project index for a path. Use this for ordinary index triggers so agents avoid optional-parameter pollution; for status, resume, cancel, cleanup, stats, or projections use project_status instead.",
      args: {
        path: tool.schema.string(),
        force: tool.schema.boolean().optional(),
      },
      execute: async (args) => {
        const callArgs: Record<string, unknown> = { path: args.path }
        if (args.force) callArgs.force = true
        const filterResult = buildCodeIndexFilterArgs(config.codeIndexSync)
        if (typeof filterResult === "string") return filterResult
        Object.assign(callArgs, filterResult)
        return proxy("index_project", callArgs)
      },
    }),

    project_ensure_index: tool({
      description:
        "Ensure a project is indexed for readiness checks. Use this for the common 'make sure indexing exists or is current' workflow; it inspects durable status first, resumes only when the server provides resumable identity, and otherwise starts a clean fresh index without exposing filter or resume identity fields to agents.",
      args: {
        path: tool.schema.string(),
      },
      execute: async (args) => {
        const freshIndexPayload = (): Record<string, unknown> | string => {
          const filterResult = buildCodeIndexFilterArgs(config.codeIndexSync)
          if (typeof filterResult === "string") return filterResult
          return { path: args.path, ...filterResult }
        }

        const status = await getProjectDurableStatus(config, args.path)
        if (!status) {
          const callArgs = freshIndexPayload()
          if (typeof callArgs === "string") return callArgs
          return proxy("index_project", callArgs)
        }

        if (
          status.reason_code === "active_index_running"
          || status.state === "queued"
          || status.state === "running"
        ) {
          return JSON.stringify({
            status: "already_running",
            state: status.state,
            reason_code: status.reason_code,
            progress: status.progress,
          })
        }

        if (status.state === "completed") {
          return JSON.stringify({
            status: "already_ready",
            state: status.state,
            reason_code: status.reason_code,
          })
        }

        if (status.can_resume === true) {
          if (!status.job_id || !status.resume_token) {
            return JSON.stringify({
              status: "blocked",
              reason: "missing_resume_identity",
              state: status.state,
              reason_code: status.reason_code,
            })
          }

          return proxy("index_project", {
            path: args.path,
            resume: true,
            job_id: status.job_id,
            resume_token: status.resume_token,
            allow_full_restart_fallback: false,
          })
        }

        const callArgs = freshIndexPayload()
        if (typeof callArgs === "string") return callArgs
        return proxy("index_project", callArgs)
      },
    }),

    project_recover_index: tool({
      description:
        "Recover an interrupted project index for a path. The plugin checks durable status, resumes only when the server provides job_id and resume_token, and never exposes resume/filter parameters to agents.",
      args: {
        path: tool.schema.string(),
      },
      execute: async (args) => {
        const status = await getProjectDurableStatus(config, args.path)
        if (!status) {
          return JSON.stringify({
            status: "unsupported",
            message: "Durable project status is unavailable; use project_index for a fresh index.",
          })
        }

        if (
          status.reason_code === "active_index_running"
          || status.state === "queued"
          || status.state === "running"
        ) {
          return JSON.stringify({
            status: "already_running",
            state: status.state,
            reason_code: status.reason_code,
            progress: status.progress,
          })
        }

        if (status.state === "completed") {
          return JSON.stringify({
            status: "already_completed",
            state: status.state,
            reason_code: status.reason_code,
          })
        }

        if (status.can_resume === true) {
          if (!status.job_id || !status.resume_token) {
            return JSON.stringify({
              status: "blocked",
              reason: "missing_resume_identity",
              state: status.state,
              reason_code: status.reason_code,
            })
          }

          return proxy("index_project", {
            path: args.path,
            resume: true,
            job_id: status.job_id,
            resume_token: status.resume_token,
            allow_full_restart_fallback: false,
          })
        }

        return JSON.stringify({
          status: "not_resumable",
          state: status.state,
          reason_code: status.reason_code,
          can_resume: status.can_resume ?? false,
        })
      },
    }),

    project_projection: tool({
      description:
        "Simple project projection/readback entry point. Use this for ordinary projection workflows instead of project_status. " +
        "Provide project_id, optionally add locator to read back an existing projection, and optionally set relation_scope or sort_mode when you need non-default traversal or ordering.",
      args: {
        project_id: tool.schema.string(),
        locator: tool.schema.string().optional(),
        relation_scope: tool.schema.enum(["all", "calls", "imports", "type_links", "none"]).optional(),
        sort_mode: tool.schema.string().optional(),
      },
      execute: async (args) => {
        if (!args.project_id) return "Error: project_id is required for projection"
        const { relationScope, sortMode } = projectionRequestDefaults(args)

        if (!args.locator) {
          return getFreshProjectProjection(config, {
            projectId: args.project_id,
            relationScope,
            sortMode,
          })
        }

        const result = await getProjectProjectionByLocatorInfo(config, { locator: args.locator })
        if (!result || isMissingProjectLocator(result.locator)) {
          return getFreshProjectProjection(config, {
            projectId: args.project_id,
            relationScope,
            sortMode,
          })
        }

        return result.raw != null ? JSON.stringify(result.raw) : "Error: projection readback failed"
      },
    }),

    project_status: tool({
      description:
        "Check project indexing status and manage indexing lifecycle. Start with 'list' to see indexed projects, use 'status' to inspect durable state, use 'ensure_index' for normal readiness workflows, then use 'stats' to confirm the index is ready. " +
        "For ordinary index triggers, prefer project_index; for interrupted indexes, prefer project_recover_index to avoid optional-parameter pollution. " +
        "Use project_projection for ordinary projection/readback workflows; keep 'projection' / 'projection_by_locator' here only for compatibility. Use 'cancel' to stop an active index, 'cleanup' to clear abandoned jobs, and 'projection' / 'projection_by_locator' for short-lived projection exports. For 'index', optional include_patterns/exclude_patterns override filter scope (omit = use plugin/server defaults; [] = disable that side; not allowed on resume).",
      args: {
        action: tool.schema.enum(["list", "status", "index", "resume", "cancel", "cleanup", "stats", "projection", "projection_by_locator"]),
        path: tool.schema.string().optional(),
        project_id: tool.schema.string().optional(),
        force: tool.schema.boolean().optional(),
        resume: tool.schema.boolean().optional(),
        job_id: tool.schema.string().optional(),
        resume_token: tool.schema.string().optional(),
        allow_full_restart_fallback: tool.schema.boolean().optional(),
        confirm_failed_restart: tool.schema.boolean().optional(),
        include_patterns: tool.schema.array(tool.schema.string()).optional(),
        exclude_patterns: tool.schema.array(tool.schema.string()).optional(),
        relation_scope: tool.schema.enum(["all", "calls", "imports", "type_links", "none"]).optional(),
        sort_mode: tool.schema.string().optional(),
        locator: tool.schema.string().optional(),
      },
      execute: async (args) => {
        switch (args.action) {
          case "list":
            return annotateProjectStatusResponse(await proxy("project_info", { action: "list" }))

          case "status": {
            const callArgs: Record<string, unknown> = { action: "status" }
            if (args.project_id !== undefined) callArgs.project_id = args.project_id
            if (args.path !== undefined) callArgs.path = args.path
            return annotateProjectStatusResponse(await proxy("project_info", callArgs))
          }

          case "stats":
            return proxy("project_info", {
              action: "stats",
              project_id: args.project_id,
              path: args.path,
            })

          case "cancel": {
            const callArgs: Record<string, unknown> = { action: "cancel_index" }
            if (args.project_id !== undefined) callArgs.project_id = args.project_id
            if (args.path !== undefined) callArgs.path = args.path
            if (args.job_id !== undefined) callArgs.job_id = args.job_id
            return proxy("project_info", callArgs)
          }

          case "cleanup": {
            const callArgs: Record<string, unknown> = { action: "cleanup_abandoned_index_jobs" }
            if (args.project_id !== undefined) callArgs.project_id = args.project_id
            if (args.path !== undefined) callArgs.path = args.path
            return proxy("project_info", callArgs)
          }

          case "projection": {
            if (!args.project_id) return "Error: project_id is required for projection action"
            const { relationScope, sortMode } = projectionRequestDefaults(args)
            return getFreshProjectProjection(config, {
              projectId: args.project_id,
              relationScope,
              sortMode,
            })
          }

          case "projection_by_locator": {
            const { relationScope, sortMode } = projectionRequestDefaults(args)
            const tryFreshProjection = async (): Promise<string> => {
              if (!args.project_id) {
                return "Error: project_id is required when locator readback is missing or invalid"
              }
              return getFreshProjectProjection(config, {
                projectId: args.project_id,
                relationScope,
                sortMode,
              })
            }

            if (!args.locator) {
              return tryFreshProjection()
            }

            const result = await getProjectProjectionByLocatorInfo(config, { locator: args.locator })
            if (!result) {
              return tryFreshProjection()
            }

            if (isMissingProjectLocator(result.locator)) {
              return tryFreshProjection()
            }

            return JSON.stringify(result.raw)
          }

          case "resume": {
            if (!args.path) return "Error: path is required for resume action"
            if (!args.job_id) return "Error: job_id is required for resume action"
            if (!args.resume_token) return "Error: resume_token is required for resume action"
            if (args.include_patterns !== undefined || args.exclude_patterns !== undefined) {
              return "Error: include_patterns/exclude_patterns cannot be used when resuming an index job"
            }
            return proxy("index_project", {
              path: args.path,
              resume: true,
              job_id: args.job_id,
              resume_token: args.resume_token,
              allow_full_restart_fallback: args.allow_full_restart_fallback,
            })
          }

          case "index": {
            if (!args.path) return "Error: path is required for index action"
            const callArgs: Record<string, unknown> = { path: args.path }
            if (args.force !== undefined) callArgs.force = args.force
            if (args.resume !== undefined) callArgs.resume = args.resume
            if (args.job_id !== undefined) callArgs.job_id = args.job_id
            if (args.resume_token !== undefined) callArgs.resume_token = args.resume_token
            if (args.allow_full_restart_fallback !== undefined) {
              callArgs.allow_full_restart_fallback = args.allow_full_restart_fallback
            }
            if (args.confirm_failed_restart !== undefined) {
              callArgs.confirm_failed_restart = args.confirm_failed_restart
            }
            const isResumeContinuation = args.resume === true || args.job_id !== undefined || args.resume_token !== undefined
            if (isResumeContinuation) {
              if (args.include_patterns !== undefined || args.exclude_patterns !== undefined) {
                return "Error: include_patterns/exclude_patterns cannot be used when resuming an index job"
              }
            } else {
              const filterResult = buildCodeIndexFilterArgs(config.codeIndexSync, {
                include_patterns: args.include_patterns,
                exclude_patterns: args.exclude_patterns,
              })
              if (typeof filterResult === "string") return filterResult
              Object.assign(callArgs, filterResult)
            }
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
        "Map and query architectural relationships between codebase components — services, modules, data flows, and dependencies. Use when analyzing system architecture, tracing module dependencies, or recording discovered structural relationships. Actions: create_entity(name, entity_type?, description?) | create_relation(from_entity, to_entity, relation_type, weight?) | get_related(entity_id, depth?, direction?) | detect_communities()",
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
        if (isConnectionFailed(connectionKey)) {
          const status = getConnectionStatus(connectionKey)
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
            if (config.mcpServer.transport === "http") {
              msg += "\n⚠️ mcpServer settings changed — use /manage-mcp-server restart to apply server process changes for HTTP transport. Otherwise restart the editor for non-server changes."
            } else {
              msg += "\n⚠️ mcpServer settings changed — restart the editor for changes to take effect."
            }
          }
          return msg
        } catch (err) {
          return `Config reload failed: ${String(err)}`
        }
      },
    }),

    // --- Learning Memory Management Tools ---

    memory_learning_list: tool({
      description:
        "List learning memories with optional filters. Use to browse stored learnings by kind (user_preference, project_lesson, project_pattern, project_pitfall, workflow_rule), " +
        "status (candidate, confirmed, rule, rejected, superseded, archived), scope, namespace, user_id, or metadata. " +
        "Omit filters to list all learnings. Use memory_learning_retrieve to fetch a specific record by id.",
      args: {
        kind: tool.schema.string().optional(),
        status: tool.schema.string().optional(),
        scope: tool.schema.string().optional(),
        namespace: tool.schema.string().optional(),
        user_id: tool.schema.string().optional(),
        metadata_filter_json: tool.schema.string().optional(),
        limit: tool.schema.number().optional(),
      },
      execute: async (args) => {
        if (isConnectionFailed(connectionKey)) return UNAVAILABLE_MESSAGE
        try {
          const callArgs: Record<string, unknown> = {}
          if (args.kind) callArgs.kind = args.kind
          if (args.status) callArgs.include_status = [args.status]
          if (args.scope) callArgs.scope = args.scope
          if (args.namespace) callArgs.namespace = args.namespace
          if (args.user_id) callArgs.user_id = args.user_id
          if (args.metadata_filter_json) {
            const parsed = parseJsonArg(args.metadata_filter_json)
            if (parsed) callArgs.metadata_filter = parsed
          }
          if (args.limit) callArgs.limit = args.limit
          const result = await listLearningMemories(config, callArgs as any)
          return JSON.stringify(result)
        } catch (err) {
          logger.error("memory_learning_list failed", { error: String(err) })
          return `Error: ${String(err)}`
        }
      },
    }),

    memory_learning_retrieve: tool({
      description: "Retrieve a specific learning memory by id. Returns the full record including metadata, status, and lifecycle state.",
      args: {
        id: tool.schema.string(),
      },
      execute: async (args) => {
        if (isConnectionFailed(connectionKey)) return UNAVAILABLE_MESSAGE
        if (!args.id) return "Error: id is required"
        try {
          const result = await getLearningMemory(config, { id: args.id })
          return JSON.stringify(result)
        } catch (err) {
          logger.error("memory_learning_retrieve failed", { error: String(err) })
          return `Error: ${String(err)}`
        }
      },
    }),

    memory_learning_confirm: tool({
      description:
        "Confirm a candidate learning memory by id, promoting it to confirmed status. " +
        "Use when a candidate learning has been validated and should be treated as an active confirmed memory.",
      args: {
        id: tool.schema.string(),
      },
      execute: async (args) => {
        if (isConnectionFailed(connectionKey)) return UNAVAILABLE_MESSAGE
        if (!args.id) return "Error: id is required"
        try {
          const result = await promoteLearningMemory(config, { id: args.id, target_status: "confirmed" })
          return JSON.stringify(result)
        } catch (err) {
          logger.error("memory_learning_confirm failed", { error: String(err) })
          return `Error: ${String(err)}`
        }
      },
    }),

    memory_learning_promote: tool({
      description:
        "Promote a learning memory to a higher status by id. Use target_status='confirmed' to confirm a candidate, or 'rule' to elevate to a hard rule. " +
        "For simple candidate confirmation, prefer memory_learning_confirm.",
      args: {
        id: tool.schema.string(),
        target_status: tool.schema.enum(["confirmed", "rule"]),
      },
      execute: async (args) => {
        if (isConnectionFailed(connectionKey)) return UNAVAILABLE_MESSAGE
        if (!args.id) return "Error: id is required"
        if (!args.target_status) return "Error: target_status is required"
        try {
          const result = await promoteLearningMemory(config, { id: args.id, target_status: args.target_status })
          return JSON.stringify(result)
        } catch (err) {
          logger.error("memory_learning_promote failed", { error: String(err) })
          return `Error: ${String(err)}`
        }
      },
    }),

    memory_learning_reject: tool({
      description:
        "Reject a learning memory by id. Marks it as rejected so it is excluded from future injection and search. " +
        "Optionally provide a reason. Does not delete the record — use memory_learning_delete (deprecated) for hard removal.",
      args: {
        id: tool.schema.string(),
        reason: tool.schema.string().optional(),
      },
      execute: async (args) => {
        if (isConnectionFailed(connectionKey)) return UNAVAILABLE_MESSAGE
        if (!args.id) return "Error: id is required"
        try {
          const result = await rejectLearningMemory(config, { id: args.id, reason: args.reason })
          return JSON.stringify(result)
        } catch (err) {
          logger.error("memory_learning_reject failed", { error: String(err) })
          return `Error: ${String(err)}`
        }
      },
    }),

    memory_learning_archive: tool({
      description:
        "Archive a learning memory by id. Moves it to archived status — excluded from default injection but retained for history. " +
        "Use for learnings that are no longer relevant but should be preserved.",
      args: {
        id: tool.schema.string(),
      },
      execute: async (args) => {
        if (isConnectionFailed(connectionKey)) return UNAVAILABLE_MESSAGE
        if (!args.id) return "Error: id is required"
        try {
          const result = await archiveLearningMemory(config, { id: args.id })
          return JSON.stringify(result)
        } catch (err) {
          logger.error("memory_learning_archive failed", { error: String(err) })
          return `Error: ${String(err)}`
        }
      },
    }),

    memory_learning_supersede: tool({
      description:
        "Supersede a learning memory by id, linking it to a replacement record. " +
        "Marks the original as superseded and records the replacement_id in the lineage chain. " +
        "Use when a learning has been replaced by a newer, more accurate version.",
      args: {
        id: tool.schema.string(),
        replacement_id: tool.schema.string(),
      },
      execute: async (args) => {
        if (isConnectionFailed(connectionKey)) return UNAVAILABLE_MESSAGE
        if (!args.id) return "Error: id is required"
        if (!args.replacement_id) return "Error: replacement_id is required"
        try {
          const result = await supersedeLearningMemory(config, { id: args.id, replacement_id: args.replacement_id })
          return JSON.stringify(result)
        } catch (err) {
          logger.error("memory_learning_supersede failed", { error: String(err) })
          return `Error: ${String(err)}`
        }
      },
    }),

    memory_learning_update: tool({
      description:
        "Update the content or metadata of a learning memory by id. " +
        "Use to correct content, adjust confidence, or add/change metadata fields. " +
        "Only provide fields you want to change; omit unchanged fields.",
      args: {
        id: tool.schema.string(),
        content: tool.schema.string().optional(),
        confidence: tool.schema.number().optional(),
        metadata_json: tool.schema.string().optional(),
      },
      execute: async (args) => {
        if (isConnectionFailed(connectionKey)) return UNAVAILABLE_MESSAGE
        if (!args.id) return "Error: id is required"
        try {
          const updateArgs: { id: string; content?: string; confidence?: number; metadata?: Record<string, unknown> } = { id: args.id }
          if (args.content !== undefined) updateArgs.content = args.content
          if (args.confidence !== undefined) updateArgs.confidence = args.confidence
          if (args.metadata_json) {
            const parsed = parseJsonArg(args.metadata_json)
            if (parsed) updateArgs.metadata = parsed
          }
          const result = await updateLearningMemory(config, updateArgs)
          return JSON.stringify(result)
        } catch (err) {
          logger.error("memory_learning_update failed", { error: String(err) })
          return `Error: ${String(err)}`
        }
      },
    }),

    memory_learning_migrate_legacy: tool({
      description:
        "Trigger migration of legacy learning memories to the current schema. " +
        "Set dry_run=true (default) to preview what would be migrated without making changes. " +
        "Set dry_run=false to execute the migration. Optionally filter by source_prefixes.",
      args: {
        dry_run: tool.schema.boolean().optional(),
        source_prefixes: tool.schema.string().optional(),
      },
      execute: async (args) => {
        if (isConnectionFailed(connectionKey)) return UNAVAILABLE_MESSAGE
        try {
          const migrateArgs: { dry_run?: boolean; source_prefixes?: string[] } = {
            dry_run: args.dry_run ?? true,
          }
          if (args.source_prefixes) {
            migrateArgs.source_prefixes = args.source_prefixes.split(",").map((s) => s.trim()).filter(Boolean)
          }
          const result = await migrateLegacyLearningMemories(config, migrateArgs)
          return JSON.stringify(result)
        } catch (err) {
          logger.error("memory_learning_migrate_legacy failed", { error: String(err) })
          return `Error: ${String(err)}`
        }
      },
    }),

    memory_learning_delete: tool({
      description:
        "[DEPRECATED] Soft-invalidation compatibility shim. Prefer memory_learning_reject or memory_learning_archive for lifecycle management. " +
        "This tool forwards to the server's delete operation for backward compatibility only. " +
        "Do not use for new workflows — use reject/archive/supersede instead.",
      args: {
        id: tool.schema.string(),
      },
      execute: async (args) => {
        if (isConnectionFailed(connectionKey)) return UNAVAILABLE_MESSAGE
        if (!args.id) return "Error: id is required"
        try {
          const result = await deleteLearningMemory(config, { id: args.id })
          return JSON.stringify(result)
        } catch (err) {
          logger.error("memory_learning_delete failed", { error: String(err) })
          return `Error: ${String(err)}`
        }
      },
    }),

    // --- Canonical learning_memory_* tools (server protocol naming) ---
    // These are the authoritative tool names per the server protocol handoff.
    // The memory_learning_* tools above are the plugin's internal naming convention;
    // these canonical aliases ensure the LLM can use the protocol-specified names.

    learning_memory_reject: tool({
      description:
        "Reject a learning memory by id. Marks it as rejected so it is excluded from future injection and search. " +
        "Optionally provide a reason. Does not delete the record — use the deprecated delete shim for hard removal. " +
        "Preferred over memory_learning_reject for new workflows.",
      args: {
        id: tool.schema.string(),
        reason: tool.schema.string().optional(),
      },
      execute: async (args) => {
        if (isConnectionFailed(connectionKey)) return UNAVAILABLE_MESSAGE
        if (!args.id) return "Error: id is required"
        try {
          const result = await rejectLearningMemory(config, { id: args.id, reason: args.reason })
          return JSON.stringify(result)
        } catch (err) {
          logger.error("learning_memory_reject failed", { error: String(err) })
          return `Error: ${String(err)}`
        }
      },
    }),

    learning_memory_archive: tool({
      description:
        "Archive a learning memory by id. Moves it to archived status — excluded from default injection but retained for history. " +
        "Use for learnings that are no longer relevant but should be preserved. " +
        "Preferred over memory_learning_archive for new workflows.",
      args: {
        id: tool.schema.string(),
      },
      execute: async (args) => {
        if (isConnectionFailed(connectionKey)) return UNAVAILABLE_MESSAGE
        if (!args.id) return "Error: id is required"
        try {
          const result = await archiveLearningMemory(config, { id: args.id })
          return JSON.stringify(result)
        } catch (err) {
          logger.error("learning_memory_archive failed", { error: String(err) })
          return `Error: ${String(err)}`
        }
      },
    }),

    learning_memory_supersede: tool({
      description:
        "Supersede a learning memory by id, linking it to a replacement record. " +
        "Marks the original as superseded and records the replacement_id in the lineage chain. " +
        "Use when a learning has been replaced by a newer, more accurate version. " +
        "Preferred over memory_learning_supersede for new workflows.",
      args: {
        id: tool.schema.string(),
        replacement_id: tool.schema.string(),
      },
      execute: async (args) => {
        if (isConnectionFailed(connectionKey)) return UNAVAILABLE_MESSAGE
        if (!args.id) return "Error: id is required"
        if (!args.replacement_id) return "Error: replacement_id is required"
        try {
          const result = await supersedeLearningMemory(config, { id: args.id, replacement_id: args.replacement_id })
          return JSON.stringify(result)
        } catch (err) {
          logger.error("learning_memory_supersede failed", { error: String(err) })
          return `Error: ${String(err)}`
        }
      },
    }),

    learning_memory_migrate_legacy: tool({
      description:
        "Trigger migration of legacy learning memories to the current schema. " +
        "Set dry_run=true (default) to preview what would be migrated without making changes. " +
        "Set dry_run=false to execute the migration. Optionally filter by source_prefixes. " +
        "Preferred over memory_learning_migrate_legacy for new workflows.",
      args: {
        dry_run: tool.schema.boolean().optional(),
        source_prefixes: tool.schema.string().optional(),
      },
      execute: async (args) => {
        if (isConnectionFailed(connectionKey)) return UNAVAILABLE_MESSAGE
        try {
          const migrateArgs: { dry_run?: boolean; source_prefixes?: string[] } = {
            dry_run: args.dry_run ?? true,
          }
          if (args.source_prefixes) {
            migrateArgs.source_prefixes = args.source_prefixes.split(",").map((s) => s.trim()).filter(Boolean)
          }
          const result = await migrateLegacyLearningMemories(config, migrateArgs)
          return JSON.stringify(result)
        } catch (err) {
          logger.error("learning_memory_migrate_legacy failed", { error: String(err) })
          return `Error: ${String(err)}`
        }
      },
    }),

    mcp_server_control: tool({
      description:
        "Manage the shared HTTP MCP server lifecycle. Supports status, controlled stop, and controlled restart. " +
        "Only applies to HTTP transport; stdio returns a no-op response.",
      args: {
        action: tool.schema.enum(["status", "stop", "restart"]),
      },
      execute: async (args) => {
        const transport = config.mcpServer.transport

        if (args.action === "status") {
          if (transport !== "http") {
            return JSON.stringify({
              ok: true,
              action: "status",
              transport,
              running: false,
              message: "stdio transport does not use a shared HTTP MCP server.",
            })
          }

          const status = await getServerRuntimeStatus(config)
          return JSON.stringify({ ok: true, action: "status", ...status })
        }

        if (args.action === "stop") {
          if (transport !== "http") {
            return JSON.stringify({
              ok: true,
              action: "stop",
              transport,
              running: false,
              message: "stdio transport does not use a shared HTTP MCP server.",
            })
          }

          const before = await getServerRuntimeStatus(config)
          await resetMemoryClientForServerControl(config)
          await stopServer(config)
          const after = await getServerRuntimeStatus(config)

          return JSON.stringify({
            ok: true,
            action: "stop",
            transport,
            stopped: !after.running,
            serverStillRunningDueToOtherHolders: after.running && after.holderCount > 0,
            before,
            after,
            message: after.running
              ? "Stop requested; shared HTTP MCP server is still running due to other active holders."
              : "Stop requested; shared HTTP MCP server is not running.",
          })
        }

        let before: Awaited<ReturnType<typeof getServerRuntimeStatus>> | undefined
        let afterStop: Awaited<ReturnType<typeof getServerRuntimeStatus>> | undefined

        if (transport !== "http") {
          return JSON.stringify({
            ok: true,
            action: "restart",
            transport,
            running: false,
            message: "stdio transport does not use a shared HTTP MCP server.",
          })
        }

        try {
          before = await getServerRuntimeStatus(config)
          await resetMemoryClientForServerControl(config)
          await stopServer(config)
          afterStop = await getServerRuntimeStatus(config)

          const url = await ensureServerRunning(config)
          const healthy = await isServerRunning(config)
          if (!healthy) {
            throw new Error("Health verification failed after restart.")
          }

          await getMemoryClient(config)
          const afterStart = await getServerRuntimeStatus(config)

          return JSON.stringify({
            ok: true,
            action: "restart",
            transport,
            url,
            running: true,
            restarted: !afterStop.running,
            serverReusedDueToOtherHolders: afterStop.running && afterStop.holderCount > 0,
            before,
            afterStop,
            afterStart,
            message: "Restart completed and MCP client reconnected.",
          })
        } catch (err) {
          return JSON.stringify({
            ok: false,
            action: "restart",
            transport,
            url: getServerUrl(config),
            error: String(err),
            ...(before ? { before } : {}),
            ...(afterStop ? { afterStop } : {}),
          })
        }
      },
    }),
  }

  return tools
}
