/**
 * Placeholder for future HTTP transport support.
 * Currently only stdio transport is supported (MCP server lacks --listen).
 * When upstream adds HTTP support, this file will manage server lifecycle.
 */

export async function stopServer(): Promise<void> {
  // no-op: stdio transport lifecycle managed by StdioClientTransport
}
