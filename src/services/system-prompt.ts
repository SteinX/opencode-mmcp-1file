import type { PluginConfig } from "../config.js"

const MEMORY_PROTOCOL = `## Memory System

You have access to a persistent memory system via MCP tools. Use it to store and retrieve knowledge across sessions.

### When to Store Memories
- **Decisions**: Architecture choices, trade-offs, rejected alternatives → prefix with DECISION
- **Tasks**: Work in progress, planned next steps → prefix with TASK (mark as [in_progress] or [completed])
- **Patterns**: Recurring code patterns, conventions, best practices → prefix with PATTERN
- **Bugs**: Bug fixes, root causes, workarounds → prefix with BUGFIX
- **Context**: Project structure, dependencies, environment details → prefix with CONTEXT
- **Research**: Investigation findings, documentation references → prefix with RESEARCH
- **User preferences**: User's coding style, tool preferences → prefix with USER

### Key Tools (Unified Interface)
- **memory_query**: Unified search — use natural language to find stored memories. Automatically uses the best search strategy.
- **memory_save**: Save knowledge — automatically categorizes based on content (DECISION, TASK, PATTERN, etc.)
- **memory_manage**: Manage existing memories — get, update, delete, or invalidate by ID
- **knowledge_graph**: Store and query relationships between entities

### Memory Lifecycle
1. Before starting work: use memory_query to find relevant context about the current project/task
2. During work: use memory_save for significant decisions, discoveries, or task state changes
3. When information changes: use memory_manage with action "update" or "invalidate"
4. After completing a task: use memory_manage to update TASK to [completed]

### Prefix Format
Always prefix stored content with the appropriate category:
- DECISION — Use PostgreSQL over MongoDB for relational data integrity
- TASK — [in_progress] Implement user authentication with JWT
- CONTEXT — Project uses ESM modules with .js import extensions

### Action Triggers — WHEN to use memory tools

**BEFORE starting work on a new task:**
→ Call memory_query with your task description to find relevant context and past decisions

**AFTER making architectural decisions:**
→ Call memory_save — it will auto-detect and add DECISION prefix

**BEFORE debugging errors:**
→ Call memory_query with "BUGFIX" or error message to check for known solutions

**DURING implementation (need to understand existing code):**
→ Call code_search with search_type "intent" instead of guessing how code works
→ Call code_search with search_type "symbol" when you know the function/class name

**WHEN you notice reusable patterns:**
→ Call memory_save — it will auto-detect and add PATTERN prefix

**AFTER completing a task:**
→ Call memory_manage(action: "update") to mark TASK as [completed]

### Anti-patterns — AVOID these mistakes

- **Do not store everything** — only reusable knowledge (decisions, patterns, fixes)
- **Do not search memories after every message** — only when context switching or stuck
- **Do not guess how code works** — use code_search with search_type "intent" to find actual implementations
- **Do not leave tasks unfinished** — use memory_manage to update TASK memories to [completed] when done
`

const CODE_INTELLIGENCE = `
### Code Intelligence Tools
When a project has been indexed (via /init-mcp-memory or project_status), these tools provide **semantic code understanding** beyond what grep/LSP offer — intent-based search, cross-session persistence, and call graph traversal.

#### Tool Selection Guide
| Need | How to use code_search | When to prefer over grep/LSP |
|------|------------------------|------------------------------|
| Find code by **intent or concept** | search_type: "intent", query: "how is auth handled?" | Semantic search understands intent, not just literal matches |
| Find symbols by **name** | search_type: "symbol", query: "handleRequest" | Similar to LSP symbol search, but works across indexed projects |
| Trace **callers/callees** | search_type: "callers" or "callees", symbol_id: "..." | Call graph traversal — grep/LSP cannot provide this |
| Check indexing status | project_status(action: "list") | Verify projects are indexed before searching |

#### Workflow
1. **Search by intent**: Use code_search with search_type "intent" for semantic queries
2. **Find symbols**: Use code_search with search_type "symbol" for exact name lookup
3. **Trace relationships**: Use code_search with search_type "callers"/"callees"/"related" and the symbol_id from step 2
4. **Do NOT** call project_status(action: "index") proactively — indexing is a one-time setup via /init-mcp-memory

Use /init-mcp-memory command to bootstrap full project memory with code indexing + deep research + knowledge graph.
Use /setup-mcp-memory command to configure or update the plugin settings for this project.
`

const CONNECTION_WARNING = `
### MEMORY SERVER OFFLINE
All memory tools (memory_query, memory_save, memory_manage, etc.) are temporarily unavailable.
Auto-reconnection is in progress. Do NOT call memory tools until this warning disappears.
The only working tool is get_status which returns local connection status.
Continue your work without memory tools for now.
`

export function buildMemorySystemPrompt(
  _config: PluginConfig,
  availableTools: string[],
  connectionOk = true,
): string {
  if (availableTools.length === 0) return MEMORY_PROTOCOL

  const toolList = availableTools.map((t) => "`" + t + "`").join(", ")
  const hasCodeIntel = availableTools.some((t) =>
    ["code_search", "project_status"].includes(t),
  )

  let prompt = MEMORY_PROTOCOL

  if (!connectionOk) {
    prompt += CONNECTION_WARNING
  }

  prompt += `
### Available Memory Tools
${toolList}
`
  if (hasCodeIntel) {
    prompt += CODE_INTELLIGENCE
  }
  return prompt
}
