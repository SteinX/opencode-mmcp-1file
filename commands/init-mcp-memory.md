---
description: Initialize project memory with the current unified tool surface and scoped memory model
---

# Init Project Memory

Initialize persistent memory for this project using the plugin's **current architecture**.

Your goal is to create a **small, high-value, reusable project knowledge base** for future sessions.

## Rules

1. **Use unified plugin tools first**
   - Use `project_status`, `code_search`, `memory_query`, `memory_save`, `memory_manage`, `knowledge_graph`
   - Do **not** prefer raw MCP tool names when a unified tool exists

2. **Respect current memory scope**
   - Initialization writes into the currently active memory boundary:
     - physical shard: `mcpServer.tag` or `dataDir`
     - logical scope: `memoryScope.namespace` if configured
   - If the active scope looks wrong or unclear, stop and recommend `/setup-mcp-memory`

3. **Index only if needed**
   - Check indexing readiness first
   - Only call `project_status(action: "index")` if the project is missing an index or the index is clearly stale
   - Do not repeatedly re-index; background freshness may already be handled by the plugin
   - In HTTP transport mode, remember that background freshness is coordinated by the shared server's primary holder; follower clients may observe readiness without being the process that triggered the refresh
   - When multiple workspaces share one `tag` / `dataDir`, treat readiness as workspace-specific rather than assuming one global sync state for the whole shard

4. **Store only durable knowledge**
   Save memories only if they will help future work:
   - project structure
   - build/test/dev workflows
   - stable architecture
   - important conventions
   - key decisions
   - important gotchas

5. **Avoid memory spam**
   Do **not** store:
   - long file summaries
   - low-value exploration notes
   - redundant README paraphrases
   - transient details with no future retrieval value

---

## Step 1: Confirm active scope

Check current plugin status and project config.

Determine:
- active shard/tag or dataDir
- active namespace, if any
- whether the plugin is properly configured for this project

If scope/config is missing, ambiguous, or obviously unsuitable, stop and recommend:

```text
/setup-mcp-memory
```

## Step 2: Check code intelligence readiness

Use:

```text
project_status(action: "list")
```

If needed, index the project root with:

```text
project_status(action: "index", path: "<project root path>")
```

Then verify with:

```text
project_status(action: "stats", project_id: "<project id>")
```

Optionally save one concise `CONTEXT` memory that semantic code search is ready.

Readiness is evaluated for the current workspace. A shared shard may already contain code-index sync state for other workspaces, but that does not mean the current project is indexed and fresh.

## Step 3: Build the minimum useful project skeleton

Read only the highest-signal sources if they exist:
- `README.md`
- `AGENTS.md`
- package manifest
- main config files
- CI/workflow files
- top-level structure

Capture **3–8 high-value `CONTEXT` memories** at most.

Examples:
- tech stack
- runtime/build/test commands
- top-level architecture
- main directories
- major entry points

## Step 4: Capture patterns and decisions

Use `code_search` to identify stable implementation patterns and important architectural choices.

Save only high-value items as:
- `PATTERN`
- `DECISION`
- `BUGFIX`
- `RESEARCH` (only if truly reusable)

Good memory test:
- Will this help a future agent make a better decision?
- Is this more than a one-file summary?
- Does it capture the “why”, not only the “what”?

If not, do not store it.

## Step 5: Build a minimal knowledge graph

Create a minimal knowledge graph for every project. Even small projects benefit from recording key architectural relationships.

At minimum, create entities for the top-level modules or services and relations showing the primary dependency or data flow directions.

**Example**: For a web API project, create entities for "API Routes", "Database", "Auth Service" and relations showing which depends on which.

For trivially small single-file scripts or throwaway prototypes, you may skip this step.

## Final output

Finish with a concise summary including:
- active shard / namespace used
- whether code intelligence is ready
- how many memories were added and of what types
- whether a knowledge graph was created or skipped
- the most important insights captured
- whether `/setup-mcp-memory` is still recommended
