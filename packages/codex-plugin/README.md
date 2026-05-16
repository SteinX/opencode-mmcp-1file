# codex-mmcp-1file

Codex plugin for `memory-mcp-1file`.

## What it does

- `UserPromptSubmit` hook injects concise memory context before a prompt reaches the model.
- Codex built-in memory summaries and nearest `AGENTS.md` guidance are read as auxiliary context only.
- `Stop` hook captures a task ledger from the transcript and stores reusable facts.
- Recovery content is additive: it avoids repeating compact summaries and focuses on missing operational context.
- The plugin does not declare a static Codex MCP server. Hooks connect to `memory-mcp-1file` only when the current workspace config enables memory with `mcpServer.tag` or `mcpServer.dataDir`.

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
