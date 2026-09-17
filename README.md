# FLM-VSCode

Interact with and manage a FastFlowLM server from Visual Studio Code.

## Version 0.1.7

Version 0.1.7 focuses the direct harness experience on **None**, **DeepSeek**, and **Hermes**. Direct Claude routing was removed because Claude Code is available via Hermes. The release also improves external harness diagnostics, including clearer DeepSeek credential guidance.

## Quick start

1. Install the extension and open the project you want to work in.
2. Start or point the extension at a FastFlowLM server exposing an OpenAI-compatible `/v1` API.
3. Open VS Code Settings and configure the main FastFlowLM values:
   - `flm-vscode.serverUrl`
   - `flm-vscode.model`
   - `flm-vscode.apiKey` when needed
4. If you want direct external-agent routing, add DeepSeek or Hermes under `flm-vscode.externalAgents` and set `flm-vscode.selectedAgent` to the harness you want by default.
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
- Connect DeepSeek or Hermes through direct harness routing, or use the included MCP project bridge with compatible clients.

## Configuration

Open **Settings** and search for **FastFlowLM**:

- `flm-vscode.serverUrl`: API base URL. Defaults to `http://127.0.0.1:8000/v1`.
- `flm-vscode.model`: Initial model identifier. Defaults to `qwen3.5:2b`.
- `flm-vscode.apiKey`: Optional API key sent as a bearer token.
- `flm-vscode.serverCommand`: Optional local server command, such as `python`.
- `flm-vscode.serverArgs`: Arguments passed to the local server command.
- `flm-vscode.serverCwd`: Optional working directory for the server process.
- `flm-vscode.checkForUpdates`: Check FLM availability and releases when the extension activates. Defaults to `true`.
- `flm-vscode.debugStreaming`: Include raw streaming responses and model reasoning in activity output. Defaults to `false`.
- `flm-vscode.allowWorkspaceWrites`: Allow `@flm` to request workspace file writes. Defaults to `true`; every write still requires a VS Code confirmation dialog.
- `flm-vscode.selectedAgent`: Legacy configuration fallback for the default harness. The **FastFlowLM: Select Harness or Agent** command stores its choice in extension state, so it remains reliable across extension reloads even when settings registration is stale. The selector offers `None`, `DeepSeek`, and `Hermes`; direct Claude entries are ignored because Claude Code is available via Hermes.

When the configured model is unavailable, the extension selects the first model reported by the server. The `@flm` participant also includes earlier prompts and responses from the current participant conversation.

For example, a local Python server can be managed with:

```json
{
	"flm-vscode.serverCommand": "python",
	"flm-vscode.serverArgs": ["-m", "fastflowlm.server"],
	"flm-vscode.serverCwd": "C:/path/to/FastFlowLM"
}
```

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

The extension can invoke DeepSeek and Hermes command-line harnesses that are not registered as VS Code language models. Configure them in Settings JSON under `flm-vscode.externalAgents`; prompts are sent as a structured text transcript on stdin. Put `{prompt}` in an argument when a harness requires the prompt as a command-line argument instead.

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
		{
			"name": "deepseek",
			"command": "dsh",
			"args": ["--profile", "headless", "{prompt}"],
			"versionArgs": ["--version"],
			"latestVersionUrl": "https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest",
			"latestVersionField": "version",
			"installCommand": "npm",
			"installArgs": ["install", "--global", "@deepseek-ai/dsh@{version}"]
		}
	],
	"flm-vscode.selectedAgent": "deepseek"
}
```

Once per VS Code extension session, the selected external agent is checked with `versionArgs` and, when configured, `latestVersionUrl`. If it is missing or outdated, the extension asks before running `installCommand` with `installArgs`. Use `{version}` in installer arguments to pass the latest version. Replace the example release URLs and package names with the official metadata and installer for your Hermes and DeepSeek distributions. If no update URL is configured, the installed command is checked but no remote update comparison is made. The extension starts commands directly without a shell.

## External harnesses

The package includes `dist/mcp-server.js`, a stdio MCP server that lets Hermes, DeepSeek-based harnesses, and other MCP clients use FastFlowLM alongside the current project. It provides `fastflowlm_chat`, `fastflowlm_models`, `project_list_files`, `project_read_file`, and `project_write_file` tools, plus persistent `memory_read`, `memory_write`, and `memory_delete` tools.

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
- **DeepSeek `MISSING_CREDENTIAL`:** configure the `llm-deepseek` provider in the DeepSeek Models page, or set `DEEPSEEK_API_KEY` in the environment before launching VS Code. You can also pass it through the selected agent's `env` object, but do not commit that key to workspace settings.

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
