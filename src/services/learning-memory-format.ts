import type {
  LearningRecord,
  LearningSummary,
} from "./learning-memory-client.js"

export interface LearningMemoryFormatterConfig {
  includeEvidence: boolean
  includeCandidates: boolean
}

export interface LearningMemoryFormatInput {
  records: LearningRecord[]
  learning_summary?: LearningSummary
}

type LearningSectionId =
  | "hard_rules"
  | "confirmed_user_preferences"
  | "relevant_project_lessons"
  | "relevant_patterns_pitfalls"
  | "candidate_signals"

interface SectionDefinition {
  id: LearningSectionId
  title: string
  hint: string
}

interface PreparedLearningRecord {
  content: string
  kind: string
  status: string
  sourceLabel: string
  evidence?: string
}

const SECTION_ORDER: SectionDefinition[] = [
  {
    id: "hard_rules",
    title: "Hard Rules",
    hint: "Treat these as non-negotiable constraints.",
  },
  {
    id: "confirmed_user_preferences",
    title: "Confirmed User Preferences",
    hint: "Use these as strong guidance for response style and choices.",
  },
  {
    id: "relevant_project_lessons",
    title: "Relevant Project Lessons",
    hint: "Apply these as project-specific lessons learned.",
  },
  {
    id: "relevant_patterns_pitfalls",
    title: "Relevant Patterns/Pitfalls",
    hint: "Prefer these patterns; avoid the pitfalls.",
  },
  {
    id: "candidate_signals",
    title: "Candidate Signals",
    hint: "Tentative only — validate before relying on them.",
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function getLearningMetadata(record: LearningRecord): Record<string, unknown> | undefined {
  const learning = record.metadata.learning
  return isRecord(learning) ? learning : undefined
}

function getRecordKind(record: LearningRecord): string {
  return asString(getLearningMetadata(record)?.kind) ?? record.memory_type ?? "unknown"
}

function getRecordStatus(record: LearningRecord): string {
  return asString(getLearningMetadata(record)?.status) ?? "unknown"
}

function getSourceLabel(record: LearningRecord): string {
  const learning = getLearningMetadata(record)
  const source = isRecord(learning?.source) ? learning.source : undefined
  const labels: string[] = []

  const createdFrom = asString(source?.created_from)
  if (createdFrom) labels.push(createdFrom)

  const client = asString(source?.client)
  if (client) labels.push(client)

  const sourceIds = Array.isArray(source?.source_memory_ids)
    ? source?.source_memory_ids.filter((value): value is string => typeof value === "string" && value.length > 0)
    : []
  if (sourceIds.length > 0) labels.push(`ids:${sourceIds.join(",")}`)

  return labels.length > 0 ? labels.join(" / ") : "unknown"
}

function getEvidence(record: LearningRecord): string | undefined {
  const learning = getLearningMetadata(record)
  const candidate = asString(learning?.evidence)
    ?? asString(learning?.raw_evidence)
    ?? asString(record.raw.evidence)
    ?? asString(record.raw.source_evidence)

  return candidate
}

function classifySection(record: LearningRecord): LearningSectionId | null {
  const kind = getRecordKind(record)
  const status = getRecordStatus(record)

  if (status === "candidate") return "candidate_signals"
  if (kind === "workflow_rule" || status === "rule") return "hard_rules"
  if (kind === "user_preference" && status === "confirmed") return "confirmed_user_preferences"
  if (kind === "project_lesson") return "relevant_project_lessons"
  if (kind === "project_pattern" || kind === "project_pitfall") return "relevant_patterns_pitfalls"

  return null
}

function prepareRecord(record: LearningRecord, includeEvidence: boolean): PreparedLearningRecord {
  return {
    content: record.content,
    kind: getRecordKind(record),
    status: getRecordStatus(record),
    sourceLabel: getSourceLabel(record),
    ...(includeEvidence ? { evidence: getEvidence(record) } : {}),
  }
}

function formatRecord(record: PreparedLearningRecord): string {
  const lines = [
    `- ${record.content}`,
    `  Source: ${record.sourceLabel}`,
    `  Kind: ${record.kind}`,
    `  Status: ${record.status}`,
  ]

  if (record.evidence) {
    lines.push(`  Evidence: ${record.evidence}`)
  }

  return lines.join("\n")
}

function formatSection(title: string, hint: string, records: PreparedLearningRecord[]): string | null {
  if (records.length === 0) return null

  return [
    `## ${title}`,
    hint,
    ...records.map((record) => formatRecord(record)),
  ].join("\n")
}

export function formatLearningMemoryInjection(
  input: LearningMemoryFormatInput,
  config: LearningMemoryFormatterConfig,
): string | null {
  if (input.learning_summary?.injectable_by_default !== true) {
    return null
  }

  const sections: Record<LearningSectionId, PreparedLearningRecord[]> = {
    hard_rules: [],
    confirmed_user_preferences: [],
    relevant_project_lessons: [],
    relevant_patterns_pitfalls: [],
    candidate_signals: [],
  }

  for (const record of input.records) {
    const sectionId = classifySection(record)
    if (!sectionId) continue
    if (sectionId === "candidate_signals" && !config.includeCandidates) continue

    sections[sectionId].push(prepareRecord(record, config.includeEvidence))
  }

  const formattedSections = SECTION_ORDER
    .map((section) => formatSection(section.title, section.hint, sections[section.id]))
    .filter((section): section is string => section !== null)

  if (formattedSections.length === 0) return null

  return ["[MEMORY] Learned Memory", ...formattedSections].join("\n\n")
}
