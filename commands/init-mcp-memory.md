---
description: Initialize persistent project memory with deep codebase indexing and knowledge extraction
---

# Project Memory Initialization

You are initializing persistent memory for this codebase. Your goal is to build a rich, searchable knowledge base that makes you significantly more effective across all future sessions.

This initialization has three phases: **Code Indexing**, **Deep Research**, and **Knowledge Graph**.

## Phase 1: Code Indexing

First, index the codebase for code-level search. This enables `recall_code` and `search_symbols` for all future interactions.

1. Check if this project is already indexed:

```
project_info(action: "list")
```

2. If not indexed (or to refresh), index the project root:

```
index_project(path: "<project root path>")
```

3. Wait for indexing to complete — check status periodically:

```
project_info(action: "status", project_id: "<id from step 2>")
```

4. Once complete, verify with a quick stats check:

```
project_info(action: "stats", project_id: "<id>")
```

Store the project stats as a CONTEXT memory for future reference.

## Phase 2: Deep Research

Conduct thorough research to understand the project. This is not surface-level data collection — cross-reference findings and dig into inconsistencies.

### 2a. Documentation & Config (read these files if they exist)

- README.md, CONTRIBUTING.md, AGENTS.md, CLAUDE.md
- Package manifests: package.json, Cargo.toml, pyproject.toml, go.mod, requirements.txt
- Config files: tsconfig.json, .eslintrc*, .prettierrc*, vite.config.*, webpack.config.*
- CI/CD: .github/workflows/, .gitlab-ci.yml, Jenkinsfile

### 2b. Git History & Conventions

```bash
git log --oneline -20                          # Recent history
git log --format="%s" -50                      # Commit message conventions
git branch -a                                  # Branching strategy
git shortlog -sn --all | head -10              # Main contributors
git log --diff-filter=D --name-only -20        # Recently deleted files (refactors)
```

### 2c. Code Structure (use code intelligence tools)

```
recall_code(query: "main entry point initialization")
recall_code(query: "error handling patterns")
recall_code(query: "authentication authorization")
recall_code(query: "database models schema")
recall_code(query: "API routes endpoints")
search_symbols(query: "main")
search_symbols(query: "config")
```

### 2d. Explore Agent (fire parallel queries for broad understanding)

```
Task(explore, "What is the tech stack and key dependencies?")
Task(explore, "What is the project structure and key directories?")
Task(explore, "How do you build, test, lint, and run this project?")
Task(explore, "What are the main architectural patterns and data flow?")
Task(explore, "What conventions, coding standards, or patterns are used?")
Task(explore, "What are known gotchas, edge cases, or workarounds?")
```

## What to Capture

Save each distinct insight as a separate memory using `store_memory`. Use appropriate prefixes:

| Prefix | Use for | Examples |
|--------|---------|----------|
| `CONTEXT:` | Project structure, tech stack, environment | "CONTEXT: Monorepo using pnpm workspaces with 3 packages: api, web, shared" |
| `PATTERN:` | Code conventions, style rules | "PATTERN: All exports use named exports, no default exports" |
| `DECISION:` | Architecture choices and rationale | "DECISION: PostgreSQL chosen over MongoDB for relational data integrity" |
| `RESEARCH:` | Investigation findings | "RESEARCH: Auth refactored in v2.0, old JWT flow deprecated in favor of sessions" |

**Quality guidelines:**
- Be concise but include enough context to be useful later
- Include the "why" not just the "what"
- Save incrementally as you discover — don't wait until the end
- Each memory should be independently useful when recalled

**Good memories:**
- "CONTEXT: Uses Bun runtime. Commands: bun install, bun run dev, bun test. CI runs on Node 20."
- "PATTERN: Error handling uses Result type pattern — functions return {ok, error} not throw."
- "CONTEXT: API in src/routes/ using Hono framework. Auth middleware in src/middleware/auth.ts."
- "DECISION: Strict TypeScript — no `any`. Use `unknown` with type narrowing."

## Phase 3: Knowledge Graph

Build a knowledge graph of the project's key entities and their relationships. This enables graph-based retrieval and community detection.

### 3a. Create entities for major components

```
knowledge_graph(action: "create_entity", name: "auth-service", entity_type: "service", description: "Handles user authentication and session management")
knowledge_graph(action: "create_entity", name: "user-model", entity_type: "model", description: "Core user data model in src/models/user.ts")
```

Entity types to consider: `service`, `model`, `module`, `config`, `tool`, `api`, `database`, `external-dependency`

### 3b. Create relations between entities

```
knowledge_graph(action: "create_relation", from_entity: "<id>", to_entity: "<id>", relation_type: "depends_on")
knowledge_graph(action: "create_relation", from_entity: "<id>", to_entity: "<id>", relation_type: "implements")
```

Relation types to consider: `depends_on`, `implements`, `calls`, `configures`, `extends`, `contains`, `produces`, `consumes`

### 3c. Verify the graph

```
knowledge_graph(action: "detect_communities")
```

## Before Starting

Ask the user:
1. "Any specific rules or conventions I should always follow?"
2. "Are there areas of the codebase you'd like me to focus on?"
3. "Should I index the entire project or specific directories?"

## Reflection

Before finishing, verify completeness:
1. **Commands**: Build, test, lint, run, deploy — are they all captured?
2. **Architecture**: Entry points, data flow, key abstractions — understood?
3. **Conventions**: Naming, error handling, file organization — documented?
4. **Gotchas**: Known issues, workarounds, non-obvious behavior — noted?
5. **Graph**: Are the major components and their relationships mapped?

Summarize what was learned and ask: "I've initialized memory with X insights across Y entities. Want me to dive deeper into any area?"

## Your Task

1. Ask upfront questions (focus areas, rules, indexing scope)
2. Check existing memories: `recall(query: "project context")` and `project_info(action: "list")`
3. Execute Phase 1 (Code Indexing)
4. Execute Phase 2 (Deep Research) — save memories incrementally
5. Execute Phase 3 (Knowledge Graph)
6. Reflect, verify completeness, and summarize
