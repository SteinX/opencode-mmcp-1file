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
When a project has been indexed (via \`index_project\`), you can use these tools for deep code understanding:
- **index_project**: Index a codebase directory. Run once per project; use \`force: true\` to re-index after major changes
- **recall_code**: Search indexed code with hybrid retrieval (vector + BM25 + graph). Supports filtering by \`path_prefix\`, \`language\`, \`chunk_type\`
- **search_symbols**: Find functions, classes, types by name across indexed projects
- **project_info**: Check indexing status (\`action: "list"\`) or get code statistics (\`action: "stats"\`)

Use \`/init-mcp-memory\` command to bootstrap full project memory with code indexing + deep research + knowledge graph.
Use \`/setup-mcp-memory\` command to configure or update the plugin settings for this project.
`

export function buildMemorySystemPrompt(
  _config: PluginConfig,
  availableTools: string[],
): string {
  if (availableTools.length === 0) return MEMORY_PROTOCOL

  const toolList = availableTools.map((t) => `\`${t}\``).join(", ")
  const hasCodeIntel = availableTools.some((t) =>
    ["index_project", "recall_code", "search_symbols", "project_info"].includes(t),
  )

  let prompt = `${MEMORY_PROTOCOL}
### Available Memory Tools
${toolList}
`
  if (hasCodeIntel) {
    prompt += CODE_INTELLIGENCE
  }
  return prompt
}
