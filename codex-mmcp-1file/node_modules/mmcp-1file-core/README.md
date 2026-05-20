# mmcp-1file-core

Shared runtime logic for memory-mcp-backed agent plugins.

This package intentionally has no OpenCode or Codex runtime dependency. Client
packages adapt their hook inputs and outputs to the core context, capture, and
recovery APIs.
