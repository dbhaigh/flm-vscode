# FastFlowLM VS Code

Interact with and manage a FastFlowLM server from Visual Studio Code.

## Features

- Chat with a FastFlowLM server through a webview panel.
- Register FastFlowLM as a native VS Code Chat language model provider.
- Discover available models through the OpenAI-compatible `/models` endpoint.
- Check connectivity and manage a local FastFlowLM server from the Command Palette.
- Configure the server URL, model, API key, command, arguments, and working directory.

## Configuration

Open **Settings** and search for **FastFlowLM**:

- `flm-vscode.serverUrl`: API base URL. Defaults to `http://127.0.0.1:8000/v1`.
- `flm-vscode.model`: Initial model identifier. Defaults to `qwen3.5:2b`.
- `flm-vscode.apiKey`: Optional API key sent as a bearer token.
- `flm-vscode.serverCommand`: Optional local server command, such as `python`.
- `flm-vscode.serverArgs`: Arguments passed to the local server command.
- `flm-vscode.serverCwd`: Optional working directory for the server process.

For example, a local Python server can be managed with:

```json
{
	"flm-vscode.serverCommand": "python",
	"flm-vscode.serverArgs": ["-m", "fastflowlm.server"],
	"flm-vscode.serverCwd": "C:/path/to/FastFlowLM"
}
```

## Usage
4. Use **FastFlowLM: Check Server** from the Command Palette to test connectivity.
> Tip: Many popular extensions utilize animations. This is an excellent way to show off your extension! We recommend short, focused animations that are easy to follow.

The extension does not assume how FastFlowLM is installed or launched. Configure the command that matches your server installation. Native Chat requests use streaming responses when the server supports OpenAI-compatible SSE streaming.

## Development

```bash
npm install
npm run compile
npm test
```

Press `F5` in VS Code to launch an Extension Development Host.

## Current Scope

The extension manages one local server process. FastFlowLM receives VS Code tool schemas and conversation context, then returns text or tool calls through the native Chat provider API. The server must support OpenAI-compatible chat completions and function/tool calling.
