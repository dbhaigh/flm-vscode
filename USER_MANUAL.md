# FLM-VSCode Extension User Manual

This extension lets you work with a local or remote FastFlowLM server directly from VS Code and route prompts through external harnesses and agents.

## Version 0.1.16

When an external harness request is cancelled or finishes, the extension now cleans up its child processes. On Windows, this includes subprocesses spawned by Hermes, preventing them from continuing to run after the request ends.

## Version 0.1.15

The built-in Aider configuration now runs non-interactively, suppressing interactive input, styled output, update checks, and release notes while accepting prompts automatically. The built-in Hermes configuration now invokes `hermes -z "{prompt}"` to run each request in prompt mode.

## Version 0.1.14

The chat panel now keeps its output in an independently scrollable region and keeps the composer accessible. The toolbar is placed with the composer, and the layout adapts to short windows. Version 0.1.13 was skipped; the previous release was 0.1.12.

## Version 0.1.12

The Aider and Codex harness integrations route requests to the configured FastFlowLM server. Aider uses the configured OpenAI-compatible endpoint, model, and API key by default. Codex uses a temporary authenticated loopback bridge to translate its Responses API requests to FastFlowLM's Chat Completions API.

## What this extension does

The extension provides:

- A native FastFlowLM chat participant for `@flm` prompts in VS Code Chat.
- A local FastFlowLM server manager with start, stop, restart, and status checks.
- Model discovery and connectivity checks against an OpenAI-compatible `/v1` API.
- Workspace file tools for reading and writing files in the first workspace folder.
- Support for direct prompts to external command-line harnesses and agents.
- Version checks for installed harnesses and optional install/update flows.
- An MCP bridge so Hermes and other compatible clients can use FastFlowLM chat, model, and project tools.

## Core abilities

### 1. FastFlowLM chat and control

Use the `@flm` chat participant in VS Code Chat to:

- send ordinary prompts to the configured FastFlowLM model
- inspect the server status
- list available models
- start or stop the server
- restart the server
- run an update check for FastFlowLM

Slash commands include:

- `/status`
- `/models`
- `/start`
- `/stop`
- `/restart`
- `/update`
- `/collaborate`

You can also send a prompt directly to a Copilot language model with `@copilot`. Use `@copilot /status` to check whether one is available in the current VS Code session.

### 2. Direct interaction with external harnesses

You can configure external command-line agents and select one as the default harness. When a harness is selected, ordinary `@flm` prompts can be routed directly to that harness instead of the local FastFlowLM model.

This is useful when you want to use a different coding agent while still retaining FastFlowLM for project tooling and model routing.

Supported choices include Aider (`aider`), Codex (`codex`), Hermes (`hermes`), OpenCode (`opencode`), Pi (`pi`), and any other configured external harness. Copilot is available separately as a direct `@copilot` participant when VS Code exposes a Copilot language model.

Direct `@aider` and `@codex` requests use the configured FastFlowLM server. Aider receives the configured OpenAI-compatible server URL, model, and API key. The extension bridges Codex's Responses API to FastFlowLM's Chat Completions API using a temporary authenticated loopback endpoint; it does not change the Codex user configuration.

### 3. External agent properties

Each external harness can be configured with its own properties in Settings JSON:

- `name`: the identifier used in `selectedAgent` and mentions
- `command`: executable path or command name
- `args`: required CLI arguments
- `versionArgs`: how to read the installed version
- `cwd`: working directory, when needed
- `env`: environment variables for the process
- `latestVersionUrl`: JSON endpoint used to check for an update
- `latestVersionField`: JSON field to read from the update endpoint
- `installCommand`: installation command, such as `npm` or `pip`
- `installArgs`: arguments to run when installing or upgrading

Use `{prompt}` in `args` when the harness expects the prompt as a command-line argument rather than reading it from stdin.

The default Pi harness is routed to the configured FastFlowLM `serverUrl` and `model`. On its first use, the extension adds or updates the `flm-vscode` provider in Pi's `models.json` under `PI_CODING_AGENT_DIR` (or `~/.pi/agent`), preserving other providers. The FastFlowLM API key is passed to Pi through the process environment and is not written to `models.json`. If Pi's `args` explicitly include `--provider` or `--model`, those arguments take precedence and automatic FastFlowLM routing is skipped.

### 4. Workspace-aware project tools

FastFlowLM can use workspace tools to:

- list file paths in the active workspace
- read file contents
- write files when the user confirms the operation

This makes the extension useful for coding workflows where the model interacts with the current project.

### 5. MCP server bridge

The extension ships with a bridge server at `dist/mcp-server.js`. It exposes tools such as:

- `fastflowlm_chat`
- `fastflowlm_models`
- `project_list_files`
- `project_read_file`
- `project_write_file`
- `memory_read`
- `memory_write`
- `memory_delete`

These tools can be used by Hermes and other compatible MCP clients.

## Settings reference

Open VS Code Settings and search for `FastFlowLM`.

### Server settings

- `flm-vscode.serverUrl`: FastFlowLM API base URL. Default: `http://127.0.0.1:8000/v1`
- `flm-vscode.model`: Initial model to use. Default: `qwen3.5:2b`
- `flm-vscode.apiKey`: Optional bearer token for the server
- `flm-vscode.serverCommand`: Local command used to run FastFlowLM, if needed
- `flm-vscode.serverArgs`: Arguments passed to the server command
- `flm-vscode.serverCwd`: Working directory for the server process
- `flm-vscode.checkForUpdates`: Check whether `flm` or the server is outdated
- `flm-vscode.debugStreaming`: Show raw stream output for debugging
- `flm-vscode.allowWorkspaceWrites`: Allow writes to workspace files; default is `true`

### External agent settings

- `flm-vscode.externalAgents`: Array of external harness settings, such as Aider, Codex, Hermes, OpenCode, or Pi
- `flm-vscode.selectedAgent`: Default configured harness name to use for ordinary `@flm` requests, or `none` to stay on FastFlowLM

The command `FastFlowLM: Select Harness or Agent` lets you choose `None` or a configured external harness without editing settings manually.

## Example configuration

```json
{
  "flm-vscode.serverUrl": "http://127.0.0.1:52625/v1",
  "flm-vscode.model": "qwen3.5:2b",
  "flm-vscode.apiKey": "dummy_key",
  "flm-vscode.selectedAgent": "hermes",
  "flm-vscode.externalAgents": [
    {
      "name": "aider",
      "command": "aider",
      "args": ["--no-fancy-input", "--no-pretty", "--no-check-update", "--no-show-release-notes", "--yes-always", "--message", "{prompt}"],
      "versionArgs": ["--version"],
      "installCommand": "pip",
      "installArgs": ["install", "--upgrade", "aider-chat"]
    },
    {
      "name": "codex",
      "command": "codex",
      "args": ["exec", "{prompt}"],
      "versionArgs": ["--version"],
      "installCommand": "npm",
      "installArgs": ["install", "-g", "@openai/codex@{version}"]
    },
    {
      "name": "hermes",
      "command": "hermes",
      "args": ["-z", "{prompt}"],
      "versionArgs": ["--version"],
      "installCommand": "pip",
      "installArgs": ["install", "--upgrade", "hermes-agent"]
    },
    {
      "name": "opencode",
      "command": "opencode",
      "args": ["run", "{prompt}"],
      "versionArgs": ["--version"],
      "installCommand": "npm",
      "installArgs": ["install", "-g", "@anthropic/opencode@{version}"]
    },
    {
      "name": "pi",
      "command": "pi",
      "args": ["--print", "{prompt}"],
      "versionArgs": ["--version"],
      "installCommand": "npm",
      "installArgs": ["install", "-g", "@mariozechner/pi-coding-agent@{version}"]
    }
  ]
}
```

## How to interact with harnesses directly

### Option 1: Use the selected default harness

Set `flm-vscode.selectedAgent` to the harness name you want to use, then send an ordinary `@flm` prompt.

The extension checks that the harness is installed and, when configured, checks for a newer version. If the harness is missing, it may prompt to install it.

### Option 2: Use the command palette

Run:

- `FastFlowLM: Select Harness or Agent`

This picks the default `@flm` harness without editing the JSON manually.

### Option 3: Mention a specific external agent

Use a normal prompt that explicitly names a configured agent, or run a multi-agent collaborative flow with the `/collaborate` command.

### Option 4: Use the built-in MCP bridge

Configure the MCP server entry:

```json
{
  "mcpServers": {
    "fastflowlm": {
      "command": "node",
      "args": ["C:/path/to/flm-vscode/dist/mcp-server.js"],
      "env": {
        "FLM_PROJECT_ROOT": "C:/path/to/project",
        "FLM_SERVER_URL": "http://127.0.0.1:52625/v1",
        "FLM_MODEL": "qwen3.5:2b",
        "FLM_API_KEY": "dummy_key"
      }
    }
  }
}
```

This lets Hermes or any compatible MCP client access FastFlowLM project tools and model tools.

## Best performance setup

To get the best results from this extension:

1. Keep FastFlowLM on a local, low-latency endpoint.
   - Prefer a local server on `127.0.0.1`.
   - Keep `flm-vscode.serverUrl` short and stable.

2. Match the server model to the task.
   - Use a smaller model for quick edits and code review.
   - Use a larger model when you need deep reasoning or architecture work.

3. Use the right harness for the right job.
   - FastFlowLM for local project work and model routing
  - Aider, Codex, Hermes, OpenCode, or Pi for specialized workflows or tooling

4. Keep the default agent aligned with the work you do most often.
   - Set `flm-vscode.selectedAgent` to the harness you want to use by default.

5. Use the local project tools but keep writes intentional.
   - Leave `flm-vscode.allowWorkspaceWrites` enabled only when you want the model to change files.
   - For safer workflows, keep it disabled and review changes manually.

6. Keep update checks enabled if you want the extension to keep harnesses current.
   - Set `flm-vscode.checkForUpdates` to `true` for the best maintenance flow.

7. Use `debugStreaming` only when diagnosing issues.
   - Leave it off in normal use to keep logs clean and output focused.

8. Use static environment variables and keep the command paths explicit.
   - Prefer fully-qualified command paths when required.
   - Put `cwd` and `env` values in the harness config when the tool needs a specific environment.

## Security and trust

- The extension sends prompts and tool payloads to the configured FastFlowLM server.
- API keys should be kept in user settings rather than committed to source control.
- Only configure commands and working directories you trust.
- The workspace write tools are bounded to the first workspace folder and require confirmation before writing.
- Treat external harnesses as trusted programs; they can launch local processes and read/write files depending on the command and environment you configure.

## Troubleshooting

### The server is not reachable

- Verify `flm-vscode.serverUrl`
- Run `FastFlowLM: Check Server`
- Start the server with `FastFlowLM: Start Server`

### The selected harness is missing

- Check the command is on PATH or use an explicit absolute path
- Confirm the installed version command is correct in `versionArgs`
- Set `installCommand` and `installArgs` if the extension should offer an install flow

### The harness expects the prompt as an argument

- Include `{prompt}` in the harness `args` array
- Example: `"args": ["--profile", "headless", "{prompt}"]`

### The harness is installed but outdated

- Use `latestVersionUrl` and `latestVersionField` to set up update comparison
- The extension will ask before running the installer

### The model is not available

- Refresh the server model list
- Confirm the model identifier is correct
- Check that the server is exposing an OpenAI-compatible /v1 API

## Recommended workflow

1. Start FastFlowLM or point to a stable local server.
2. Configure your default model and API settings.
3. Add one or more external harnesses in `flm-vscode.externalAgents`.
4. Set `flm-vscode.selectedAgent` to the harness you want most often.
5. Use `@flm` as your entry point for ordinary requests and `/collaborate` for multi-agent coordination.
6. Keep `allowWorkspaceWrites` conservative and confirm file changes.
7. Use lower latency local models for day-to-day coding, and larger models only when needed.

## Summary

This extension is most effective when you treat it as a workbench for local AI coding:

- FastFlowLM provides the local project model and tool layer.
- External harnesses provide direct agent access when needed.
- The selected agent becomes the default direct route for ordinary prompts.
- MCP integration allows the harnesses to share the same project and model tools.

With the right configuration, the extension becomes a stable, fast, and flexible local AI interface for coding, debugging, model switching, and multi-agent collaboration.
