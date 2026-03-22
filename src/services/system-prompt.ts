import type { PluginConfig } from "../config.js"

const MEMORY_PROTOCOL = `## Memory System

You have access to a persistent memory system via MCP tools. Use it to store and retrieve knowledge across sessions.

### When to Store Memories
- **Decisions**: Architecture choices, trade-offs, rejected alternatives → prefix with "DECISION:"
- **Tasks**: Work in progress, planned next steps → prefix with "TASK:" (mark as "in_progress" or "completed")
- **Patterns**: Recurring code patterns, conventions, best practices → prefix with "PATTERN:"
- **Bugs**: Bug fixes, root causes, workarounds → prefix with "BUGFIX:"
- **Context**: Project structure, dependencies, environment details → prefix with "CONTEXT:"
- **Research**: Investigation findings, documentation references → prefix with "RESEARCH:"
- **User preferences**: User's coding style, tool preferences → prefix with "USER:"

### Key Tools
- **store_memory**: Save important knowledge with a descriptive prefix
- **recall**: Hybrid search (semantic + keyword) — best for general queries
- **search_memory**: Targeted search (vector or bm25 mode)
- **update_memory / invalidate**: Keep memories current — update stale info, invalidate outdated entries
- **knowledge_graph**: Store and query relationships between entities

### Memory Lifecycle
1. Before starting work: \`recall\` relevant context about the current project/task
2. During work: \`store_memory\` for significant decisions, discoveries, or task state changes
3. When information changes: \`update_memory\` or \`invalidate\` the old entry
4. After completing a task: Update the TASK: memory to mark it as completed

### Prefix Format
Always prefix stored content with the appropriate category:
\`\`\`
DECISION: Use PostgreSQL over MongoDB for relational data integrity
TASK: [in_progress] Implement user authentication with JWT
CONTEXT: Project uses ESM modules with .js import extensions
\`\`\`
`

const CODE_INTELLIGENCE = `
### Code Intelligence Tools
When a project has been indexed (via \`/init-mcp-memory\` or \`index_project\`), these tools provide **semantic code understanding** beyond what grep/LSP offer — intent-based search, cross-session persistence, and call graph traversal.

#### Tool Selection Guide
| Need | Tool | When to prefer over grep/LSP |
|------|------|------------------------------|
| Find code by **intent or concept** | \`recall_code\` | "How is auth handled?" — semantic search understands intent, not just literal matches |
| Find symbols by **name** | \`search_symbols\` | Similar to LSP symbol search, but works across indexed projects and persists cross-session |
| Trace **callers/callees** of a symbol | \`symbol_graph\` | Call graph traversal — grep/LSP cannot provide this relationship view |
| Check indexing status | \`project_info\` | Use \`action: "list"\` to verify a project is indexed before searching |

#### Workflow
1. **Search**: Use \`recall_code\` for semantic/intent queries, \`search_symbols\` for exact symbol lookup
2. **Trace relationships**: Pass \`symbol_id\` from \`search_symbols\` results into \`symbol_graph\` to explore callers, callees, or related symbols
3. **Do NOT** call \`index_project\` proactively — indexing is a one-time setup via \`/init-mcp-memory\`. Only call it if search tools return empty results and you suspect the project is not yet indexed.

Use \`/init-mcp-memory\` command to bootstrap full project memory with code indexing + deep research + knowledge graph.
Use \`/setup-mcp-memory\` command to configure or update the plugin settings for this project.
`

const CONNECTION_WARNING = `
### MEMORY SERVER OFFLINE
All memory tools (recall, store_memory, search_memory, etc.) are temporarily unavailable.
Auto-reconnection is in progress. Do NOT call memory tools until this warning disappears.
The only working tool is \`get_status\` which returns local connection status.
Continue your work without memory tools for now.
`

export function buildMemorySystemPrompt(
  _config: PluginConfig,
  availableTools: string[],
  connectionOk = true,
): string {
  if (availableTools.length === 0) return MEMORY_PROTOCOL

  const toolList = availableTools.map((t) => `\`${t}\``).join(", ")
  const hasCodeIntel = availableTools.some((t) =>
    ["index_project", "recall_code", "search_symbols", "project_info", "symbol_graph"].includes(t),
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
