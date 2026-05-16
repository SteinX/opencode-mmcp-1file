export interface ClientRuntimeContext {
  client: "opencode" | "codex"
  cwd: string
  sessionId?: string
  runId?: string
  namespace?: string
}

export interface ContextRequest {
  userText: string
  runtime: ClientRuntimeContext
  afterCompaction?: boolean
  compactSummary?: string
}

export type ContextSource =
  | "query_recall"
  | "project_knowledge"
  | "code_intel"
  | "learning"
  | "codex_builtin"
  | "recovery"

export interface ContextBundle {
  text: string
  sources: ContextSource[]
  diagnostics: {
    skippedSimilarToSummary: number
    injectedCount: number
  }
}

export interface LedgerCaptureRequest {
  transcriptText: string
  lastUserText?: string
  lastAssistantText?: string
  runtime: ClientRuntimeContext
}

export interface LedgerCaptureResult {
  stored: number
  skipped: number
  categories: string[]
}
