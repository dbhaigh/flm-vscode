# FastFlowLM VS Code

Interact with and manage a FastFlowLM server from Visual Studio Code.

## Features

- Chat with a FastFlowLM server through a webview panel.
- Register FastFlowLM as a native VS Code Chat language model provider.
- Use the `@flm` chat participant and `/status`, `/models`, `/start`, `/stop`, `/restart`, or `/update` commands to manage the server directly in Chat.
- Discover available models through the OpenAI-compatible `/models` endpoint.
- Check connectivity and manage a local FastFlowLM server from the Command Palette.
- Detect whether `flm` is installed on PATH and check for newer FastFlowLM releases.
- Follow server output and model activity in the `FastFlowLM` output channel.
- Configure the server URL, model, API key, command, arguments, and working directory.

## Configuration

Open **Settings** and search for **FastFlowLM**:

- `flm-vscode.serverUrl`: API base URL. Defaults to `http://127.0.0.1:8000/v1`.
- `flm-vscode.model`: Initial model identifier. Defaults to `qwen3.5:2b`.
- `flm-vscode.apiKey`: Optional API key sent as a bearer token.
- `flm-vscode.serverCommand`: Optional local server command, such as `python`.
- `flm-vscode.serverArgs`: Arguments passed to the local server command.
- `flm-vscode.serverCwd`: Optional working directory for the server process.
- `flm-vscode.checkForUpdates`: Check FLM availability and releases when the extension activates. Defaults to `true`.

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

6. you can interact withthe flm server directly in chat via the @flm chat partciipant

The chat panel displays live activity while a request runs, including model download/load messages, server status events, reasoning progress, and streamed response text. When the extension starts the server as a child process, its stdout and stderr are also shown in the chat and in the `FastFlowLM` output channel. Use **FastFlowLM: Show Activity Log** to view the complete activity history. A separately managed server must include its download/load activity in the OpenAI-compatible streaming response for the extension to display it.

The extension does not assume how FastFlowLM is installed or launched. Configure the command that matches your server installation. Native Chat requests use streaming responses when the server supports OpenAI-compatible SSE streaming.

## Requirements

- VS Code 1.137.0 or newer.
- A FastFlowLM server exposing an OpenAI-compatible `/v1` API.
	- if a FastFlowLM server isn't available, the system will prompt for permission to downlad and install the latest version
	- the system will also check the version of flm that is installed, and prompt to download and install the latest version
- The configured model must support chat completions. Tool calling requires server support for OpenAI-compatible function tools.

## Data and security

Chat messages, tool schemas, and tool results are sent to the configured FastFlowLM server. This extension does not send requests to a hosted service of its own. API keys are sent as bearer tokens and should be configured in user settings rather than committed to workspace settings.

The extension starts the configured server command with the current user permissions. Only configure commands and working directories you trust.

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

## Current Scope

The extension manages one local server process. FastFlowLM receives VS Code tool schemas and conversation context, then returns text or tool calls through the native Chat provider API. The server must support OpenAI-compatible chat completions and function/tool calling.

## NOTE

This is a work-in-progress, there's a number of things I want to implement - like te FLM server being a bit more chatty in the terminal - I want to see the status and the thinking process , not just a single word

Yeah, it's very chatty now - just open the dedicated chat window and watch the noise
