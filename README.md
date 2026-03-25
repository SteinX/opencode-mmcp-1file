# opencode-mmcp-1file

[![npm version](https://img.shields.io/npm/v/opencode-mmcp-1file)](https://www.npmjs.com/package/opencode-mmcp-1file)
[![license](https://img.shields.io/npm/l/opencode-mmcp-1file)](./LICENSE)
[![node](https://img.shields.io/node/v/opencode-mmcp-1file)](https://nodejs.org)
[![GitHub Actions](https://img.shields.io/github/actions/workflow/status/SteinX/opencode-mmcp-1file/npm-publish.yml?label=publish)](https://github.com/SteinX/opencode-mmcp-1file/actions)

Persistent memory for OpenCode agents via [memory-mcp-1file](https://github.com/pomazanbohdan/memory-mcp-1file).

## What it does

This OpenCode plugin gives agents persistent memory across sessions. It connects to a `memory-mcp-1file` MCP server via stdio and registers **8 unified tools** as plugin tools — consolidating memory search, storage, lifecycle management, code intelligence, and project indexing into an ergonomic interface with automatic routing. The plugin also provides automatic context injection, idle-time capture, compaction recovery, smart trigger nudges, agent guidance via system prompt, a `/init-mcp-memory` bootstrap command for deep project onboarding, and a `/setup-mcp-memory` guided configuration wizard.

## Features

### Agent-facing (via plugin tool registration)

- **Unified Memory Tools (8 tools)** — The plugin consolidates 17 underlying MCP operations into 8 ergonomic tools:
  - `memory_query` — Unified search with auto/semantic/keyword/recent modes. Routes to the best search strategy automatically.
  - `memory_save` — Smart storage with auto-categorization (DECISION, TASK, PATTERN, BUGFIX, etc.) and privacy filtering.
  - `memory_manage` — Memory lifecycle: get, update, delete, or invalidate by ID.
  - `code_search` — Unified code intelligence: intent-based search, symbol lookup, and call graph traversal (callers/callees/related).
  - `project_status` — Project indexing: list indexed projects, index new ones, or view code statistics.
  - `knowledge_graph` — Create entities/relations, query relationships, detect communities.
  - `get_status` — Memory system status and startup progress.
  - `reload_config` — Hot-reload configuration from disk without restart.
- **System Prompt Guidance** — Injects a Memory Protocol into the system prompt via `experimental.chat.system.transform`, teaching the agent when and how to use memory tools, prefix conventions, memory lifecycle, action triggers, and anti-patterns.
- **Tool Description Enhancement** — Augments MCP tool descriptions via `tool.definition` hook with contextual hints (prefix guidance for `store_memory`, hybrid search notes for `recall`, etc.).
- **Keyword Detection** — Detects phrases like "remember this", "save this", "记住" in user messages and nudges the agent to use memory tools.
- **Smart Triggers** — Detects decision points, new task starts, and error/debugging contexts in conversations, nudging the agent to store or recall memories at the right time (with 5-minute cooldown per trigger type).

### Plugin-managed (automatic, behind the scenes)

- **Memory Injection** — On first user message (or every message), recalls relevant memories via hybrid search and injects them as synthetic context the LLM sees but the user doesn't.
- **Auto-Capture** — When session goes idle (10s default), extracts the latest exchange, summarizes it via an external LLM, and stores with AGENTS.md-compatible prefixes.
- **Compaction Recovery** — After context compaction, injects recovery guidance and relevant memories via `experimental.session.compacting` hook. Instructs the agent to recall in-progress tasks and restore context.
- **Preemptive Compaction** — Tracks estimated token usage per session. When approaching model context limit (default 80%), triggers early compaction with memory context preserved.
- **Privacy Filtering** — Content wrapped in `<private>...</private>` is stripped to `[REDACTED]` before storing. Also intercepts agent's direct `store_memory`/`update_memory` calls via `tool.execute.before`.
- **Compaction Summary Capture** — After compaction completes, stores the summary as a CONTEXT: memory for future reference.
- **Fallback Memory Tool** — Exposes a `memory` tool (search/store/list) as fallback in case MCP registration fails.

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
    "maxProjectMemories": 30,       // Max memories to fetch for tiered allocation (pool size)
    "injectOn": "first",           // "first" = first message only, "always" = every message
    // Tiered injection: prioritize important categories over recency.
    // Set to null to disable and use flat recency-based list.
    "projectKnowledgeTiers": [
      { "categories": ["DECISION", "PATTERN"], "limit": 5 },
      { "categories": ["TASK"], "limit": 3 },
      { "categories": ["CONTEXT"], "limit": 4 },
      { "categories": [], "limit": 3 }
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

  // LLM for auto-capture summarization
  // When apiKey is set: uses direct HTTP to the specified API (fastest)
  // When apiKey is empty: uses OpenCode's session API with your configured providers (zero-config)
  "captureModel": {
    "provider": "",                  // OpenCode provider ID (e.g. "openai", "anthropic"); empty = use default
    "model": "",                     // Model ID (e.g. "gpt-4o-mini"); empty = use default
    "apiUrl": "",                    // Only used with direct HTTP mode (when apiKey is set)
    "apiKey": ""                     // Optional; leave empty to use OpenCode session API
  },

  // MCP server configuration (memory-mcp-1file)
  "mcpServer": {
    "command": ["npm", "exec", "-y", "memory-mcp-1file", "--"],
    "tag": "default",                // Memory namespace; derives dataDir as ~/.local/share/opencode-mmcp-1file/{tag}
    // "dataDir": "",               // Override: explicit data directory (takes precedence over tag)
    "model": "qwen3",               // Embedding model for vector search
    "mcpServerName": "memory-mcp-1file"  // Cosmetic name for logging
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
| **captureModel** | LLM for auto-capture summarization — uses direct HTTP when apiKey is set, otherwise OpenCode session API |
| **mcpServer** | [`memory-mcp-1file`](https://github.com/pomazanbohdan/memory-mcp-1file) server command, data directory, and embedding model |
| **systemPrompt** | Agent guidance via Memory Protocol in system prompt |

### Memory Namespaces via `tag`

The `tag` field controls where memories are stored. Different tags create isolated memory namespaces:

```jsonc
// Project-specific memories
{ "mcpServer": { "tag": "my-project" } }
// → stores in ~/.local/share/opencode-mmcp-1file/my-project/

// Shared across all projects
{ "mcpServer": { "tag": "global" } }
// → stores in ~/.local/share/opencode-mmcp-1file/global/
```

Set `dataDir` to override the derived path entirely. If neither `tag` nor `dataDir` is set, the plugin is **disabled**.

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
    ├── tool-registry.ts  → register 8 unified tools (consolidating 17 MCP operations)
    ├── mcp-client.ts     → stdio transport to MCP server
    ├── system-prompt.ts  → Memory Protocol prompt builder
    ├── auto-capture.ts   → LLM summarization + store
    ├── context-inject.ts → memory injection
    ├── compaction.ts     → recovery guidance + data
    ├── preemptive-compaction.ts → token tracking
    └── llm-client.ts     → OpenAI-compatible API
        ↓
  MCP Server (memory-mcp-1file)
    └── stdio: plugin spawns server, proxies tool calls
```

## How It Works

The plugin spawns a [`memory-mcp-1file`](https://github.com/pomazanbohdan/memory-mcp-1file) server via stdio and registers 8 unified tools that consolidate 17 underlying MCP operations into an ergonomic interface. The agent calls these tools directly; each call is automatically routed to the appropriate MCP operation.

Memory context is also handled through **synthetic parts** — invisible in the OpenCode TUI but received by the LLM as part of the conversation. The agent has full access to past project context without cluttering the user's view.

## Project Initialization

The plugin ships with a `/init-mcp-memory` slash command that bootstraps deep project knowledge in memory. On first load, the command file is automatically installed to `~/.config/opencode/command/init-mcp-memory.md`.

### Usage

In OpenCode, run:

```
/init-mcp-memory
```

The agent will execute a 3-phase initialization:

1. **Code Indexing** — Indexes the project directory via `index_project`, then verifies with `project_info`.
2. **Deep Research** — Explores docs, configs, git history, dependencies, and code patterns. Stores findings as categorized memories (CONTEXT:, PATTERN:, DECISION:, etc.).
3. **Knowledge Graph** — Creates entities and relations for key architectural components, then runs community detection.

This typically involves 30–60+ tool calls and takes a few minutes. The result is a rich, queryable memory base the agent can draw on in future sessions.

### Manual Installation

If auto-install doesn't work (e.g. permissions), copy the command files manually:

```bash
cp node_modules/opencode-mmcp-1file/commands/init-mcp-memory.md ~/.config/opencode/command/
cp node_modules/opencode-mmcp-1file/commands/setup-mcp-memory.md ~/.config/opencode/command/
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
2. **Auto-capture** — configuring the LLM provider and model for automatic memory extraction (API key optional)
3. **Embedding model** — selecting the local embedding model for code search
4. **Optional tuning** — memory injection frequency, context limits, privacy settings

After answering, the agent generates `opencode-mmcp-1file.jsonc` in the project root and calls `reload_config()` to apply changes immediately — no restart needed.

You can also re-run `/setup-mcp-memory` anytime to update your configuration.

## Requirements

- OpenCode v1.2.27+
- Node.js 18+
- For auto-capture: Works out of the box using OpenCode's session API; optionally set an API key for direct HTTP mode

## Limitations

- **Stdio transport only** — The MCP server is accessed exclusively via stdio. HTTP/SSE transport is not implemented, so external tools cannot connect to the memory server directly.
- **Auto-capture LLM routing** — When `captureModel.apiKey` is set, auto-capture uses direct HTTP to the specified API. When empty, it falls back to OpenCode's session API (creates an ephemeral session, prompts, then deletes). The session API approach is zero-config but slightly slower due to session lifecycle overhead.
- **In-memory session tracking** — Duplicate-prevention state (`injectedSessions`, `capturedSessions`) is held in memory and resets on process restart. The first message after a restart may re-inject memories that were already injected in the previous session.
- **Tag-based privacy only** — Content is redacted only when explicitly wrapped in `<private>…</private>` tags. There is no automatic PII or secret detection.
- **Approximate token counting** — Preemptive compaction estimates token usage via `chars / 4`, not a real tokenizer. Thresholds may not trigger at the exact expected point.
- **Single namespace per project** — Each configuration binds to one memory namespace (via `tag` or `dataDir`). Cross-namespace queries are not supported.

## License

MIT
