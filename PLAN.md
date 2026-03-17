# Memory Plugin for OpenCode — Implementation Plan

## Goal
Build an OpenCode plugin that makes agents **proactively use project-memory MCP** without relying on AGENTS.md instructions. The plugin hooks into the framework layer to automatically read and write memories.

## Architecture

### Storage Backend
Uses the existing `project-memory` MCP server (already running). The plugin communicates with it via the OpenCode SDK's MCP tool-calling API (`client.mcp.tool.call()`), not direct HTTP/gRPC.

### Three Core Mechanisms

#### 1. Memory Injection on Chat (READ — `chat.message` hook)
**When**: Every user message (configurable: first-only or always)
**What**: Fetch relevant memories from project-memory and prepend them as a synthetic text part
**How**:
1. Hook fires → check injection policy (`injectOn: 'first' | 'always'`)
2. Call `project-memory.recall(query=<user_message_text>, limit=5)` via MCP
3. Format results as structured markdown: `[MEMORY] Project Knowledge:\n- {content}`
4. Build a valid `TextPart` with proper branded IDs and unshift into `output.parts`

**Part format** (CRITICAL — opencode v1.2.25+ validates strictly):

IDs are branded strings with **mandatory prefix validation** (`z.string().startsWith(prefix)`):
- `PartID` — must start with `prt`
- `MessageID` — must start with `msg`
- `SessionID` — must start with `ses`

```typescript
// Proven format from opencode-mem v2.12.0:
const syntheticPart = {
  id: `prt-memory-context-${Date.now()}`,  // MUST start with "prt"
  sessionID: input.sessionID,              // already "ses_..." from hook input
  messageID: output.message.id,            // already "msg_..." from hook output
  type: "text" as const,
  text: formattedMemories,
  synthetic: true,
} as Part
output.parts.unshift(syntheticPart)
```

**Important behavioral note**: Parts with `synthetic: true` are NOT rendered in the TUI
(by design), but the LLM still receives them. This is the correct behavior for memory injection.

**Edge cases**:
- Skip if user message is too short (< 10 chars) or is a system command
- Skip if no memories returned
- Configurable max memories to inject (default: 5)
- If `output.message.id` is missing, generate `msg-memory-fallback-${Date.now()}`

#### 2. Auto-Capture on Idle (WRITE — `event: session.idle`)
**When**: Session goes idle (agent finished responding)
**What**: Summarize the latest exchange and store as a memory
**How**:
1. Event fires → 10s debounce timer
2. Fetch session messages via `client.session.messages()`
3. Extract the last user prompt + AI response + tool calls used
4. Call a small LLM (via opencode's configured provider) with structured output:
   - Schema: `{ summary: string, type: 'decision' | 'pattern' | 'bugfix' | 'context' | 'task' | 'skip', tags: string[] }`
   - If type='skip' (trivial/non-technical), discard
5. Map type to memory prefix (e.g., 'decision' → 'DECISION:', 'pattern' → 'PATTERN:')
6. Call `project-memory.store_memory(content=<prefixed_summary>, memory_type=<mapped_type>)`
7. Show toast notification

**Edge cases**:
- Track last captured message ID to avoid double-capture
- Skip if conversation has < 2 messages since last capture
- Configurable: enable/disable, LLM model selection

#### 3. Memory Recovery on Compaction (READ — `event: session.compacted`)
**When**: Context window is compacted/compressed
**What**: Re-inject relevant memories so agent doesn't lose project context
**How**:
1. Event fires with `sessionID`
2. Call `project-memory.search_memory(query="TASK: in_progress", mode="bm25")` to find active tasks
3. Call `project-memory.recall(query="recent project context", limit=5)` for general context
4. Format combined results as markdown
5. Inject via `client.session.prompt({ path: {id: sessionID}, body: { parts: [contextPart], noReply: true } })`
6. Show toast: "N memories restored after compaction"

**Part format for `session.prompt()`** (different from chat.message!):
```typescript
// PromptInput validates parts with relaxed schema:
// - id is OPTIONAL (auto-generated if missing)
// - messageID and sessionID are OMITTED (server fills them)
// - Only TextPart, FilePart, AgentPart, SubtaskPart allowed
const contextPart = {
  type: "text" as const,
  text: formattedMemories,
  synthetic: true,
}
// No need for id/messageID/sessionID — server handles it
await client.session.prompt({
  path: { id: sessionID },
  body: { parts: [contextPart], noReply: true }
})
```

### Bonus: Explicit Memory Tool
Register a `memory` tool the agent can call directly with modes:
- `search <query>` — semantic search
- `store <content>` — manual store
- `list [limit]` — list recent
- `graph <entity>` — knowledge graph query

## File Structure
```
memory-plugin/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Plugin entry: hooks + tool registration
│   ├── config.ts             # Config loading from opencode-mem.jsonc
│   ├── services/
│   │   ├── mcp-client.ts     # Wrapper for project-memory MCP calls
│   │   ├── auto-capture.ts   # Idle → summarize → store logic
│   │   ├── context-inject.ts # Chat message → fetch memories → inject
│   │   └── compaction.ts     # Compaction recovery logic
│   └── utils/
│       ├── format.ts         # Memory formatting helpers
│       └── debounce.ts       # Debounce utility
└── opencode-mem.jsonc        # Default config template
```

## Config (opencode-mem.jsonc)
```jsonc
{
  // Read: inject memories on user messages
  "chatMessage": {
    "enabled": true,
    "maxMemories": 5,
    "injectOn": "first",       // "first" = first message only, "always" = every message
    "excludeCurrentSession": true,
    "maxAgeDays": 30
  },
  // Write: auto-capture on idle
  "autoCapture": {
    "enabled": true,
    "debounceMs": 10000,
    "language": "en"
  },
  // Read: restore after compaction
  "compaction": {
    "enabled": true,
    "memoryLimit": 10
  },
  // LLM for auto-capture summarization
  "captureModel": {
    "useOpencodeProvider": true,  // use opencode's own LLM
    "provider": "",               // manual override
    "model": "",
    "apiKey": ""
  }
}
```

## Implementation Order

### Phase 1: Scaffold + MCP Client
1. `npm init`, install `@opencode-ai/plugin`, `@opencode-ai/sdk`, `zod`, `typescript`
2. Create `tsconfig.json` with ESM output
3. Implement `src/services/mcp-client.ts` — wrapper that calls project-memory tools via `client.mcp.tool.call()`
4. Implement `src/config.ts` — load config from jsonc file
5. Create minimal `src/index.ts` plugin skeleton

### Phase 2: Memory Injection (READ)
6. Implement `src/services/context-inject.ts` — fetch + format memories
7. Wire into `chat.message` hook in `src/index.ts`
8. Test: verify memories appear as synthetic parts

### Phase 3: Auto-Capture (WRITE)
9. Implement `src/services/auto-capture.ts` — session message extraction + LLM summarization
10. Wire into `event` handler for `session.idle`
11. Test: verify memories are stored after idle

### Phase 4: Compaction Recovery (READ)
12. Implement `src/services/compaction.ts` — fetch + re-inject after compaction
13. Wire into `event` handler for `session.compacted`

### Phase 5: Explicit Tool + Polish
14. Register `memory` tool with search/store/list/graph modes
15. Add toast notifications
16. Write README with installation instructions
17. Test end-to-end

## MCP Tool Call Pattern
```typescript
// How we call project-memory tools through the OpenCode SDK
async function callMcpTool(client: OpencodeClient, toolName: string, args: Record<string, unknown>) {
  return client.mcp.tool.call({
    body: {
      server: "project-memory",
      tool: toolName,
      args
    }
  });
}

// Example: recall memories
const result = await callMcpTool(client, "recall", { query: "auth patterns", limit: 5 });
```

## Dependencies
- `@opencode-ai/plugin` — Plugin types and tool helper
- `@opencode-ai/sdk` — Client SDK for session/MCP APIs (includes `MessageV2`, ID types)
- `zod` — Schema validation (re-exported by plugin as `tool.schema`)
- `typescript` — Build

## Part Format Reference

### Branded ID Prefixes (MANDATORY — validated via `z.string().startsWith()`)
| ID Type | Prefix | Example |
|---------|--------|---------|
| PartID | `prt` | `prt-memory-context-1710000000000` |
| MessageID | `msg` | `msg_01abc...` (from `output.message.id`) |
| SessionID | `ses` | `ses_01xyz...` (from `input.sessionID`) |

### chat.message hook (memory injection)
Parts are full `MessageV2.Part` objects. A valid `TextPart` requires:
```typescript
{
  id: `prt-memory-context-${Date.now()}`,  // MUST start with "prt"
  sessionID: input.sessionID,              // from hook input (already "ses_...")
  messageID: output.message.id,            // from hook output (already "msg_...")
  type: "text",
  text: string,
  synthetic: true,     // marks as plugin-injected; NOT rendered in TUI but LLM receives it
}
```

### session.prompt() (compaction recovery)
Relaxed validation — only needs:
```typescript
{
  type: "text",
  text: string,
  synthetic: true,
  // id, messageID, sessionID all optional/omitted — server fills them
}
```

### ID Generation Strategy
Use `prt-<purpose>-<timestamp>` format (proven by opencode-mem v2.12.0).
No need to import SDK ID generators — simple string with correct prefix passes validation.

## Risks & Mitigations
| Risk | Mitigation |
|------|-----------|
| MCP server not running | Graceful fallback: log warning, skip injection/capture |
| LLM call fails during auto-capture | Catch error, log, skip this capture cycle |
| Too many memories injected | Cap via config, use `recall` (ranked) not `list_memories` |
| Duplicate memories from rapid idle events | Debounce + track last captured message ID |
| Plugin loaded before MCP server ready | Retry with backoff on first MCP call failure |
| Part format validation fails (v1.2.25+) | Use `prt-` prefix for PartID (validated via `z.string().startsWith("prt")`); reuse `ses_`/`msg_` from hook input/output |
| chat.message parts array is empty | Generate fresh messageID with `msg-` prefix; handle gracefully |
