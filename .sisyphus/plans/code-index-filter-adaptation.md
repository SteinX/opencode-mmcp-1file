# Code Index Filter Adaptation

## TL;DR
> **Summary**: Adapt the OpenCode plugin to expose Memory MCP code-index `include_patterns` / `exclude_patterns` through plugin config defaults and `project_status(action: "index")` call-time overrides, with plugin-side validation and tests-after coverage.
> **Deliverables**:
> - `codeIndexSync.includePatterns` / `codeIndexSync.excludePatterns` optional config defaults.
> - `project_status` index-call override args translated to MCP `include_patterns` / `exclude_patterns`.
> - Shared validation for project-relative glob patterns before MCP calls.
> - Background code-index sync propagation and filter-change freshness handling.
> - README, example config, and Vitest updates.
> **Effort**: Medium
> **Parallel**: YES - 2 waves
> **Critical Path**: Task 1 → Tasks 2/3/4 → Task 5 → Final Verification

## Context

### Original Request
用户请求：“相关的适配可以出一个方案 /Users/xiayiming1/Documents/Workspace/memory-mcp-1file/doc/plugin-filter-adaptation-guide.md”

### Interview Summary
- User chose **配置+调用（推荐）**: expose filter rules in both plugin config defaults and per-call index overrides.
- User chose **插件预校验（推荐）**: validate patterns in the plugin before invoking MCP, while still passing through MCP server errors.
- User chose **测试后补（推荐）**: implement tests after code changes using existing Vitest infrastructure.

### Source Guide Summary
Reference: `/Users/xiayiming1/Documents/Workspace/memory-mcp-1file/doc/plugin-filter-adaptation-guide.md`
- MCP supports default filters via env vars `CODE_INDEX_INCLUDE_PATTERNS` / `CODE_INDEX_EXCLUDE_PATTERNS` and per-call overrides via `include_patterns` / `exclude_patterns`.
- Override semantics: omitted/None uses server defaults; provided array fully replaces the corresponding defaults; empty array disables that side of filtering.
- Matching rules: patterns are project-relative, must use `/`, must not start with `/`, and exclude rules win over include rules.
- Invalid patterns must stop indexing with an error.
- Server persists effective filters in `IndexStatus`; incremental validation uses that snapshot.
- Hard invariants remain server-owned: skip dirs, supported extension whitelist, and `.gitignore`.

### Metis Review (gaps addressed)
- **Config shape**: place optional fields under existing `codeIndexSync` instead of adding a new top-level section. This avoids changing the documented 13-section config count in `AGENTS.md`.
- **Default behavior**: use optional/undefined defaults, not `[]`, so omitted plugin config preserves existing behavior and allows MCP server env defaults to apply.
- **Tool arg naming**: use snake_case `include_patterns` / `exclude_patterns` for `project_status` arguments because existing plugin tool args already use snake_case (`project_id`, `resume_token`, `allow_full_restart_fallback`). Translate config camelCase to MCP snake_case internally.
- **Validation strictness**: validate only clear plugin-side contract violations; do not over-validate valid glob syntax the MCP server may accept.
- **Error behavior**: return existing tool-style error strings (`Error: ...`) rather than throwing.
- **Resume guardrail**: do not attach filters to resume operations; reject call-time filters when `project_status(action: "index")` is being used as a resume continuation.
- **Freshness guardrail**: include effective configured filter defaults in plugin local sync metadata so config changes can trigger reindexing instead of falsely treating a stale filtered index as fresh.

## Work Objectives

### Core Objective
Add plugin-side support for Memory MCP code-index filtering without changing Memory MCP server code and without conflating code-index file filters with existing `<private>` privacy filtering.

### Deliverables
- Optional config fields under `codeIndexSync`:
  - `includePatterns?: string[]`
  - `excludePatterns?: string[]`
- Tool-call args on `project_status`:
  - `include_patterns?: string[]`
  - `exclude_patterns?: string[]`
- Validation helper that rejects invalid project-relative patterns before MCP calls.
- Wiring in manual `project_status(action: "index")` and background `ensureCodeIndexFresh()` index starts/restarts.
- Updated tests and docs.

### Definition of Done (verifiable conditions with commands)
- `npm run test` passes.
- `tests/config.test.ts` proves optional filter defaults preserve omitted-vs-empty-array semantics.
- `tests/services/tool-registry.test.ts` proves manual index overrides are forwarded, config defaults are used when args are omitted, empty arrays are preserved, and invalid patterns return `Error:` without calling MCP.
- `tests/services/code-index-sync.test.ts` proves background index calls include configured defaults and filter-signature changes trigger refresh.
- `README.md` and `opencode-mmcp-1file.example.jsonc` describe the new config and override behavior consistently.

### Must Have
- Preserve current behavior when no filter config and no call-time overrides are provided.
- Preserve `undefined` vs `[]` semantics:
  - `undefined` / omitted = do not send that filter side; server env defaults may apply.
  - `[]` = send an empty array and disable that filter side.
- Use config camelCase (`includePatterns`, `excludePatterns`) and MCP/tool snake_case (`include_patterns`, `exclude_patterns`).
- Return structured error strings consistent with current `project_status` missing-argument behavior.
- Keep privacy filtering unchanged.

### Must NOT Have
- Do not edit Memory MCP server files under `/Users/xiayiming1/Documents/Workspace/memory-mcp-1file`.
- Do not add a new top-level config section unless implementation proves impossible; expected solution uses existing `codeIndexSync`.
- Do not update `AGENTS.md` section count because no section is added/removed/renamed.
- Do not pass include/exclude filters to resume operations.
- Do not run formatters or introduce lint tooling; repo has no linter/formatter configured.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: tests-after with Vitest.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`.

## Execution Strategy

### Parallel Execution Waves
> Target: 5-8 tasks per wave. This plan has 5 implementation tasks; Wave 2 waits for shared contracts from Wave 1.

Wave 1:
- Task 1 — config contract and validation helper foundation.

Wave 2:
- Task 2 — manual `project_status` index override wiring.
- Task 3 — background code-index sync propagation and freshness handling.
- Task 4 — docs/example config sync.

Wave 3:
- Task 5 — integrated test run and evidence consolidation.

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|---|---|---|
| 1. Config + validation foundation | None | 2, 3, 4, 5 |
| 2. Manual `project_status` override wiring | 1 | 5 |
| 3. Background sync propagation | 1 | 5 |
| 4. Documentation/config example sync | 1 | 5 |
| 5. Integrated verification | 2, 3, 4 | Final Verification |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Tasks | Categories |
|---|---:|---|
| 1 | 1 | quick |
| 2 | 3 | quick, unspecified-low, writing |
| 3 | 1 | unspecified-low |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Add config contract and shared filter validation

  **What to do**:
  1. In `src/config.ts`, extend `PluginConfig["codeIndexSync"]` with optional fields:
     - `includePatterns?: string[]`
     - `excludePatterns?: string[]`
  2. In `DEFAULT_CONFIG.codeIndexSync` at `src/config.ts:176-187`, add `includePatterns: undefined` and `excludePatterns: undefined` rather than `[]`.
  3. In `mergeConfig()` at `src/config.ts:275-282`, preserve nested `resume` merge and ensure `includePatterns` / `excludePatterns` are inherited from defaults unless explicitly overridden. No separate merge object is needed beyond the existing spread, but tests must prove the behavior.
  4. Create `src/utils/code-index-filters.ts` with exports:
     - `export type CodeIndexFilterArgs = { include_patterns?: string[]; exclude_patterns?: string[] }`
     - `export type CodeIndexFilterConfig = { includePatterns?: string[]; excludePatterns?: string[] }`
     - `export function validateCodeIndexPatterns(patterns: unknown, fieldName: "include_patterns" | "exclude_patterns" | "includePatterns" | "excludePatterns"): string | null`
     - `export function buildCodeIndexFilterArgs(config: CodeIndexFilterConfig, overrides?: CodeIndexFilterArgs): CodeIndexFilterArgs | string`
  5. Validation rules for each provided array entry:
     - reject non-array values with `Error: {fieldName} must be an array of strings`;
     - reject non-string entries with `Error: {fieldName}[{index}] must be a string`;
     - reject empty/whitespace-only strings with `Error: {fieldName}[{index}] must not be empty`;
     - reject `\` with `Error: invalid glob pattern: {pattern} (use '/' path separators)`;
     - reject leading `/` with `Error: invalid glob pattern: {pattern} (patterns must be project-relative, do not start with '/')`;
     - reject Windows drive absolute paths matching `/^[A-Za-z]:/` with `Error: invalid glob pattern: {pattern} (patterns must be project-relative)`;
     - reject parent traversal segments where normalized split contains `..` with `Error: invalid glob pattern: {pattern} (parent traversal is not allowed)`.
  6. `buildCodeIndexFilterArgs` behavior:
     - call-time `overrides.include_patterns !== undefined` wins over config `includePatterns`;
     - otherwise config `includePatterns !== undefined` is used;
     - same for exclude;
     - preserve empty arrays exactly;
     - omit keys whose effective value is `undefined`;
     - return an error string starting with `Error:` if validation fails.
  7. Add `tests/utils/code-index-filters.test.ts` covering valid patterns, omitted values, empty arrays, config fallback, override precedence, and all validation failures.
  8. Update `tests/config.test.ts` default-config and merge tests to assert:
     - default `includePatterns` and `excludePatterns` are `undefined`;
     - JSONC `{ "codeIndexSync": { "includePatterns": [], "excludePatterns": ["**/generated/**"] } }` preserves empty include and non-empty exclude.

  **Must NOT do**:
  - Do not put code-index filters in `privacy` config.
  - Do not default either filter side to `[]`.
  - Do not validate against server hard invariants like extension whitelist or `.gitignore`.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: bounded TypeScript config/helper/test work.
  - Skills: [] - No specialized skill needed.
  - Omitted: [`mcp-builder`] - This does not change MCP server/tool protocol design beyond plugin forwarding.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 2, 3, 4, 5 | Blocked By: None

  **References**:
  - Pattern: `src/config.ts:58-69` - existing `codeIndexSync` config interface location.
  - Pattern: `src/config.ts:176-187` - default `codeIndexSync` values.
  - Pattern: `src/config.ts:266-288` - merge behavior for nested config.
  - Test: `tests/config.test.ts:112-178` - default and JSONC merge test style.
  - Guide: `/Users/xiayiming1/Documents/Workspace/memory-mcp-1file/doc/plugin-filter-adaptation-guide.md:31-45` - override and validation semantics.

  **Acceptance Criteria**:
  - [ ] `npm run test -- tests/utils/code-index-filters.test.ts tests/config.test.ts` exits 0.
  - [ ] `DEFAULT_CONFIG.codeIndexSync.includePatterns` and `.excludePatterns` are `undefined`, not `[]`.
  - [ ] `buildCodeIndexFilterArgs({ includePatterns: ["src/**/*"] })` returns `{ include_patterns: ["src/**/*"] }`.
  - [ ] `buildCodeIndexFilterArgs({ includePatterns: ["src/**/*"] }, { include_patterns: [] })` returns `{ include_patterns: [] }`.
  - [ ] Invalid `/src/**/*`, `src\\main.ts`, `../secret/**/*`, `C:/repo/**/*`, empty string, and non-string entries each return `Error:` strings and do not throw.

  **QA Scenarios**:
  ```
  Scenario: Config default preserves MCP env-default behavior
    Tool: Bash
    Steps: npm run test -- tests/config.test.ts tests/utils/code-index-filters.test.ts
    Expected: Tests pass and assertions prove omitted config produces no include_patterns/exclude_patterns keys.
    Evidence: .sisyphus/evidence/task-1-config-validation.txt

  Scenario: Invalid glob rejected before MCP layer
    Tool: Bash
    Steps: npm run test -- tests/utils/code-index-filters.test.ts
    Expected: Tests pass and invalid patterns return Error strings without thrown exceptions.
    Evidence: .sisyphus/evidence/task-1-config-validation-error.txt
  ```

  **Commit**: YES | Message: `feat(index): add code index filter config validation` | Files: `src/config.ts`, `src/utils/code-index-filters.ts`, `tests/config.test.ts`, `tests/utils/code-index-filters.test.ts`

- [x] 2. Wire manual `project_status` index filters to MCP calls

  **What to do**:
  1. In `src/services/tool-registry.ts`, import `buildCodeIndexFilterArgs` from `../utils/code-index-filters.js` using `.js` extension.
  2. Extend `project_status.args` at `src/services/tool-registry.ts:324-337` with:
     - `include_patterns: tool.schema.array(tool.schema.string()).optional()`
     - `exclude_patterns: tool.schema.array(tool.schema.string()).optional()`
  3. Update the `project_status` description at `src/services/tool-registry.ts:321-323` to mention that `index` accepts optional `include_patterns` / `exclude_patterns`, where omitted uses plugin/server defaults and `[]` disables that filter side.
  4. In the `case "index"` block at `src/services/tool-registry.ts:426-440`:
     - before calling MCP, detect resume-style continuation: `args.resume === true || args.resume_token !== undefined || args.job_id !== undefined`;
     - if resume-style continuation and either `include_patterns` or `exclude_patterns` is provided, return `Error: include_patterns/exclude_patterns cannot be used when resuming an index job` and do not call MCP;
     - if not resume-style continuation, call `buildCodeIndexFilterArgs(config.codeIndexSync, { include_patterns: args.include_patterns, exclude_patterns: args.exclude_patterns })`;
     - if helper returns a string, return it directly;
     - otherwise `Object.assign(callArgs, filterArgs)` before `proxy("index_project", callArgs)`.
  5. In `case "resume"` at `src/services/tool-registry.ts:413-424`, do not pass filters. If `include_patterns` or `exclude_patterns` are present, return the same resume-filter error string before required-field validation or immediately after `path/job_id/resume_token` validation; tests should only require no MCP call.
  6. Update `tests/services/tool-registry.test.ts` project_status block around `tests/services/tool-registry.test.ts:675-725` with tests for:
     - config defaults are forwarded on plain `index`;
     - call-time overrides beat config defaults;
     - empty arrays are forwarded;
     - omitted values do not add keys;
     - invalid patterns return `Error:` and do not call `callMemoryTool`;
     - resume action and resume-style index reject call-time filters.

  **Must NOT do**:
  - Do not add filters to `list`, `status`, `stats`, `cancel`, `cleanup`, `projection`, or `projection_by_locator` actions.
  - Do not pass config defaults to resume actions.
  - Do not rename existing arguments.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: single service file plus focused test updates.
  - Skills: [] - No specialized skill needed.
  - Omitted: [`webapp-testing`] - No browser/UI surface.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 5 | Blocked By: 1

  **References**:
  - Pattern: `src/services/tool-registry.ts:320-337` - existing `project_status` schema.
  - Pattern: `src/services/tool-registry.ts:413-440` - current resume/index MCP proxy logic.
  - Test: `tests/services/tool-registry.test.ts:441-725` - existing `project_status` tests.
  - Config: `src/config.ts:58-69` - `codeIndexSync` source for config defaults.

  **Acceptance Criteria**:
  - [ ] Plain `project_status.execute({ action: "index", path: "/project" })` with config `{ includePatterns: ["src/**/*"] }` calls `index_project` with `include_patterns: ["src/**/*"]`.
  - [ ] `include_patterns: []` in call args reaches MCP as an empty array.
  - [ ] Invalid `include_patterns: ["/src/**/*"]` returns an `Error:` string and `callMemoryTool` is not called.
  - [ ] `project_status.execute({ action: "resume", ..., include_patterns: ["src/**/*"] })` returns an `Error:` string and does not call MCP.
  - [ ] Existing tests for list/status/stats/projection/resume/index continue passing.

  **QA Scenarios**:
  ```
  Scenario: Manual index uses configured filters and call-time overrides
    Tool: Bash
    Steps: npm run test -- tests/services/tool-registry.test.ts
    Expected: Tests pass; mocked callMemoryTool receives expected include_patterns/exclude_patterns only for non-resume index calls.
    Evidence: .sisyphus/evidence/task-2-tool-registry.txt

  Scenario: Manual invalid/resume filter cases do not hit MCP
    Tool: Bash
    Steps: npm run test -- tests/services/tool-registry.test.ts
    Expected: Tests pass; invalid glob and resume-with-filter assertions show Error strings and zero callMemoryTool calls for those cases.
    Evidence: .sisyphus/evidence/task-2-tool-registry-error.txt
  ```

  **Commit**: YES | Message: `feat(index): forward project_status filter overrides` | Files: `src/services/tool-registry.ts`, `tests/services/tool-registry.test.ts`

- [x] 3. Apply config defaults to background code-index sync and filter freshness

  **What to do**:
  1. In `src/services/code-index-sync.ts`, import `buildCodeIndexFilterArgs` and any needed stable signature helper from `../utils/code-index-filters.js`.
  2. Add a deterministic filter signature helper if not already in Task 1:
     - `export function codeIndexFilterSignature(config: CodeIndexFilterConfig): string`
     - returns JSON for only defined fields, preserving empty arrays, with field order `{ includePatterns, excludePatterns }`;
     - examples: `{}` → `{}`, `{ includePatterns: [] }` → `{"includePatterns":[]}`.
  3. Extend sync metadata types in `src/services/code-index-sync.ts` to store `filterSignature?: string` per workspace entry.
  4. In `ensureCodeIndexFresh()`, treat saved metadata as fresh only when both `fingerprint` and `filterSignature` match the current signature.
  5. In every new index/restart MCP call that starts or rebuilds an index, merge filter defaults into the payload:
     - `src/services/code-index-sync.ts:493-496` legacy force rebuild;
     - `src/services/code-index-sync.ts:561-564` restart with `confirm_failed_restart`;
     - `src/services/code-index-sync.ts:585-589` normal start.
  6. Do **not** merge filters into resume calls at `src/services/code-index-sync.ts:528-536`.
  7. If configured default filters are invalid, log a warning through `logger.warn("Code index sync skipped due to invalid filter config", ...)`, do not call MCP, and do not mark metadata fresh.
  8. When writing completed metadata at `src/services/code-index-sync.ts:539-547`, `566-572`, `590-599`, and `612-619`, persist the current `filterSignature` alongside `fingerprint`.
  9. Update `tests/services/code-index-sync.test.ts` to cover:
     - configured defaults are included in legacy/start/restart index calls;
     - resume calls omit filters;
     - unchanged fingerprint but changed filter signature triggers another index call;
     - invalid config filters skip MCP call and log warning.

  **Must NOT do**:
  - Do not alter `computeWorkspaceFingerprint()` content hashing rules; filters are metadata freshness, not filesystem fingerprint content.
  - Do not force reindex when both fingerprint and filter signature match.
  - Do not pass filters to resume calls.

  **Recommended Agent Profile**:
  - Category: `unspecified-low` - Reason: localized state-machine update with existing test coverage.
  - Skills: [] - No specialized skill needed.
  - Omitted: [`debugging/build-debugging`] - No dependency/build-system change expected.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 5 | Blocked By: 1

  **References**:
  - Pattern: `src/services/code-index-sync.ts:493-588` - existing index/resume/restart calls.
  - Pattern: `src/services/code-index-sync.ts:539-619` - metadata writes after completion.
  - Test: `tests/services/code-index-sync.test.ts:235-258` - existing reindex/freshness assertion style.
  - Test: `tests/services/code-index-sync.test.ts:35-61` - local `makeConfig` needs new optional fields.

  **Acceptance Criteria**:
  - [ ] Background index start with config `{ includePatterns: ["src/**/*"], excludePatterns: ["**/*.log"] }` calls `index_project` with `include_patterns` and `exclude_patterns`.
  - [ ] Resume path calls `index_project` without either filter key.
  - [ ] Existing saved fingerprint with old filter signature does not suppress a new index call.
  - [ ] Invalid configured filter logs warning, does not call MCP, and does not write fresh metadata.
  - [ ] Existing debounce/cooldown tests still pass.

  **QA Scenarios**:
  ```
  Scenario: Background sync applies configured code-index filters
    Tool: Bash
    Steps: npm run test -- tests/services/code-index-sync.test.ts
    Expected: Tests pass; mocked callMemoryTool payload includes filters on start/restart/legacy paths and omits them on resume.
    Evidence: .sisyphus/evidence/task-3-code-index-sync.txt

  Scenario: Filter config change invalidates local freshness
    Tool: Bash
    Steps: npm run test -- tests/services/code-index-sync.test.ts
    Expected: Tests pass; unchanged workspace fingerprint with changed filter signature causes another index call.
    Evidence: .sisyphus/evidence/task-3-code-index-sync-filter-change.txt
  ```

  **Commit**: YES | Message: `feat(index): apply filters during background sync` | Files: `src/services/code-index-sync.ts`, `src/utils/code-index-filters.ts`, `tests/services/code-index-sync.test.ts`

- [x] 4. Update user-facing docs and example config

  **What to do**:
  1. Update `README.md` Configuration JSONC example around `README.md:64-206` inside the existing `codeIndexSync` block to show commented optional fields:
     ```jsonc
     // Optional code-index filters. Omit to use MCP server defaults/env vars.
     // Empty arrays are meaningful: [] disables that side of filtering.
     "includePatterns": undefined, // Do not literally use undefined in JSONC; omit this key unless needed.
     "excludePatterns": undefined
     ```
     Because JSONC cannot contain `undefined`, implement this as comments plus commented-out example lines, e.g. `// "includePatterns": ["src/**/*", "tests/**/*"],` and `// "excludePatterns": ["**/generated/**"],`.
  2. Update `README.md` Configuration Sections table at `README.md:206-217` for `codeIndexSync` to mention optional include/exclude filter defaults and omitted-vs-empty-array semantics.
  3. Add a short README subsection under code indexing/tool usage explaining:
     - config defaults are camelCase under `codeIndexSync`;
     - manual `project_status(action: "index")` overrides use snake_case `include_patterns` / `exclude_patterns`;
     - omitted uses plugin config or MCP server env defaults;
     - empty arrays disable that side;
     - filters are not accepted on resume operations.
  4. Update `opencode-mmcp-1file.example.jsonc` inside the existing `codeIndexSync` block around `opencode-mmcp-1file.example.jsonc:68-77` with commented examples and clear comments matching README.
  5. Do not update `AGENTS.md` section count because no new section is introduced.
  6. If `src/services/system-prompt.ts` already lists project_status usage in a way that becomes misleading, add one sentence only; otherwise leave it unchanged to avoid prompt bloat.

  **Must NOT do**:
  - Do not place literal `undefined` in JSONC examples.
  - Do not document filters as privacy/security controls; they are code-index scope controls.
  - Do not claim filters override server hard invariants.

  **Recommended Agent Profile**:
  - Category: `writing` - Reason: docs and example config synchronization.
  - Skills: [] - Repo-specific docs only.
  - Omitted: [`doc-coauthoring`] - This is a small documentation update, not a new long-form spec.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 5 | Blocked By: 1

  **References**:
  - Pattern: `README.md:64-217` - config example and section table.
  - Pattern: `opencode-mmcp-1file.example.jsonc:68-77` - example `codeIndexSync` block.
  - Rule: `AGENTS.md` Config/Example config conventions - schema/default/config behavior changes require README and example config updates.
  - Guide: `/Users/xiayiming1/Documents/Workspace/memory-mcp-1file/doc/plugin-filter-adaptation-guide.md:34-45` - semantics to document.

  **Acceptance Criteria**:
  - [ ] README and example config both mention `includePatterns` and `excludePatterns` under `codeIndexSync`.
  - [ ] README explains manual override args `include_patterns` and `exclude_patterns` for `project_status(action: "index")`.
  - [ ] Docs distinguish omitted vs `[]` semantics.
  - [ ] Docs state resume operations do not accept filters.
  - [ ] No literal `undefined` appears inside active JSONC examples.

  **QA Scenarios**:
  ```
  Scenario: Documentation matches implemented config and tool surfaces
    Tool: Bash
    Steps: npm run test -- tests/config.test.ts tests/services/tool-registry.test.ts
    Expected: Tests pass; documented fields correspond to tested config/tool names.
    Evidence: .sisyphus/evidence/task-4-docs-sync.txt

  Scenario: Example config remains valid JSONC-style guidance
    Tool: Bash
    Steps: npm run test -- tests/config.test.ts
    Expected: Tests pass; example uses comments/commented-out optional lines rather than invalid active undefined values.
    Evidence: .sisyphus/evidence/task-4-docs-sync-example.txt
  ```

  **Commit**: YES | Message: `docs(index): document code index filter configuration` | Files: `README.md`, `opencode-mmcp-1file.example.jsonc`, optionally `src/services/system-prompt.ts`

- [x] 5. Run integrated verification and capture evidence

  **What to do**:
  1. Run targeted tests first:
     - `npm run test -- tests/utils/code-index-filters.test.ts tests/config.test.ts tests/services/tool-registry.test.ts tests/services/code-index-sync.test.ts`
  2. Run full suite:
     - `npm run test`
  3. Capture command output to evidence files under `.sisyphus/evidence/`.
  4. Inspect changed files and confirm source changes are limited to the planned files.
  5. Confirm no Memory MCP server repo files were modified.
  6. Confirm no generated build artifacts or local config files were accidentally changed.

  **Must NOT do**:
  - Do not skip full `npm run test` after targeted tests pass.
  - Do not commit `.sisyphus/evidence/*` unless the repository policy explicitly tracks evidence; by default evidence is for run audit only.
  - Do not push to remote unless explicitly requested by the user.

  **Recommended Agent Profile**:
  - Category: `unspecified-low` - Reason: test execution and final consistency checks.
  - Skills: [] - Standard npm/Vitest workflow.
  - Omitted: [`git-master`] - Commit may be done by executor if requested, but this task itself is verification.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: Final Verification | Blocked By: 2, 3, 4

  **References**:
  - Command: `package.json` - `npm run test` maps to `vitest run`.
  - Config: `vitest.config.ts` - includes `tests/**/*.test.ts`.
  - Rule: `AGENTS.md` Testing convention - corresponding unit tests must be created/updated and `npm run test` run.

  **Acceptance Criteria**:
  - [ ] Targeted Vitest command exits 0.
  - [ ] Full `npm run test` exits 0.
  - [ ] Evidence files exist for targeted and full test runs.
  - [ ] Git diff contains only planned plugin files plus tests/docs.
  - [ ] No files under `/Users/xiayiming1/Documents/Workspace/memory-mcp-1file` are changed.

  **QA Scenarios**:
  ```
  Scenario: Targeted regression suite passes
    Tool: Bash
    Steps: npm run test -- tests/utils/code-index-filters.test.ts tests/config.test.ts tests/services/tool-registry.test.ts tests/services/code-index-sync.test.ts
    Expected: Exit code 0; all code-index filter adaptation tests pass.
    Evidence: .sisyphus/evidence/task-5-targeted-tests.txt

  Scenario: Full repository test suite passes
    Tool: Bash
    Steps: npm run test
    Expected: Exit code 0; no unrelated regressions.
    Evidence: .sisyphus/evidence/task-5-full-tests.txt
  ```

  **Commit**: YES | Message: `test(index): verify code index filter adaptation` | Files: no source-only commit required if previous task commits already include tests; otherwise include remaining test/doc files.

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Prefer one cohesive commit after all tasks pass: `feat(index): support code index filter adaptation`.
- If committing per task, use the commit messages listed in each task and ensure docs/tests land with the behavior they verify.
- Do not commit `.sisyphus/evidence/*` unless explicitly requested.
- Do not push unless explicitly requested.

## Success Criteria
- Plugin users can define persistent index filters in `codeIndexSync.includePatterns` / `codeIndexSync.excludePatterns`.
- Agents can override filters for manual `project_status(action: "index")` calls with `include_patterns` / `exclude_patterns`.
- Omitted-vs-empty-array semantics match the Memory MCP guide exactly.
- Invalid patterns are rejected before MCP invocation with clear `Error:` strings.
- Resume operations remain snapshot-based and do not accept new filters.
- Background code-index sync honors configured defaults and reindexes when configured filter scope changes.
- README and example config are synchronized with code behavior.
- Full Vitest suite passes.
