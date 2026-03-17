import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { loadConfig } from "./config.js"
import {
  shouldInjectMemories,
  markSessionInjected,
  fetchAndFormatMemories,
} from "./services/context-inject.js"
import { performAutoCapture } from "./services/auto-capture.js"
import { buildCompactionRecoveryContext } from "./services/compaction.js"
import { recall, searchMemory, storeMemory, listMemories } from "./services/mcp-client.js"
import { summarizeExchange } from "./services/llm-client.js"
import { detectMemoryKeyword, MEMORY_NUDGE_MESSAGE } from "./utils/keywords.js"
import { stripPrivateContent, isFullyPrivate } from "./utils/privacy.js"
import { initLogger, logger } from "./utils/logger.js"
import {
  trackMessageTokens,
  shouldTriggerCompaction,
  performPreemptiveCompaction,
  resetSessionState,
} from "./services/preemptive-compaction.js"
import type { PluginConfig } from "./config.js"

const plugin: Plugin = async (input) => {
  const config = loadConfig(input.directory)
  initLogger(input.client)
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const compactedSessions = new Set<string>()

  return {
    "chat.message": async (hookInput, output) => {
      const isAfterCompaction = compactedSessions.has(hookInput.sessionID)
      if (isAfterCompaction) {
        compactedSessions.delete(hookInput.sessionID)
      }

      const userText = extractUserText(output)

      if (config.keywordDetection.enabled && userText) {
        const extraPatterns = config.keywordDetection.extraPatterns.map((p) => new RegExp(p, "i"))
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

      if (!shouldInjectMemories(config, hookInput.sessionID, isAfterCompaction)) {
        return
      }

      if (!userText) return

      const formatted = await fetchAndFormatMemories(config, userText)
      if (!formatted) return

      const syntheticPart = {
        id: `prt-memory-context-${Date.now()}`,
        sessionID: hookInput.sessionID,
        messageID: output.message.id || `msg-memory-fallback-${Date.now()}`,
        type: "text" as const,
        text: formatted,
        synthetic: true,
      }

      output.parts.unshift(syntheticPart as any)
      markSessionInjected(hookInput.sessionID)
    },

    event: async (eventInput) => {
      const event = eventInput.event as any

      if (event.type === "session.idle" && config.autoCapture.enabled) {
        const sessionID = event.properties?.sessionID
        if (!sessionID) return

        const existingTimer = idleTimers.get(sessionID)
        if (existingTimer) clearTimeout(existingTimer)

        const timer = setTimeout(async () => {
          idleTimers.delete(sessionID)
          await handleIdleCapture(config, input, sessionID)
        }, config.autoCapture.debounceMs)

        idleTimers.set(sessionID, timer)
      }

      if (event.type === "session.compacted" && config.compaction.enabled) {
        const sessionID = event.properties?.sessionID
        if (!sessionID) return

        compactedSessions.add(sessionID)
        resetSessionState(sessionID)
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

    tool: {
      memory: tool({
        description:
          "Search, store, or list project memories. Modes: search <query>, store <content>, list [limit]",
        args: {
          mode: tool.schema.enum(["search", "store", "list"]),
          query: tool.schema.string().optional(),
          content: tool.schema.string().optional(),
          limit: tool.schema.number().optional(),
        },
        execute: async (args) => {
          switch (args.mode) {
            case "search": {
              if (!args.query) return "Error: query is required for search mode"
              const results = await recall(config, args.query, args.limit ?? 10)
              if (results.length === 0) return "No memories found."
              return results.map((m) => `- ${m.content}`).join("\n")
            }
            case "store": {
              if (!args.content) return "Error: content is required for store mode"
              let content = args.content
              if (config.privacy.enabled) {
                content = stripPrivateContent(content)
                if (isFullyPrivate(content)) {
                  return "Content is entirely private — nothing to store."
                }
              }
              const ok = await storeMemory(config, content)
              return ok ? "Memory stored successfully." : "Failed to store memory."
            }
            case "list": {
              const results = await listMemories(config, args.limit ?? 10)
              if (results.length === 0) return "No memories found."
              return results.map((m) => `- [${m.memory_type ?? "unknown"}] ${m.content}`).join("\n")
            }
            default:
              return "Unknown mode. Use: search, store, or list."
          }
        },
      }),
    },
  }
}

function extractUserText(output: { parts: Array<{ type: string; text?: string }> }): string | null {
  const textParts = output.parts.filter(
    (p) => p.type === "text" && p.text && !(p as any).synthetic,
  )
  const text = textParts.map((p) => p.text!).join("\n")
  return text.length >= 10 ? text : null
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
  if (!config.captureModel.apiKey) return

  try {
    const messagesResponse = await input.client.session.messages({
      path: { id: sessionID },
    })

    if (!messagesResponse.data) return

    const messages = messagesResponse.data as any[]

    const callLLM = (prompt: string) => summarizeExchange(config, prompt)

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

export default plugin
