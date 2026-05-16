---
name: memory-mcp
description: Use when Codex should retrieve durable project memory, record reusable decisions, or continue work after context compaction using memory-mcp-1file.
---

# Memory MCP for Codex

Use memory as durable project context, not as a transcript archive.

## Before Work

- Prefer the automatically injected context from the UserPromptSubmit hook.
- When context seems missing, query the `memory-mcp-1file` MCP server directly.
- Start broad; only add namespace or metadata filters when you intentionally need a narrower scope.

## After Work

Store only reusable information:

- decisions and rejected alternatives
- task status and continuation entry points
- verification commands and results
- user preferences and corrections
- known environment constraints

Do not store ordinary chat narration.

## Compaction Recovery

Recovery should add what the compact summary lacks. Do not repeat the summary.
Prioritize task state, decision anchors, verification facts, environment constraints, and next entry points.
