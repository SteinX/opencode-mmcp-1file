import { existsSync, mkdirSync, copyFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig, resolveDataDir } from "./config.js"
import {
  shouldInjectMemories,
  markSessionInjected,
  fetchAndFormatMemories,
  fetchCodeIntelContext,
  fetchProjectKnowledge,
  shouldInjectQueryRecall,
  shouldInjectProjectKnowledge,
  shouldInjectCodeIntel,
  type InjectionSource,
} from "./services/context-inject.js"
import { performAutoCapture } from "./services/auto-capture.js"
import { buildCompactionRecoveryContext } from "./services/compaction.js"
import { getMemoryClient, storeMemory, disconnectMemoryClient, tryReconnect } from "./services/mcp-client.js"
import { isConnectionFailed, startRetryLoop, stopRetryLoop } from "./services/connection-state.js"
import { summarizeExchange } from "./services/llm-client.js"
import { callSessionLLM } from "./services/session-llm.js"
import { detectMemoryKeyword, MEMORY_NUDGE_MESSAGE } from "./utils/keywords.js"
import { checkTriggers, clearNudgeHistory } from "./utils/triggers.js"
import { stripPrivateContent, isFullyPrivate } from "./utils/privacy.js"
import { initLogger, logger } from "./utils/logger.js"
import {
  trackMessageTokens,
  shouldTriggerCompaction,
  performPreemptiveCompaction,
  resetSessionState,
} from "./services/preemptive-compaction.js"

import { buildMemorySystemPrompt } from "./services/system-prompt.js"
import { buildToolRegistry } from "./services/tool-registry.js"
import { ensureCodeIndexFresh, resetCodeIndexSyncState } from "./services/code-index-sync.js"
import type { PluginConfig } from "./config.js"

const plugin: Plugin = async (input) => {
  const config = loadConfig(input.directory)
  initLogger(input.client)

  // Check if plugin is enabled (requires tag or dataDir)
  const dataDir = resolveDataDir(config)
  if (!dataDir) {
    logger.warn("Plugin disabled: no tag or dataDir configured")
    return {}
  }

  void (async () => {
    try {
      await getMemoryClient(config)
      const tag = config.mcpServer.tag
      let connLabel: string
      if (config.mcpServer.transport === "http") {
        const endpoint = `${config.mcpServer.bind}:${config.mcpServer.port}`
        connLabel = tag ? `${endpoint} · ${tag}` : endpoint
      } else {
        connLabel = tag || "custom"
      }
      logger.info(`Memory server connected (${connLabel})`)
      // Brief delay so the TUI is ready to display toasts — without this,
      // fast HTTP connections (joining an already-running server) finish
      // before the UI is initialised and the toast is silently dropped.
      await new Promise((r) => setTimeout(r, 1500))
      await input.client.tui.showToast({
        body: {
          message: `Memory server connected (${connLabel})`,
          variant: "success",
          duration: 3000,
        },
      })
    } catch (err) {
      logger.error("Memory server connection failed", { error: String(err) })
      await new Promise((r) => setTimeout(r, 1500))
      await input.client.tui.showToast({
        body: {
          message: "Memory server failed to connect — retrying in background",
          variant: "error",
          duration: 5000,
        },
      })
      startRetryLoop(
        () => tryReconnect(config),
        30_000,
        () => {
          void input.client.tui.showToast({
            body: {
              message: "Memory server reconnected!",
              variant: "success",
              duration: 5000,
            },
          })
        },
      )
    }
  })()

  void ensureCodeIndexFresh(config, input.directory, "startup")

  installCommand()

  const toolRegistry = buildToolRegistry(config, input.directory)
  const availablePluginTools = Object.keys(toolRegistry)

  const cleanup = async () => {
    resetCodeIndexSyncState()
    stopRetryLoop()
    await disconnectMemoryClient(config)
  }
  process.on("SIGTERM", () => void cleanup())
  process.on("SIGINT", () => void cleanup())

  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const capturedSessions = new Set<string>()
  const compactedSessions = new Set<string>()

  return {
    "chat.message": async (hookInput, output) => {
      // Reset auto-capture guard so next idle can capture new exchange
      capturedSessions.delete(hookInput.sessionID)

      const isAfterCompaction = compactedSessions.has(hookInput.sessionID)
      if (isAfterCompaction) {
        compactedSessions.delete(hookInput.sessionID)
      }

      const userText = extractUserText(output)

      if (config.keywordDetection.enabled && userText) {
        const extraPatterns = config.keywordDetection.extraPatterns.flatMap((pattern) => {
          try {
            return [new RegExp(pattern, "i")]
          } catch (err) {
            logger.warn("Ignoring invalid keywordDetection.extraPatterns entry", {
              pattern,
              error: String(err),
            })
            return []
          }
        })
        const matched = detectMemoryKeyword(userText, extraPatterns)
        if (matched) {
          output.parts.push({
            id: `prt-memory-nudge-${Date.now()}`,
            sessionID: hookInput.sessionID,
            messageID: output.message.id || `msg-memory-fallback-${Date.now()}`,
            type: "text" as const,
            text: MEMORY_NUDGE_MESSAGE,
            synthetic: true,
          } as any)
        }
      }

      if (userText) {
        const messageText = extractMessageText(output) || ""
        const trigger = checkTriggers(hookInput.sessionID, messageText, userText)
        if (trigger.triggered) {
          output.parts.push({
            id: `prt-smart-nudge-${Date.now()}`,
            sessionID: hookInput.sessionID,
            messageID: output.message.id || `msg-memory-fallback-${Date.now()}`,
            type: "text" as const,
            text: trigger.message,
            synthetic: true,
          } as any)
        }
      }

      if (!shouldInjectMemories(config, hookInput.sessionID, isAfterCompaction)) {
        return
      }

      if (!userText) return

      const formattedPromise = shouldInjectQueryRecall(config, hookInput.sessionID, isAfterCompaction)
        ? fetchAndFormatMemories(config, userText)
        : Promise.resolve(null)
      const projectKnowledgePromise = shouldInjectProjectKnowledge(config, hookInput.sessionID, isAfterCompaction)
        ? fetchProjectKnowledge(config)
        : Promise.resolve(null)
      const codeIntelPromise = shouldInjectCodeIntel(config, hookInput.sessionID, isAfterCompaction)
        ? fetchCodeIntelContext(config)
        : Promise.resolve(null)

      const [formatted, projectKnowledge, codeIntelContext] = await Promise.all([
        formattedPromise,
        projectKnowledgePromise,
        codeIntelPromise,
      ])

      let injected = false
      const injectedSources: InjectionSource[] = []

      if (formatted) {
        const syntheticPart = {
          id: `prt-memory-context-${Date.now()}`,
          sessionID: hookInput.sessionID,
          messageID: output.message.id || `msg-memory-fallback-${Date.now()}`,
          type: "text" as const,
          text: formatted,
          synthetic: true,
        }

        output.parts.unshift(syntheticPart as any)
        injected = true
        injectedSources.push("query_recall")
      }

      if (projectKnowledge) {
        output.parts.push({
          id: `prt-project-knowledge-${Date.now()}`,
          sessionID: hookInput.sessionID,
          messageID: output.message.id || `msg-memory-fallback-${Date.now()}`,
          type: "text" as const,
          text: projectKnowledge,
          synthetic: true,
        } as any)
        injected = true
        injectedSources.push("project_knowledge")
      }

      if (codeIntelContext) {
        output.parts.push({
          id: `prt-code-intel-${Date.now()}`,
          sessionID: hookInput.sessionID,
          messageID: output.message.id || `msg-memory-fallback-${Date.now()}`,
          type: "text" as const,
          text: codeIntelContext,
          synthetic: true,
        } as any)
        injected = true
        injectedSources.push("code_intel")
      }

      if (!injected) return

      markSessionInjected(hookInput.sessionID, injectedSources)
    },

    event: async (eventInput) => {
      const event = eventInput.event as any

      if (event.type === "session.idle" && config.autoCapture.enabled) {
        const sessionID = event.properties?.sessionID
        if (!sessionID) return
        if (capturedSessions.has(sessionID)) return

        const existingTimer = idleTimers.get(sessionID)
        if (existingTimer) clearTimeout(existingTimer)

        const timer = setTimeout(async () => {
          idleTimers.delete(sessionID)
          capturedSessions.add(sessionID)
          await handleIdleCapture(config, input, sessionID)
        }, config.autoCapture.debounceMs)

        idleTimers.set(sessionID, timer)
      }

      if (event.type === "session.idle") {
        void ensureCodeIndexFresh(config, input.directory, "session.idle")
      }

      if (event.type === "session.compacted" && config.compaction.enabled) {
        const sessionID = event.properties?.sessionID
        if (!sessionID) return

        compactedSessions.add(sessionID)
        resetSessionState(sessionID)
        clearNudgeHistory(sessionID)
        await handleCompactionRecovery(config, input, sessionID)
      }

      if (event.type === "message.updated" && config.preemptiveCompaction.enabled) {
        const sessionID = event.properties?.sessionID
        if (!sessionID) return

        const messageText = extractEventMessageText(event)
        if (messageText) {
          trackMessageTokens(sessionID, messageText)
        }

        if (shouldTriggerCompaction(config, sessionID, config.preemptiveCompaction.modelContextLimit)) {
          const compacted = await performPreemptiveCompaction(config, input.client, sessionID)
          if (compacted) {
            await input.client.tui.showToast({
              body: {
                message: "Context reaching limit — preemptive compaction triggered",
                variant: "warning",
                duration: 5000,
              },
            })

            if (config.preemptiveCompaction.autoContinue) {
              try {
                await input.client.session.prompt({
                  path: { id: sessionID },
                  body: {
                    parts: [{ type: "text" as const, text: "Continue" } as any],
                  },
                })
              } catch (err) {
                logger.warn("auto-continue prompt failed", { sessionID, error: String(err) })
              }
            }
          }
        }

        if (config.compactionSummaryCapture.enabled) {
          const info = event.properties?.info
          if (info?.summary === true && info?.finish) {
            await captureCompactionSummary(config, input, sessionID)
          }
        }
      }
    },

    "experimental.chat.system.transform": async (_hookInput, output) => {
      if (!config.systemPrompt.enabled) return
      const promptText = buildMemorySystemPrompt(config, availablePluginTools, !isConnectionFailed())
      output.system.push(promptText)
    },

    "tool.definition": async (hookInput, output) => {
      const toolID = hookInput.toolID.toLowerCase()
      const serverName = config.mcpServer.mcpServerName.toLowerCase()
      if (!toolID.includes(serverName) && !toolID.includes("memory")) return

      const TOOL_HINTS: Record<string, string> = {
        store_memory:
          "\n\nPrefer the unified `memory_save` tool. If you call this raw MCP tool directly, prefix content with DECISION:, TASK:, PATTERN:, BUGFIX:, CONTEXT:, RESEARCH:, or USER: for categorization.",
        recall:
          "\n\nPrefer the unified `memory_query` tool for general context retrieval. This raw MCP tool performs hybrid search (semantic + keyword + knowledge graph).",
        invalidate:
          "\n\nPrefer the unified `memory_manage` tool when information becomes outdated. Provide replacement_id to link to the updated entry.",
        // Code Intelligence hints
        index_project:
          "\n\nPrefer `project_status(action: \"index\")` from the unified tool registry. This raw MCP tool is mainly for initial indexing, manual recovery, or stale-index repair.",
        recall_code:
          "\n\nPrefer `code_search(search_type: \"intent\")` for intent-based semantic code search. Requires the project to be indexed.",
        search_symbols:
          "\n\nPrefer `code_search(search_type: \"symbol\")`. Results include symbol_id values that can be passed to `code_search` caller/callee modes. Requires the project to be indexed.",
        symbol_graph:
          "\n\nPrefer `code_search(search_type: \"callers\" | \"callees\" | \"related\")`. The symbol_id parameter comes from symbol lookup results.",
        project_info:
          "\n\nPrefer `project_status(action: \"list\" | \"stats\")` to inspect indexing state and project statistics.",
      }

      const sortedHints = Object.entries(TOOL_HINTS).sort(
        ([a], [b]) => b.length - a.length,
      )
      for (const [toolName, hint] of sortedHints) {
        if (toolID.includes(toolName)) {
          output.description += hint
          break
        }
      }
    },

    "experimental.session.compacting": async (_hookInput, output) => {
      if (!config.compaction.enabled) return
      const recovery = await buildCompactionRecoveryContext(config)
      if (recovery) {
        output.context.push(recovery.text)
      }
    },

    "tool.execute.before": async (hookInput, output) => {
      if (!config.privacy.enabled) return
      const toolName = hookInput.tool.toLowerCase()
      if (!toolName.includes("store_memory") && !toolName.includes("update_memory")) return

      const content = output.args?.content
      if (typeof content !== "string") return

      if (isFullyPrivate(content)) {
        output.args.content = "[REDACTED — fully private content]"
        return
      }
      output.args.content = stripPrivateContent(content)
    },

    tool: toolRegistry,
  }
}

function extractUserText(output: { parts: Array<{ type: string; text?: string }> }): string | null {
  const text = extractMessageText(output)
  return text && text.trim().length > 0 ? text : null
}

function extractMessageText(output: { parts: Array<{ type: string; text?: string }> }): string | null {
  const textParts = output.parts.filter(
    (p) => p.type === "text" && p.text && !(p as any).synthetic,
  )
  const text = textParts.map((p) => p.text!).join("\n")
  return text.trim().length > 0 ? text : null
}

function extractEventMessageText(event: any): string | null {
  try {
    const parts = event.properties?.parts
    if (!Array.isArray(parts)) return null
    return parts
      .filter((p: any) => p.type === "text" && p.text)
      .map((p: any) => p.text)
      .join("\n") || null
  } catch (err) {
    logger.debug("failed to extract event message text", { error: String(err) })
    return null
  }
}

async function handleIdleCapture(
  config: PluginConfig,
  input: Parameters<Plugin>[0],
  sessionID: string,
): Promise<void> {
  try {
    const messagesResponse = await input.client.session.messages({
      path: { id: sessionID },
    })

    if (!messagesResponse.data) return

    const messages = messagesResponse.data as any[]

    const callLLM = config.captureModel.apiKey
      ? (prompt: string) => summarizeExchange(config, prompt)
      : (prompt: string) => callSessionLLM(input.client as any, config, prompt, sessionID)

    const captured = await performAutoCapture(config, sessionID, messages, callLLM)

    if (captured) {
      await input.client.tui.showToast({
        body: {
          message: "Memory auto-captured",
          variant: "info",
          duration: 3000,
        },
      })
    }
  } catch (err) {
    logger.error("idle capture failed", { sessionID, error: String(err) })
  }
}

async function handleCompactionRecovery(
  config: PluginConfig,
  input: Parameters<Plugin>[0],
  sessionID: string,
): Promise<void> {
  try {
    const recovery = await buildCompactionRecoveryContext(config)
    if (!recovery) return

    await input.client.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [
          {
            type: "text" as const,
            text: recovery.text,
            synthetic: true,
          } as any,
        ],
        noReply: true,
      },
    })

    await input.client.tui.showToast({
      body: {
        message: `${recovery.count} memories restored after compaction`,
        variant: "success",
        duration: 5000,
      },
    })
  } catch (err) {
    logger.error("compaction recovery failed", { sessionID, error: String(err) })
  }
}

async function captureCompactionSummary(
  config: PluginConfig,
  input: Parameters<Plugin>[0],
  sessionID: string,
): Promise<void> {
  try {
    const messagesResponse = await input.client.session.messages({
      path: { id: sessionID },
    })

    if (!messagesResponse.data) return

    const messages = messagesResponse.data as any[]

    const summaryMsg = messages.find(
      (m: any) => m.info?.summary === true || m.info?.role === "assistant",
    )
    if (!summaryMsg) return

    const summaryText = summaryMsg.parts
      ?.filter((p: any) => p.type === "text" && p.text)
      ?.map((p: any) => p.text)
      ?.join("\n")

    if (!summaryText || summaryText.length < 50) return

    let content = `CONTEXT: Session compaction summary\n${summaryText.slice(0, 1800)}`

    if (config.privacy.enabled) {
      content = stripPrivateContent(content)
      if (isFullyPrivate(content)) return
    }

    await storeMemory(config, content, "episodic")
  } catch (err) {
    logger.error("compaction summary capture failed", { sessionID, error: String(err) })
  }
}

function installCommand(): void {
  try {
    const pluginDir = dirname(fileURLToPath(import.meta.url))
    const commandsDir = join(pluginDir, "..", "commands")
    const targetDir = join(homedir(), ".config", "opencode", "command")

    const commands = ["init-mcp-memory.md", "setup-mcp-memory.md"]
    const installed: string[] = []

    for (const cmd of commands) {
      const source = join(commandsDir, cmd)
      if (!existsSync(source)) continue
      const target = join(targetDir, cmd)
      if (existsSync(target)) continue
      mkdirSync(targetDir, { recursive: true })
      copyFileSync(source, target)
      installed.push(cmd.replace(".md", ""))
    }

    if (installed.length > 0) {
      logger.info(`Installed commands: ${installed.map((c) => `/${c}`).join(", ")}`)
    }
  } catch (err) {
    logger.debug("Command auto-install failed (manual copy available)", { error: String(err) })
  }
}

export default plugin
