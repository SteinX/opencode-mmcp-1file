import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const root = process.cwd()
const pluginName = "codex-mmcp-1file"
const runtimeRoot = process.env.CODEX_RUNTIME_DIR ?? join(root, "dist/codex-runtime")
const runtimeDir = process.env.CODEX_RUNTIME_PLUGIN_DIR ?? join(runtimeRoot, pluginName)
const requiredFiles = [
  ".codex-plugin/plugin.json",
  "hooks/hooks.json",
  "skills/memory/SKILL.md",
  "dist/index.js",
  "dist/hooks/user-prompt-submit.js",
  "dist/hooks/stop.js",
  "node_modules/mmcp-1file-core/dist/index.js",
  "node_modules/mmcp-1file-core/package.json",
  "node_modules/@modelcontextprotocol/sdk/package.json",
  "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
  "node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js",
  "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js",
  "node_modules/jsonc-parser/package.json",
  "README.md",
  "LICENSE",
  "package.json",
]

function assertFile(relativePath) {
  const absolutePath = join(runtimeDir, relativePath)
  if (!existsSync(absolutePath)) {
    throw new Error(`Missing Codex runtime file: ${relativePath}`)
  }
  if (!statSync(absolutePath).isFile()) {
    throw new Error(`Codex runtime path is not a file: ${relativePath}`)
  }
}

function parseJson(relativePath) {
  try {
    return JSON.parse(readFileSync(join(runtimeDir, relativePath), "utf8"))
  } catch (error) {
    throw new Error(`Invalid JSON in Codex runtime ${relativePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

for (const file of requiredFiles) assertFile(file)

const manifest = parseJson(".codex-plugin/plugin.json")
const runtimePackage = parseJson("package.json")
const hooks = parseJson("hooks/hooks.json")

if (manifest.name !== pluginName) {
  throw new Error(`Codex runtime manifest name must be ${pluginName}, got ${manifest.name}`)
}
if (manifest.version !== runtimePackage.version) {
  throw new Error(`Codex runtime manifest version must match package.json: ${manifest.version} !== ${runtimePackage.version}`)
}
if (manifest.hooks !== "./hooks/hooks.json") {
  throw new Error("Codex runtime manifest must point hooks to ./hooks/hooks.json")
}
if (manifest.skills !== "./skills/") {
  throw new Error("Codex runtime manifest must point skills to ./skills/")
}
if ("mcpServers" in manifest) {
  throw new Error("Codex runtime manifest must not declare mcpServers; hooks start MCP from workspace config")
}
if (runtimePackage.private !== true) {
  throw new Error("Codex runtime package.json must be private")
}

const userPromptCommand = hooks?.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command
const stopCommand = hooks?.hooks?.Stop?.[0]?.hooks?.[0]?.command
if (userPromptCommand !== "node \"$PLUGIN_ROOT/dist/hooks/user-prompt-submit.js\"") {
  throw new Error("UserPromptSubmit hook must run dist/hooks/user-prompt-submit.js through PLUGIN_ROOT")
}
if (stopCommand !== "node \"$PLUGIN_ROOT/dist/hooks/stop.js\"") {
  throw new Error("Stop hook must run dist/hooks/stop.js through PLUGIN_ROOT")
}

console.log(`Codex runtime verification passed: ${runtimeDir}`)
