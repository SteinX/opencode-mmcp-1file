import type { PluginConfig } from "../config.js"
import { storeMemory } from "./mcp-client.js"
import { stripPrivateContent, isFullyPrivate } from "../utils/privacy.js"

interface SessionMessages {
  info: { id: string; role: string }
  parts: Array<{ type: string; text?: string }>
}

const lastCapturedMessageId = new Map<string, string>()

export function getLastCapturedId(sessionID: string): string | undefined {
  return lastCapturedMessageId.get(sessionID)
}

export async function performAutoCapture(
  config: PluginConfig,
  sessionID: string,
  messages: SessionMessages[],
  callLLM: (prompt: string) => Promise<string>,
): Promise<boolean> {
  const lastCaptured = lastCapturedMessageId.get(sessionID)

  let startIdx = 0
  if (lastCaptured) {
    const idx = messages.findIndex((m) => m.info.id === lastCaptured)
    if (idx >= 0) startIdx = idx + 1
  }

  const uncapturedMessages = messages.slice(startIdx)
  if (uncapturedMessages.length < 2) return false

  const userMessages = uncapturedMessages.filter((m) => m.info.role === "user")
  const assistantMessages = uncapturedMessages.filter((m) => m.info.role === "assistant")

  if (userMessages.length === 0 || assistantMessages.length === 0) return false

  const lastUserMsg = userMessages[userMessages.length - 1]
  const userText = lastUserMsg.parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n")

  const assistantText = assistantMessages
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n")
    .slice(0, 2000)

  const toolCalls = assistantMessages
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "tool")
    .slice(0, 10)

  const toolSummary = toolCalls.length > 0
    ? `\nTools used: ${toolCalls.length} tool call(s)`
    : ""

  const llmPrompt = buildSummarizationPrompt(userText, assistantText, toolSummary, config.autoCapture.language)

  try {
    const raw = await callLLM(llmPrompt)
    const parsed = parseStructuredOutput(raw)

    if (parsed.prefix === "SKIP") return false

    let content = `${parsed.prefix} ${parsed.summary}`

    if (config.privacy.enabled) {
      content = stripPrivateContent(content)
      if (isFullyPrivate(content)) return false
    }

    const stored = await storeMemory(config, content, parsed.memoryType)

    if (stored) {
      const lastMsg = uncapturedMessages[uncapturedMessages.length - 1]
      lastCapturedMessageId.set(sessionID, lastMsg.info.id)
    }

    return stored
  } catch {
    return false
  }
}

function buildSummarizationPrompt(
  userText: string,
  assistantText: string,
  toolSummary: string,
  language: string,
): string {
  return `You are a memory extraction system. Analyze this conversation exchange and produce a structured JSON output.

User Request:
${userText.slice(0, 500)}

AI Response (excerpt):
${assistantText.slice(0, 1000)}
${toolSummary}

Output a JSON object with exactly these fields:
- "summary": A concise summary (1-3 sentences, max 200 chars) of the key knowledge gained. Language: ${language}
- "prefix": One of: "DECISION:", "TASK:", "PATTERN:", "BUGFIX:", "CONTEXT:", "RESEARCH:", "PROJECT:", "EPIC:", "USER:", "SKIP"
  Use "SKIP" if the exchange is trivial (greetings, simple questions, non-technical).
- "memory_type": One of: "semantic" (facts, decisions), "episodic" (events, tasks), "procedural" (patterns, how-to)
- "tags": Array of 1-3 relevant tags (e.g., ["auth", "react", "migration"])

Respond with ONLY the JSON object, no markdown fences.`
}

interface CaptureResult {
  summary: string
  prefix: string
  memoryType: string
  tags: string[]
}

function parseStructuredOutput(raw: string): CaptureResult {
  const cleaned = raw.replace(/```json?\n?/g, "").replace(/```\n?/g, "").trim()
  try {
    const parsed = JSON.parse(cleaned)
    return {
      summary: parsed.summary ?? "",
      prefix: parsed.prefix ?? "SKIP",
      memoryType: parsed.memory_type ?? "semantic",
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    }
  } catch {
    return { summary: "", prefix: "SKIP", memoryType: "semantic", tags: [] }
  }
}
