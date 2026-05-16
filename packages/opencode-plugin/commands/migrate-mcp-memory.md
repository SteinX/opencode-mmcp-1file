---
description: Migrate memories between memory-mcp shards using export/import with dry-run-first safety
---

# Migrate MCP Memory

Migrate memories between two memory-mcp physical shards using the local plugin tool `memory_migrate`.

This command uses `export_memory` and `import_memory` internally via isolated MCP clients. It always performs a dry-run first. Actual migration only proceeds when explicitly confirmed.

## Usage

Provide a source selector and project ID. Target and target project ID are optional — omitting them migrates to the current workspace's configured memory shard while preserving the source project ID.

If the action is unclear, ask the user for:
- Source: `source_tag` OR `source_data_dir` (exactly one)
- `source_project_id` — the project ID in the source shard
- Target (optional): `target_tag` OR `target_data_dir` — omit to use current workspace
- `target_project_id` (optional): omit to preserve source project ID; provide to retarget to a new project

## Parameters

### Required

| Parameter | Description |
|---|---|
| `source_tag` OR `source_data_dir` | Exactly one. Tag derives path as `~/.local/share/opencode-mmcp-1file/{tag}` |
| `source_project_id` | Project ID in the source shard. Must be explicit — never inferred. |

### Optional — Target

| Parameter | Default | Description |
|---|---|---|
| `target_tag` OR `target_data_dir` | current workspace | Omit both to migrate into the current workspace's configured shard. Providing either always uses an isolated stdio client. |
| `target_project_id` | (preserve source) | Omit to preserve the source project ID (`preserve_project_id: true`). Provide to retarget memories to a new project ID (`preserve_project_id: false`). |

### Optional — Behavior

| Parameter | Default | Description |
|---|---|---|
| `source_namespace` | — | Namespace filter for export (opt-in only) |
| `target_namespace` | — | Namespace for import (opt-in only) |
| `include_invalidated` | `false` | Archive opt-in: export and import invalidated records too |
| `dry_run` | `true` | Set `false` to perform actual migration (requires `confirm: true`) |
| `confirm` | `false` | Must be `true` when `dry_run=false` to authorize actual import |
| `conflict_strategy` | `remap` | Conflict resolution strategy. Only `remap` is supported in v1 — conflicting IDs are remapped to new IDs on import. |

## Target Resolution

The tool resolves the target shard in one of three modes:

| Mode | How | Transport |
|---|---|---|
| **Current workspace (HTTP)** | No `target_tag`/`target_data_dir`; transport = `http` | Shared HTTP MCP server via `StreamableHTTPClientTransport` — no new process spawned |
| **Current workspace (stdio)** | No `target_tag`/`target_data_dir`; transport = `stdio` | Isolated stdio client using current `dataDir` |
| **Explicit target** | `target_tag` or `target_data_dir` provided | Always isolated stdio client, regardless of transport setting |

## Project ID Modes

| Mode | Parameters | Behavior |
|---|---|---|
| **preserve-source-project** | `target_project_id` omitted | Memories keep their original project ID (`preserve_project_id: true`) |
| **retarget** | `target_project_id: "new-proj-id"` | Memories are assigned to the new project ID (`preserve_project_id: false`) |

## Dry-Run Flow (default)

Always run dry-run first:

```text
memory_migrate({
  source_tag: "project-a",
  source_project_id: "proj-123"
})
```

Summarize the result for the user:
- `status`: `dry_run_passed` or `dry_run_failed`
- `exportedCount`, `truncated`
- `importedCount`, `skippedCount`, `failedCount`
- `idMappings`: list of old→new ID pairs
- `errors`: any validation errors
- `resolvedSource`, `resolvedTarget`: resolved data directory paths
- `nextCall`: when `status` is `dry_run_passed`, use this exact payload after explicit user confirmation

**Actual import is BLOCKED if dry-run returns errors or `failedCount > 0`.**

## Actual Migration

Only proceed after dry-run passes AND the user explicitly confirms. Prefer the dry-run report's `nextCall` object instead of reconstructing arguments manually. It will include both `dry_run: false` and `confirm: true`:

```text
// Use report.nextCall.args after explicit confirmation
memory_migrate(report.nextCall.args)
```

## Examples

**Current workspace target, preserve source project ID (simplest migration):**
```text
memory_migrate({
  source_tag: "old-project",
  source_project_id: "proj-old"
})
```
Migrates from `old-project` shard into the current workspace's configured shard, keeping the original project ID. Dry-run only.

**Current workspace target, retarget to new project ID:**
```text
memory_migrate({
  source_tag: "old-project",
  source_project_id: "proj-old",
  target_project_id: "proj-new"
})
// After dry-run passes and the user confirms:
memory_migrate(report.nextCall.args)
```
Migrates into the current workspace shard and reassigns memories to `proj-new`.

**Explicit tag-to-tag migration (dry-run):**
```text
memory_migrate({ source_tag: "old-project", target_tag: "new-project", source_project_id: "proj-old", target_project_id: "proj-new" })
```

**DataDir-to-tag migration:**
```text
memory_migrate({ source_data_dir: "/custom/path/memory", target_tag: "new-project", source_project_id: "proj-123", target_project_id: "proj-456" })
// After dry-run passes and the user confirms:
memory_migrate(report.nextCall.args)
```

**Archive migration (include invalidated records):**
```text
memory_migrate({ source_tag: "project-a", source_project_id: "proj-123", include_invalidated: true })
// After dry-run passes and the user confirms:
memory_migrate(report.nextCall.args)
```

## Prohibitions

- **NO raw MCP tools**: Do not call `export_memory` or `import_memory` directly. Use only `memory_migrate`.
- **NO `migrate_memory`**: This tool does not exist. Do not reference or attempt to call it.
- **NO shell commands**: Do not use shell DB copy, `cp`, `rsync`, or any filesystem-level migration.
- **NO file JSONL**: Do not write or read JSONL migration payloads from files or paths.
- **NO URL migration**: Do not use HTTP endpoints or remote URLs for migration.
- **NO overwrite/reset/replace-all**: Do not clear, overwrite, or destructively replace the target shard.
- **NO `mcp_server_control`**: Do not stop or restart the shared HTTP server as part of migration.
- **NO vector migration**: Embeddings are not transferred; records are re-embedded by the target server.
- **NO unconfirmed actual import**: Never run `dry_run: false` without also passing `confirm: true`.
