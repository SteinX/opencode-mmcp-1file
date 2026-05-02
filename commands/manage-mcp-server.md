---
description: Stop, restart, or check status of the current HTTP MCP server
---

# Manage MCP Server

Manage the current plugin's shared HTTP MCP server using the local plugin tool `mcp_server_control`.

This command is intended for the **current shared HTTP MCP server**. If you are using stdio transport, these actions will result in a no-op.

## Usage

If the user's requested action is unclear or omitted, ask them to choose one of:
- `status`
- `stop`
- `restart`

### Status
Check if the server is running, its transport mode, and connection details.

```text
mcp_server_control({ action: "status" })
```

### Stop
Controlled stop requests shutdown of the shared HTTP server; if other holders remain, the tool reports that the server is still running.

```text
mcp_server_control({ action: "stop" })
```

### Restart
Restart the HTTP MCP server and reconnect the client. This is useful after config changes or if the server becomes unresponsive.

```text
mcp_server_control({ action: "restart" })
```

## Summary of Results

Summarize the returned JSON concisely for the user. Include relevant fields such as:
- `ok`: Whether the action succeeded.
- `action`: The action performed.
- `transport`: The current transport mode (stdio or http).
- `running`: Whether the server is currently running.
- `stopped`: Whether the server was successfully stopped.
- `url`: The server endpoint (for HTTP mode).
- `before`/`after`: State transitions for restart/stop actions.
- `holderCount`: Number of active plugin processes using the server.
- `error`: If `ok` is false, describe what went wrong.

## Prohibitions

- **NO shell commands**: Do not use `kill`, `pkill`, `lsof`, `ps`, or any manual process management workflows.
- **NO lock file access**: Do not attempt to read or modify `.server-lock` manually.
- **NO config edits**: Do not modify the plugin configuration files through this command.
- **NO manual process killing**: Never manually terminate the server process.
- **NO raw tools**: Use only the `mcp_server_control` unified tool. Do not call raw MCP server lifecycle tools.
