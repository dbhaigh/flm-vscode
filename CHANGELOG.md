# Change Log

All notable changes to the "flm-vscode" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.0] - 2026-09-16

- a seperate FLM server is no longer required, flm-vscode can initiate it's own instance of flm serve - this can be configured via settings\extensions\flm-vscode
- Added FLM PATH detection and release version checking.
- Added the ability to download and install new version of FLM
- Added a dedicated chat window for FLM (it's a bit too chatty now :P )
- Added the ability to directly interact with the flm server in chat by invoking @flm (this is pretty damned fast :P )

## [0.0.1] - 2026-09-15

- Added FastFlowLM as a native VS Code language model chat provider.
- Added model discovery, streaming responses, tool calling, and local server management.
- Added an OpenAI-compatible webview chat panel.
- Published te source code to github.com/dbhaigh/flm-vscode
