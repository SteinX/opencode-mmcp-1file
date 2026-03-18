# opencode-mmcp-1file

Persistent memory for OpenCode agents via [memory-mcp-1file](https://github.com/pomazanbohdan/memory-mcp-1file).

## What it does

This OpenCode plugin gives agents persistent memory across sessions. It connects to a `memory-mcp-1file` MCP server via stdio and registers **11 core memory tools** as plugin tools, giving the agent direct access to store, search, and manage memories. The plugin also provides automatic context injection, idle-time capture, compaction recovery, and agent guidance via system prompt.

## Features

### Agent-facing (via plugin tool registration)

- **Direct Memory Tools** — The plugin registers 11 core memory tools (`store_memory`, `recall`, `search_memory`, `update_memory`, `delete_memory`, `get_memory`, `list_memories`, `invalidate`, `get_valid`, `knowledge_graph`, `get_status`) as plugin tools. Each proxies to the MCP server via stdio.
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

The plugin automatically spawns a [`memory-mcp-1file`](https://github.com/pomazanbohdan/memory-mcp-1file) server via stdio. No separate MCP server configuration needed.

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
| **captureModel** | LLM used for auto-capture summarization |
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
    ├── tool-registry.ts  → register 11 memory tools as plugin tools
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

The plugin spawns a [`memory-mcp-1file`](https://github.com/pomazanbohdan/memory-mcp-1file) server via stdio and registers 11 core memory tools as plugin tools. The agent calls these tools directly; each call is proxied to the MCP server.

Memory context is also handled through **synthetic parts** — invisible in the OpenCode TUI but received by the LLM as part of the conversation. The agent has full access to past project context without cluttering the user's view.

## Requirements

- OpenCode v1.2.27+
- Node.js 18+
- For auto-capture: An OpenAI-compatible API key

## License

MIT
