/**
 * Contract fixtures for learning memory server response envelopes.
 *
 * These fixtures mirror the server response shapes defined in the server protocol handoff
 * and clarifications documents. They are used to validate that the plugin correctly
 * handles all response variants including non-happy-path cases.
 *
 * Server protocol authority:
 *   memory-mcp-1file/.sisyphus/drafts/plugin-learning-memory-protocol-handoff.md
 *   memory-mcp-1file/.sisyphus/drafts/server-learning-memory-protocol-clarifications.md
 *   memory-mcp-1file/.sisyphus/drafts/learning-memory-v1-contract-fixture.json
 */

export type LearningKind =
  | "user_preference"
  | "project_lesson"
  | "project_pattern"
  | "project_pitfall"
  | "workflow_rule"

export type LearningStatus =
  | "candidate"
  | "confirmed"
  | "rule"
  | "rejected"
  | "superseded"
  | "archived"

export type LifecycleState =
  | "active"
  | "candidate"
  | "rejected"
  | "superseded"
  | "archived"
  | "invalidated"
  | "unknown"

export type InvalidationReason =
  | "learning_rejected"
  | "learning_archived"
  | "superseded"
  | "expired"
  | "manual_invalidation"
  | "privacy_removed"
  | "migration_replaced"
  | null

export type SummaryReasonCode =
  | "missing"
  | "stale"
  | "partial"
  | "degraded"
  | "invalid_locator"
  | "generation_mismatch"
  | "unsupported"
  | null

export interface LearningRecord {
  id: string
  content: string
  memory_type: string
  metadata: {
    learning: {
      schema_version: number
      kind: LearningKind
      status: LearningStatus
      confidence?: number
      scope?: { level: string; project_id?: string }
      source?: { created_from: string; client: string; source_memory_ids?: string[] }
    }
  }
  valid_until: string | null
  invalidation_reason: InvalidationReason
  superseded_by: string | null
}

export interface LearningSummary {
  schema_version: number
  kind: LearningKind
  status: LearningStatus
  lifecycle_state: LifecycleState
  included_in_default_list: boolean
  included_in_default_search: boolean
  injectable_by_default: boolean
}

export interface LearningContract {
  schema_version: number
}

export interface LearningResponseEnvelope {
  record: LearningRecord
  learning_summary: LearningSummary
  contract: LearningContract
  summary: {
    partial: {
      reason_code: SummaryReasonCode
    }
  }
}

export interface LearningListResponseEnvelope {
  records: LearningRecord[]
  learning_summary?: LearningSummary
  contract: LearningContract
  summary: {
    partial: {
      reason_code: SummaryReasonCode
    }
  }
}

const baseRecord: LearningRecord = {
  id: "memory:fixture-confirmed-001",
  content: "Prefer concise responses without filler phrases.",
  memory_type: "semantic",
  metadata: {
    learning: {
      schema_version: 1,
      kind: "user_preference",
      status: "confirmed",
      confidence: 0.9,
      scope: { level: "project", project_id: "memory-plugin" },
      source: { created_from: "plugin", client: "opencode-plugin", source_memory_ids: [] },
    },
  },
  valid_until: null,
  invalidation_reason: null,
  superseded_by: null,
}

export const happyPathConfirmed: LearningResponseEnvelope = {
  record: baseRecord,
  learning_summary: {
    schema_version: 1,
    kind: "user_preference",
    status: "confirmed",
    lifecycle_state: "active",
    included_in_default_list: true,
    included_in_default_search: true,
    injectable_by_default: true,
  },
  contract: { schema_version: 1 },
  summary: { partial: { reason_code: null } },
}

export const happyPathCandidate: LearningResponseEnvelope = {
  record: {
    ...baseRecord,
    id: "memory:fixture-candidate-001",
    metadata: {
      learning: {
        ...baseRecord.metadata.learning,
        status: "candidate",
        confidence: 0.6,
      },
    },
  },
  learning_summary: {
    schema_version: 1,
    kind: "user_preference",
    status: "candidate",
    lifecycle_state: "candidate",
    included_in_default_list: true,
    included_in_default_search: false,
    injectable_by_default: false,
  },
  contract: { schema_version: 1 },
  summary: { partial: { reason_code: null } },
}

export const happyPathRule: LearningResponseEnvelope = {
  record: {
    ...baseRecord,
    id: "memory:fixture-rule-001",
    metadata: {
      learning: {
        ...baseRecord.metadata.learning,
        status: "rule",
        confidence: 1.0,
      },
    },
  },
  learning_summary: {
    schema_version: 1,
    kind: "workflow_rule",
    status: "rule",
    lifecycle_state: "active",
    included_in_default_list: true,
    included_in_default_search: true,
    injectable_by_default: true,
  },
  contract: { schema_version: 1 },
  summary: { partial: { reason_code: null } },
}

export const rejectedRecord: LearningResponseEnvelope = {
  record: {
    ...baseRecord,
    id: "memory:fixture-rejected-001",
    metadata: {
      learning: {
        ...baseRecord.metadata.learning,
        status: "rejected",
      },
    },
    invalidation_reason: "learning_rejected",
  },
  learning_summary: {
    schema_version: 1,
    kind: "user_preference",
    status: "rejected",
    lifecycle_state: "rejected",
    included_in_default_list: false,
    included_in_default_search: false,
    injectable_by_default: false,
  },
  contract: { schema_version: 1 },
  summary: { partial: { reason_code: null } },
}

export const archivedRecord: LearningResponseEnvelope = {
  record: {
    ...baseRecord,
    id: "memory:fixture-archived-001",
    metadata: {
      learning: {
        ...baseRecord.metadata.learning,
        status: "archived",
      },
    },
    invalidation_reason: "learning_archived",
  },
  learning_summary: {
    schema_version: 1,
    kind: "user_preference",
    status: "archived",
    lifecycle_state: "archived",
    included_in_default_list: false,
    included_in_default_search: false,
    injectable_by_default: false,
  },
  contract: { schema_version: 1 },
  summary: { partial: { reason_code: null } },
}

export const supersededRecord: LearningResponseEnvelope = {
  record: {
    ...baseRecord,
    id: "memory:fixture-superseded-001",
    metadata: {
      learning: {
        ...baseRecord.metadata.learning,
        status: "superseded",
      },
    },
    invalidation_reason: "superseded",
    superseded_by: "memory:fixture-confirmed-002",
  },
  learning_summary: {
    schema_version: 1,
    kind: "user_preference",
    status: "superseded",
    lifecycle_state: "superseded",
    included_in_default_list: false,
    included_in_default_search: false,
    injectable_by_default: false,
  },
  contract: { schema_version: 1 },
  summary: { partial: { reason_code: null } },
}

/**
 * Non-happy-path: reason_code "unsupported"
 * Plugin behavior: fall back to legacy memory search; do not attempt learning_summary parsing.
 */
export const partialUnsupported: LearningResponseEnvelope = {
  record: baseRecord,
  learning_summary: {
    schema_version: 1,
    kind: "user_preference",
    status: "confirmed",
    lifecycle_state: "unknown",
    included_in_default_list: false,
    included_in_default_search: false,
    injectable_by_default: false,
  },
  contract: { schema_version: 1 },
  summary: { partial: { reason_code: "unsupported" } },
}

/**
 * Non-happy-path: reason_code "degraded"
 * Plugin behavior: do not inject; log warning; treat as non-injectable.
 */
export const partialDegraded: LearningResponseEnvelope = {
  record: baseRecord,
  learning_summary: {
    schema_version: 1,
    kind: "user_preference",
    status: "confirmed",
    lifecycle_state: "active",
    included_in_default_list: true,
    included_in_default_search: false,
    injectable_by_default: false,
  },
  contract: { schema_version: 1 },
  summary: { partial: { reason_code: "degraded" } },
}

/**
 * Non-happy-path: reason_code "stale"
 * Plugin behavior: do not inject; prompt user to refresh or re-confirm the learning.
 */
export const partialStale: LearningResponseEnvelope = {
  record: {
    ...baseRecord,
    valid_until: "2025-01-01T00:00:00Z",
  },
  learning_summary: {
    schema_version: 1,
    kind: "user_preference",
    status: "confirmed",
    lifecycle_state: "active",
    included_in_default_list: true,
    included_in_default_search: false,
    injectable_by_default: false,
  },
  contract: { schema_version: 1 },
  summary: { partial: { reason_code: "stale" } },
}

/**
 * Non-happy-path: reason_code "generation_mismatch"
 * Plugin behavior: do not inject; schema_version mismatch detected; log error and skip.
 */
export const partialGenerationMismatch: LearningResponseEnvelope = {
  record: baseRecord,
  learning_summary: {
    schema_version: 2,
    kind: "user_preference",
    status: "confirmed",
    lifecycle_state: "unknown",
    included_in_default_list: false,
    included_in_default_search: false,
    injectable_by_default: false,
  },
  contract: { schema_version: 2 },
  summary: { partial: { reason_code: "generation_mismatch" } },
}

export const listHappyPath: LearningListResponseEnvelope = {
  records: [baseRecord],
  contract: { schema_version: 1 },
  summary: { partial: { reason_code: null } },
}

export const listEmpty: LearningListResponseEnvelope = {
  records: [],
  contract: { schema_version: 1 },
  summary: { partial: { reason_code: null } },
}

export const listPartialUnsupported: LearningListResponseEnvelope = {
  records: [],
  contract: { schema_version: 1 },
  summary: { partial: { reason_code: "unsupported" } },
}
