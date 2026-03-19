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
    ├── tool-registry.ts  → register 16 memory + code intelligence tools as plugin tools
    ├── mcp-client.ts     → stdio transport to MCP server
    └── ...other services
        ↓
  memory-mcp-1file server (stdio)
    └── spawned by plugin, tool calls proxied via StdioClientTransport
```

**Data flow**: Plugin hooks → services → MCP client → MCP server. Plugin manages server lifecycle (spawn, shutdown). LLM client (`llm-client.ts`) used only for auto-capture summarization.

## Conventions

- **Module system**: ES modules — `type: "module"` in package.json, **all imports use `.js` extensions** (mandatory for ESNext module resolution)
- **Naming**: camelCase functions/variables, PascalCase types/interfaces, kebab-case file names
- **State management**: Module-level singletons (`Map`, `Set`) for session tracking — no classes, no DI
- **Error handling**: try/catch with `logger.error()`, return `false`/`null` on failure — never throw to callers
- **Privacy**: Content passes through `privacy.ts` filters before memory storage. Also intercepted via `tool.execute.before` hook for agent's direct MCP calls.
- **SDK types**: `as any` casts used where OpenCode SDK type declarations are incomplete — this is intentional, not sloppy
- **Config**: JSONC format (`opencode-mmcp-1file.jsonc`), loaded via `loadConfig()` with 10 sections (chatMessage, autoCapture, compaction, keywordDetection, preemptiveCompaction, privacy, compactionSummaryCapture, captureModel, mcpServer, systemPrompt)
- **Transport**: Stdio only — plugin spawns MCP server via `StdioClientTransport`. HTTP/SSE transport is not implemented (server-process.ts is a placeholder).
- **Testing**: When adding or modifying functionality, the corresponding unit tests in `tests/` **must** be created or updated in the same change. Follow existing test patterns (vitest, `vi.mock()` for dependencies). Run `npm run test` to verify before considering work complete.
- **Sync rule**: Any change to config schema (`src/config.ts` `PluginConfig`), default values (`DEFAULT_CONFIG`), or config-driven behavior **must** be reflected in all three places in the same commit: (1) code implementation, (2) `README.md` Configuration section (both the JSONC example block and the config sections table), (3) example config file `opencode-mmcp-1file.jsonc`. If a section is added/removed/renamed, update the section count in this file's Conventions → Config bullet as well.

## Key Files

| File | Role | Key exports |
|------|------|-------------|
| `src/index.ts` | Plugin entry, all hook registrations | `plugin` (default export via `definePlugin`) |
| `src/config.ts` | Config schema + loader + hot-reload | `PluginConfig`, `loadConfig()`, `resolveDataDir()`, `applyConfig()` |
| `src/services/server-process.ts` | MCP server spawn + lifecycle (placeholder) | `stopServer()` (no-op placeholder) |
| `src/services/mcp-client.ts` | MCP connection singleton (stdio) | `recall()`, `searchMemory()`, `storeMemory()`, `listMemories()`, `discoverTools()`, `disconnectMemoryClient()` |
| `src/services/tool-registry.ts` | Register 16 memory + code intelligence tools as plugin tools | `buildToolRegistry()` |
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
| `commands/init-mcp-memory.md` | `/init-mcp-memory` slash command for project bootstrap | N/A (Markdown prompt) |
| `commands/setup-mcp-memory.md` | `/setup-mcp-memory` slash command for guided config setup | N/A (Markdown prompt) |

## Gotchas

- **Import extensions**: Always use `.js` in import paths, even for `.ts` source files. TypeScript's `bundler` module resolution requires this.
- **MCP server lifecycle**: `server-process.ts` is currently a placeholder (no-op `stopServer()`). Stdio transport lifecycle is managed by `StdioClientTransport` in `mcp-client.ts`.
- **MCP client transport selection**: `mcp-client.ts` uses only `StdioClientTransport`. Connection is lazy-initialized as a singleton — first call to `getMemoryClient()` spawns the process.
- **Session tracking**: `injectedSessions` Set in `context-inject.ts` and `capturedSessions` Set in `auto-capture.ts` prevent duplicate operations per session. These reset only on process restart.
- **Config path**: `loadConfig()` searches for `opencode-mmcp-1file.jsonc` relative to CWD, not plugin install dir.
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
