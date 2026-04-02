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
  ├── event:session.idle → auto-capture + code-index freshness check
  ├── event:compacted    → inject recovery context
  ├── event:message.updated → preemptive compaction + summary capture
  └── tool:memory        → fallback memory tool (search/store/list)
        ↓
  Services layer (src/services/)
    ├── tool-registry.ts  → register 8 unified tools (consolidating 17 MCP operations)
    ├── mcp-client.ts     → stdio/HTTP transport to MCP server
    ├── server-process.ts → HTTP server lifecycle (spawn, health check, refcount)
    └── ...other services
        ↓
  memory-mcp-1file server (stdio or HTTP)
    └── stdio: spawned per-process via StdioClientTransport
    └── http: shared server via StreamableHTTPClientTransport + file-based refcount
```

**Data flow**: Plugin hooks → services → MCP client → MCP server. In stdio mode, `StdioClientTransport` manages the server process. In HTTP mode, `server-process.ts` manages a shared server with file-based reference counting — first process spawns, last process kills. LLM client (`llm-client.ts`) used only for auto-capture summarization.

## Conventions

- **Module system**: ES modules — `type: "module"` in package.json, **all imports use `.js` extensions** (mandatory for ESNext module resolution)
- **Naming**: camelCase functions/variables, PascalCase types/interfaces, kebab-case file names
- **State management**: Module-level singletons (`Map`, `Set`) for session tracking — no classes, no DI
- **Error handling**: try/catch with `logger.error()`, return `false`/`null` on failure — never throw to callers
- **Privacy**: Content passes through `privacy.ts` filters before memory storage. Also intercepted via `tool.execute.before` hook for agent's direct MCP calls.
- **SDK types**: `as any` casts used where OpenCode SDK type declarations are incomplete — this is intentional, not sloppy
- **Config**: JSONC format (`opencode-mmcp-1file.jsonc`), loaded via `loadConfig()` with 11 sections (chatMessage, autoCapture, compaction, keywordDetection, preemptiveCompaction, privacy, compactionSummaryCapture, codeIndexSync, captureModel, mcpServer, systemPrompt)
- **Transport**: Stdio (default) or HTTP. Stdio spawns one server per plugin process via `StdioClientTransport`. HTTP mode uses `StreamableHTTPClientTransport` with a shared server managed by `server-process.ts` (spawn, health check, file-based refcount).
- **Testing**: When adding or modifying functionality, the corresponding unit tests in `tests/` **must** be created or updated in the same change. Follow existing test patterns (vitest, `vi.mock()` for dependencies). Run `npm run test` to verify before considering work complete.
- **Sync rule**: Any change to config schema (`src/config.ts` `PluginConfig`), default values (`DEFAULT_CONFIG`), or config-driven behavior **must** be reflected in all three places in the same commit: (1) code implementation, (2) `README.md` Configuration section (both the JSONC example block and the config sections table), (3) example config file `opencode-mmcp-1file.example.jsonc`. If a section is added/removed/renamed, update the section count in this file's Conventions → Config bullet as well.
- **Example config rule**: `opencode-mmcp-1file.example.jsonc` must always reflect the **complete, current feature set** — every config section, every field, with accurate default values and descriptive comments. When any feature is added, removed, or changed, the example config must be updated in the same commit. Treat it as the single source of truth for users; a stale or incomplete example config is a bug.

## Key Files

| File | Role | Key exports |
|------|------|-------------|
| `src/index.ts` | Plugin entry, all hook registrations | `plugin` (default export via `definePlugin`) |
| `src/config.ts` | Config schema + loader + hot-reload | `PluginConfig`, `loadConfig()`, `resolveDataDir()`, `applyConfig()` |
| `src/services/server-process.ts` | HTTP server lifecycle: spawn, health check, refcount lock file | `getServerUrl()`, `isServerRunning()`, `ensureServerRunning()`, `stopServer()` |
| `src/services/mcp-client.ts` | MCP connection singleton (stdio or HTTP) | `recall()`, `searchMemory()`, `storeMemory()`, `listMemories()`, `discoverTools()`, `disconnectMemoryClient()` |
| `src/services/tool-registry.ts` | Register 8 unified tools (consolidating 17 MCP operations) | `buildToolRegistry()` |
| `src/services/system-prompt.ts` | Memory Protocol system prompt builder | `buildMemorySystemPrompt()` |
| `src/services/auto-capture.ts` | Session-idle memory extraction | `performAutoCapture()` |
| `src/services/code-index-sync.ts` | Workspace fingerprinting + deferred re-index | `ensureCodeIndexFresh()`, `computeWorkspaceFingerprint()` |
| `src/services/context-inject.ts` | Chat message memory injection | `shouldInjectMemories()`, `fetchAndFormatMemories()` |
| `src/services/preemptive-compaction.ts` | Token-based early compaction | `checkAndTriggerPreemptiveCompaction()` |
| `src/services/compaction.ts` | Post-compaction recovery guidance + data | `buildCompactionRecoveryContext()` |
| `src/services/llm-client.ts` | OpenAI-compatible completions | `chatCompletion()` |
| `src/utils/format.ts` | Memory formatting helpers | `MemoryEntry`, `formatMemoriesForInjection()`, `formatMemoriesForRecovery()` |
| `src/utils/triggers.ts` | Smart trigger detection for decision/task/error nudges | `checkTriggers()`, `clearNudgeHistory()` |
| `src/utils/keywords.ts` | Memory keyword detection (EN+CN) | `detectMemoryKeyword()`, `MEMORY_NUDGE_MESSAGE` |
| `src/utils/privacy.ts` | Content privacy filtering | `stripPrivateContent()`, `isFullyPrivate()`, `containsPrivateTag()` |
| `src/utils/logger.ts` | Logging wrapper | `initLogger()`, `logger` |
| `commands/init-mcp-memory.md` | `/init-mcp-memory` slash command for project bootstrap | N/A (Markdown prompt) |
| `commands/setup-mcp-memory.md` | `/setup-mcp-memory` slash command for guided config setup | N/A (Markdown prompt) |

## Gotchas

- **Import extensions**: Always use `.js` in import paths, even for `.ts` source files. TypeScript's `bundler` module resolution requires this.
- **MCP server lifecycle**: In stdio mode, `StdioClientTransport` manages the process. In HTTP mode, `server-process.ts` manages a shared server with a lock file at `{dataDir}/.server-lock` containing PID, port, and refcount. First process spawns, last process kills.
- **MCP client transport selection**: `mcp-client.ts` branches on `config.mcpServer.transport` — `"stdio"` uses `StdioClientTransport`, `"http"` uses `StreamableHTTPClientTransport`. Connection is lazy-initialized as a singleton.
- **Session tracking**: `injectedSessions` Set in `context-inject.ts` and `capturedSessions` Set in `auto-capture.ts` prevent duplicate operations per session. These reset only on process restart.
- **Config path**: `loadConfig()` searches for `opencode-mmcp-1file.jsonc` relative to CWD, not plugin install dir. The repo tracks `opencode-mmcp-1file.example.jsonc` as a template; `opencode-mmcp-1file.jsonc` is gitignored for local use.
- **Plugin disabled state**: If neither `tag` nor `dataDir` is set in config, `resolveDataDir()` returns `null` and the plugin returns `{}` (no hooks registered).
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
