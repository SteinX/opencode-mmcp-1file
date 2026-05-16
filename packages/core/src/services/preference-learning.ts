import type { PluginConfig } from "../config.js"
import type { MemoryOperationContext, RetrievalResult } from "./mcp-client.js"
import { callChatCompletion } from "./llm-client.js"
import { listProjectMemories, storeMemory } from "./mcp-client.js"
import { isFullyPrivate, stripPrivateContent } from "../utils/privacy.js"

export type PreferenceSignalType =
  | "explicit_preference"
  | "correction"
  | "negation"
  | "message_updated"

export interface LearningMemoryCandidate {
  kind: "user_preference" | "project_lesson" | "project_pattern" | "project_pitfall"
  content: string
  confidence: number
  importance: number
  source: string
  evidence?: string
}

export interface PreferenceSignal {
  signalType: PreferenceSignalType
  excerpt: string
  source?: string
  eventType?: string
}

export interface PreferenceCandidate {
  content: string
  confidence: number
  signalType: PreferenceSignalType
  status: "confirmed" | "candidate"
  rationale?: string
  category?: string
}

interface RawPreferenceCandidate {
  content?: unknown
  confidence?: unknown
  rationale?: unknown
  category?: unknown
}

export interface DetectPreferenceSignalContext {
  source?: string
  eventType?: string
}

interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

type LlmCaller = (config: PluginConfig, messages: ChatMessage[]) => Promise<string>
type PreferenceListFn = (
  config: PluginConfig,
  limit?: number,
  validOnly?: boolean,
  context?: MemoryOperationContext,
) => Promise<RetrievalResult>

type PreferenceStoreFn = (
  config: PluginConfig,
  content: string,
  memoryType?: string,
  context?: MemoryOperationContext,
) => Promise<boolean>

const EXPLICIT_PATTERNS: RegExp[] = [
  /\bi\s+(?:prefer|like|love|hate)\b/i,
  /\bmy\s+preference\s+is\b/i,
  /\bplease\s+(?:use|avoid)\b/i,
  /\b(?:always|never)\s+(?:use|do)\b/i,
  /\b我(?:更)?(?:喜欢|偏好|希望|不喜欢|讨厌)\b/u,
  /\b请(?:用|不要|别)\b/u,
]

const CORRECTION_PATTERNS: RegExp[] = [
  /\b(?:actually|instead|correction|to clarify|i meant)\b/i,
  /\bthat(?:'s| is)\s+(?:wrong|incorrect|not right)\b/i,
  /\b不是.*(?:是|应该是)\b/u,
  /\b我(?:的意思是|是说)\b/u,
]

const NEGATION_PATTERNS: RegExp[] = [
  /\b(?:don't|do not|never)\s+(?:want|use|do|suggest)\b/i,
  /\bi\s+(?:don't|do not)\s+like\b/i,
  /\bno\b[^.]{0,30}\b(?:that|this|thanks)\b/i,
  /\b不要\b/u,
  /\b别\b/u,
  /\b不想\b/u,
  /\b不需要\b/u,
]

const PREFERENCE_PREFIX = "USER — Preference:"
const GLOBAL_PREFERENCE_NAMESPACE = "global"
const preferenceStoreDebounceByScope = new Map<string, number>()
const preferenceInjectedSessions = new Set<string>()

export interface StorePreferenceCandidatesResult {
  stored: number
  skippedDuplicate: number
  skippedPrivate: number
  skippedThrottled: number
  skippedLimit: number
  failed: number
}

export interface StorePreferenceCandidatesDependencies {
  listFn?: PreferenceListFn
  storeFn?: PreferenceStoreFn
  nowMs?: number
}

export interface FetchLearnedPreferencesDependencies {
  listFn?: PreferenceListFn
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ")
}

function truncateInput(text: string, maxChars: number): string {
  if (maxChars <= 0) return ""
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars)
}

function normalizePreferenceContent(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase()
}

function formatStoredPreferenceContent(content: string): string {
  return `${PREFERENCE_PREFIX} ${content.trim()}`
}

function parseStoredPreferenceContent(content: string): string | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith(PREFERENCE_PREFIX)) return null

  const raw = trimmed.slice(PREFERENCE_PREFIX.length).trim()
  return raw || null
}

function applyPerCallPreferenceLimits(
  candidates: PreferenceCandidate[],
  options: Pick<PluginConfig["preferenceLearning"], "maxPreferences" | "maxCandidates">,
): { limited: PreferenceCandidate[]; skippedLimit: number } {
  const confirmed: PreferenceCandidate[] = []
  const tentative: PreferenceCandidate[] = []

  for (const candidate of candidates) {
    if (candidate.status === "confirmed") {
      confirmed.push(candidate)
    } else {
      tentative.push(candidate)
    }
  }

  const limitedConfirmed = confirmed.slice(0, Math.max(0, options.maxPreferences))
  const limitedCandidates = tentative.slice(0, Math.max(0, options.maxCandidates))

  return {
    limited: [...limitedConfirmed, ...limitedCandidates],
    skippedLimit: (confirmed.length - limitedConfirmed.length) + (tentative.length - limitedCandidates.length),
  }
}

function buildPreferenceScopeContext(
  config: PluginConfig,
  context?: MemoryOperationContext,
): MemoryOperationContext {
  if (config.preferenceLearning.scope === "global") {
    return {
      ...context,
      namespace: GLOBAL_PREFERENCE_NAMESPACE,
    }
  }

  return {
    ...context,
    namespace: context?.namespace,
  }
}

function buildPreferenceScopeKey(
  config: PluginConfig,
  context?: MemoryOperationContext,
): string {
  const namespace = config.preferenceLearning.scope === "global"
    ? GLOBAL_PREFERENCE_NAMESPACE
    : (context?.namespace ?? config.memoryScope.namespace ?? "")
  const userId = context?.userId ?? config.memoryScope.userId ?? ""
  return `${config.preferenceLearning.scope}:${namespace}:${userId}`
}

function buildCandidateMetadata(
  config: PluginConfig,
  candidate: PreferenceCandidate,
  context?: MemoryOperationContext,
): Record<string, unknown> {
  return {
    ...(context?.metadata ?? {}),
    kind: "preference_learning",
    status: candidate.status,
    signalType: candidate.signalType,
    confidence: candidate.confidence,
    ...(candidate.category ? { category: candidate.category } : {}),
    ...(config.preferenceLearning.scope ? { scope: config.preferenceLearning.scope } : {}),
  }
}

export function resetPreferenceLearningStoreStateForTests(): void {
  preferenceStoreDebounceByScope.clear()
  preferenceInjectedSessions.clear()
}

function normalizePreferenceStatus(value: unknown): "confirmed" | "candidate" | null {
  if (value === "confirmed" || value === "candidate") return value
  return null
}

function extractPreferenceStatus(memory: RetrievalResult["memories"][number]): "confirmed" | "candidate" {
  const metadata = (memory as { metadata?: unknown }).metadata
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const status = normalizePreferenceStatus((metadata as { status?: unknown }).status)
    if (status) return status
  }

  return "confirmed"
}

function formatLearnedPreferenceSection(title: string, hint: string, values: string[]): string | null {
  if (values.length === 0) return null

  return [
    `## ${title}`,
    hint,
    ...values.map((value) => `- ${value}`),
  ].join("\n")
}

export function shouldInjectLearnedPreferences(
  config: PluginConfig,
  sessionID: string,
  isAfterCompaction: boolean,
): boolean {
  if (config.learningMemory?.enabled === true) {
    return config.learningMemory.injection?.mode !== "manual"
  }

  if (!config.preferenceLearning.enabled) return false

  const mode = config.preferenceLearning.injectOn
  if (mode === "never") return false
  if (isAfterCompaction) return mode === "compaction" || mode === "always"
  if (mode === "compaction") return false
  if (mode === "always") return true

  return !preferenceInjectedSessions.has(sessionID)
}

export function markLearnedPreferencesInjected(sessionID: string): void {
  preferenceInjectedSessions.add(sessionID)
}

export function markLearnedPreferencesCompacted(sessionID: string): void {
  preferenceInjectedSessions.delete(sessionID)
}

export async function fetchAndFormatLearnedPreferences(
  config: PluginConfig,
  context?: MemoryOperationContext,
  dependencies?: FetchLearnedPreferencesDependencies,
): Promise<string | null> {
  if (!config.preferenceLearning.enabled) return null

  const listFn = dependencies?.listFn ?? listProjectMemories
  const scopeContext = buildPreferenceScopeContext(config, context)

  try {
    const result = await listFn(
      config,
      Math.max(1, config.preferenceLearning.maxStoredPreferences),
      false,
      scopeContext,
    )

    if (result.status !== "ok") return null

    const confirmed: string[] = []
    const candidates: string[] = []
    const seen = new Set<string>()

    for (const memory of result.memories) {
      const parsed = parseStoredPreferenceContent(memory.content)
      if (!parsed) continue

      const normalized = normalizePreferenceContent(parsed)
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)

      const status = extractPreferenceStatus(memory)
      if (status === "candidate") {
        if (candidates.length < config.preferenceLearning.maxCandidates) {
          candidates.push(parsed)
        }
      } else if (confirmed.length < config.preferenceLearning.maxPreferences) {
        confirmed.push(parsed)
      }

      if (
        confirmed.length >= config.preferenceLearning.maxPreferences
        && candidates.length >= config.preferenceLearning.maxCandidates
      ) {
        break
      }
    }

    if (confirmed.length === 0 && candidates.length === 0) return null

    const sections = [
      "[MEMORY] Learned User Preferences",
      formatLearnedPreferenceSection(
        "Confirmed Preferences",
        "Treat these as strong guidance from prior user signals:",
        confirmed,
      ),
      formatLearnedPreferenceSection(
        "Candidate Preferences",
        "Tentative hints only — validate before treating as hard rules:",
        candidates,
      ),
    ].filter(Boolean)

    return sections.join("\n\n")
  } catch {
    return null
  }
}

function firstMatchExcerpt(text: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[0]) {
      return match[0]
    }
  }
  return text.slice(0, 80)
}

function classifySignalType(
  normalizedText: string,
  options: PluginConfig["preferenceLearning"],
  context?: { eventType?: string },
): PreferenceSignalType | null {
  if (context?.eventType === "message.updated") {
    return options.learnOnMessageUpdated ? "message_updated" : null
  }

  if (
    options.learnOnCorrections
    && CORRECTION_PATTERNS.some((pattern) => pattern.test(normalizedText))
  ) {
    return "correction"
  }

  if (
    options.learnOnNegations
    && NEGATION_PATTERNS.some((pattern) => pattern.test(normalizedText))
  ) {
    return "negation"
  }

  if (EXPLICIT_PATTERNS.some((pattern) => pattern.test(normalizedText))) {
    return "explicit_preference"
  }

  return null
}

export function detectPreferenceSignal(
  text: string,
  options: PluginConfig["preferenceLearning"],
  context?: DetectPreferenceSignalContext,
): PreferenceSignal | null {
  const normalizedText = normalizeText(text)
  if (!normalizedText) return null

  const signalType = classifySignalType(normalizedText, options, {
    eventType: context?.eventType,
  })

  if (!signalType) return null

  const excerptPatterns =
    signalType === "correction"
      ? CORRECTION_PATTERNS
      : signalType === "negation"
        ? NEGATION_PATTERNS
        : EXPLICIT_PATTERNS

  return {
    signalType,
    excerpt: firstMatchExcerpt(normalizedText, excerptPatterns),
    source: context?.source,
    eventType: context?.eventType,
  }
}

export function buildPreferenceExtractionPrompt(
  text: string,
  signal: PreferenceSignal,
): ChatMessage[] {
  const systemPrompt = [
    "You extract user preferences from conversation text.",
    "Return strict JSON only (no markdown, no prose).",
    "Output MUST be a JSON array.",
    "Each array item MUST contain:",
    '- "content": concise preference statement string',
    '- "confidence": number in [0,1]',
    'Optional: "rationale" (string), "category" (string)',
    "If no preference is present, return [] exactly.",
  ].join("\n")

  const userPrompt = [
    `Signal type: ${signal.signalType}`,
    signal.excerpt ? `Signal excerpt: ${signal.excerpt}` : "",
    "Conversation text:",
    text,
  ]
    .filter(Boolean)
    .join("\n")

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]
}

function normalizeRawCandidate(raw: RawPreferenceCandidate): RawPreferenceCandidate | null {
  if (!raw || typeof raw !== "object") return null

  const content = typeof raw.content === "string" ? raw.content.trim() : ""
  const confidence = typeof raw.confidence === "number" ? raw.confidence : Number.NaN
  if (!content || Number.isNaN(confidence)) return null

  return {
    content,
    confidence,
    rationale: typeof raw.rationale === "string" ? raw.rationale : undefined,
    category: typeof raw.category === "string" ? raw.category : undefined,
  }
}

export function parsePreferenceCandidates(
  rawResponse: string,
  signalType: PreferenceSignalType,
  options: Pick<PluginConfig["preferenceLearning"], "minConfidence" | "candidateConfidence">,
): PreferenceCandidate[] {
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

  const candidates: PreferenceCandidate[] = []
  for (const item of parsed) {
    const normalized = normalizeRawCandidate(item as RawPreferenceCandidate)
    if (!normalized) continue

    const confidence = normalized.confidence as number
    if (confidence < options.candidateConfidence) continue

    const status: "confirmed" | "candidate" =
      confidence >= options.minConfidence ? "confirmed" : "candidate"

    candidates.push({
      content: normalized.content as string,
      confidence,
      signalType,
      status,
      rationale: normalized.rationale as string | undefined,
      category: normalized.category as string | undefined,
    })
  }

  return candidates
}

export async function extractPreferenceCandidates(
  config: PluginConfig,
  text: string,
  signal: PreferenceSignal,
  llmCaller: LlmCaller = callChatCompletion,
): Promise<LearningMemoryCandidate[]> {
  const truncated = truncateInput(text, config.preferenceLearning.maxInputChars)
  const messages = buildPreferenceExtractionPrompt(truncated, signal)

  try {
    const raw = await llmCaller(config, messages)
    const parsed = parsePreferenceCandidates(raw, signal.signalType, {
      minConfidence: config.preferenceLearning.minConfidence,
      candidateConfidence: config.preferenceLearning.candidateConfidence,
    })
    return parsed.map((c) => ({
      kind: "user_preference" as const,
      content: c.content,
      confidence: c.confidence,
      importance: c.status === "confirmed" ? 0.8 : 0.5,
      source: signal.source ?? "preference-learning",
      evidence: c.rationale,
    }))
  } catch {
    return []
  }
}

export async function storePreferenceCandidates(
  config: PluginConfig,
  candidates: PreferenceCandidate[],
  context?: MemoryOperationContext,
  dependencies?: StorePreferenceCandidatesDependencies,
): Promise<StorePreferenceCandidatesResult> {
  const result: StorePreferenceCandidatesResult = {
    stored: 0,
    skippedDuplicate: 0,
    skippedPrivate: 0,
    skippedThrottled: 0,
    skippedLimit: 0,
    failed: 0,
  }

  const { limited, skippedLimit } = applyPerCallPreferenceLimits(candidates, {
    maxPreferences: config.preferenceLearning.maxPreferences,
    maxCandidates: config.preferenceLearning.maxCandidates,
  })
  result.skippedLimit += skippedLimit

  if (limited.length === 0) return result

  const nowMs = dependencies?.nowMs ?? Date.now()
  const scopeKey = buildPreferenceScopeKey(config, context)
  const lastStoreMs = preferenceStoreDebounceByScope.get(scopeKey)
  if (lastStoreMs != null && nowMs - lastStoreMs < config.preferenceLearning.debounceMs) {
    result.skippedThrottled += limited.length
    return result
  }

  const scopeContext = buildPreferenceScopeContext(config, context)
  const listFn = dependencies?.listFn ?? listProjectMemories
  const storeFn = dependencies?.storeFn ?? storeMemory

  const existingResult = await listFn(
    config,
    Math.max(1, config.preferenceLearning.maxStoredPreferences),
    false,
    scopeContext,
  )

  const existingPreferenceSet = new Set<string>()
  let existingPreferenceCount = 0
  for (const memory of existingResult.memories) {
    const parsed = parseStoredPreferenceContent(memory.content)
    if (!parsed) continue
    existingPreferenceCount += 1
    existingPreferenceSet.add(normalizePreferenceContent(parsed))
  }

  const sameBatchSet = new Set<string>()
  let remainingCapacity = Math.max(0, config.preferenceLearning.maxStoredPreferences - existingPreferenceCount)

  for (const candidate of limited) {
    if (remainingCapacity <= 0) {
      result.skippedLimit += 1
      continue
    }

    if (isFullyPrivate(candidate.content)) {
      result.skippedPrivate += 1
      continue
    }

    const filteredContent = stripPrivateContent(candidate.content).trim()
    if (!filteredContent || isFullyPrivate(filteredContent)) {
      result.skippedPrivate += 1
      continue
    }

    const normalized = normalizePreferenceContent(filteredContent)
    if (!normalized || existingPreferenceSet.has(normalized) || sameBatchSet.has(normalized)) {
      result.skippedDuplicate += 1
      continue
    }

    const content = formatStoredPreferenceContent(filteredContent)
    const metadata = buildCandidateMetadata(config, candidate, scopeContext)
    const ok = await storeFn(config, content, "semantic", {
      ...scopeContext,
      metadata,
      memoryType: "semantic",
    })

    if (!ok) {
      result.failed += 1
      continue
    }

    result.stored += 1
    remainingCapacity -= 1
    existingPreferenceSet.add(normalized)
    sameBatchSet.add(normalized)
  }

  preferenceStoreDebounceByScope.set(scopeKey, nowMs)
  return result
}
