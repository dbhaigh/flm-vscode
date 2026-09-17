# Change Log

All notable changes to the "flm-vscode" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.3] - 2026-09-16

- Made MCP requests process sequentially so persistent memory writes and reads remain ordered.
- Added atomic project-memory updates with per-entry and total-size limits.
- Added explicit MCP memory versioning and improved external harness documentation.

## [0.1.2] - 2026-09-16

- Prepared the external harness MCP bridge for publishing as a VSIX.
- Added persistent project memory tools for external harness sessions.

## [0.1.1] - 2026-09-16

- Added a standalone stdio MCP bridge for external coding harnesses, with FastFlowLM chat/model tools and guarded project file tools.

- Improved managed server startup by waiting for the child process to spawn and reporting startup failures immediately.
- Improved readiness checks so a server that exits before becoming available fails promptly instead of waiting for the full timeout.
- Added cancellation cleanup for dedicated chat requests when the chat panel closes.
- Added a 120-second streaming response timeout and clearer errors for incomplete SSE responses.
- Added support for multiline SSE `data:` fields.
- Disabled raw streaming diagnostics by default to avoid exposing prompts, reasoning, and tool results in logs.
- Added the `flm-vscode.debugStreaming` setting for opt-in raw stream diagnostics.
- Added fallback to the first available server model when the configured model is unavailable.
- Preserved earlier prompts and responses in normal `@flm` participant conversations.
- Added Authenticode signature validation before downloaded Windows installers are executed.
- Added regression coverage for multiline streams, incomplete streams, and model fallback.
- Added GitHub Actions validation and VSIX packaging, and excluded CI metadata from the published package.
- Enabled stricter TypeScript compiler checks and cleaned up shared workspace settings and documentation.

## [0.1.0] - 2026-09-16

- A separate FLM server is no longer required; flm-vscode can start its own `flm serve` instance configured in Settings.
- Added FLM PATH detection and release version checking.
- Added the ability to download and install new versions of FLM.
- Added a dedicated chat window for FLM with live activity reporting.
- Added the ability to interact directly with the FLM server in Chat by invoking `@flm`.
- Added model fallback when the configured model is unavailable.
- Preserved conversation history for normal `@flm` prompts.
- Added Authenticode validation before running downloaded Windows installers.

## [0.0.1] - 2026-09-15

- Added FastFlowLM as a native VS Code language model chat provider.
- Added model discovery, streaming responses, tool calling, and local server management.
- Added an OpenAI-compatible webview chat panel.
- Published the source code to github.com/dbhaigh/flm-vscode.
