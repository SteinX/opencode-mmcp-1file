# AGENTS.md — opencode-mmcp-1file

OpenCode plugin providing persistent memory for AI agents via `memory-mcp-1file` MCP server.

## Build & Run

```bash
npm run build          # tsc → dist/
npm run prepublishOnly # same as build
```

No test framework or test scripts exist. No linter/formatter configured.

## Architecture

```
Plugin hooks (index.ts)
  ├── chat.message       → context injection + memory keyword nudge
  ├── event:session.idle → auto-capture conversation memories
  ├── event:compacted    → inject recovery context post-compaction
  ├── event:message.updated → preemptive compaction check
  └── tool:memory        → manual memory store/search/list
        ↓
  Services layer (src/services/)
        ↓
  MCP Client singleton (mcp-client.ts)
        ↓
  memory-mcp-1file server (stdio transport)
```

**Data flow**: Plugin hooks → services → MCP client → external MCP server. LLM client (`llm-client.ts`) used only for auto-capture summarization, not for memory storage.

## Conventions

- **Module system**: ES modules — `type: "module"` in package.json, **all imports use `.js` extensions** (mandatory for ESNext module resolution)
- **Naming**: camelCase functions/variables, PascalCase types/interfaces, kebab-case file names
- **State management**: Module-level singletons (`Map`, `Set`) for session tracking — no classes, no DI
- **Error handling**: try/catch with `logger.error()`, return `false`/`null` on failure — never throw to callers
- **Privacy**: All user content passes through `privacy.ts` filters before memory storage
- **SDK types**: `as any` casts used where OpenCode SDK type declarations are incomplete — this is intentional, not sloppy
- **Config**: JSONC format (`opencode-mmcp-1file.jsonc`), loaded via `loadConfig()` with 9 sections (autoCapture, contextInjection, preemptiveCompaction, memoryKeywordDetection, privacyFilter, compactionRecovery, memoryTool, llm, mcp)

## Key Files

| File | Role | Key exports |
|------|------|-------------|
| `src/index.ts` | Plugin entry, all hook registrations | `plugin` (default export via `definePlugin`) |
| `src/config.ts` | Config schema + loader | `PluginConfig`, `loadConfig()` |
| `src/services/mcp-client.ts` | MCP connection singleton | `recall()`, `searchMemory()`, `storeMemory()`, `listMemories()`, `disconnectMemoryClient()` |
| `src/services/auto-capture.ts` | Session-idle memory extraction | `performAutoCapture()` |
| `src/services/context-inject.ts` | Chat message memory injection | `shouldInjectMemories()`, `fetchAndFormatMemories()` |
| `src/services/preemptive-compaction.ts` | Token-based early compaction | `checkAndTriggerPreemptiveCompaction()` |
| `src/services/compaction.ts` | Post-compaction recovery | `buildCompactionRecoveryContext()` |
| `src/services/llm-client.ts` | OpenAI-compatible completions | `chatCompletion()` |
| `src/utils/format.ts` | Memory formatting + type maps | `MemoryEntry`, `formatMemoriesForInjection()`, `formatMemoriesForRecovery()` |
| `src/utils/keywords.ts` | Memory keyword detection (EN+CN) | `detectMemoryKeyword()`, `MEMORY_NUDGE_MESSAGE` |
| `src/utils/privacy.ts` | Content privacy filtering | `stripPrivateContent()`, `isFullyPrivate()` |

## Gotchas

- **Import extensions**: Always use `.js` in import paths, even for `.ts` source files. TypeScript's `bundler` module resolution requires this.
- **MCP client lifecycle**: `mcp-client.ts` lazily initializes a singleton connection. Call `disconnectMemoryClient()` only on plugin shutdown. Multiple concurrent callers share one connection.
- **Session tracking**: `injectedSessions` Set in `context-inject.ts` and `capturedSessions` Set in `auto-capture.ts` prevent duplicate operations per session. These reset only on process restart.
- **Config path**: `loadConfig()` searches for `opencode-mmcp-1file.jsonc` relative to CWD, not plugin install dir.
- **No tests**: There is no test infrastructure. Any new test framework would need to be set up from scratch.
- **CI/CD**: `.github/workflows/npm-publish.yml` uses manual dispatch (`workflow_dispatch`), bumps version, publishes to npm, creates GitHub release. Does NOT run tests (none exist).
