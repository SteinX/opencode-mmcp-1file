import type { PluginConfig } from "../config.js"
import { callChatCompletion } from "./llm-client.js"
import type { LearningMemoryCandidate } from "./preference-learning.js"

export type LessonKind = "project_lesson" | "project_pattern" | "project_pitfall"

interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

type LlmCaller = (config: PluginConfig, messages: ChatMessage[]) => Promise<string>

interface RawLessonCandidate {
  kind?: unknown
  content?: unknown
  confidence?: unknown
  importance?: unknown
  evidence?: unknown
}

const VALID_KINDS = new Set<string>(["project_lesson", "project_pattern", "project_pitfall"])

export function buildLessonExtractionPrompt(text: string): ChatMessage[] {
  const systemPrompt = [
    "You extract project lessons, patterns, and pitfalls from session or compaction text.",
    "Return strict JSON only (no markdown, no prose).",
    "Output MUST be a JSON array.",
    "Each array item MUST contain:",
    '- "kind": one of "project_lesson", "project_pattern", "project_pitfall"',
    '- "content": concise statement string',
    '- "confidence": number in [0,1] — how certain you are this is a real lesson',
    '- "importance": number in [0,1] — how valuable this is to remember',
    'Optional: "evidence" (string) — brief supporting quote or context',
    "If no lessons are present, return [] exactly.",
    "",
    "Definitions:",
    "- project_lesson: a concrete takeaway from something that happened (e.g. 'Always run tests before merging')",
    "- project_pattern: a recurring approach or convention in this project (e.g. 'Use kebab-case for file names')",
    "- project_pitfall: a mistake or trap to avoid (e.g. 'Do not import from dist/ in source files')",
  ].join("\n")

  const userPrompt = ["Session/compaction text:", text].join("\n")

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]
}

function normalizeRawLesson(raw: RawLessonCandidate): {
  kind: LessonKind
  content: string
  confidence: number
  importance: number
  evidence?: string
} | null {
  if (!raw || typeof raw !== "object") return null

  const kind = typeof raw.kind === "string" ? raw.kind : ""
  if (!VALID_KINDS.has(kind)) return null

  const content = typeof raw.content === "string" ? raw.content.trim() : ""
  if (!content) return null

  const confidence = typeof raw.confidence === "number" ? raw.confidence : Number.NaN
  const importance = typeof raw.importance === "number" ? raw.importance : Number.NaN
  if (Number.isNaN(confidence) || Number.isNaN(importance)) return null

  const evidence = typeof raw.evidence === "string" ? raw.evidence.trim() || undefined : undefined

  return { kind: kind as LessonKind, content, confidence, importance, evidence }
}

export function parseLessonCandidates(
  rawResponse: string,
  options: { minConfidence: number; minImportance: number },
): LearningMemoryCandidate[] {
  const cleaned = rawResponse
    .replace(/```json\n?/gi, "")
    .replace(/```\n?/g, "")
    .trim()

  if (!cleaned) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) return []

  const candidates: LearningMemoryCandidate[] = []
  for (const item of parsed) {
    const normalized = normalizeRawLesson(item as RawLessonCandidate)
    if (!normalized) continue

    if (normalized.confidence < options.minConfidence) continue
    if (normalized.importance < options.minImportance) continue

    candidates.push({
      kind: normalized.kind,
      content: normalized.content,
      confidence: normalized.confidence,
      importance: normalized.importance,
      source: "lesson-learning",
      evidence: normalized.evidence,
    })
  }

  return candidates
}

export async function extractLessonCandidates(
  config: PluginConfig,
  text: string,
  llmCaller: LlmCaller = callChatCompletion,
): Promise<LearningMemoryCandidate[]> {
  if (!text.trim()) return []

  const messages = buildLessonExtractionPrompt(text)

  try {
    const raw = await llmCaller(config, messages)
    return parseLessonCandidates(raw, {
      minConfidence: 0.5,
      minImportance: 0.4,
    })
  } catch {
    return []
  }
}
