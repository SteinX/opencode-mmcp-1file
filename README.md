# memory-plugin monorepo

Persistent memory plugins for agent clients backed by `memory-mcp-1file`.

## Packages

| Package | Role |
| --- | --- |
| `mmcp-1file-core` | Workspace-internal shared config, MCP client, memory formatting, recovery, capture, and learning logic. It is bundled into plugin packages and is not published separately in v1. |
| `opencode-mmcp-1file` | OpenCode plugin package. Keeps the original package name and public entrypoint. |
| `codex-mmcp-1file` | Private Codex plugin workspace. It builds hooks and a ready-to-run runtime tree for Codex marketplace installation; it is not published to npm. |

## Commands

```bash
npm run build
npm run test
npm run bundle:core
npm run build:codex-runtime
npm run verify:codex-runtime
npm run pack:dry-run
npm run build -w opencode-mmcp-1file
npm run build -w codex-mmcp-1file
npm run build -w mmcp-1file-core
```

OpenCode-specific documentation lives in `packages/opencode-plugin/README.md`.
Codex-specific documentation lives in `packages/codex-plugin/README.md`.

## Release Model

- `opencode-mmcp-1file` is released to npm.
- `codex-mmcp-1file` is released through the Codex marketplace. The repository marketplace points at the ready-to-run runtime tree on the `codex-mmcp-1file-runtime` release branch via the `codex-mmcp-1file@x.y.z` tag.
- GitHub Releases attach the same Codex runtime tree as `.tgz` and `.zip` artifacts for audit or manual installation.
