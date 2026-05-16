import {
  buildCompactionRecoveryContext,
  fetchAndFormatMemories,
  loadConfig,
  resolveDataDir,
  storeMemory,
  stripPrivateContent,
  isFullyPrivate,
  type ContextBundle,
  type ContextSource,
  type LedgerCaptureResult,
} from "mmcp-1file-core"
import { readCodexBuiltinMemorySummary, readStableRepoGuidance } from "./codex-builtins.js"

const ENGLISH_CONTINUE_PATTERN = /\b(?:continue|resume|keep going)\b/i
const CHINESE_CONTINUE_PATTERN = /(?:继续|接着|恢复)/

function shouldBuildRecovery(prompt: string, compactSummary?: string): boolean {
  return Boolean(compactSummary?.trim())
    || ENGLISH_CONTINUE_PATTERN.test(prompt)
    || CHINESE_CONTINUE_PATTERN.test(prompt)
}

function sourcesFor(parts: Array<{ source: ContextSource; text: string | null }>): ContextSource[] {
  return parts.flatMap((part) => part.text ? [part.source] : [])
}

function joinContext(parts: Array<{ title: string; text: string | null }>): string {
  return parts
    .filter((part) => part.text && part.text.trim().length > 0)
    .map((part) => `## ${part.title}\n${part.text}`)
    .join("\n\n")
}

export async function buildPromptContext(args: {
  cwd: string
  sessionId?: string
  prompt: string
  compactSummary?: string
}): Promise<ContextBundle | null> {
  const config = loadConfig(args.cwd)
  if (!resolveDataDir(config)) return null

  const memoryContext = await fetchAndFormatMemories(config, args.prompt)
  const shouldRecover = shouldBuildRecovery(args.prompt, args.compactSummary)
  const recovery = shouldRecover
    ? await buildCompactionRecoveryContext(config, args.compactSummary)
    : null
  const codexBuiltin = readCodexBuiltinMemorySummary()
  const stableGuidance = readStableRepoGuidance(args.cwd)

  const parts = [
    { source: "query_recall" as const, title: "Relevant Memory", text: memoryContext },
    { source: "codex_builtin" as const, title: "Codex Built-In Memory", text: codexBuiltin },
    { source: "project_knowledge" as const, title: "Stable Repo Guidance", text: stableGuidance },
    { source: "recovery" as const, title: "Recovery Additions", text: recovery?.text ?? null },
  ]
  const text = joinContext(parts)
  if (!text) return null

  return {
    text,
    sources: sourcesFor(parts),
    diagnostics: {
      skippedSimilarToSummary: recovery?.skippedSimilarToSummary ?? 0,
      injectedCount: parts.filter((part) => part.text).length,
    },
  }
}

function extractLedgerCandidates(transcript: string): string[] {
  const lines = transcript
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)

  return lines
    .filter((line) =>
      /\b(?:DECISION|TASK|PATTERN|BUGFIX|CONTEXT|RESEARCH|USER)\b[:：]/i.test(line)
      || /\b(?:verified|verification|test|build|failed|pre-existing|not verified|用户|偏好|拒绝|纠正)\b/i.test(line)
    )
    .slice(-8)
}

function categorize(content: string): string {
  const match = content.match(/\b(DECISION|TASK|PATTERN|BUGFIX|CONTEXT|RESEARCH|USER)\b[:：]/i)
  if (match) return match[1].toUpperCase()
  if (/\b(?:verified|test|build|not verified)\b/i.test(content)) return "CONTEXT"
  if (/\b(?:failed|pre-existing|error)\b/i.test(content)) return "BUGFIX"
  if (/\b(?:用户|偏好|纠正|拒绝)\b/i.test(content)) return "USER"
  return "CONTEXT"
}

export async function captureTaskLedger(args: {
  cwd: string
  sessionId?: string
  transcriptText: string
}): Promise<LedgerCaptureResult> {
  const config = loadConfig(args.cwd)
  if (!resolveDataDir(config)) return { stored: 0, skipped: 0, categories: [] }

  const candidates = extractLedgerCandidates(args.transcriptText)
  let stored = 0
  let skipped = 0
  const categories: string[] = []

  for (const candidate of candidates) {
    let content = stripPrivateContent(candidate)
    if (!content || isFullyPrivate(content)) {
      skipped += 1
      continue
    }

    const category = categorize(content)
    if (!new RegExp(`^${category}[:：]`, "i").test(content)) {
      content = `${category}: ${content}`
    }

    const ok = await storeMemory(config, content, "episodic", {
      runId: args.sessionId,
      metadata: { source: "codex.stop" },
    })

    if (ok) {
      stored += 1
      categories.push(category)
    } else {
      skipped += 1
    }
  }

  return { stored, skipped, categories }
}
