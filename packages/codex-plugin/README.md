# codex-mmcp-1file

Codex plugin for `memory-mcp-1file`.

## What it does

- `UserPromptSubmit` hook injects concise memory context before a prompt reaches the model.
- Codex built-in memory summaries and nearest `AGENTS.md` guidance are read as auxiliary context only.
- `Stop` hook captures a task ledger from the transcript and stores reusable facts.
- Recovery content is additive: it avoids repeating compact summaries and focuses on missing operational context.
- When supported by the server, hooks prefer `memory_bootstrap` for prompt/recovery context and `memory_observation_create` for stop-time ledger capture. Older servers fall back to the legacy recall and `store_memory` paths.
- The plugin does not declare a static Codex MCP server. Hooks connect to `memory-mcp-1file` only when the current workspace config enables memory with `mcpServer.tag` or `mcpServer.dataDir`.

## Marketplace install

This repository publishes a Codex marketplace at `.codex-plugin/marketplace.json`. The marketplace entry uses `git-subdir` and points to `./packages/codex-plugin`, where the actual plugin manifest lives.

After adding the marketplace in Codex, enable `codex-mmcp-1file`. Edit source files in this repository, not the loaded cache under `~/.codex/plugins/cache`.

## Build

```bash
npm run build -w codex-mmcp-1file
npm run test -w codex-mmcp-1file
```

## Package contents

The published package includes:

- `.codex-plugin/plugin.json`
- `hooks/hooks.json`
- `skills/memory/SKILL.md`
- `dist/`
