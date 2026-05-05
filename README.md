# opencode-mmcp-1file

[![npm version](https://img.shields.io/npm/v/opencode-mmcp-1file)](https://www.npmjs.com/package/opencode-mmcp-1file)
[![license](https://img.shields.io/npm/l/opencode-mmcp-1file)](./LICENSE)
[![node](https://img.shields.io/node/v/opencode-mmcp-1file)](https://nodejs.org)
[![GitHub Actions](https://img.shields.io/github/actions/workflow/status/SteinX/opencode-mmcp-1file/npm-publish.yml?label=publish)](https://github.com/SteinX/opencode-mmcp-1file/actions)

Persistent memory for OpenCode agents via [memory-mcp-1file](https://github.com/pomazanbohdan/memory-mcp-1file).

## What it does

This OpenCode plugin gives agents persistent memory across sessions. It connects to a `memory-mcp-1file` MCP server via stdio and registers **9 unified tools** as plugin tools — consolidating memory search, storage, lifecycle management, code intelligence, project indexing, and shared HTTP server control into an ergonomic interface with automatic routing. The plugin also provides automatic context injection, idle-time capture, background code-index refresh, compaction recovery, smart trigger nudges, agent guidance via system prompt, a `/init-mcp-memory` bootstrap command for deep project onboarding, a `/setup-mcp-memory` guided configuration wizard, and a `/manage-mcp-server` command for controlled HTTP lifecycle actions.

The plugin now distinguishes between a **physical storage shard** and a **logical retrieval scope**:
- `mcpServer.tag` / `dataDir` decide which on-disk memory store you are using.
- `memoryScope.namespace` narrows reads and writes *within* that shard.
- For agentic coding, the default is **shared memory across collaborating agents**. Agent/run identifiers are treated as provenance unless you explicitly opt into tighter isolation.

## Features

### Agent-facing (via plugin tool registration)

- **Unified Memory Tools (9 tools)** — The plugin consolidates 17 underlying MCP operations into 9 ergonomic tools:
  - `memory_query` — Unified search with auto/semantic/keyword/recent modes. Routes to the best search strategy automatically.
  - `memory_save` — Smart storage with auto-categorization (DECISION, TASK, PATTERN, BUGFIX, etc.) and privacy filtering.
  - `memory_manage` — Memory lifecycle: get, update, delete, or invalidate by ID.
  - `code_search` — Unified code intelligence: intent-based search, symbol lookup, and call graph traversal (callers/callees/related).
  - `project_status` — Project indexing and projections: list indexed projects, index new ones, view code statistics, build short-lived projections, or read them back by ephemeral locator.
  - `mcp_server_control` — Manage shared HTTP MCP server lifecycle with `status`, `stop`, and `restart` actions. HTTP transport only.
  - `knowledge_graph` — Map and query architectural relationships between codebase components. Use when analyzing system architecture, tracing module dependencies, or recording structural relationships. Actions: create_entity, create_relation, get_related, detect_communities.
  - `get_status` — Memory system status and startup progress.
  - `reload_config` — Hot-reload configuration from disk without restart.
- **System Prompt Guidance** — Injects a Memory Protocol into the system prompt via `experimental.chat.system.transform`, teaching the agent when and how to use memory tools, prefix conventions, memory lifecycle, action triggers, and anti-patterns.
- **Tool Description Enhancement** — Augments raw MCP tool descriptions via `tool.definition` hook with guidance that points agents back to the unified plugin tools first.
- **Keyword Detection** — Detects phrases like "remember this", "save this", "记住" in user messages and nudges the agent to store explicit user-requested memories with a `USER:` prefix.
- **Smart Triggers** — Detects decision points, new task starts, and error/debugging contexts in conversations, nudging the agent to store or recall memories at the right time (with 5-minute cooldown per trigger type).

### Plugin-managed (automatic, behind the scenes)

- **Memory Injection** — Injects query recall, project knowledge, and code-intelligence guidance independently, with per-source injection strategies, score filtering, dedupe, and source-specific budgets before synthetic context is added.
- **Auto-Capture** — When session goes idle (10s default), extracts the latest exchange, summarizes it via an external LLM, and stores with AGENTS.md-compatible prefixes.
- **Code Index Sync** — On startup and idle, computes a lightweight workspace fingerprint for code index freshness detection and refreshes stale code indexes in the background with debounce, cooldown, and single-flight locking. Freshness signals include common iOS, Android, and Flutter source/project/dependency metadata changes, while common generated/dependency directories are ignored. This is freshness detection only and does not add mobile semantic indexing, mobile parsers, or mobile LSP support. Sync metadata, cooldown, and lock contention are tracked per workspace inside the current shard. In HTTP mode, only the shared server's primary live holder coordinates freshness checks; follower clients skip redundant coordination work.
- **Compaction Recovery** — After context compaction, injects recovery guidance and relevant memories via `experimental.session.compacting` hook. Instructs the agent to use `memory_query` to restore in-progress tasks and project context.
- **Preemptive Compaction** — Tracks estimated token usage per session. When approaching model context limit (default 80%), triggers early compaction with memory context preserved.
- **Privacy Filtering** — Content wrapped in `<private>...</private>` is stripped to `[REDACTED]` before storing. Also intercepts agent's direct raw MCP `store_memory`/`update_memory` calls via `tool.execute.before`.
- **Compaction Summary Capture** — After compaction completes, stores the summary as a CONTEXT: memory for future reference.

## Install

```bash
npm install opencode-mmcp-1file
```

Add to your OpenCode configuration (`opencode.json` or `~/.config/opencode/config.json`):

```json
{
  "plugin": ["opencode-mmcp-1file"]
}
```

The plugin automatically spawns a [`memory-mcp-1file`](https://github.com/pomazanbohdan/memory-mcp-1file) server via stdio. No separate MCP server configuration needed.

## Configuration

Create `opencode-mmcp-1file.jsonc` at your project root or `~/.config/opencode/opencode-mmcp-1file.jsonc`:

```jsonc
{
  // Memory injection on user messages (READ)
  "chatMessage": {
    "enabled": true,
    "maxMemories": 5,
    "maxInjectedMemories": 6,       // Max query-recall memories injected after filtering/dedupe
    "maxProjectMemories": 30,       // Max memories to fetch for tiered allocation (pool size)
    "injectOn": "first",           // Query recall only: "first" or "always"
    "projectKnowledgeInjectOn": "first", // "first" | "always" | "compaction" | "never"
    "codeIntelInjectOn": "first",  // "first" | "always" | "compaction" | "never"
    "shortQueryMinLength": 3,       // Skip query recall for very short queries
    "minScore": 0.35,               // Query recall score threshold before injection
    "projectKnowledgeValidOnly": false, // Use only valid project memories when true
    "knowledgeGraphInjectOn": "first", // "first" | "always" | "compaction" | "never"
    "maxKnowledgeGraphItems": 10,   // Max related entities to inject from the graph
    "knowledgeGraphRelatedDepth": 1, // Traversal depth for related entity lookup
    "knowledgeGraphEntityMatch": true, // Enable automatic entity matching in conversation
    // Tiered injection: prioritize explicit user-requested memories first, then project guidance.
    // Set to null to disable and use flat recency-based list.
    "projectKnowledgeTiers": [
      { "categories": ["USER"], "limit": 5 },
      { "categories": ["DECISION", "PATTERN"], "limit": 5 },
      { "categories": ["CONTEXT"], "limit": 5 }
    ]
  },

  // Auto-capture on session idle (WRITE)
  "autoCapture": {
    "enabled": false,
    "debounceMs": 10000,
    "language": "en"
  },

  // Memory recovery after context compaction (READ)
  "compaction": {
    "enabled": true,
    "memoryLimit": 10
  },

  // Keyword detection for explicit memory requests
  // Agent should store these with a USER: prefix when they are direct user instructions to remember something.
  "keywordDetection": {
    "enabled": true,
    "extraPatterns": []              // Additional regex patterns to detect
  },

  // Preemptive compaction before hitting context limit
  "preemptiveCompaction": {
    "enabled": true,
    "thresholdPercent": 80,
    "modelContextLimit": 200000,
    "autoContinue": true
  },

  // Privacy: strip <private> tags before storing
  "privacy": {
    "enabled": true
  },

  // Store compaction summaries as memories
  "compactionSummaryCapture": {
    "enabled": true
  },

  // Plugin-managed code intelligence refresh
  "codeIndexSync": {
    "enabled": true,
    "debounceMs": 10000,            // Wait after detecting staleness before re-indexing
    "minReindexIntervalMs": 300000  // Cooldown between successful force re-indexes
  },

  // Preference learning from conversational signals
  "preferenceLearning": {
    "enabled": false,
    "learnOnCorrections": true,      // Learn when users correct prior assistant output
    "learnOnNegations": true,        // Learn when users reject/negate suggestions
    "learnOnMessageUpdated": true,   // Learn from message-updated events when available
    "injectOn": "first",            // "first" | "always" | "compaction" | "never"
    "scope": "project",             // "project" or "global"
    "minConfidence": 0.7,            // Minimum confidence required to persist a learned preference
    "candidateConfidence": 0.4,      // Lower threshold for candidate preferences pending stronger evidence
    "maxPreferences": 5,             // Max injected preferences per retrieval
    "maxCandidates": 3,              // Max candidate preferences tracked per cycle
    "debounceMs": 10000,             // Debounce learning updates to avoid rapid duplicate writes
    "maxInputChars": 4000,           // Truncate oversized inputs before preference extraction
    "maxStoredPreferences": 50       // Upper bound for stored preference records per scope
  },

  // LLM for auto-capture summarization
  // When apiKey is set: uses direct HTTP to the specified API (fastest)
  // When apiKey is empty: uses OpenCode's session API with your configured providers (zero-config)
  "captureModel": {
    "provider": "",                  // OpenCode provider ID (e.g. "openai", "anthropic"); empty = use default
    "model": "",                     // Model ID (e.g. "gpt-4o-mini"); empty = use default
    "apiUrl": "",                    // Only used with direct HTTP mode (when apiKey is set)
    "apiKey": ""                     // Optional; leave empty to use OpenCode session API
  },

  // Logical memory scope inside the current tag/dataDir shard
  "memoryScope": {
    "namespace": "",                 // Optional logical scope for one project/workstream inside the current shard
    "shareAcrossAgents": true,        // Default for agentic coding: collaborating agents read/write shared memory
    "includeAgentMetadata": true,     // Record source_agent_id in metadata for observability
    "includeRunMetadata": false,      // Record source_run_id in metadata when run/session provenance matters
    "userId": "",                    // Optional default user scope applied to reads/writes
    "defaultMetadata": {}             // Optional metadata merged into every write
  },

  // MCP server configuration (memory-mcp-1file)
  "mcpServer": {
    "command": ["npm", "exec", "-y", "memory-mcp-1file", "--"],
    "tag": "default",                // Physical storage shard; derives dataDir as ~/.local/share/opencode-mmcp-1file/{tag}
    // "dataDir": "",               // Override: explicit data directory (takes precedence over tag)
    "model": "qwen3",               // Embedding model for vector search
    "mcpServerName": "memory-mcp-1file",  // Cosmetic name for logging
    // "commandPath": "",            // Override: path to custom binary (plugin appends flags automatically)
    "transport": "stdio",            // "stdio" or "http" — HTTP mode shares one server across processes
    "port": 23817,                   // HTTP mode: server listen port
    "bind": "127.0.0.1",            // HTTP mode: server bind address
    "reconnectIntervalMs": 30000,    // Background reconnect cadence after failures
    "heartbeatIntervalMs": 20000     // HTTP mode: keepalive/liveness check while connected
  },

  // System prompt injection — guides agent on memory tool usage
  "systemPrompt": {
    "enabled": true
  }
}
```

### Configuration Sections

| Section | Purpose |
|---------|---------|
| **chatMessage** | Controls memory retrieval and injection into the chat stream |
| **autoCapture** | Idle-time memory extraction via external LLM |
| **compaction** | Memory re-injection after context compaction |
| **keywordDetection** | Detection of "remember" requests in user messages |
| **preemptiveCompaction** | Early compaction trigger based on token estimates |
| **privacy** | Redaction of `<private>` tagged content |
| **compactionSummaryCapture** | Saves compaction summaries as memories |
| **codeIndexSync** | Detects stale workspace indexes and refreshes code intelligence in the background |
| **preferenceLearning** | Controls preference extraction, confidence thresholds, scope, and injection cadence for learned user preferences |
| **captureModel** | LLM for auto-capture summarization — uses direct HTTP when apiKey is set, otherwise OpenCode session API |
| **memoryScope** | Logical scope, agent-sharing defaults, and default metadata layered inside the current shard |
| **mcpServer** | [`memory-mcp-1file`](https://github.com/pomazanbohdan/memory-mcp-1file) server command, physical data shard, embedding model, transport mode, and HTTP reconnect/heartbeat timing |
| **systemPrompt** | Agent guidance via Memory Protocol in system prompt |

By default, `USER:` memories are prioritized ahead of `DECISION:`, `PATTERN:`, and `CONTEXT:` in Project Knowledge. This keeps explicit user-requested memories more visible during session bootstrap and compaction recovery.

### Physical Shard vs Logical Scope

Use the two layers for different jobs:

- **`mcpServer.tag` / `dataDir`** — physical storage shard. Use this to separate unrelated projects, environments, or trust boundaries.
- **`memoryScope.namespace`** — logical scope within that shard. Use this for sub-workspaces, branches of work, or multi-tenant slices that should still live in the same store.

For agentic coding, the plugin defaults to **shared memory across collaborating agents**:

- `shareAcrossAgents: true` means reads are not filtered by `agent_id` by default.
- `includeAgentMetadata: true` records provenance as metadata (`source_agent_id`) so you can still inspect or filter later.
- `includeRunMetadata: false` avoids overfitting durable project memory to one transient session, but you can enable it when run/session provenance matters.

Examples:

```jsonc
// Project-specific physical shard
{ "mcpServer": { "tag": "my-project" } }
// → stores in ~/.local/share/opencode-mmcp-1file/my-project/

// Shared shard plus logical namespace separation
{
  "mcpServer": { "tag": "team-memory" },
  "memoryScope": { "namespace": "frontend" }
}
// → stores in ~/.local/share/opencode-mmcp-1file/team-memory/
// → reads/writes are filtered to namespace=frontend inside that shard

// Shared across all projects
{ "mcpServer": { "tag": "global" } }
// → stores in ~/.local/share/opencode-mmcp-1file/global/
```

Set `dataDir` to override the derived path entirely. If neither `tag` nor `dataDir` is set, the plugin is **disabled**.

Recommended rule of thumb:

- Change **`tag`** when you want a different physical store.
- Change **`memoryScope.namespace`** when you want a different retrieval boundary inside the same store.
- Only use **`agent_id`** overrides for explicit per-agent isolation workflows; do not make that your default collaboration model.

## Architecture

```
Plugin hooks (index.ts)
  ├── experimental.chat.system.transform → Memory Protocol system prompt
  ├── chat.message       → context injection + keyword nudge
  ├── tool.definition    → raw MCP tool hint enhancement
  ├── tool.execute.before → privacy filtering on agent store/update calls
  ├── experimental.session.compacting → compaction recovery context
  ├── event:session.idle → auto-capture + code-index freshness check
  ├── event:compacted    → inject recovery context
  ├── event:message.updated → preemptive compaction + summary capture
  └── tool              → 9 unified plugin tools
        ↓
  Services layer (src/services/)
    ├── tool-registry.ts  → register 9 unified tools (consolidating 17 MCP operations)
    ├── mcp-client.ts     → stdio/HTTP transport + centralized contract adapters
    ├── system-prompt.ts  → Memory Protocol prompt builder
    ├── auto-capture.ts   → LLM summarization + store
    ├── code-index-sync.ts → fingerprinting + background re-index
    ├── context-inject.ts → per-source memory injection assembly
    ├── compaction.ts     → recovery guidance + data
    ├── preemptive-compaction.ts → token tracking
    └── llm-client.ts     → OpenAI-compatible API
        ↓
  MCP Server (memory-mcp-1file)
    └── stdio or HTTP: plugin proxies tool calls
```

## How It Works

The plugin spawns a [`memory-mcp-1file`](https://github.com/pomazanbohdan/memory-mcp-1file) server via stdio and registers 9 unified tools that consolidate 17 underlying MCP operations into an ergonomic interface. The agent calls these tools directly; each call is automatically routed to the appropriate MCP operation.

`project_status` remains part of that same 9-tool surface. In addition to `list`, `index`, and `stats`, it now supports projection workflows with `action: "projection"` and `action: "projection_by_locator"`. Projection requests default to `relation_scope: "all"` and `sort_mode: "canonical"`, and any locator returned by the server is treated as an opaque, same-process, non-persistable handle.

`mcp_server_control` is also part of the same 9-tool surface and supports `action: "status" | "stop" | "restart"` for controlled shared HTTP MCP server lifecycle operations.

Memory context is also handled through **synthetic parts** — invisible in the OpenCode TUI but received by the LLM as part of the conversation. The agent has full access to past project context without cluttering the user's view.

## Project Initialization

The plugin ships with a `/init-mcp-memory` slash command that bootstraps deep project knowledge in memory. On first load, the command file is automatically installed to `~/.config/opencode/command/init-mcp-memory.md`.

### Usage

In OpenCode, run:

```
/init-mcp-memory
```

The agent will execute a 3-phase initialization:

1. **Code Intelligence Readiness** — Checks current index state first, only triggers indexing when missing or clearly stale, then verifies readiness with project stats.
2. **Deep Research** — Explores docs, configs, git history, dependencies, and code patterns. Stores findings as categorized memories (CONTEXT:, PATTERN:, DECISION:, etc.).
3. **Knowledge Graph** — Creates entities and relations for key architectural components, then runs community detection.

This typically involves 30–60+ tool calls and takes a few minutes. The result is a rich, queryable memory base the agent can draw on in future sessions.

### Manual Installation

If auto-install doesn't work (e.g. permissions), copy the command files manually:

```bash
cp node_modules/opencode-mmcp-1file/commands/init-mcp-memory.md ~/.config/opencode/command/
cp node_modules/opencode-mmcp-1file/commands/setup-mcp-memory.md ~/.config/opencode/command/
cp node_modules/opencode-mmcp-1file/commands/manage-mcp-server.md ~/.config/opencode/command/
```

## Configuration Setup

The plugin ships with a `/setup-mcp-memory` slash command that guides you through generating a project-scoped configuration file.

### Usage

In OpenCode, run:

```
/setup-mcp-memory
```

The agent will walk you through:

1. **Memory namespace** — choosing a `tag` to isolate this project's memories
2. **Logical scope** — optionally choosing a `memoryScope.namespace` inside that shard for narrower retrieval
3. **Auto-capture** — configuring the LLM provider and model for automatic memory extraction (API key optional)
4. **Embedding model** — selecting the local embedding model for code search
5. **Optional tuning** — memory injection frequency, context limits, privacy settings

After answering, the agent generates `opencode-mmcp-1file.jsonc` in the project root and calls `reload_config()` to apply changes immediately — no restart needed.

You can also re-run `/setup-mcp-memory` anytime to update your configuration.

## MCP Server Management

The plugin ships with a `/manage-mcp-server` slash command that controls the current shared HTTP MCP server through the local unified tool `mcp_server_control`.

### Usage

In OpenCode, run:

```
/manage-mcp-server
```

Choose one action:

1. `status` — returns current transport, running state, and HTTP URL/port when available.
2. `stop` — performs a controlled shutdown request in HTTP mode. If other live holders remain, it does not force-kill the shared server and reports that it is still running/reused.
3. `restart` — performs controlled HTTP restart by ensuring a running/healthy shared server and reports final URL/port after health verification.

Behavior by transport:

- **HTTP (`"transport": "http"`)** — all three actions are supported with controlled lifecycle behavior.
- **stdio (`"transport": "stdio"`)** — there is no shared HTTP server to stop or restart; actions return no-op status guidance.

## Requirements

- OpenCode v1.2.27+
- Node.js 18+
- For auto-capture: Works out of the box using OpenCode's session API; optionally set an API key for direct HTTP mode

## Troubleshooting: legacy `access_count` warning

If you see a startup warning like:

`Failed to deserialize field 'access_count' on type 'Memory': Expected number, got none`

this plugin should be treated as a **diagnose-only layer**. The warning is typically a
`memory-mcp-1file` storage/model compatibility issue, not a plugin-side schema or mutation path.

Recommended diagnosis path:

1. Confirm your `memory-mcp-1file` version and changelog for storage/model compatibility updates.
2. If core memory flows still work (`memory_query`, `memory_save`, `memory_manage`), keep the plugin running and monitor.
3. If warnings persist or functionality degrades, upgrade the `memory-mcp-1file` server and validate in a safe/staging environment first.

Safety guardrail:

- Do **not** manually edit or delete production memory DB records as a normal fix path from this plugin repository.

## Limitations

- **HTTP transport sharing** — In HTTP mode (`"transport": "http"`), multiple plugin processes share one MCP server instance via a file-based holder list. The lock file (`{dataDir}/.server-lock`) records the PID of each live client; on every read, dead PIDs are pruned to maintain an accurate holder count. The server remains resident by default for fast subsequent connections even after the last plugin process disconnects. `/manage-mcp-server` provides controlled status/stop/restart operations for this shared server. Controlled stop/restart does not force-kill when other live holders remain; the result reports that the server is still running/reused. Restart success is health-gated and reports the final server URL/port after verification. The first live holder also acts as the code-index sync leader, so follower clients skip redundant fingerprint/debounce/cooldown work and rely on the leader to trigger background re-indexing. Code-index sync state is tracked per workspace so multiple workspaces sharing one `tag` / `dataDir` do not overwrite each other's freshness metadata or cooldown timestamps. The shared server startup is coordinated via a separate `.server-startup-lock` which ensures that even during concurrent plugin launches, only one process attempts to spawn the server while others wait for it to become healthy. This eliminates the narrow race window previously present in rename-based atomic writes.
- **stdio lifecycle scope** — In stdio mode (`"transport": "stdio"`), each plugin process manages its own MCP server connection through stdio transport. There is no shared HTTP server for `/manage-mcp-server` to stop or restart.
- **Auto-capture LLM routing** — When `captureModel.apiKey` is set, auto-capture uses direct HTTP to the specified API. When empty, it falls back to OpenCode's session API (creates an ephemeral session, prompts, then deletes). The session API approach is zero-config but slightly slower due to session lifecycle overhead.
- **In-memory session tracking** — Duplicate-prevention state (`injectedSessions`, `capturedSessions`) is held in memory and resets on process restart. The first message after a restart may re-inject memories that were already injected in the previous session.
- **Tag-based privacy only** — Content is redacted only when explicitly wrapped in `<private>…</private>` tags. There is no automatic PII or secret detection.
- **Approximate token counting** — Preemptive compaction estimates token usage via `chars / 4`, not a real tokenizer. Thresholds may not trigger at the exact expected point.
- **Single default logical scope per config** — Each configuration has one default shard (`tag`/`dataDir`) and one default logical scope (`memoryScope.namespace`). Unified tools can override scope per call, but automatic plugin-managed retrieval uses the configured default scope.

## License

MIT
