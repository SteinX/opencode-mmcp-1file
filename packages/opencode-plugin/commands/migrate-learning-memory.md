---
description: Migrate legacy prefixed memories to typed metadata.learning server records
---

# /migrate-learning-memory

Migrate legacy learning memories (stored with text prefixes like `USER — Preference:`) to the current typed `metadata.learning` schema used by the learning memory subsystem.

**Safety rule**: Always dry-run first. Never auto-migrate on plugin startup. Migration does not delete originals.

---

## Step 1 — Dry Run (always first)

Call the migration tool in preview mode to see what would change without touching any data:

```
memory_learning_migrate_legacy(dry_run: true)
```

The result is a JSON object with migration counts. Example:

```json
{
  "scanned": 42,
  "eligible": 18,
  "created": 0,
  "skipped": 3,
  "ambiguous": 2,
  "already_migrated": 13,
  "invalidated_skipped": 1
}
```

In dry-run mode, `created` is always `0` — no records are written.

---

## Step 2 — Review the Counts

Explain each field to the user before proceeding:

| Field | Meaning |
|-------|---------|
| `scanned` | Total legacy memory records examined |
| `eligible` | Records that match a known migratable prefix and can be converted |
| `created` | Records that would be (or were) created as typed learning memories |
| `skipped` | Records skipped due to unrecognized or excluded prefix (e.g. `TASK:`, `EPIC:`) |
| `ambiguous` | Records where the prefix matched but the learning type could not be determined confidently |
| `already_migrated` | Records that already exist as typed learning memories (no duplicate created) |
| `invalidated_skipped` | Records that are soft-deleted/invalidated and were skipped |

If `ambiguous > 0`, ask the user whether to proceed or inspect those records first with `memory_query`.

If `eligible === 0`, inform the user there is nothing to migrate and stop.

---

## Step 3 — Execute (only after explicit user approval)

**Do not proceed without the user saying "yes", "go ahead", "execute", or equivalent.**

Once approved:

```
memory_learning_migrate_legacy(dry_run: false)
```

Report the final counts. Highlight `created` (new records written) and any `ambiguous` records that were skipped.

---

## Prefix Behavior Reference

| Prefix | Action | Resulting type |
|--------|--------|----------------|
| `USER — Preference:` | ✅ Confirmed migration | `user_preference` |
| `TASK:` | ⛔ Skipped | — (task-scoped, not a learning) |
| `EPIC:` | ⛔ Skipped | — (project-scoped, not a learning) |
| `USER:` | ⚠️ Requires explicit classification mode | Needs `source_prefixes` override |
| `CONTEXT:` | ⚠️ Requires explicit classification mode | Needs `source_prefixes` override |
| `RESEARCH:` | ⚠️ Requires explicit classification mode | Needs `source_prefixes` override |

To migrate only specific prefixes, pass a comma-separated list:

```
memory_learning_migrate_legacy(dry_run: true, source_prefixes: "USER — Preference:,USER:")
```

---

## Rollback & Safety

- **Originals are preserved**: migration creates new typed records but does not delete or modify the original legacy memories.
- **Legacy fallback**: if `fallback.legacyPreferences: true` is set in config, the plugin continues to read legacy prefixed memories even after migration. You can disable this once you've verified the new records are correct.
- **Idempotent**: running migration twice is safe — `already_migrated` count will reflect previously migrated records and no duplicates are created.
- **No startup migration**: the plugin never auto-migrates on startup. This command must be invoked explicitly.

---

## When to Use This Command

- After upgrading to a version that introduced the typed learning memory subsystem
- When `memory_learning_list` returns fewer preferences than expected (legacy records not yet migrated)
- When you want to consolidate all preference history into the structured learning store for better recall and lifecycle management
