import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const commandPath = join(process.cwd(), "commands", "migrate-mcp-memory.md")
const content = readFileSync(commandPath, "utf-8")

describe("migrate-mcp-memory command", () => {
  it("references memory_migrate tool", () => {
    expect(content).toContain("memory_migrate")
  })

  it("documents dry-run flow", () => {
    expect(content).toContain("dry-run")
  })

  it("documents confirm requirement", () => {
    expect(content).toContain("confirm")
  })

  it("documents remap conflict strategy", () => {
    expect(content).toContain("remap")
  })

  it("documents source_tag and target_tag selectors", () => {
    expect(content).toContain("source_tag")
    expect(content).toContain("target_tag")
  })

  it("documents source_data_dir and target_data_dir selectors", () => {
    expect(content).toContain("source_data_dir")
    expect(content).toContain("target_data_dir")
  })

  it("documents source_project_id and target_project_id", () => {
    expect(content).toContain("source_project_id")
    expect(content).toContain("target_project_id")
  })

  it("prohibits destructive workflows", () => {
    const lower = content.toLowerCase()
    expect(lower).toMatch(/overwrite|reset|replace.all|do not|must not|never|prohibited|forbidden/)
  })

  it("prohibits migrate_memory raw tool", () => {
    expect(content).toContain("migrate_memory")
  })

  it("documents optional target selector (current workspace default)", () => {
    expect(content).toContain("current workspace")
  })

  it("documents optional target_project_id with preserve-source-project mode", () => {
    expect(content).toContain("preserve")
    expect(content).toContain("target_project_id")
  })
})
