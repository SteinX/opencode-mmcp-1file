import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { homedir } from "os"
import { join, resolve } from "path"
import { PluginConfig, resolveDataDir } from "../config.js"
import { isServerRunning, ensureServerRunning } from "./server-process.js"
import { logger } from "../utils/logger.js"

export type MigrationStatus = "dry_run_passed" | "dry_run_failed" | "migrated" | "blocked" | "failed"

export type TargetMode = "current-http" | "current-stdio-isolated" | "explicit-stdio-isolated"

export type ProjectMode = "retarget" | "preserve-source-project"

export interface MemoryMigrationArgs {
  source_tag?: string
  source_data_dir?: string
  target_tag?: string
  target_data_dir?: string
  source_project_id: string
  target_project_id?: string
  source_namespace?: string
  target_namespace?: string
  include_invalidated?: boolean
  dry_run?: boolean
  confirm?: boolean
}

export interface ResolvedMigrationShard {
  tag?: string
  dataDir: string
}

export interface ResolvedTarget {
  mode: TargetMode
  transport: "http" | "stdio"
  dataDir: string
  tag?: string
  serverUrl?: string
  runtimeWasRunning?: boolean
  runtimeStarted?: boolean
  message?: string
}

export interface MigrationNextCall {
  tool: "memory_migrate"
  args: MemoryMigrationArgs & { dry_run: false; confirm: true }
}

export interface MigrationReport {
  status: MigrationStatus
  exportedCount: number
  truncated: boolean
  importedCount: number
  skippedCount: number
  failedCount: number
  idMappings: unknown[]
  errors: unknown[]
  resolvedSource?: ResolvedMigrationShard
  resolvedTarget?: ResolvedTarget
  dryRun: boolean
  rawExportFragment?: string
  rawImportFragment?: string
  targetMode?: TargetMode
  targetTransport?: "http" | "stdio"
  targetDataDir?: string
  targetTag?: string
  targetServerUrl?: string
  targetRuntimeWasRunning?: boolean
  targetRuntimeStarted?: boolean
  targetProjectMode?: ProjectMode
  nextCall?: MigrationNextCall
}

interface MigrationClient {
  client: Client
  shard: ResolvedMigrationShard
}

interface ParsedToolResult {
  parsed: Record<string, unknown> | null
  rawFragment?: string
}

export function resolveTargetMode(args: MemoryMigrationArgs, config: PluginConfig): ResolvedTarget | null {
  const trimmedTag = args.target_tag?.trim()
  const trimmedDataDir = args.target_data_dir?.trim()

  // Both provided — validation error
  if (trimmedTag && trimmedDataDir) return null

  // Explicit target via tag or data_dir
  if (trimmedTag || trimmedDataDir) {
    let dataDir: string
    let tag: string | undefined
    if (trimmedDataDir) {
      dataDir = resolve(trimmedDataDir)
    } else {
      tag = trimmedTag
      dataDir = join(homedir(), ".local/share/opencode-mmcp-1file", trimmedTag ?? "target")
    }
    return { mode: "explicit-stdio-isolated", transport: "stdio", dataDir, tag }
  }

  // No target selectors — use current workspace
  const currentDataDir = resolveDataDir(config)
  if (currentDataDir === null) return null

  if (config.mcpServer.transport === "http") {
    return {
      mode: "current-http",
      transport: "http",
      dataDir: currentDataDir,
      tag: config.mcpServer.tag,
    }
  }

  return {
    mode: "current-stdio-isolated",
    transport: "stdio",
    dataDir: currentDataDir,
    tag: config.mcpServer.tag,
  }
}

export function projectModeFromArgs(args: MemoryMigrationArgs): ProjectMode {
  return isNonEmptyString(args.target_project_id) ? "retarget" : "preserve-source-project"
}

export async function migrateMemory(config: PluginConfig, args: MemoryMigrationArgs): Promise<MigrationReport> {
  let sourceClient: Client | null = null
  let targetClient: Client | null = null

  try {
    const resolvedSource = resolveMigrationShard(args.source_tag, args.source_data_dir, "source")
    const resolvedTarget = resolveTargetMode(args, config)
    const validationErrors = validateMigrationArgs(args, resolvedSource, resolvedTarget)

    if (validationErrors.length > 0 || !resolvedSource || !resolvedTarget) {
      return createReport({
        status: "blocked",
        errors: validationErrors,
        resolvedSource,
        resolvedTarget: resolvedTarget ?? undefined,
        dryRun: args.dry_run !== false,
      })
    }

    const sourceConnection = await connectToShard(config, resolvedSource)
    const targetConnection = await connectToTarget(config, resolvedTarget)
    sourceClient = sourceConnection.client
    targetClient = targetConnection.client

    const exportResult = await callJsonTool(sourceClient, "export_memory", buildExportArgs(args))
    const exportedJsonl = typeof exportResult.parsed?.jsonl === "string" ? exportResult.parsed.jsonl : ""

    const targetProjectMode = projectModeFromArgs(args)
    const dryRunResult = await callJsonTool(targetClient, "import_memory", buildImportArgs(args, exportedJsonl, true))
    const dryRunReport = reportFromResults({
      status: dryRunResult.parsed && !isImportFailed(dryRunResult.parsed) ? "dry_run_passed" : "dry_run_failed",
      resolvedSource,
      resolvedTarget,
      exportResult,
      importResult: dryRunResult,
      dryRun: true,
      targetProjectMode,
    })

    if (!dryRunResult.parsed || isImportFailed(dryRunResult.parsed)) {
      return dryRunReport.status === "dry_run_passed" ? { ...dryRunReport, status: "dry_run_failed" } : dryRunReport
    }

    if (args.dry_run !== false || args.confirm !== true) {
      return dryRunReport.status === "dry_run_passed"
        ? { ...dryRunReport, nextCall: buildMigrationNextCall(args) }
        : dryRunReport
    }

    const actualResult = await callJsonTool(targetClient, "import_memory", buildImportArgs(args, exportedJsonl, false))
    return reportFromResults({
      status: actualResult.parsed ? "migrated" : "failed",
      resolvedSource,
      resolvedTarget,
      exportResult,
      importResult: actualResult,
      dryRun: false,
      targetProjectMode,
    })
  } catch (err) {
    logger.error("migrateMemory failed", { error: String(err) })
    return createReport({
      status: "failed",
      errors: [{ code: "migration_failed", message: String(err) }],
      dryRun: args.dry_run !== false,
    })
  } finally {
    await disconnectClient(sourceClient)
    await disconnectClient(targetClient)
  }
}

function resolveMigrationShard(tag: string | undefined, dataDir: string | undefined, label: string): ResolvedMigrationShard | undefined {
  const trimmedTag = tag?.trim()
  const trimmedDataDir = dataDir?.trim()

  if ((trimmedTag && trimmedDataDir) || (!trimmedTag && !trimmedDataDir)) return undefined

  if (trimmedDataDir) return { dataDir: resolve(trimmedDataDir) }
  return { tag: trimmedTag, dataDir: join(homedir(), ".local/share/opencode-mmcp-1file", trimmedTag ?? label) }
}

function validateMigrationArgs(
  args: MemoryMigrationArgs,
  resolvedSource: ResolvedMigrationShard | undefined,
  resolvedTarget: ResolvedTarget | null,
): unknown[] {
  const errors: unknown[] = []

  if (!resolvedSource) errors.push({ code: "invalid_source_selector", message: "Provide exactly one of source_tag or source_data_dir" })

  // Both target selectors provided
  if (args.target_tag?.trim() && args.target_data_dir?.trim()) {
    errors.push({ code: "invalid_target_selector", message: "Provide at most one of target_tag or target_data_dir" })
  }

  // Plugin disabled: no explicit target and current workspace has no dataDir configured
  if (!args.target_tag?.trim() && !args.target_data_dir?.trim() && resolvedTarget === null) {
    errors.push({ code: "plugin_disabled", message: "Plugin is disabled (no tag or dataDir configured)" })
  }

  if (!isNonEmptyString(args.source_project_id)) errors.push({ code: "missing_source_project_id", message: "source_project_id is required" })

  if (resolvedSource && resolvedTarget && resolve(resolvedSource.dataDir) === resolve(resolvedTarget.dataDir)) {
    errors.push({ code: "same_shard", message: "Source and target shards resolve to the same data directory" })
  }

  return errors
}

async function connectToShard(config: PluginConfig, shard: ResolvedMigrationShard): Promise<MigrationClient> {
  const client = new Client({ name: "opencode-mmcp-1file-migration", version: "0.1.0" })
  const cmdParts = buildMigrationStdioCommand(config, shard.dataDir)
  const [command, ...args] = cmdParts
  logger.info(`Connecting migration MCP client via stdio: ${command} ${args.join(" ")}`)
  const transport = new StdioClientTransport({ command, args, stderr: "pipe" })
  await client.connect(transport)
  return { client, shard }
}

interface TargetConnection {
  client: Client
  runtimeWasRunning: boolean | undefined
  runtimeStarted: boolean | undefined
  serverUrl: string | undefined
}

async function connectToTarget(config: PluginConfig, resolvedTarget: ResolvedTarget): Promise<TargetConnection> {
  if (resolvedTarget.mode === "current-http") {
    const runtimeWasRunning = await isServerRunning(config)
    let serverUrl: string
    try {
      serverUrl = await ensureServerRunning(config)
    } catch (err) {
      throw new Error(`Failed to connect to HTTP MCP server: ${String(err)}`)
    }
    const url = new URL("/mcp", serverUrl)
    logger.info(`Connecting migration MCP client via HTTP: ${url.href}`)
    const transport = new StreamableHTTPClientTransport(url)
    const client = new Client({ name: "opencode-mmcp-1file-migration", version: "0.1.0" })
    await client.connect(transport)
    const runtimeStarted = !runtimeWasRunning
    resolvedTarget.runtimeWasRunning = runtimeWasRunning
    resolvedTarget.runtimeStarted = runtimeStarted
    resolvedTarget.serverUrl = serverUrl
    return { client, runtimeWasRunning, runtimeStarted, serverUrl }
  }

  const shard: ResolvedMigrationShard = { tag: resolvedTarget.tag, dataDir: resolvedTarget.dataDir }
  const connection = await connectToShard(config, shard)
  return { client: connection.client, runtimeWasRunning: undefined, runtimeStarted: undefined, serverUrl: undefined }
}

function buildMigrationStdioCommand(config: PluginConfig, dataDir: string): string[] {
  const { command, commandPath, model } = config.mcpServer
  const fullCommand = commandPath ? [commandPath, "--stdio"] : [...command]

  if (!fullCommand.some((arg) => arg === "--stdio")) fullCommand.push("--stdio")
  if (!fullCommand.some((arg) => arg === "--data-dir")) fullCommand.push("--data-dir", dataDir)
  if (!fullCommand.some((arg) => arg === "--log-file")) fullCommand.push("--log-file", `${dataDir}/log/mcp-server.log`)
  if (!fullCommand.some((arg) => arg === "--model") && model) fullCommand.push("--model", model)

  return fullCommand
}

function buildExportArgs(args: MemoryMigrationArgs): Record<string, unknown> {
  const includeInvalidated = args.include_invalidated === true
  return omitUndefined({
    project_id: args.source_project_id.trim(),
    valid_only: !includeInvalidated,
    include_invalidated: includeInvalidated,
    limit: 1000,
    namespace: optionalTrim(args.source_namespace),
  })
}

function buildImportArgs(args: MemoryMigrationArgs, jsonl: string, dryRun: boolean): Record<string, unknown> {
  const hasTargetProjectId = isNonEmptyString(args.target_project_id)
  return omitUndefined({
    ...(hasTargetProjectId ? { project_id: args.target_project_id!.trim() } : {}),
    jsonl,
    dry_run: dryRun,
    conflict_strategy: "remap",
    preserve_project_id: !hasTargetProjectId,
    allow_invalidated: args.include_invalidated === true,
    namespace: optionalTrim(args.target_namespace),
  })
}

function buildMigrationNextCall(args: MemoryMigrationArgs): MigrationNextCall {
  return {
    tool: "memory_migrate",
    args: {
      ...args,
      dry_run: false,
      confirm: true,
    },
  }
}

async function callJsonTool(client: Client, name: string, args: Record<string, unknown>): Promise<ParsedToolResult> {
  const result = await client.callTool({ name, arguments: args })
  const rawText = extractTextResult(result)

  try {
    return { parsed: JSON.parse(rawText) }
  } catch {
    return { parsed: null, rawFragment: rawText.slice(0, 1000) }
  }
}

function extractTextResult(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!result.content || !Array.isArray(result.content)) return ""
  return result.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n")
}

function reportFromResults(args: {
  status: MigrationStatus
  resolvedSource: ResolvedMigrationShard
  resolvedTarget: ResolvedTarget
  exportResult: ParsedToolResult
  importResult: ParsedToolResult
  dryRun: boolean
  targetProjectMode?: ProjectMode
  nextCall?: MigrationNextCall
}): MigrationReport {
  const status = args.status === "migrated" && isImportFailed(args.importResult.parsed) ? "failed" : args.status
  return createReport({
    status,
    resolvedSource: args.resolvedSource,
    resolvedTarget: args.resolvedTarget,
    exportedCount: toNumber(args.exportResult.parsed?.exported_count),
    truncated: toBoolean(args.exportResult.parsed?.truncated),
    importedCount: toNumber(args.importResult.parsed?.imported_count),
    skippedCount: toNumber(args.importResult.parsed?.skipped_count),
    failedCount: toNumber(args.importResult.parsed?.failed_count),
    idMappings: toArray(args.importResult.parsed?.id_mappings),
    errors: args.importResult.parsed ? toArray(args.importResult.parsed.errors) : [{ code: "import_parse_failed", message: "import_memory response was not parseable JSON" }],
    dryRun: args.dryRun,
    rawExportFragment: args.exportResult.rawFragment,
    rawImportFragment: args.importResult.rawFragment,
    targetMode: args.resolvedTarget.mode,
    targetTransport: args.resolvedTarget.transport,
    targetDataDir: args.resolvedTarget.dataDir,
    targetTag: args.resolvedTarget.tag,
    targetRuntimeWasRunning: args.resolvedTarget.runtimeWasRunning,
    targetRuntimeStarted: args.resolvedTarget.runtimeStarted,
    targetServerUrl: args.resolvedTarget.serverUrl,
    targetProjectMode: args.targetProjectMode,
  })
}

function createReport(overrides: Partial<MigrationReport> & { status: MigrationStatus; dryRun: boolean }): MigrationReport {
  return {
    status: overrides.status,
    exportedCount: overrides.exportedCount ?? 0,
    truncated: overrides.truncated ?? false,
    importedCount: overrides.importedCount ?? 0,
    skippedCount: overrides.skippedCount ?? 0,
    failedCount: overrides.failedCount ?? 0,
    idMappings: overrides.idMappings ?? [],
    errors: overrides.errors ?? [],
    resolvedSource: overrides.resolvedSource,
    resolvedTarget: overrides.resolvedTarget,
    dryRun: overrides.dryRun,
    rawExportFragment: overrides.rawExportFragment,
    rawImportFragment: overrides.rawImportFragment,
    targetMode: overrides.targetMode,
    targetTransport: overrides.targetTransport,
    targetDataDir: overrides.targetDataDir,
    targetTag: overrides.targetTag,
    targetServerUrl: overrides.targetServerUrl,
    targetRuntimeWasRunning: overrides.targetRuntimeWasRunning,
    targetRuntimeStarted: overrides.targetRuntimeStarted,
    targetProjectMode: overrides.targetProjectMode,
    nextCall: overrides.nextCall,
  }
}

function isImportFailed(parsed: Record<string, unknown> | null): boolean {
  if (!parsed) return true
  return toArray(parsed.errors).length > 0 || toNumber(parsed.failed_count) > 0
}

async function disconnectClient(client: Client | null): Promise<void> {
  if (!client) return
  try {
    await client.close()
  } catch (err) {
    logger.error("Failed to disconnect migration MCP client", { error: String(err) })
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function optionalTrim(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function toBoolean(value: unknown): boolean {
  return value === true
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
