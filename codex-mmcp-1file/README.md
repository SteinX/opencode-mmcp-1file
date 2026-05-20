# codex-mmcp-1file

Codex plugin for `memory-mcp-1file`.

## What it does

- `UserPromptSubmit` hook injects concise memory context before a prompt reaches the model.
- Codex built-in memory summaries and nearest `AGENTS.md` guidance are read as auxiliary context only.
- `Stop` hook captures a task ledger from the transcript and stores reusable facts.
- Recovery content is additive: it avoids repeating compact summaries and focuses on missing operational context.
- When supported by the server, hooks prefer `memory_bootstrap` for prompt/recovery context and `memory_observation_create` for stop-time ledger capture. Older servers fall back to the legacy recall and `store_memory` paths.
- The plugin does not declare a static Codex MCP server. Hooks use the current workspace config, whose default `mcpServer.command` runs the `@steinx/memory-mcp-1file` package, and connect only when `mcpServer.tag` or `mcpServer.dataDir` enables memory.

## Marketplace install

This repository publishes a Codex marketplace at `.codex-plugin/marketplace.json`. The stable marketplace entry uses `git-subdir` and points to the generated runtime tree on the `codex-mmcp-1file-runtime` release branch:

- path: `./codex-mmcp-1file`
- ref: `codex-mmcp-1file@x.y.z`

The runtime tree contains the actual plugin manifest, hooks, skills, compiled `dist/`, bundled `mmcp-1file-core`, and production runtime dependencies.

After adding the marketplace in Codex, enable `codex-mmcp-1file`. Edit source files in this repository, not the loaded cache under `~/.codex/plugins/cache`.

## Build

```bash
npm run build -w codex-mmcp-1file
npm run test -w codex-mmcp-1file
npm run build:codex-runtime
npm run verify:codex-runtime
```

## Release

`codex-mmcp-1file` is not published to npm. The npm workspace is private and exists only for local build/test and runtime generation.

The release workflow builds the runtime tree at `dist/codex-runtime/codex-mmcp-1file`, pushes that tree to the `codex-mmcp-1file-runtime` branch, tags it as `codex-mmcp-1file@x.y.z`, and attaches `.tgz` / `.zip` copies to the GitHub Release.

The Codex runtime includes:

- `.codex-plugin/plugin.json`
- `hooks/hooks.json`
- `skills/memory/SKILL.md`
- `dist/`
- `node_modules/mmcp-1file-core/`
- production runtime dependencies used by hooks
