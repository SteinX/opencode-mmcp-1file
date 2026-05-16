# memory-plugin monorepo

Persistent memory plugins for agent clients backed by `memory-mcp-1file`.

## Packages

| Package | Role |
| --- | --- |
| `mmcp-1file-core` | Workspace-internal shared config, MCP client, memory formatting, recovery, capture, and learning logic. It is bundled into plugin packages and is not published separately in v1. |
| `opencode-mmcp-1file` | OpenCode plugin package. Keeps the original package name and public entrypoint. |
| `codex-mmcp-1file` | Codex plugin package with Context Router and Task Ledger hooks. |

## Commands

```bash
npm run build
npm run test
npm run bundle:core
npm run pack:dry-run
npm run build -w opencode-mmcp-1file
npm run build -w codex-mmcp-1file
npm run build -w mmcp-1file-core
```

OpenCode-specific documentation lives in `packages/opencode-plugin/README.md`.
Codex-specific documentation lives in `packages/codex-plugin/README.md`.
