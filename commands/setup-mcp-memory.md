---
description: Set up or update memory plugin configuration for this project
---

# Memory Plugin Setup

You are helping the user configure the opencode-mmcp-1file memory plugin for this project. Your goal is to generate a project-scoped `opencode-mmcp-1file.jsonc` configuration file through a guided conversation, then reload the config to apply it immediately.

## Step 1: Check Current State

First, check if a config file already exists in this project:

```bash
ls opencode-mmcp-1file.jsonc opencode-mmcp-1file.json 2>/dev/null
```

Also check the current plugin status:

```
get_status()
```

If a config file already exists, read it and ask the user what they'd like to change. Otherwise, proceed with full setup.

## Step 2: Gather Requirements

Ask the user these questions (adapt based on their answers — skip what's already clear):

### Essential

1. **Physical shard (`tag`)**: "What tag/name should I use for this project's physical memory store? (e.g. `my-app`, `team-memory`, `global`). This controls which on-disk memory shard we use."
   - This maps to `mcpServer.tag`
   - Explain that `tag` is the coarse physical boundary, not the per-workstream retrieval filter
   - If the user already has a tag configured, confirm it

2. **Logical scope (`namespace`)**: "Do you also want a logical scope inside that shard, via `memoryScope.namespace`? This is useful when one shard contains multiple workstreams, apps, tenants, or environments. Leave empty if one project = one scope."
   - This maps to `memoryScope.namespace`
   - Explain the recommended default: keep collaborating agents shared, use `namespace` for scope isolation before reaching for per-agent isolation

### Important

3. **Auto-capture**: "Do you want the plugin to automatically capture important context from your conversations? (Works out of the box — no API key needed)"
   - Auto-capture works by default using OpenCode's session API with your already-configured providers
   - Optionally ask if they want to set a dedicated API key for faster direct HTTP mode:
     - API provider: OpenAI, Anthropic, or custom OpenAI-compatible endpoint
     - API key (remind them this stays local in the config file)
     - Model preference (default: `gpt-4o-mini` — cheap and fast)
   - This maps to `captureModel` and `autoCapture`

4. **Embedding model**: "The MCP server uses a local embedding model for code search. Default is `qwen3`. Want to keep the default or use a different model?"
   - This maps to `mcpServer.model`

### Optional (ask only if the user seems interested in tuning)

5. **Memory injection**: "When should I inject relevant memories into conversations?"
   - `"first"` = only on the first message (default, less noise)
   - `"always"` = every message (more context, more tokens)
   - How many memories max? (default: 5)

6. **Preemptive compaction**: "What's the context limit of the model you typically use? (default: 200000 tokens). The plugin triggers early compaction at 80% of this limit."

7. **Privacy**: "Keep privacy filtering enabled? (strips `<private>...</private>` tagged content before storing)" — default: yes

8. **Code index auto-refresh and scope**: "Do you want the plugin to automatically refresh stale code indexes on startup/idle, or only index when you call the project tools manually? For monorepos or generated-heavy projects, you can also configure `codeIndexSync.includePatterns` / `excludePatterns`; otherwise omit them and use server defaults."
   - Ask only when the project is large, generated-heavy, a monorepo, or the user asks about indexing scope/performance
   - `codeIndexSync.autoRefresh` default is `false`; manual `project_index`, `project_ensure_index`, and `project_recover_index` still work when it is false
   - Patterns are project-relative globs using `/` separators and must not start with `/`
   - Example include: `["src/**/*", "tests/**/*"]`
   - Example exclude: `["**/generated/**", "**/*.min.js", "**/dist/**"]`
   - Explain that long-term defaults belong in config; agents should use `project_index({ path })` and `project_recover_index({ path })` rather than passing filters every time
   - Empty array `[]` is meaningful because it disables that filter side; do not generate empty arrays unless the user explicitly asks to disable server defaults

9. **Advanced scope behavior** (ask only if the user explicitly wants tighter control):
   - "Should collaborating agents share memory by default?" → `memoryScope.shareAcrossAgents` (recommended: `true`)
   - "Do you want agent/run provenance recorded in metadata?" → `includeAgentMetadata` / `includeRunMetadata`
   - Explain that for agentic coding the recommended default is shared agent memory, with agent/run captured as provenance instead of retrieval isolation

## Step 3: Generate Config

Based on the user's answers, generate a `opencode-mmcp-1file.jsonc` file. Use the template below, including ONLY sections the user customized (omit sections where defaults are fine — the plugin uses defaults for missing sections).

**Full template** (include only relevant sections):

```jsonc
{
  // Memory injection on user messages
  "chatMessage": {
    "enabled": true,
    "maxMemories": 5,
    "maxProjectMemories": 10,       // Latest N memories injected as project knowledge (always-on context)
    "injectOn": "first",           // "first" = first message only, "always" = every message
    "projectKnowledgeTiers": [
      { "categories": ["USER"], "limit": 5 },
      { "categories": ["DECISION", "PATTERN"], "limit": 5 },
      { "categories": ["CONTEXT"], "limit": 5 }
    ]
  },

  // Auto-capture on session idle
  "autoCapture": {
    "enabled": true,
    "debounceMs": 10000,
    "language": "en"
  },

  // Memory recovery after context compaction
  "compaction": {
    "enabled": true,
    "memoryLimit": 10
  },

  // Keyword detection for explicit memory requests
  // Agent should store direct user memory requests with a USER: prefix.
  "keywordDetection": {
    "enabled": true,
    "extraPatterns": []
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

  // Plugin-managed code intelligence refresh and optional index scope filters
  "codeIndexSync": {
    "enabled": true,
    "autoRefresh": false,
    "debounceMs": 10000,
    "minReindexIntervalMs": 300000,
    "resume": {
      "enabled": true,
      "pollIntervalMs": 5000,
      "maxPollMs": 300000,
      "allowFullRestartFallback": false,
      "allowDestructiveRecovery": false
    },
    // Optional: include only these project-relative paths; omit to use server defaults
    // "includePatterns": ["src/**/*", "tests/**/*"],
    // Optional: exclude generated or build artifacts; omit to use server defaults
    // "excludePatterns": ["**/generated/**", "**/*.min.js", "**/dist/**"]
  },

  // LLM for auto-capture summarization
  // apiKey set → direct HTTP; apiKey empty → OpenCode session API (zero-config)
  "captureModel": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "apiUrl": "https://api.openai.com/v1",
    "apiKey": ""
  },

  // Logical scope inside the current physical shard
  "memoryScope": {
    "namespace": "",                 // Optional logical scope for one app/workstream inside the shard
    "shareAcrossAgents": true,        // Recommended for agentic coding: collaborating agents share memory
    "includeAgentMetadata": true,     // Record source_agent_id as provenance
    "includeRunMetadata": false,      // Record source_run_id only when session provenance matters
    "userId": "",                    // Optional default user scope
    "defaultMetadata": {}
  },

  // MCP server configuration
  "mcpServer": {
    "command": ["npm", "exec", "-y", "memory-mcp-1file", "--"],
    "tag": "",                       // Physical storage shard / dataDir selector
    "model": "qwen3",
    "mcpServerName": "memory-mcp-1file"
  },

  // System prompt injection
  "systemPrompt": {
    "enabled": true
  }
}
```

**Rules for generating the config:**
- Always include `mcpServer.tag` — the plugin is disabled without it
- Include `memoryScope` only when the user wants a non-default logical scope or provenance behavior
- Prefer `memoryScope.namespace` over per-agent isolation when the user wants narrower retrieval inside one shared shard
- Default recommendation for agentic coding: `shareAcrossAgents: true`, `includeAgentMetadata: true`, `includeRunMetadata: false`
- Include comments explaining non-obvious settings
- Only include sections that differ from defaults
- Include `codeIndexSync` only when the user customizes index refresh/resume behavior, enables `autoRefresh`, or wants project-specific `includePatterns` / `excludePatterns`; otherwise omit it and rely on defaults
- For index filters, prefer config defaults over per-call agent arguments; do not generate empty `includePatterns` / `excludePatterns` unless the user explicitly wants to disable server defaults
- Exception: always include `mcpServer` section (it's the core config)

## Step 4: Write and Apply

1. Write the generated config to the project root:

```bash
# Write the config file (use the tool to write the file)
```

2. Reload the plugin configuration:

```
reload_config()
```

3. Verify the reload was successful. Report which sections were updated.

4. Confirm to the user: "Configuration saved and applied. Here's what's active: [summary]"

## Step 5: Next Steps

After setup, suggest:
- "Run `/init-mcp-memory` to index this codebase and build project memory. This enables semantic `code_search` and call graph workflows."
- "Your config is at `opencode-mmcp-1file.jsonc` — edit it anytime and call `reload_config()` to apply"
- If auto-capture is enabled: "I'll automatically capture important context from our conversations" (note: works out of the box even without a dedicated API key)
- If auto-capture is disabled: "You can manually store memories using `memory_save`"

## Your Task

1. Check current state
2. Ask questions (essential first, optional only if user is interested)
3. Generate minimal config (only non-default values + mcpServer)
4. Write file, reload, verify
5. Suggest next steps

## Learning Memory (Optional)

Learning memory is **disabled by default**. It enables the plugin to capture typed preferences, lessons, and rules from conversational signals and inject them back into future sessions.

### Choices

Ask the user which (if any) learning memory features they want:

1. **Disabled (default)** — no learning memory; skip this section entirely
2. **Project preference learning** — capture user preferences scoped to this project
3. **Global preference learning** — capture preferences shared across all projects
4. **Project lessons learning** — extract lessons, patterns, and pitfalls from sessions

### Server API requirement

Learning memory tools require `memory-mcp-1file` server v1+ with `metadata.learning` support. If the server does not support this API, the plugin will log a warning and skip learning operations.

### Legacy fallback

When the server does not support the learning API, the plugin can fall back to reading legacy `USER — Preference:` memories if `learningMemory.fallback.legacyPreferences = true` (the default). This ensures continuity for users migrating from the older preference learning system.

### Config alias

`preferenceLearning` is the legacy/compatibility config alias for the older preference learning system. New configurations should use `learningMemory` instead. Both are supported, but `learningMemory` takes precedence when both are present.

### Example config snippet

```jsonc
"learningMemory": {
  "enabled": true,
  "preferences": { "enabled": true },
  "lessons": { "enabled": false },
  "rules": { "enabled": false },
  "injection": {
    "mode": "auto",
    "maxPinned": 3,
    "maxRetrieved": 10,
    "includeEvidence": false
  },
  "fallback": {
    "legacyPreferences": true
  }
}
```
