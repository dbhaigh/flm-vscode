# FLM-VSCode

Interact with and manage a FastFlowLM server from Visual Studio Code.

## Version 0.1.9

Version 0.1.9 fixes a compatibility problem that was causing the extension to not run correctly on VSCode(Stable) - my bad, I had been developing with the Insider's edition, and not doing proper regression testing for compatibility.  It's working now

## Version 0.1.8

Version 0.1.8 removes a non-functional built-in harness integration and keeps direct routing available for configured external agents such as Hermes.

## Quick start

1. Install the extension and open the project you want to work in.
2. Start or point the extension at a FastFlowLM server exposing an OpenAI-compatible `/v1` API.
3. Open VS Code Settings and configure the main FastFlowLM values:
   - `flm-vscode.serverUrl`
   - `flm-vscode.model`
   - `flm-vscode.apiKey` when needed
4. Configure Hermes or another external agent under `flm-vscode.externalAgents` when external-agent routing is needed.
5. Open Chat and use `@flm` with a command like `/status` or a normal prompt.
6. Use the command palette commands for `FastFlowLM: Check Server`, `FastFlowLM: Start Server`, and `FastFlowLM: Select Harness or Agent` when needed.

For the complete end-user guide, see [USER_MANUAL.md](USER_MANUAL.md).

## Features

- Chat with a FastFlowLM server through a webview panel.
- Register FastFlowLM as a native VS Code Chat language model provider.
- Use the `@flm` chat participant and `/status`, `/models`, `/start`, `/stop`, `/restart`, or `/update` commands to manage the server directly in Chat.
- Let `@flm` inspect and update files in the first open workspace folder through model tool calls.
- Address another language-model-backed chat member from `@flm`, for example `@flm ask @Copilot to review this function`.
- Run `/collaborate` to pass a shared task through the selected model and explicitly mentioned agents, for example `@flm /collaborate @Copilot @qwen review this function`.
- Discover available models through the OpenAI-compatible `/models` endpoint.
- Check connectivity and manage a local FastFlowLM server from the Command Palette.
- Detect whether `flm` is installed on PATH and check for newer FastFlowLM releases.
- Follow server output and model activity in the `FastFlowLM` output channel.
- Configure the server URL, model, API key, command, arguments, and working directory.
- Connect Hermes or another configured external agent through external harness routing.

## Configuration

Configure the extension from **File > Preferences > Settings**, then search for **FastFlowLM**, or edit the JSON settings directly with **Preferences: Open User Settings (JSON)** or **Preferences: Open Workspace Settings (JSON)**. Use user settings for the API key; workspace settings are convenient for project-specific server and model values but are committed with the project if you place them in `.vscode/settings.json`.

The extension contributes these settings:

- `flm-vscode.serverUrl`: Base URL for the OpenAI-compatible API, including `/v1`. Default: `http://127.0.0.1:8000/v1`.
- `flm-vscode.model`: Model identifier sent to the server. Default: `qwen3.5:2b`.
- `flm-vscode.apiKey`: Optional bearer-token API key. Default: empty. Do not commit this value to workspace settings.
- `flm-vscode.serverCommand`: Optional executable used by **FastFlowLM: Start Server**, such as `python`. Leave empty when the server is managed separately.
- `flm-vscode.serverArgs`: Array of string arguments passed to `serverCommand`. Default: `[]`.
- `flm-vscode.serverCwd`: Optional working directory for the local server. If empty, the first open workspace folder is used.
- `flm-vscode.checkForUpdates`: Check for the `flm` executable and newer FastFlowLM releases when the extension activates. Default: `true`.
- `flm-vscode.debugStreaming`: Include raw streaming responses and model reasoning in the activity log and chat panel. Default: `false`; enable only when that output is safe to view.
- `flm-vscode.allowWorkspaceWrites`: Allow `@flm` to request writes in the first workspace folder. Default: `true`; every write still requires a confirmation dialog.
- `flm-vscode.memoryFile`: Workspace-relative JSON file used for persistent memory and agent activity. Default: `.flm/memory.json`.
- `flm-vscode.externalAgents`: Array of external command-line harness definitions. Entries must include `name` and `command`; the current implementation supports the name `hermes`.
- `flm-vscode.selectedAgent`: Default harness for `@flm` requests. Default: `none`. The **FastFlowLM: Select Harness or Agent** command saves the active choice in extension state and takes precedence over this setting.

For a separately managed server, the minimum configuration is:

```json
{
	"flm-vscode.serverUrl": "http://127.0.0.1:8000/v1",
	"flm-vscode.model": "qwen3.5:2b"
}
```

To let the extension start the server, set `serverCommand`, `serverArgs`, and, when needed, `serverCwd` together. `serverCommand` is executed directly, so put each command-line value in its own array item rather than quoting a complete command line:

```json
{
	"flm-vscode.serverCommand": "python",
	"flm-vscode.serverArgs": ["-m", "fastflowlm.server"],
	"flm-vscode.serverCwd": "C:/path/to/FastFlowLM"
}
```

To configure Hermes, add an object to `externalAgents`. `args` are passed to the harness; if an argument contains `{prompt}`, the prompt is substituted there, otherwise the prompt is sent on standard input. The version and installer fields are optional:

```json
{
	"flm-vscode.externalAgents": [
		{
			"name": "hermes",
			"command": "hermes",
			"args": [],
			"versionArgs": ["--version"],
			"latestVersionUrl": "https://pypi.org/pypi/hermes-agent/json",
			"latestVersionField": "info.version",
			"installCommand": "pip",
			"installArgs": ["install", "--upgrade", "hermes-agent"],
			"cwd": "C:/path/to/project",
			"env": {}
		}
	],
	"flm-vscode.selectedAgent": "hermes"
}
```

`latestVersionUrl` must return JSON, and `latestVersionField` is a dot-separated path to the version value. The extension checks a configured external agent once per extension session and asks before running its installer. **FastFlowLM: Select Harness or Agent** can select `None` or any valid configured external agent without editing `selectedAgent`.

When the configured model is unavailable, the extension selects the first model reported by the server. The `@flm` participant also includes earlier prompts and responses from the current participant conversation.

## Usage

1. Start a FastFlowLM server, or configure `flm-vscode.serverCommand` and use **FastFlowLM: Start Server**.
2. Use **FastFlowLM: Check Server** from the Command Palette to test connectivity.
3. Use **FastFlowLM: Check FLM Installation** to verify the CLI. When a release is missing or outdated, approve the prompt and the extension downloads and runs the Windows installer.
4. In VS Code Chat, invoke `@flm` and use a slash command such as `/status`, or send a normal prompt to talk directly to the configured FastFlowLM model.
5. Select a FastFlowLM model in the VS Code Chat model picker.

The chat panel displays live activity while a request runs, including model download/load messages, server status events, reasoning progress, and streamed response text. When the extension starts the server as a child process, its stdout and stderr are also shown in the chat and in the `FastFlowLM` output channel. Use **FastFlowLM: Show Activity Log** to view the complete activity history. A separately managed server must include its download/load activity in the OpenAI-compatible streaming response for the extension to display it.

The extension does not assume how FastFlowLM is installed or launched. Configure the command that matches your server installation. Native Chat requests use streaming responses when the server supports OpenAI-compatible SSE streaming.

Normal `@flm` prompts can use `workspace_list_files`, `workspace_read_file`, and `workspace_write_file` tools. File paths are relative to the first workspace folder, traversal outside that folder is rejected, text files are limited to 1 MB, and each write requires explicit confirmation. Disable `flm-vscode.allowWorkspaceWrites` to make the participant read-only.

When a normal `@flm` prompt explicitly mentions a language model-backed chat member, the extension resolves the mention against VS Code language models by vendor, name, id, or family and streams the request to that model. Copilot is normally available under the `copilot` vendor. Otherwise, ordinary prompts use the selected harness, or FastFlowLM when no harness is selected. VS Code does not expose a public API for one extension to invoke an arbitrary third-party chat participant directly, so participants without a language model provider cannot currently be delegated to programmatically.

The `/collaborate` command is the multi-agent workflow: the currently selected Chat model responds first, then each explicitly mentioned language model receives the shared transcript and can refine the task. Replies are labeled by model and streamed into the main Chat window.

### External agents

The extension can invoke Hermes and other configured command-line harnesses that are not registered as VS Code language models.

```json
{
	"flm-vscode.externalAgents": [
		{
			"name": "hermes",
			"command": "hermes",
			"versionArgs": ["--version"],
			"installCommand": "pip",
			"installArgs": ["install", "--upgrade", "hermes-agent"]
		},
	]
}
```

Once per VS Code extension session, the selected external agent is checked with `versionArgs` and, when configured, `latestVersionUrl`. If it is missing or outdated, the extension asks before running `installCommand` with `installArgs`. Use `{version}` in installer arguments to pass the latest version. If no update URL is configured, the installed command is checked but no remote update comparison is made. The extension starts commands directly without a shell.

## External harnesses

The package includes `dist/mcp-server.js`, a stdio MCP server that lets Hermes and other MCP clients use FastFlowLM alongside the current project. It provides `fastflowlm_chat`, `fastflowlm_models`, `project_list_files`, `project_read_file`, and `project_write_file` tools, plus persistent `memory_read`, `memory_write`, and `memory_delete` tools.

Build the extension, then configure the harness to launch `node` with the absolute path to `dist/mcp-server.js`. Set `FLM_PROJECT_ROOT` to the project directory and configure `FLM_SERVER_URL`, `FLM_MODEL`, and optionally `FLM_API_KEY` in the MCP process environment. For example:

```json
{
	"mcpServers": {
		"fastflowlm": {
			"command": "node",
			"args": ["C:/path/to/flm-vscode/dist/mcp-server.js"],
			"env": {
				"FLM_PROJECT_ROOT": "C:/path/to/project",
				"FLM_SERVER_URL": "http://127.0.0.1:8000/v1",
				"FLM_MODEL": "qwen3.5:2b"
			}
		}
	}
}
```

The bridge uses stdin/stdout for MCP protocol messages and never writes logs to stdout. Project memory is stored in `.flm/memory.json` by default, or at the project-relative path specified by `FLM_MEMORY_FILE`. Memory entries are limited to 64 KB each and 512 KB total. Keep `project_write_file` and `memory_write` available only for harnesses and projects you trust; they can modify files under `FLM_PROJECT_ROOT`.

## Requirements

- VS Code 1.137.0 or newer.
- A FastFlowLM server exposing an OpenAI-compatible `/v1` API.
- If FastFlowLM is not available, the extension can prompt to download and install the latest Windows release.
- The extension can check the installed `flm` version and prompt to install a newer release.
- Downloaded Windows installers are checked for a valid Authenticode signature before execution.
- The configured model must support chat completions. Tool calling requires server support for OpenAI-compatible function tools.

## Data and security

Chat messages, tool schemas, and tool results are sent to the configured FastFlowLM server. This extension does not send requests to a hosted service of its own. API keys are sent as bearer tokens and should be configured in user settings rather than committed to workspace settings.

The extension starts the configured server command with the current user permissions. Only configure commands and working directories you trust. Native `@flm` file tools are limited to the first workspace folder and do not provide arbitrary hard-drive access. Raw streaming output is disabled by default because it may contain prompts, reasoning, tool results, or other sensitive content.

## Troubleshooting

- **Cannot reach server:** verify `flm-vscode.serverUrl`, then run **FastFlowLM: Check Server**.
- **Model not found:** refresh models in the FastFlowLM chat panel and make sure `flm-vscode.model` matches the server's `/models` response.
- **Context or token limit errors:** reduce conversation history or increase the server KV capacity. Requests reserve up to 24,576 input tokens and 4,096 output tokens.

## Known limitations

Token counting uses a conservative character-based estimate because the extension does not have access to each model's tokenizer. The server remains authoritative for its actual context window.

## Development

```bash
npm install
npm run compile
npm test
```

Press `F5` in VS Code to launch an Extension Development Host.

## Publishing

To build a release VSIX, run `npm run package` followed by `npx --yes @vscode/vsce package --no-dependencies`. The generated artifact is named `flm-vscode-<version>.vsix` and includes both the VS Code extension and the external harness MCP bridge.

## Current Scope

The extension manages one local server process. FastFlowLM receives VS Code tool schemas and conversation context, then returns text or tool calls through the native Chat provider API. The server must support OpenAI-compatible chat completions and function/tool calling.
