export declare function readStdin(): Promise<string>;
export declare function parseHookInput(raw: string): Record<string, unknown>;
export declare function optionalString(value: unknown): string | undefined;
export declare function readTranscript(path: string | undefined): string;
export declare function writeJson(value: unknown): void;
export declare function writeEmptySuccess(): void;
