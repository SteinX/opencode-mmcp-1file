# AGENTS.md — opencode-mmcp-1file

OpenCode plugin providing persistent memory for AI agents via `memory-mcp-1file` MCP server.

## Build & Run

```bash
npm run build          # tsc → dist/
npm run prepublishOnly # same as build
npm run test           # vitest run
```

No linter/formatter configured.

## Architecture

```
Plugin hooks (index.ts)
  ├── experimental.chat.system.transform → Memory Protocol system prompt
  ├── chat.message       → context injection + keyword nudge
  ├── tool.definition    → MCP tool description enhancement
  ├── tool.execute.before → privacy filtering on agent store/update calls
  ├── experimental.session.compacting → compaction recovery context
  ├── event:session.idle → auto-capture via LLM
  ├── event:compacted    → inject recovery context
  ├── event:message.updated → preemptive compaction + summary capture
  └── tool:memory        → fallback memory tool (search/store/list)
        ↓
  Services layer (src/services/)
    ├── server-process.ts → spawn MCP server (HTTP mode)
    ├── mcp-client.ts     → dual transport (SSE / stdio)
    └── ...other services
        ↓
  memory-mcp-1file server
    ├── HTTP mode: spawned by plugin, registered in OpenCode via client.mcp.add()
    └── stdio mode: fallback, plugin-only connection
```

**Data flow**: Plugin hooks → services → MCP client → MCP server. Plugin manages server lifecycle (spawn, register, shutdown). In HTTP mode, agent also talks to server directly via OpenCode MCP integration. LLM client (`llm-client.ts`) used only for auto-capture summarization.

## Conventions

- **Module system**: ES modules — `type: "module"` in package.json, **all imports use `.js` extensions** (mandatory for ESNext module resolution)
- **Naming**: camelCase functions/variables, PascalCase types/interfaces, kebab-case file names
- **State management**: Module-level singletons (`Map`, `Set`) for session tracking — no classes, no DI
- **Error handling**: try/catch with `logger.error()`, return `false`/`null` on failure — never throw to callers
- **Privacy**: Content passes through `privacy.ts` filters before memory storage. Also intercepted via `tool.execute.before` hook for agent's direct MCP calls.
- **SDK types**: `as any` casts used where OpenCode SDK type declarations are incomplete — this is intentional, not sloppy
- **Config**: JSONC format (`opencode-mmcp-1file.jsonc`), loaded via `loadConfig()` with 10 sections (chatMessage, autoCapture, compaction, keywordDetection, preemptiveCompaction, privacy, compactionSummaryCapture, captureModel, mcpServer, systemPrompt)
- **Transport**: HTTP mode (default) spawns server with `--listen :PORT`, connects via SSE. Stdio mode is automatic fallback if HTTP fails.
- **Testing**: When adding or modifying functionality, the corresponding unit tests in `tests/` **must** be created or updated in the same change. Follow existing test patterns (vitest, `vi.mock()` for dependencies). Run `npm run test` to verify before considering work complete.

## Key Files

| File | Role | Key exports |
|------|------|-------------|
| `src/index.ts` | Plugin entry, all hook registrations | `plugin` (default export via `definePlugin`) |
| `src/config.ts` | Config schema + loader | `PluginConfig`, `loadConfig()`, `resolveDataDir()` |
| `src/services/server-process.ts` | MCP server spawn + lifecycle (HTTP mode) | `startServer()`, `stopServer()`, `getServerUrl()`, `isServerRunning()` |
| `src/services/mcp-client.ts` | MCP connection singleton (SSE or stdio) | `recall()`, `searchMemory()`, `storeMemory()`, `listMemories()`, `discoverTools()`, `disconnectMemoryClient()` |
| `src/services/system-prompt.ts` | Memory Protocol system prompt builder | `buildMemorySystemPrompt()` |
| `src/services/auto-capture.ts` | Session-idle memory extraction | `performAutoCapture()` |
| `src/services/context-inject.ts` | Chat message memory injection | `shouldInjectMemories()`, `fetchAndFormatMemories()` |
| `src/services/preemptive-compaction.ts` | Token-based early compaction | `checkAndTriggerPreemptiveCompaction()` |
| `src/services/compaction.ts` | Post-compaction recovery guidance + data | `buildCompactionRecoveryContext()` |
| `src/services/llm-client.ts` | OpenAI-compatible completions | `chatCompletion()` |
| `src/utils/format.ts` | Memory formatting helpers | `MemoryEntry`, `formatMemoriesForInjection()`, `formatMemoriesForRecovery()` |
| `src/utils/keywords.ts` | Memory keyword detection (EN+CN) | `detectMemoryKeyword()`, `MEMORY_NUDGE_MESSAGE` |
| `src/utils/privacy.ts` | Content privacy filtering | `stripPrivateContent()`, `isFullyPrivate()`, `containsPrivateTag()` |
| `src/utils/logger.ts` | Logging wrapper | `initLogger()`, `logger` |

## Gotchas

- **Import extensions**: Always use `.js` in import paths, even for `.ts` source files. TypeScript's `bundler` module resolution requires this.
- **MCP server lifecycle**: In HTTP mode, `server-process.ts` spawns the server and polls `/sse` for readiness (30s timeout). `stopServer()` sends SIGTERM with 5s grace before SIGKILL.
- **MCP client transport selection**: `mcp-client.ts` checks `isServerRunning()` — if the HTTP server is up, connects via SSE; otherwise falls back to stdio. This is transparent to callers.
- **OpenCode MCP registration**: Uses `client.mcp.add({ body: { name, config: { type: "remote", url } } })` — this is a v1 SDK pattern with `as any` cast since types are incomplete.
- **Session tracking**: `injectedSessions` Set in `context-inject.ts` and `capturedSessions` Set in `auto-capture.ts` prevent duplicate operations per session. These reset only on process restart.
- **Config path**: `loadConfig()` searches for `opencode-mmcp-1file.jsonc` relative to CWD, not plugin install dir.
- **Plugin disabled state**: If neither `tag` nor `dataDir` is set in config, `resolveDataDir()` returns `null` and the plugin returns `{}` (no hooks registered).
- **SSE transport**: Uses `SSEClientTransport` (deprecated in MCP SDK but needed for `rmcp`-based servers that don't support Streamable HTTP yet).
- **CI/CD**: `.github/workflows/npm-publish.yml` uses manual dispatch (`workflow_dispatch`), bumps version, publishes to npm, creates GitHub release.

## Plan Submission

When you have completed your plan, you MUST call the `submit_plan` tool to submit it for user review.
The user will be able to:
- Review your plan visually in a dedicated UI
- Annotate specific sections with feedback
- Approve the plan to proceed with implementation
- Request changes with detailed feedback

If your plan is rejected, you will receive the user's annotated feedback. Revise your plan
based on their feedback and call submit_plan again.

Do NOT proceed with implementation until your plan is approved.
