# opencode-mmcp-1file

Persistent memory for OpenCode agents via [memory-mcp-1file](https://github.com/pomazanbohdan/memory-mcp-1file).

## What it does

This OpenCode plugin gives agents persistent memory across sessions. It manages a `memory-mcp-1file` MCP server, registers it in OpenCode so the agent gets **direct access to all 18 memory tools**, and enhances the experience with automatic context injection, idle-time capture, compaction recovery, and agent guidance via system prompt.

## Features

### Agent-facing (via MCP server registration)

- **Direct Memory Tools** — The plugin spawns and registers the MCP server in OpenCode. The agent gets direct access to `store_memory`, `recall`, `search_memory`, `update_memory`, `invalidate`, `knowledge_graph`, and all other MCP tools — no wrapper needed.
- **System Prompt Guidance** — Injects a Memory Protocol into the system prompt via `experimental.chat.system.transform`, teaching the agent when and how to use memory tools, prefix conventions (DECISION:, TASK:, PATTERN:, etc.), and memory lifecycle.
- **Tool Description Enhancement** — Augments MCP tool descriptions via `tool.definition` hook with contextual hints (prefix guidance for `store_memory`, hybrid search notes for `recall`, etc.).
- **Keyword Detection** — Detects phrases like "remember this", "save this", "记住" in user messages and nudges the agent to use `store_memory`.

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

The plugin automatically spawns an MCP server in HTTP mode and registers it in OpenCode. No separate MCP server configuration needed.

## Configuration

Create `opencode-mmcp-1file.jsonc` at your project root or `~/.config/opencode/opencode-mmcp-1file.jsonc`:

```jsonc
{
  // Memory injection on user messages (READ)
  "chatMessage": {
    "enabled": true,
    "maxMemories": 5,
    "injectOn": "first"            // "first" = first message only, "always" = every message
  },

  // Auto-capture on session idle (WRITE)
  "autoCapture": {
    "enabled": true,
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

  // LLM for auto-capture summarization (OpenAI-compatible API)
  "captureModel": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "apiUrl": "https://api.openai.com/v1",
    "apiKey": ""                     // Required for auto-capture; leave empty to disable
  },

  // MCP server configuration (memory-mcp-1file)
  "mcpServer": {
    "command": ["npx", "-y", "memory-mcp-1file"],
    "tag": "default",                // Memory namespace; derives dataDir as ~/.local/share/opencode-mmcp-1file/{tag}
    // "dataDir": "",               // Override: explicit data directory (takes precedence over tag)
    "model": "qwen3",               // Embedding model for vector search
    "transport": "http",             // "http" (recommended) or "stdio" (fallback)
    "port": 23817,                   // HTTP server port (only used when transport is "http")
    "registerInOpencode": true,      // Register MCP server in OpenCode for direct agent access
    "mcpServerName": "memory-mcp-1file"  // Name used when registering in OpenCode
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
| **captureModel** | LLM used for auto-capture summarization |
| **mcpServer** | MCP server spawn, transport, and registration settings |
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
    ├── server-process.ts → spawn MCP server (HTTP mode)
    ├── mcp-client.ts     → dual transport (SSE / stdio)
    ├── system-prompt.ts  → Memory Protocol prompt builder
    ├── auto-capture.ts   → LLM summarization + store
    ├── context-inject.ts → memory injection
    ├── compaction.ts     → recovery guidance + data
    ├── preemptive-compaction.ts → token tracking
    └── llm-client.ts     → OpenAI-compatible API
        ↓
  MCP Server (memory-mcp-1file)
    ├── HTTP mode: plugin spawns server, registers in OpenCode
    │   → agent uses 18 MCP tools directly
    │   → plugin connects via SSE for internal operations
    └── stdio mode: fallback, plugin-only connection
```

### Transport Modes

**HTTP mode** (default, recommended):
1. Plugin spawns MCP server with `--listen :PORT`
2. Plugin registers server in OpenCode via `client.mcp.add()`
3. Agent gets direct access to all 18 MCP tools
4. Plugin connects via SSE for its own internal operations (injection, capture, etc.)

**Stdio mode** (fallback):
1. Plugin spawns MCP server via stdio
2. Only the plugin can talk to the server
3. Agent uses the fallback `memory` tool (3 modes only)

## How It Works

Memory context is handled through **synthetic parts** — invisible in the OpenCode TUI but received by the LLM as part of the conversation. The agent has full access to past project context without cluttering the user's view.

In HTTP mode, the agent also has **direct MCP tool access**, meaning it can proactively store, search, update, and manage memories without the plugin acting as intermediary.

## Requirements

- OpenCode v1.2.27+
- Node.js 18+
- For auto-capture: An OpenAI-compatible API key

## License

MIT
