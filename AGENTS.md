# AGENTS.md — FastFlowLM VS Code Extension

## Build & verify

```bash
npm install                    # one-time setup
npm run compile                # typecheck → lint → esbuild (required before test or debug)
npm test                     # runs @vscode/test-electron against compiled output
npx --yes @vscode/vsce package --no-dependencies   # produce .vsix artifact
```

Press **F5** in VS Code to launch the Extension Development Host (reads `launch.json` from `.vscode/`).

## Architecture

- Single extension: `src/extension.ts` registers commands, chat participants, settings, and activation listeners.
- MCP bridge: `src/mcp-server.ts` exposes stdio MCP tools (`fastflowlm_chat`, `project_list_files`, etc.) for external harnesses.
- Build: esbuild bundles both sources into `dist/`. `vscode` is external — never import it in MCP server code.
- Output: `dist/extension.js` (main entry), `dist/mcp-server.js` (stdio binary).

## Key constraints

- `npm run compile` enforces strict order: typecheck → lint → build. Do not skip steps.
- Production builds (`--production`) minify; development builds use source maps.
- Tests run inside a real VS Code window via `@vscode/test-electron`; they do not run in Node alone.
- The MCP server must never depend on the VS Code API — it runs outside VS Code as a standalone process.