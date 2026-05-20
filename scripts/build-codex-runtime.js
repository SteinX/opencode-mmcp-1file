import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const root = process.cwd()
const pluginName = "codex-mmcp-1file"
const pluginDir = join(root, "packages/codex-plugin")
const coreDir = join(root, "packages/core")
const outputRoot = process.env.CODEX_RUNTIME_DIR ?? join(root, "dist/codex-runtime")
const outputDir = join(outputRoot, pluginName)
const dependencyRoots = ["@modelcontextprotocol/sdk", "jsonc-parser"]
const workspaceCoreDependency = "mmcp-1file-core"
const ignoredDependencyEntries = new Set([".cache", ".vite"])

function assertFile(path) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Missing required file: ${path}`)
  }
}

function assertDirectory(path) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`Missing required directory: ${path}`)
  }
}

function readJson(path) {
  assertFile(path)
  return JSON.parse(readFileSync(path, "utf8"))
}

function copyRequiredEntry(from, to) {
  if (existsSync(from)) {
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { recursive: true })
  }
}

function listRuntimeDependencies() {
  const lockPath = join(root, "package-lock.json")
  const lock = readJson(lockPath)
  const seen = new Set()
  const queue = [...dependencyRoots]

  while (queue.length > 0) {
    const name = queue.shift()
    if (!name || seen.has(name)) continue
    seen.add(name)

    const packagePath = `node_modules/${name}`
    const packageInfo = lock.packages?.[packagePath]
    if (!packageInfo) {
      throw new Error(`Missing ${packagePath} in package-lock.json`)
    }

    for (const dependency of Object.keys(packageInfo.dependencies ?? {})) {
      if (!seen.has(dependency)) queue.push(dependency)
    }
  }

  return [...seen].sort()
}

function copyDependency(name) {
  const from = join(root, "node_modules", name)
  const to = join(outputDir, "node_modules", name)
  assertDirectory(from)
  rmSync(to, { recursive: true, force: true })
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, {
    recursive: true,
    filter: (source) => {
      const basename = source.split("/").pop()
      return !ignoredDependencyEntries.has(basename ?? "")
    },
  })
}

function writeRuntimePackageJson() {
  const sourcePackage = readJson(join(pluginDir, "package.json"))
  const runtimePackage = {
    name: sourcePackage.name,
    version: sourcePackage.version,
    private: true,
    description: sourcePackage.description,
    type: sourcePackage.type,
    main: sourcePackage.main,
    license: sourcePackage.license,
  }
  writeFileSync(join(outputDir, "package.json"), `${JSON.stringify(runtimePackage, null, 2)}\n`)
}

assertDirectory(join(pluginDir, "dist"))
assertDirectory(join(coreDir, "dist"))
assertFile(join(pluginDir, ".codex-plugin/plugin.json"))
assertFile(join(pluginDir, "hooks/hooks.json"))
assertFile(join(pluginDir, "skills/memory/SKILL.md"))

rmSync(outputDir, { recursive: true, force: true })
mkdirSync(outputDir, { recursive: true })

for (const entry of [".codex-plugin", "hooks", "skills", "dist", "README.md", "LICENSE"]) {
  copyRequiredEntry(join(pluginDir, entry), join(outputDir, entry))
}

const bundledCoreDir = join(outputDir, "node_modules", workspaceCoreDependency)
mkdirSync(bundledCoreDir, { recursive: true })
for (const entry of ["dist", "package.json", "README.md", "LICENSE"]) {
  copyRequiredEntry(join(coreDir, entry), join(bundledCoreDir, entry))
}

for (const dependency of listRuntimeDependencies()) {
  copyDependency(dependency)
}

writeRuntimePackageJson()

const files = readdirSync(outputDir)
if (!files.includes(".codex-plugin") || !files.includes("dist") || !files.includes("node_modules")) {
  throw new Error(`Runtime output is incomplete: ${outputDir}`)
}

console.log(`Built Codex runtime at ${outputDir}`)
