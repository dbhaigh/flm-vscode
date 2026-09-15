# flm-vscode README

This is the README for your extension "flm-vscode". After writing up a brief description, we recommend including the following sections.

## Features

Describe specific features of your extension including screenshots of your extension in action. Image paths are relative to this README file.

For example if there is an image subfolder under your extension project workspace:

\!\[feature X\]\(images/feature-x.png\)

> Tip: Many popular extensions utilize animations. This is an excellent way to show off your extension! We recommend short, focused animations that are easy to follow.

## Requirements

If you have any requirements or dependencies, add a section describing those and how to install and configure them.

## Extension Settings

Include if your extension adds any VS Code settings through the `contributes.configuration` extension point.

For example:

This extension contributes the following settings:

* `myExtension.enable`: Enable/disable this extension.
* `myExtension.thing`: Set to `blah` to do something.

## Known Issues

Calling out known issues can help limit users opening duplicate issues against your extension.

## Release Notes

Users appreciate release notes as you update your extension.

### 1.0.0

Initial release of ...

### 1.0.1

Fixed issue #.

### 1.1.0

Added features X, Y, and Z.


## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**

Interact with and manage a FastFlowLM server from Visual Studio Code.

## Features

- Chat with a FastFlowLM server through a webview panel.
- Discover available models through the OpenAI-compatible `/models` endpoint.
- Check server connectivity from the Command Palette.
- Start, stop, and restart a local server process from VS Code.
- Store the server URL, model, API key, command, arguments, and working directory in VS Code settings.

## Server Compatibility

The extension expects an OpenAI-compatible API:

- `GET {serverUrl}/models`
- `POST {serverUrl}/chat/completions`

Chat requests use non-streaming responses with the selected model.

## Configuration

Open **Settings** and search for **FastFlowLM**:

- `flm-vscode.serverUrl`: API base URL. Defaults to `http://127.0.0.1:8000/v1`.
- `flm-vscode.model`: Initial model identifier. Defaults to `fastflowlm`.
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

1. Run **FastFlowLM: Open Chat** from the Command Palette.
2. Use **Refresh models** to load models from the server.
3. Select a model, enter a prompt, and press **Send**. `Ctrl+Enter` also sends.
4. Use **Start**, **Stop**, or **Restart** when a local server command is configured.

The extension does not assume how FastFlowLM is installed or launched. Configure the command that matches your server installation.

## Development

```bash
npm install
npm run compile
npm test
```

Press `F5` in VS Code to launch an Extension Development Host.

## Current Scope

The first version uses non-streaming chat responses and manages one local server process. Streaming responses, server logs, and multiple named server profiles are natural follow-up features.
