---
description: Review, confirm, reject, archive, supersede, update, promote, retrieve, and migrate learning memories using the plugin's learning memory tools
---

# /manage-learning-memory

Manage the lifecycle of learning memories — observations, preferences, lessons, patterns, pitfalls, and workflow rules — stored by the plugin's learning memory system.

> **Safety note**: A `candidate` learning is a tentative observation, not a hard rule. It must be explicitly confirmed before it influences agent behavior, and must be explicitly promoted to `rule` status before it is treated as a binding constraint. Never treat a candidate as authoritative without user review.

---

## Listing and Reviewing

Use `memory_learning_list` to browse stored learnings. All filters are optional; omit them to list everything.

```text
memory_learning_list({
  kind: "user_preference" | "project_lesson" | "project_pattern" | "project_pitfall" | "workflow_rule",
  status: "candidate" | "confirmed" | "rule" | "rejected" | "superseded" | "archived",
  scope: "project" | "global",
  namespace: "<namespace>",
  limit: 20
})
```

**Scope guidance**:
- Use `scope: "project"` to see learnings tied to the current project only.
- Use `scope: "global"` to see user-level learnings that apply across all projects.
- Omit `scope` to see both.

**Default active view**: The default listing hides `rejected`, `superseded`, and `archived` records. Pass `status` explicitly to inspect those lifecycle states.

To fetch a specific record by id:

```text
memory_learning_retrieve({ id: "<learning-id>" })
```

---

## Confirming Candidates

Use `memory_learning_confirm` to promote a `candidate` to `confirmed` status after reviewing it with the user.

```text
memory_learning_confirm({ id: "<learning-id>" })
```

> ⚠️ **Candidates are NOT hard rules.** A candidate is a tentative observation captured automatically. Do not act on it as a constraint until it has been confirmed. Always show the candidate content to the user and ask for explicit confirmation before calling this tool.

---

## Rejecting / Archiving

Prefer soft lifecycle actions over hard deletion.

**Reject** — marks the learning as rejected; excluded from future injection and search. Use when the learning is incorrect or unwanted.

```text
memory_learning_reject({ id: "<learning-id>", reason: "Optional explanation" })
```

**Archive** — moves the learning to archived status; excluded from default injection but retained for history. Use when the learning is no longer relevant but should be preserved for audit purposes.

```text
memory_learning_archive({ id: "<learning-id>" })
```

> Prefer `reject` or `archive` over hard deletion. Hard deletion (`memory_learning_delete`) is deprecated and should not be used in new workflows.

---

## Superseding

Use `memory_learning_supersede` when a learning has been replaced by a newer, more accurate version. This marks the original as `superseded` and records the lineage chain.

```text
memory_learning_supersede({
  id: "<old-learning-id>",
  replacement_id: "<new-learning-id>"
})
```

Typical workflow:
1. Store the new, corrected learning (e.g., via `memory_save`).
2. Retrieve its id.
3. Call `memory_learning_supersede` with the old id and the new id as `replacement_id`.

---

## Updating

Use `memory_learning_update` to correct content, adjust confidence, or modify metadata fields. Only provide the fields you want to change.

```text
memory_learning_update({
  id: "<learning-id>",
  content: "Updated content text",
  confidence: 0.9,
  metadata_json: "{\"source\": \"user-correction\"}"
})
```

---

## Promoting to Rule

Use `memory_learning_promote` to elevate a learning to a higher status. This tool supports two target statuses:

- `"confirmed"` — equivalent to `memory_learning_confirm`; use for routine candidate confirmation.
- `"rule"` — elevates to a **hard rule**; treated as a binding constraint by the agent.

```text
memory_learning_promote({ id: "<learning-id>", target_status: "rule" })
```

> 🔒 **Promoting to `rule` REQUIRES explicit user instruction.** Never promote a learning to rule status on your own initiative. The user must explicitly ask for this. A rule-status learning is treated as a binding constraint and will influence agent behavior accordingly.

---

## Retrieving

Use `memory_learning_retrieve` to fetch the full record for a specific learning by id, including its metadata, status, confidence, and lifecycle state.

```text
memory_learning_retrieve({ id: "<learning-id>" })
```

---

## Migration

Use `memory_learning_migrate_legacy` to migrate legacy learning memories to the current schema.

**Always run a dry run first** to preview what would be migrated without making changes:

```text
memory_learning_migrate_legacy({ dry_run: true })
```

Review the preview output with the user. Only proceed with the actual migration after explicit user approval:

```text
memory_learning_migrate_legacy({ dry_run: false })
```

Optionally filter by source prefixes (comma-separated):

```text
memory_learning_migrate_legacy({ dry_run: false, source_prefixes: "prefix1,prefix2" })
```

---

## Prohibitions

- **NO direct storage edits**: Do not attempt to read or modify the underlying storage files directly. Use only the tools above.
- **NO hard deletion**: Do not use `memory_learning_delete` in new workflows — it is deprecated. Use `reject`, `archive`, or `supersede` instead.
- **NO autonomous promotion to rule**: Never call `memory_learning_promote` with `target_status: "rule"` without explicit user instruction.
- **NO treating candidates as rules**: A `candidate` learning is tentative. Do not act on it as a constraint until confirmed.
