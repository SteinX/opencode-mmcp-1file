import { buildCompactionRecoveryContext, buildBootstrapContext, createHookObservation, fetchAndFormatMemories, loadConfig, resolveDataDir, storeMemory, stripPrivateContent, isFullyPrivate, } from "mmcp-1file-core";
import { readCodexBuiltinMemorySummary, readStableRepoGuidance } from "./codex-builtins.js";
const CODEX_BOOTSTRAP_TIMEOUT_MS = 5_000;
const ENGLISH_CONTINUE_PATTERN = /\b(?:continue|resume|keep going)\b/i;
const CHINESE_CONTINUE_PATTERN = /(?:继续|接着|恢复)/;
function shouldBuildRecovery(prompt, compactSummary) {
    return Boolean(compactSummary?.trim())
        || ENGLISH_CONTINUE_PATTERN.test(prompt)
        || CHINESE_CONTINUE_PATTERN.test(prompt);
}
function sourcesFor(parts) {
    return parts.flatMap((part) => part.text ? [part.source] : []);
}
function joinContext(parts) {
    return parts
        .filter((part) => part.text && part.text.trim().length > 0)
        .map((part) => `## ${part.title}\n${part.text}`)
        .join("\n\n");
}
async function withFallback(promise, timeoutMs, fallback) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
    });
    return Promise.race([
        promise.finally(() => {
            if (timer)
                clearTimeout(timer);
        }),
        timeout,
    ]);
}
export async function buildPromptContext(args) {
    const config = loadConfig(args.cwd);
    if (!resolveDataDir(config))
        return null;
    const bootstrapTimeoutMs = Math.min(config.performance?.bootstrapTimeoutMs ?? CODEX_BOOTSTRAP_TIMEOUT_MS, CODEX_BOOTSTRAP_TIMEOUT_MS);
    const bootstrapContext = await withFallback(buildBootstrapContext(config, {
        prompt: args.prompt,
        compactSummary: args.compactSummary,
        limit: config.chatMessage.bootstrapLimit ?? 10,
        tokenBudget: config.chatMessage.bootstrapTokenBudget ?? 4000,
        context: {
            runId: args.sessionId,
            namespace: config.memoryScope.namespace,
        },
    }), bootstrapTimeoutMs, null);
    const bootstrapHasMemories = Boolean(bootstrapContext && bootstrapContext.count > 0);
    const legacyMemoryContext = bootstrapHasMemories ? null : await fetchAndFormatMemories(config, args.prompt);
    const memoryContext = [
        legacyMemoryContext,
        bootstrapHasMemories ? bootstrapContext?.text : null,
        !bootstrapHasMemories ? bootstrapContext?.text : null,
    ].filter((part) => Boolean(part?.trim())).join("\n\n") || null;
    const shouldRecover = shouldBuildRecovery(args.prompt, args.compactSummary);
    const recovery = shouldRecover
        ? await buildCompactionRecoveryContext(config, args.compactSummary)
        : null;
    const codexBuiltin = readCodexBuiltinMemorySummary();
    const stableGuidance = readStableRepoGuidance(args.cwd);
    const parts = [
        { source: "query_recall", title: "Relevant Memory", text: memoryContext },
        { source: "codex_builtin", title: "Codex Built-In Memory", text: codexBuiltin },
        { source: "project_knowledge", title: "Stable Repo Guidance", text: stableGuidance },
        { source: "recovery", title: "Recovery Additions", text: recovery?.text ?? null },
    ];
    const text = joinContext(parts);
    if (!text)
        return null;
    return {
        text,
        sources: sourcesFor(parts),
        diagnostics: {
            skippedSimilarToSummary: recovery?.skippedSimilarToSummary ?? 0,
            injectedCount: parts.filter((part) => part.text).length,
        },
    };
}
function extractLedgerCandidates(transcript) {
    const lines = transcript
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
    return lines
        .filter((line) => /\b(?:DECISION|TASK|PATTERN|BUGFIX|CONTEXT|RESEARCH|USER)\b[:：]/i.test(line)
        || /\b(?:verified|verification|test|build|failed|pre-existing|not verified|用户|偏好|拒绝|纠正)\b/i.test(line))
        .slice(-8);
}
function categorize(content) {
    const match = content.match(/\b(DECISION|TASK|PATTERN|BUGFIX|CONTEXT|RESEARCH|USER)\b[:：]/i);
    if (match)
        return match[1].toUpperCase();
    if (/\b(?:verified|test|build|not verified)\b/i.test(content))
        return "CONTEXT";
    if (/\b(?:failed|pre-existing|error)\b/i.test(content))
        return "BUGFIX";
    if (/\b(?:用户|偏好|纠正|拒绝)\b/i.test(content))
        return "USER";
    return "CONTEXT";
}
export async function captureTaskLedger(args) {
    const config = loadConfig(args.cwd);
    if (!resolveDataDir(config))
        return { stored: 0, skipped: 0, categories: [] };
    const candidates = extractLedgerCandidates(args.transcriptText);
    let stored = 0;
    let skipped = 0;
    const categories = [];
    for (const candidate of candidates) {
        let content = stripPrivateContent(candidate);
        if (!content || isFullyPrivate(content)) {
            skipped += 1;
            continue;
        }
        const category = categorize(content);
        if (!new RegExp(`^${category}[:：]`, "i").test(content)) {
            content = `${category}: ${content}`;
        }
        const ok = await createHookObservation(config, {
            content,
            source: "codex-hook",
            eventType: "stop_ledger",
            confidence: 0.8,
            redactionState: config.privacy.enabled ? "redacted" : "raw",
            memoryType: "episodic",
            context: {
                runId: args.sessionId,
                metadata: { source: "codex.stop", hook: "Stop" },
            },
            metadata: { source: "codex.stop", hook: "Stop" },
        }) || await storeMemory(config, content, "episodic", {
            runId: args.sessionId,
            metadata: { source: "codex.stop" },
        });
        if (ok) {
            stored += 1;
            categories.push(category);
        }
        else {
            skipped += 1;
        }
    }
    return { stored, skipped, categories };
}
