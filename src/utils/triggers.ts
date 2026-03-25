/**
 * Smart trigger detection utilities for prompting agent to use memory tools.
 */

export interface TriggerResult {
  triggered: boolean
  type: "decision" | "new_task" | "error_context" | null
  message: string
}

// Track recent nudges to avoid spam
const recentNudges = new Map<
  string,
  { type: string; timestamp: number }
>()

const NUDGE_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes cooldown per trigger type

function shouldTrigger(sessionID: string, type: string): boolean {
  const key = `${sessionID}:${type}`
  const lastNudge = recentNudges.get(key)

  if (!lastNudge) return true

  const elapsed = Date.now() - lastNudge.timestamp
  return elapsed > NUDGE_COOLDOWN_MS
}

function recordNudge(sessionID: string, type: string): void {
  const key = `${sessionID}:${type}`
  recentNudges.set(key, { type, timestamp: Date.now() })
}

/**
 * Detect if text contains architectural decisions or choices.
 */
function detectDecisionPoint(text: string): boolean {
  const patterns = [
    /\b(decide|decided|choose|chose|go with|settled on|opt for|will use)\b/i,
    /\b(architecture|approach|strategy|solution)\s+(?:is|will be|should be)\b/i,
    /(?:决定|选择|方案|采用)\s*(?:使用|选择|采用)/,
    /\b(let's|we should|I will)\s+(?:use|go with|implement|choose)\b/i,
    /\b(better to|prefer|recommend)\s+(?:use|go with)\b/i,
  ]
  return patterns.some((p) => p.test(text))
}

/**
 * Detect if text indicates starting a new task or feature.
 */
function detectNewTaskIntent(text: string): boolean {
  const patterns = [
    /\b(implement|build|develop|set up)\s+(?:a\s+|an?\s+|the\s+)?(?:new\s+)?\w{4,}/i,
    /\b(let's|please|can you)\s+(implement|create|build|develop)\b/i,
    /\b(start|begin)\s+(?:working\s+)?(?:on\s+)?(?:the|a|new)?\s*(?:task|feature|project|component|module|service)\b/i,
    /\bcreate\s+(?:a\s+|an?\s+|the\s+)(?:new\s+)?\w{4,}/i,
  ]
  return patterns.some((p) => p.test(text))
}

/**
 * Detect if messages contain error or debugging context.
 */
function detectErrorContext(text: string): boolean {
  const patterns = [
    /\b(error|exception|crash|bug)\b/i,
    /\b(fail|failed)\s+(?:to|when|with|on|during)\b/i,
    /\b(debug|troubleshoot)\s+(?:the|this|a|an)\b/i,
    /\b(not working|doesn't work|is broken|is crashing)\b/i,
    /\b(stack trace|error message|exception thrown|traceback)\b/i,
  ]
  return patterns.some((p) => p.test(text))
}

/**
 * Check all triggers and return the highest priority nudge.
 * Priority: decision > new_task > error_context
 */
export function checkTriggers(
  sessionID: string,
  agentText: string,
  userText: string,
): TriggerResult {
  // Check decision trigger (highest priority)
  if (detectDecisionPoint(agentText) && shouldTrigger(sessionID, "decision")) {
    recordNudge(sessionID, "decision")
    return {
      triggered: true,
      type: "decision",
      message:
        "[MEMORY NUDGE] 💡 You just made a decision. Consider storing it with store_memory using DECISION prefix — include alternatives you considered.",
    }
  }

  // Check new task trigger
  if (detectNewTaskIntent(userText) && shouldTrigger(sessionID, "new_task")) {
    recordNudge(sessionID, "new_task")
    return {
      triggered: true,
      type: "new_task",
      message:
        "[MEMORY NUDGE] 🚀 Starting a new task? Consider calling recall() to find relevant context and past decisions first.",
    }
  }

  // Check error context trigger
  if (detectErrorContext(userText) && shouldTrigger(sessionID, "error")) {
    recordNudge(sessionID, "error")
    return {
      triggered: true,
      type: "error_context",
      message:
        "[MEMORY NUDGE] 🔍 An error was mentioned. Consider searching memory for BUGFIX entries before debugging.",
    }
  }

  return { triggered: false, type: null, message: "" }
}

/**
 * Clear nudge history for a session (e.g., after compaction).
 */
export function clearNudgeHistory(sessionID: string): void {
  for (const key of recentNudges.keys()) {
    if (key.startsWith(`${sessionID}:`)) {
      recentNudges.delete(key)
    }
  }
}
