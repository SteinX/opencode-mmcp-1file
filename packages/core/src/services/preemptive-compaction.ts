import type { PluginConfig } from "../config.js"
import { recall } from "./mcp-client.js"
import { logger } from "../utils/logger.js"
import { formatMemoriesForInjection } from "../utils/format.js"

interface CompactionState {
  estimatedTokens: number
  lastCompactionTime: number
  compactionInProgress: boolean
}

const sessionStates = new Map<string, CompactionState>()
const summarizedSessions = new Set<string>()

const COMPACTION_COOLDOWN_MS = 30_000
const MIN_TOKENS_FOR_COMPACTION = 50_000

function getState(sessionID: string): CompactionState {
  let state = sessionStates.get(sessionID)
  if (!state) {
    state = {
      estimatedTokens: 0,
      lastCompactionTime: 0,
      compactionInProgress: false,
    }
    sessionStates.set(sessionID, state)
  }
  return state
}

// ~4 chars/token for English, ~2 chars/token for CJK
function estimateTokens(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) ?? []).length
  const nonCjk = text.length - cjkChars
  return Math.ceil(nonCjk / 4 + cjkChars / 2)
}

export function trackMessageTokens(sessionID: string, textContent: string): void {
  const state = getState(sessionID)
  state.estimatedTokens += estimateTokens(textContent)
}

export function shouldTriggerCompaction(
  config: PluginConfig,
  sessionID: string,
  modelContextLimit: number,
): boolean {
  const state = getState(sessionID)

  if (state.compactionInProgress) return false
  if (summarizedSessions.has(sessionID)) return false
  if (state.estimatedTokens < MIN_TOKENS_FOR_COMPACTION) return false

  const threshold = modelContextLimit * (config.preemptiveCompaction.thresholdPercent / 100)
  if (state.estimatedTokens < threshold) return false

  const now = Date.now()
  if (now - state.lastCompactionTime < COMPACTION_COOLDOWN_MS) return false

  return true
}

export async function performPreemptiveCompaction(
  config: PluginConfig,
  client: any,
  sessionID: string,
): Promise<boolean> {
  const state = getState(sessionID)
  state.compactionInProgress = true

  try {
    const memories = await recall(config, "current work context and active tasks", 10)

    if (memories.length > 0) {
      const memoryContext = formatMemoriesForInjection(memories)
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [
            {
              type: "text" as const,
              text: `[COMPACTION CONTEXT] The following memories should be preserved during summarization:\n\n${memoryContext}`,
              synthetic: true,
            } as any,
          ],
          noReply: true,
        },
      })
    }

    await client.session.summarize({
      path: { id: sessionID },
    })

    state.lastCompactionTime = Date.now()
    state.estimatedTokens = 0
    summarizedSessions.add(sessionID)

    return true
  } catch (err) {
    logger.error("preemptive compaction failed", { sessionID, error: String(err) })
    return false
  } finally {
    state.compactionInProgress = false
  }
}

export function resetSessionState(sessionID: string): void {
  summarizedSessions.delete(sessionID)
  sessionStates.delete(sessionID)
}
