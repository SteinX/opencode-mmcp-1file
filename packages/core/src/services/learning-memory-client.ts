import { PluginConfig } from "../config.js"
import { logger } from "../utils/logger.js"
import { callMemoryTool } from "./mcp-client.js"

export type LearningKind =
  | "user_preference"
  | "project_lesson"
  | "project_pattern"
  | "project_pitfall"
  | "workflow_rule"
  | (string & {})

export type LearningStatus =
  | "candidate"
  | "confirmed"
  | "rule"
  | "rejected"
  | "superseded"
  | "archived"
  | (string & {})

export type LearningLifecycleState =
  | "active"
  | "candidate"
  | "rejected"
  | "superseded"
  | "archived"
  | "invalidated"
  | "unknown"
  | (string & {})

export type LearningInvalidationReason =
  | "learning_rejected"
  | "learning_archived"
  | "superseded"
  | "expired"
  | "manual_invalidation"
  | "privacy_removed"
  | "migration_replaced"
  | (string & {})

export type LearningReasonCode =
  | "missing"
  | "stale"
  | "partial"
  | "degraded"
  | "invalid_locator"
  | "generation_mismatch"
  | "unsupported"
  | (string & {})

export type LearningOperationStatus =
  | "ok"
  | "partial"
  | "degraded"
  | "stale"
  | "generation_mismatch"
  | "unavailable"
  | "unsupported"
  | "failed"

export interface LearningMetadata {
  schema_version: number
  kind?: LearningKind
  status?: LearningStatus
  confidence?: number
  scope?: Record<string, unknown>
  source?: Record<string, unknown>
  [key: string]: unknown
}

export interface LearningRecord {
  id: string
  content: string
  memory_type?: string
  metadata: {
    learning: LearningMetadata
    [key: string]: unknown
  }
  valid_until?: string | null
  invalidation_reason?: LearningInvalidationReason | null
  superseded_by?: string | null
  raw: Record<string, unknown>
}

export interface LearningSummary {
  schema_version?: number
  kind?: LearningKind
  status?: LearningStatus
  lifecycle_state?: LearningLifecycleState
  included_in_default_list?: boolean
  included_in_default_search?: boolean
  injectable_by_default?: boolean
  result_count?: number
  default_included_status?: LearningStatus[]
  raw: Record<string, unknown>
}

export interface LearningReplacementLineage {
  chain_ids?: string[]
  depth?: number
  terminal_replacement_id?: string
  cycle_detected?: boolean
  truncated?: boolean
  raw: Record<string, unknown>
}

interface LearningResultBase {
  status: LearningOperationStatus
  reason_code?: LearningReasonCode | null
  raw?: Record<string, unknown>
}

export interface LearningRecordResult extends LearningResultBase {
  record?: LearningRecord
  learning_summary?: LearningSummary
}

export interface LearningRecordsResult extends LearningResultBase {
  records: LearningRecord[]
  learning_summary?: LearningSummary
}

export interface LearningSupersededResult extends LearningResultBase {
  record?: LearningRecord
  learning_summary?: LearningSummary
  replacement_lineage?: LearningReplacementLineage
}

export interface LearningMigrateLegacyResult extends LearningResultBase {
  dry_run?: boolean
  counts?: Record<string, number>
  proposed?: Array<Record<string, unknown>>
  migrated?: Array<Record<string, unknown>>
}

export interface LearningScope {
  level: "global" | "project" | "session" | (string & {})
  project_id?: string
  session_id?: string
}

export interface LearningFallback {
  include_global?: boolean
}

export interface LearningSource {
  created_from?: string
  client?: string
  source_memory_ids?: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function parseReasonCode(raw: Record<string, unknown>): LearningReasonCode | null | undefined {
  if (!isRecord(raw.summary)) return undefined
  const summary = raw.summary
  if (!isRecord(summary.partial)) return undefined
  const partial = summary.partial
  const code = partial.reason_code
  if (code === null) return null
  return typeof code === "string" ? (code as LearningReasonCode) : undefined
}

function mapReasonCodeToStatus(reasonCode: LearningReasonCode | null | undefined): LearningOperationStatus {
  if (reasonCode === null || reasonCode === undefined) return "ok"
  switch (reasonCode) {
    case "unsupported": return "unsupported"
    case "degraded": return "degraded"
    case "stale": return "stale"
    case "generation_mismatch": return "generation_mismatch"
    case "partial": return "partial"
    default: return "partial"
  }
}

function parseLearningMetadata(raw: unknown): LearningMetadata | null {
  if (!isRecord(raw)) return null
  const learning = raw.learning
  if (!isRecord(learning)) return null
  return {
    schema_version: asNumber(learning.schema_version) ?? 0,
    kind: asString(learning.kind) as LearningKind | undefined,
    status: asString(learning.status) as LearningStatus | undefined,
    confidence: asNumber(learning.confidence),
    scope: isRecord(learning.scope) ? learning.scope : undefined,
    source: isRecord(learning.source) ? learning.source : undefined,
    ...learning,
  }
}

function parseLearningRecord(raw: unknown): LearningRecord | null {
  if (!isRecord(raw)) return null
  const id = asString(raw.id)
  const content = asString(raw.content)
  if (!id || content === undefined) return null

  const metadata = parseLearningMetadata(raw.metadata)
  if (!metadata) return null

  return {
    id,
    content,
    memory_type: asString(raw.memory_type),
    metadata: {
      learning: metadata,
      ...(isRecord(raw.metadata) ? raw.metadata : {}),
    },
    valid_until: typeof raw.valid_until === "string" ? raw.valid_until : null,
    invalidation_reason: asString(raw.invalidation_reason) as LearningInvalidationReason | null ?? null,
    superseded_by: asString(raw.superseded_by) ?? null,
    raw: raw,
  }
}

function parseLearningSummary(raw: unknown): LearningSummary | undefined {
  if (!isRecord(raw)) return undefined
  return {
    schema_version: asNumber(raw.schema_version),
    kind: asString(raw.kind) as LearningKind | undefined,
    status: asString(raw.status) as LearningStatus | undefined,
    lifecycle_state: asString(raw.lifecycle_state) as LearningLifecycleState | undefined,
    included_in_default_list: asBoolean(raw.included_in_default_list),
    included_in_default_search: asBoolean(raw.included_in_default_search),
    injectable_by_default: asBoolean(raw.injectable_by_default),
    result_count: asNumber(raw.result_count),
    default_included_status: Array.isArray(raw.default_included_status)
      ? raw.default_included_status.filter((s): s is string => typeof s === "string") as LearningStatus[]
      : undefined,
    raw,
  }
}

function parseLearningReplacementLineage(raw: unknown): LearningReplacementLineage | undefined {
  if (!isRecord(raw)) return undefined
  return {
    chain_ids: Array.isArray(raw.chain_ids)
      ? raw.chain_ids.filter((s): s is string => typeof s === "string")
      : undefined,
    depth: asNumber(raw.depth),
    terminal_replacement_id: asString(raw.terminal_replacement_id),
    cycle_detected: asBoolean(raw.cycle_detected),
    truncated: asBoolean(raw.truncated),
    raw,
  }
}

function isUnknownToolError(err: unknown): boolean {
  const msg = String(err).toLowerCase()
  return msg.includes("unknown tool") || msg.includes("tool not found") || msg.includes("not supported")
}

function classifyCallError(err: unknown): LearningOperationStatus {
  const msg = String(err)
  if (msg.includes("Memory server unavailable")) return "unavailable"
  return "failed"
}

async function callLearningTool(
  config: PluginConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null | "unsupported"> {
  try {
    const text = await callMemoryTool(config, toolName, args)
    return parseJsonRecord(text)
  } catch (err) {
    if (isUnknownToolError(err)) return "unsupported"
    throw err
  }
}

export interface CreateLearningMemoryArgs {
  content: string
  kind: LearningKind
  status?: LearningStatus
  confidence?: number
  scope?: LearningScope
  source?: LearningSource
  metadata?: Record<string, unknown>
}

export async function createLearningMemory(
  config: PluginConfig,
  args: CreateLearningMemoryArgs,
): Promise<LearningRecordResult> {
  try {
    const result = await callLearningTool(config, "learning_memory_create", args as unknown as Record<string, unknown>)
    if (result === "unsupported") return { status: "unsupported" }
    if (!result) return { status: "failed" }

    const reasonCode = parseReasonCode(result)
    const status = mapReasonCodeToStatus(reasonCode)
    return {
      status,
      reason_code: reasonCode,
      record: parseLearningRecord(result.record) ?? undefined,
      learning_summary: parseLearningSummary(result.learning_summary),
      raw: result,
    }
  } catch (err) {
    logger.error("learning_memory_create failed", { error: String(err) })
    return { status: classifyCallError(err) }
  }
}

export interface GetLearningMemoryArgs {
  id: string
}

export async function getLearningMemory(
  config: PluginConfig,
  args: GetLearningMemoryArgs,
): Promise<LearningRecordResult> {
  try {
    const result = await callLearningTool(config, "learning_memory_get", args as unknown as Record<string, unknown>)
    if (result === "unsupported") return { status: "unsupported" }
    if (!result) return { status: "failed" }

    const reasonCode = parseReasonCode(result)
    const status = mapReasonCodeToStatus(reasonCode)
    return {
      status,
      reason_code: reasonCode,
      record: parseLearningRecord(result.record) ?? undefined,
      learning_summary: parseLearningSummary(result.learning_summary),
      raw: result,
    }
  } catch (err) {
    logger.error("learning_memory_get failed", { error: String(err), id: args.id })
    return { status: classifyCallError(err) }
  }
}

export interface ListLearningMemoriesArgs {
  scope?: LearningScope
  include_status?: LearningStatus[]
  fallback?: LearningFallback
  limit?: number
}

export async function listLearningMemories(
  config: PluginConfig,
  args: ListLearningMemoriesArgs,
): Promise<LearningRecordsResult> {
  try {
    const result = await callLearningTool(config, "learning_memory_list", args as unknown as Record<string, unknown>)
    if (result === "unsupported") return { status: "unsupported", records: [] }
    if (!result) return { status: "failed", records: [] }

    const reasonCode = parseReasonCode(result)
    const status = mapReasonCodeToStatus(reasonCode)
    const records = Array.isArray(result.records)
      ? result.records.map(parseLearningRecord).filter((r): r is LearningRecord => r !== null)
      : []

    return {
      status,
      reason_code: reasonCode,
      records,
      learning_summary: parseLearningSummary(result.learning_summary),
      raw: result,
    }
  } catch (err) {
    logger.error("learning_memory_list failed", { error: String(err) })
    return { status: classifyCallError(err), records: [] }
  }
}

export interface SearchContextHints {
  /** Originating hook or event source (e.g. "chat.message") */
  source?: string
  /** Active session identifier */
  session_id?: string
  /** Memory namespace */
  namespace?: string
  /** User identifier */
  user_id?: string
}

export interface SearchLearningMemoriesArgs {
  query: string
  scope?: LearningScope
  fallback?: LearningFallback
  limit?: number
  /** Optional context hints forwarded to the server for retrieval enrichment. The plugin does NOT use these for scoring. */
  context_hints?: SearchContextHints
}

export async function searchLearningMemories(
  config: PluginConfig,
  args: SearchLearningMemoriesArgs,
): Promise<LearningRecordsResult> {
  try {
    const result = await callLearningTool(config, "learning_memory_search", args as unknown as Record<string, unknown>)
    if (result === "unsupported") return { status: "unsupported", records: [] }
    if (!result) return { status: "failed", records: [] }

    const reasonCode = parseReasonCode(result)
    const status = mapReasonCodeToStatus(reasonCode)
    const records = Array.isArray(result.records)
      ? result.records.map(parseLearningRecord).filter((r): r is LearningRecord => r !== null)
      : []

    return {
      status,
      reason_code: reasonCode,
      records,
      learning_summary: parseLearningSummary(result.learning_summary),
      raw: result,
    }
  } catch (err) {
    logger.error("learning_memory_search failed", { error: String(err) })
    return { status: classifyCallError(err), records: [] }
  }
}

export interface UpdateLearningMemoryArgs {
  id: string
  content?: string
  confidence?: number
  metadata?: Record<string, unknown>
}

export async function updateLearningMemory(
  config: PluginConfig,
  args: UpdateLearningMemoryArgs,
): Promise<LearningRecordResult> {
  try {
    const result = await callLearningTool(config, "learning_memory_update", args as unknown as Record<string, unknown>)
    if (result === "unsupported") return { status: "unsupported" }
    if (!result) return { status: "failed" }

    const reasonCode = parseReasonCode(result)
    const status = mapReasonCodeToStatus(reasonCode)
    return {
      status,
      reason_code: reasonCode,
      record: parseLearningRecord(result.record) ?? undefined,
      learning_summary: parseLearningSummary(result.learning_summary),
      raw: result,
    }
  } catch (err) {
    logger.error("learning_memory_update failed", { error: String(err), id: args.id })
    return { status: classifyCallError(err) }
  }
}

export interface PromoteLearningMemoryArgs {
  id: string
  target_status: "confirmed" | "rule"
}

export async function promoteLearningMemory(
  config: PluginConfig,
  args: PromoteLearningMemoryArgs,
): Promise<LearningRecordResult> {
  try {
    const result = await callLearningTool(config, "learning_memory_promote", args as unknown as Record<string, unknown>)
    if (result === "unsupported") return { status: "unsupported" }
    if (!result) return { status: "failed" }

    const reasonCode = parseReasonCode(result)
    const status = mapReasonCodeToStatus(reasonCode)
    return {
      status,
      reason_code: reasonCode,
      record: parseLearningRecord(result.record) ?? undefined,
      learning_summary: parseLearningSummary(result.learning_summary),
      raw: result,
    }
  } catch (err) {
    logger.error("learning_memory_promote failed", { error: String(err), id: args.id })
    return { status: classifyCallError(err) }
  }
}

export interface RejectLearningMemoryArgs {
  id: string
  reason?: string
}

export async function rejectLearningMemory(
  config: PluginConfig,
  args: RejectLearningMemoryArgs,
): Promise<LearningRecordResult> {
  try {
    const result = await callLearningTool(config, "learning_memory_reject", args as unknown as Record<string, unknown>)
    if (result === "unsupported") return { status: "unsupported" }
    if (!result) return { status: "failed" }

    const reasonCode = parseReasonCode(result)
    const status = mapReasonCodeToStatus(reasonCode)
    return {
      status,
      reason_code: reasonCode,
      record: parseLearningRecord(result.record) ?? undefined,
      learning_summary: parseLearningSummary(result.learning_summary),
      raw: result,
    }
  } catch (err) {
    logger.error("learning_memory_reject failed", { error: String(err), id: args.id })
    return { status: classifyCallError(err) }
  }
}

export interface ArchiveLearningMemoryArgs {
  id: string
}

export async function archiveLearningMemory(
  config: PluginConfig,
  args: ArchiveLearningMemoryArgs,
): Promise<LearningRecordResult> {
  try {
    const result = await callLearningTool(config, "learning_memory_archive", args as unknown as Record<string, unknown>)
    if (result === "unsupported") return { status: "unsupported" }
    if (!result) return { status: "failed" }

    const reasonCode = parseReasonCode(result)
    const status = mapReasonCodeToStatus(reasonCode)
    return {
      status,
      reason_code: reasonCode,
      record: parseLearningRecord(result.record) ?? undefined,
      learning_summary: parseLearningSummary(result.learning_summary),
      raw: result,
    }
  } catch (err) {
    logger.error("learning_memory_archive failed", { error: String(err), id: args.id })
    return { status: classifyCallError(err) }
  }
}

export interface SupersedeLearningMemoryArgs {
  id: string
  replacement_id: string
}

export async function supersedeLearningMemory(
  config: PluginConfig,
  args: SupersedeLearningMemoryArgs,
): Promise<LearningSupersededResult> {
  try {
    const result = await callLearningTool(config, "learning_memory_supersede", args as unknown as Record<string, unknown>)
    if (result === "unsupported") return { status: "unsupported" }
    if (!result) return { status: "failed" }

    const reasonCode = parseReasonCode(result)
    const status = mapReasonCodeToStatus(reasonCode)
    return {
      status,
      reason_code: reasonCode,
      record: parseLearningRecord(result.record) ?? undefined,
      learning_summary: parseLearningSummary(result.learning_summary),
      replacement_lineage: parseLearningReplacementLineage(result.replacement_lineage),
      raw: result,
    }
  } catch (err) {
    logger.error("learning_memory_supersede failed", { error: String(err), id: args.id })
    return { status: classifyCallError(err) }
  }
}

export interface MigrateLegacyLearningArgs {
  dry_run?: boolean
  source_prefixes?: string[]
  scope?: LearningScope
}

export async function migrateLegacyLearningMemories(
  config: PluginConfig,
  args: MigrateLegacyLearningArgs,
): Promise<LearningMigrateLegacyResult> {
  try {
    const result = await callLearningTool(config, "learning_memory_migrate_legacy", args as unknown as Record<string, unknown>)
    if (result === "unsupported") return { status: "unsupported" }
    if (!result) return { status: "failed" }

    const reasonCode = parseReasonCode(result)
    const status = mapReasonCodeToStatus(reasonCode)
    return {
      status,
      reason_code: reasonCode,
      dry_run: asBoolean(result.dry_run),
      counts: isRecord(result.counts)
        ? Object.fromEntries(
            Object.entries(result.counts)
              .filter(([, v]) => typeof v === "number")
              .map(([k, v]) => [k, v as number]),
          )
        : undefined,
      proposed: Array.isArray(result.proposed)
        ? result.proposed.filter(isRecord)
        : undefined,
      migrated: Array.isArray(result.migrated)
        ? result.migrated.filter(isRecord)
        : undefined,
      raw: result,
    }
  } catch (err) {
    logger.error("learning_memory_migrate_legacy failed", { error: String(err) })
    return { status: classifyCallError(err) }
  }
}

export async function deleteLearningMemory(
  config: PluginConfig,
  args: { id: string },
): Promise<LearningRecordResult> {
  try {
    const result = await callLearningTool(config, "learning_memory_delete", args as unknown as Record<string, unknown>)
    if (result === "unsupported") return { status: "unsupported" }
    if (!result) return { status: "failed" }

    const reasonCode = parseReasonCode(result)
    const status = mapReasonCodeToStatus(reasonCode)
    return {
      status,
      reason_code: reasonCode,
      record: parseLearningRecord(result.record) ?? undefined,
      learning_summary: parseLearningSummary(result.learning_summary),
      raw: result,
    }
  } catch (err) {
    logger.error("learning_memory_delete failed", { error: String(err), id: args.id })
    return { status: classifyCallError(err) }
  }
}
