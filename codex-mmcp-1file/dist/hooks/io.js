import { readFileSync } from "node:fs";
export async function readStdin() {
    return new Promise((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
            data += chunk;
        });
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", reject);
    });
}
export function parseHookInput(raw) {
    if (!raw.trim())
        return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
}
export function optionalString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
export function readTranscript(path) {
    if (!path)
        return "";
    try {
        return readFileSync(path, "utf8");
    }
    catch {
        return "";
    }
}
export function writeJson(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}
export function writeEmptySuccess() {
    writeJson({});
}
