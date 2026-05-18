import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const root = process.cwd()
const sharedCoreRuntimeDependencies = ["@modelcontextprotocol/sdk", "jsonc-parser"]
const forbiddenCoreRuntimeReferences = ["@opencode-ai/plugin", "@opencode-ai/sdk"]

const packages = [
  {
    name: "opencode-mmcp-1file",
    dir: "packages/opencode-plugin",
    required: [
      "dist/index.js",
      "dist/index.d.ts",
      "node_modules/mmcp-1file-core/dist/index.js",
      "node_modules/mmcp-1file-core/package.json",
      "commands/init-mcp-memory.md",
      "commands/setup-mcp-memory.md",
      "commands/manage-mcp-server.md",
      "opencode-mmcp-1file.example.jsonc",
      "README.md",
      "LICENSE",
    ],
    json: ["package.json"],
  },
  {
    name: "codex-mmcp-1file",
    dir: "packages/codex-plugin",
    required: [
      "dist/index.js",
      "node_modules/mmcp-1file-core/dist/index.js",
      "node_modules/mmcp-1file-core/package.json",
      "dist/hooks/user-prompt-submit.js",
      "dist/hooks/stop.js",
      ".codex-plugin/plugin.json",
      "hooks/hooks.json",
      "skills/memory/SKILL.md",
      "README.md",
      "LICENSE",
    ],
    json: ["package.json", ".codex-plugin/plugin.json", "hooks/hooks.json"],
  },
]

function assertFile(packageDir, relativePath) {
  const absolutePath = join(root, packageDir, relativePath)
  if (!existsSync(absolutePath)) {
    throw new Error(`Missing package file: ${packageDir}/${relativePath}`)
  }
  if (!statSync(absolutePath).isFile()) {
    throw new Error(`Package path is not a file: ${packageDir}/${relativePath}`)
  }
}

function parseJson(packageDir, relativePath) {
  const absolutePath = join(root, packageDir, relativePath)
  try {
    return JSON.parse(readFileSync(absolutePath, "utf8"))
  } catch (error) {
    throw new Error(`Invalid JSON in ${packageDir}/${relativePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertNoForbiddenReferences(packageDir, relativePath, forbiddenReferences) {
  const absolutePath = join(root, packageDir, relativePath)
  if (!existsSync(absolutePath)) return

  const content = readFileSync(absolutePath, "utf8")
  for (const forbiddenReference of forbiddenReferences) {
    if (content.includes(forbiddenReference)) {
      throw new Error(`${packageDir}/${relativePath} must not reference ${forbiddenReference}`)
    }
  }
}

const marketplace = parseJson(".", ".codex-plugin/marketplace.json")
if (marketplace.name !== "mmcp-1file") {
  throw new Error(`Root .codex-plugin/marketplace.json name must be mmcp-1file, got ${marketplace.name}`)
}
if (marketplace.interface?.displayName !== "Memory MCP") {
  throw new Error("Root .codex-plugin/marketplace.json interface.displayName must be Memory MCP")
}
const marketplacePlugin = marketplace.plugins?.find((plugin) => plugin.name === "codex-mmcp-1file")
if (!marketplacePlugin) {
  throw new Error("Root .codex-plugin/marketplace.json must list codex-mmcp-1file")
}
if (marketplacePlugin.source?.source !== "git-subdir") {
  throw new Error("codex-mmcp-1file marketplace source must use git-subdir")
}
if (marketplacePlugin.source?.url !== "https://github.com/SteinX/opencode-mmcp-1file.git") {
  throw new Error("codex-mmcp-1file marketplace source url must point to the GitHub repository")
}
if (marketplacePlugin.source?.path !== "./packages/codex-plugin") {
  throw new Error("codex-mmcp-1file marketplace source path must be ./packages/codex-plugin")
}
if (marketplacePlugin.source?.ref !== "main") {
  throw new Error("codex-mmcp-1file marketplace source ref must be main")
}
if (marketplacePlugin.policy?.installation !== "AVAILABLE") {
  throw new Error("codex-mmcp-1file marketplace installation policy must be AVAILABLE")
}
if (marketplacePlugin.policy?.authentication !== "ON_INSTALL") {
  throw new Error("codex-mmcp-1file marketplace authentication policy must be ON_INSTALL")
}
if (marketplacePlugin.category !== "Memory") {
  throw new Error("codex-mmcp-1file marketplace category must be Memory")
}

for (const pkg of packages) {
  for (const file of pkg.required) assertFile(pkg.dir, file)
  for (const file of pkg.json) parseJson(pkg.dir, file)

  const packageJson = parseJson(pkg.dir, "package.json")
  if (packageJson.name !== pkg.name) {
    throw new Error(`${pkg.dir}/package.json name must be ${pkg.name}, got ${packageJson.name}`)
  }

  if (!Array.isArray(packageJson.bundledDependencies) || !packageJson.bundledDependencies.includes("mmcp-1file-core")) {
    throw new Error(`${pkg.dir}/package.json must bundle mmcp-1file-core so plugin installs do not require publishing core separately`)
  }

  for (const dependency of sharedCoreRuntimeDependencies) {
    if (typeof packageJson.dependencies?.[dependency] !== "string") {
      throw new Error(`${pkg.dir}/package.json must declare ${dependency} because bundled mmcp-1file-core imports it at runtime`)
    }
  }
}

const codexPlugin = parseJson("packages/codex-plugin", ".codex-plugin/plugin.json")
const codexPackage = parseJson("packages/codex-plugin", "package.json")
if (codexPlugin.version !== codexPackage.version) {
  throw new Error(`codex plugin manifest version must match package.json version: ${codexPlugin.version} !== ${codexPackage.version}`)
}
if (codexPlugin.hooks !== "./hooks/hooks.json") {
  throw new Error("codex plugin.json must point hooks to ./hooks/hooks.json")
}
if (codexPlugin.skills !== "./skills/") {
  throw new Error("codex plugin.json must point skills to ./skills/")
}
if ("mcpServers" in codexPlugin) {
  throw new Error("codex plugin.json must not declare mcpServers; hooks start MCP from workspace config")
}

const hooks = parseJson("packages/codex-plugin", "hooks/hooks.json")
const userPromptCommand = hooks?.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command
const stopCommand = hooks?.hooks?.Stop?.[0]?.hooks?.[0]?.command
if (userPromptCommand !== "node \"$PLUGIN_ROOT/dist/hooks/user-prompt-submit.js\"") {
  throw new Error("UserPromptSubmit hook must run dist/hooks/user-prompt-submit.js through PLUGIN_ROOT")
}
if (stopCommand !== "node \"$PLUGIN_ROOT/dist/hooks/stop.js\"") {
  throw new Error("Stop hook must run dist/hooks/stop.js through PLUGIN_ROOT")
}

for (const file of [
  "package.json",
  "dist/index.d.ts",
  "dist/utils/logger.d.ts",
  "node_modules/mmcp-1file-core/package.json",
  "node_modules/mmcp-1file-core/dist/index.d.ts",
  "node_modules/mmcp-1file-core/dist/utils/logger.d.ts",
]) {
  assertNoForbiddenReferences("packages/core", file, forbiddenCoreRuntimeReferences)
  assertNoForbiddenReferences("packages/codex-plugin", file, forbiddenCoreRuntimeReferences)
}

console.log("Package content verification passed")
