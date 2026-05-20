import { type ContextBundle, type LedgerCaptureResult } from "mmcp-1file-core";
export declare function buildPromptContext(args: {
    cwd: string;
    sessionId?: string;
    prompt: string;
    compactSummary?: string;
}): Promise<ContextBundle | null>;
export declare function captureTaskLedger(args: {
    cwd: string;
    sessionId?: string;
    transcriptText: string;
}): Promise<LedgerCaptureResult>;
