import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

const root = process.cwd()
const coreDir = join(root, "packages/core")
const bundledTargets = [
  join(root, "packages/opencode-plugin/node_modules/mmcp-1file-core"),
  join(root, "packages/codex-plugin/node_modules/mmcp-1file-core"),
]

function assertBuiltCore() {
  const distIndex = join(coreDir, "dist/index.js")
  if (!existsSync(distIndex)) {
    throw new Error("packages/core/dist/index.js is missing. Run npm run build -w mmcp-1file-core before bundling core.")
  }
}

function copyCore(targetDir) {
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })

  for (const entry of ["dist", "package.json", "README.md", "LICENSE"]) {
    cpSync(join(coreDir, entry), join(targetDir, entry), { recursive: true })
  }
}

assertBuiltCore()
for (const target of bundledTargets) copyCore(target)

console.log("Bundled mmcp-1file-core into plugin packages")
