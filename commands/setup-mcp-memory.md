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

1. **Memory namespace**: "What tag/name should I use for this project's memory? (e.g., project name like `my-app`). This keeps memories separate from other projects."
   - This maps to `mcpServer.tag`
   - If the user already has a tag configured, confirm it

### Important

2. **Auto-capture**: "Do you want the plugin to automatically capture important context from your conversations? (Requires an LLM API key)"
   - If yes, ask for:
     - API provider: OpenAI, Anthropic, or custom OpenAI-compatible endpoint
     - API key (remind them this stays local in the config file)
     - Model preference (default: `gpt-4o-mini` — cheap and fast)
   - This maps to `captureModel` and `autoCapture`

3. **Embedding model**: "The MCP server uses a local embedding model for code search. Default is `qwen3`. Want to keep the default or use a different model?"
   - This maps to `mcpServer.model`

### Optional (ask only if the user seems interested in tuning)

4. **Memory injection**: "When should I inject relevant memories into conversations?"
   - `"first"` = only on the first message (default, less noise)
   - `"always"` = every message (more context, more tokens)
   - How many memories max? (default: 5)

5. **Preemptive compaction**: "What's the context limit of the model you typically use? (default: 200000 tokens). The plugin triggers early compaction at 80% of this limit."

6. **Privacy**: "Keep privacy filtering enabled? (strips `<private>...</private>` tagged content before storing)" — default: yes

## Step 3: Generate Config

Based on the user's answers, generate a `opencode-mmcp-1file.jsonc` file. Use the template below, including ONLY sections the user customized (omit sections where defaults are fine — the plugin uses defaults for missing sections).

**Full template** (include only relevant sections):

```jsonc
{
  // Memory injection on user messages
  "chatMessage": {
    "enabled": true,
    "maxMemories": 5,
    "injectOn": "first"            // "first" = first message only, "always" = every message
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

  // LLM for auto-capture summarization (OpenAI-compatible API)
  "captureModel": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "apiUrl": "https://api.openai.com/v1",
    "apiKey": ""
  },

  // MCP server configuration
  "mcpServer": {
    "command": ["npm", "exec", "-y", "memory-mcp-1file", "--"],
    "tag": "",
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
- Include comments explaining non-obvious settings
- Only include sections that differ from defaults
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
- "Run `/init-mcp-memory` to index this codebase and build project memory"
- "Your config is at `opencode-mmcp-1file.jsonc` — edit it anytime and call `reload_config()` to apply"
- If auto-capture is enabled: "I'll automatically capture important context from our conversations"
- If auto-capture is disabled: "You can manually store memories using `store_memory()`"

## Your Task

1. Check current state
2. Ask questions (essential first, optional only if user is interested)
3. Generate minimal config (only non-default values + mcpServer)
4. Write file, reload, verify
5. Suggest next steps
