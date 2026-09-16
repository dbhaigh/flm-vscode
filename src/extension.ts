import * as vscode from 'vscode';
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type ChatMessage = {
	role: 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_call_id?: string;
	tool_calls?: ToolCall[];
};
type OpenAITool = { type: 'function'; function: { name: string; description: string; parameters: object } };
type ServerState = 'stopped' | 'starting' | 'running' | 'error';
type StatusReporter = (message: string) => void;
type ServerStarter = () => Promise<void>;
const MAX_INPUT_TOKENS = 24576;
const MAX_OUTPUT_TOKENS = 4096;
const CHARS_PER_TOKEN = 4;
const FLM_INSTALLER_URL = 'https://github.com/ROCm/FastFlowLM/releases/latest/download/flm-setup.msi';
const FLM_LATEST_RELEASE_API = 'https://api.github.com/repos/ROCm/FastFlowLM/releases/latest';

export function parseFlmVersion(output: string): string | undefined {
	try {
		const payload = JSON.parse(output) as { version?: unknown };
		if (typeof payload.version === 'string') {
			const match = payload.version.match(/\d+(?:\.\d+){1,3}/);
			if (match) {return match[0];}
		}
	} catch { /* Fall back to human-readable version output. */ }
	return output.match(/\d+(?:\.\d+){1,3}/)?.[0];
}

export function compareFlmVersions(left: string, right: string): number {
	const parse = (version: string) => version.replace(/^v/i, '').split('.').map(part => Number.parseInt(part, 10) || 0);
	const leftParts = parse(left);
	const rightParts = parse(right);
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (difference !== 0) {return difference > 0 ? 1 : -1;}
	}
	return 0;
}

export function installedFlmVersion(command = 'flm'): string | undefined {
	try {
		const output = execFileSync(command, ['version', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		return parseFlmVersion(String(output));
	} catch {
		return undefined;
	}
}

async function latestFlmVersion(): Promise<string | undefined> {
	try {
		const response = await fetch(FLM_LATEST_RELEASE_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'flm-vscode' } });
		if (!response.ok) {return undefined;}
		const release = await response.json() as { tag_name?: unknown };
		return typeof release.tag_name === 'string' ? parseFlmVersion(release.tag_name) : undefined;
	} catch {
		return undefined;
	}
}

export async function downloadAndInstallFlm(reportStatus: StatusReporter = () => {}): Promise<void> {
	if (process.platform !== 'win32') {throw new Error('Automatic FLM installation is currently supported on Windows only.');}
	const installerPath = join(tmpdir(), `flm-setup-${Date.now()}.msi`);
	try {
		reportStatus('Downloading the latest FastFlowLM installer.');
		const response = await fetch(FLM_INSTALLER_URL);
		if (!response.ok) {throw new Error(`FastFlowLM installer download failed (${response.status}).`);}
		await fs.writeFile(installerPath, Buffer.from(await response.arrayBuffer()));
		reportStatus('Starting the FastFlowLM installer.');
		await new Promise<void>((resolve, reject) => {
			const installer = spawn('msiexec.exe', ['/i', installerPath, '/passive', '/norestart'], { windowsHide: false });
			installer.on('error', reject);
			installer.on('exit', code => code === 0 ? resolve() : reject(new Error(`FastFlowLM installer exited with code ${code ?? 'unknown'}.`)));
		});
		reportStatus('FastFlowLM installation completed.');
	} finally {
		await fs.rm(installerPath, { force: true });
	}
}

export async function checkFlmInstallation(reportStatus: StatusReporter = () => {}): Promise<void> {
	const installed = installedFlmVersion();
	if (!installed) {
		reportStatus('FLM is not installed or is not available on PATH.');
		const choice = await vscode.window.showWarningMessage('FastFlowLM (flm) is not installed or is not available on PATH.', 'Download and Install');
		if (choice === 'Download and Install') {
			try {await downloadAndInstallFlm(reportStatus); void vscode.window.showInformationMessage('FastFlowLM was installed successfully.');}
			catch (error) {void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));}
		}
		return;
	}
	reportStatus(`Found FLM ${installed} on PATH.`);
	const latest = await latestFlmVersion();
	if (latest && compareFlmVersions(latest, installed) > 0) {
		const choice = await vscode.window.showWarningMessage(`A newer FastFlowLM server is available (${latest}); you have ${installed}.`, 'Download and Install');
		if (choice === 'Download and Install') {
			try {await downloadAndInstallFlm(reportStatus); void vscode.window.showInformationMessage('FastFlowLM was upgraded successfully.');}
			catch (error) {void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));}
		}
		return;
	}
	void vscode.window.showInformationMessage(`FastFlowLM ${installed} is installed and up to date.`);
}

function activityText(payload: Record<string, unknown>): string | undefined {
	for (const key of ['activity', 'status', 'message', 'progress', 'event', 'raw_output', 'rawOutput', 'model_output', 'modelOutput']) {
		const value = payload[key];
		if (typeof value === 'string' && value.trim()) {return value.trim();}
		if (value && typeof value === 'object') {
			const nested = activityText(value as Record<string, unknown>);
			if (nested) {return nested;}
		}
	}
	return undefined;
}

function modelThinkingText(payload: Record<string, unknown>): string | undefined {
	for (const key of ['reasoning', 'reasoning_content', 'thinking', 'thinking_content', 'thought', 'analysis']) {
		const value = payload[key];
		if (typeof value === 'string' && value.trim()) {return value.trim();}
		if (value && typeof value === 'object') {
			const nested = modelThinkingText(value as Record<string, unknown>);
			if (nested) {return nested;}
		}
	}
	return undefined;
}

export function limitMessages(messages: ChatMessage[]): ChatMessage[] {
	let remaining = MAX_INPUT_TOKENS * CHARS_PER_TOKEN;
	const limited: ChatMessage[] = [];
	for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
		const message = messages[index];
		const content = message.content ?? '';
		if (content.length <= remaining) {
			limited.unshift(message);
			remaining -= content.length;
			continue;
		}
		limited.unshift({ ...message, content: content.slice(-remaining) });
		break;
	}
	return limited;
}

export class FastFlowLMClient {
	public constructor(private readonly reportStatus: StatusReporter = () => {}, private readonly startServer: ServerStarter = async () => {}) {}
	private get settings() { return vscode.workspace.getConfiguration('flm-vscode'); }
	private get baseUrl() { return this.settings.get<string>('serverUrl', 'http://127.0.0.1:8000/v1').replace(/\/$/, ''); }
	private async request(url: string, init?: RequestInit): Promise<Response> {
		try {
			return await fetch(url, init);
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {throw error;}
			this.reportStatus('FastFlowLM is not reachable. Starting the configured server.');
			try {
				await this.startServer();
				return await fetch(url, init);
			} catch (startError) {
				const detail = startError instanceof Error ? startError.message : String(startError);
				throw new Error(`Cannot reach FastFlowLM at ${this.baseUrl}. Start the server or update FastFlowLM: Server URL. ${detail}`);
			}
		}
	}
	private headers(): Record<string, string> {
		const apiKey = this.settings.get<string>('apiKey', '').trim();
		return { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
	}

	public async listModels(): Promise<string[]> {
		this.reportStatus(`Checking available models at ${this.baseUrl}/models.`);
		const response = await this.request(`${this.baseUrl}/models`, { headers: this.headers() });
		if (!response.ok) {throw new Error(`Model request failed (${response.status}).`);}
		const payload = await response.json() as { data?: Array<{ id?: string }> };
		const models = (payload.data ?? []).map(model => model.id).filter((id): id is string => Boolean(id));
		this.reportStatus(models.length ? `Available models: ${models.join(', ')}.` : 'The server reported no available models.');
		return models;
	}

	public async chat(messages: ChatMessage[], model: string): Promise<string> {
		this.reportStatus(`Sending task to model "${model}".`);
		const response = await this.request(`${this.baseUrl}/chat/completions`, {
			method: 'POST', headers: this.headers(), body: JSON.stringify({ model, messages, stream: false, max_tokens: MAX_OUTPUT_TOKENS })
		});
		if (!response.ok) {throw new Error(`Chat request failed (${response.status}): ${(await response.text()).slice(0, 240)}`);}
		const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
		const content = payload.choices?.[0]?.message?.content;
		if (!content) {throw new Error('FastFlowLM returned no assistant content.');}
		this.reportStatus(`Model "${model}" completed the task.`);
		return content;
	}

	public async streamChat(
		messages: ChatMessage[],
		model: string,
		tools: OpenAITool[],
		toolMode: vscode.LanguageModelChatToolMode,
		token: vscode.CancellationToken,
		onText: (text: string) => void,
		onToolCall: (call: ToolCall) => void,
		onActivity: (message: string) => void = () => {},
		onRaw: (data: string) => void = data => this.reportStatus(`[server raw] ${data}`)
	): Promise<void> {
		messages = limitMessages(messages);
		this.reportStatus(`Loading or selecting model "${model}" and sending the task.`);
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			const response = await this.request(`${this.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: this.headers(),
				body: JSON.stringify({
					model,
					messages,
					stream: true,
					max_tokens: MAX_OUTPUT_TOKENS,
					...(tools.length ? { tools, tool_choice: toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto' } : {})
				}),
				signal: controller.signal
			});
			if (!response.ok) {throw new Error(`Chat request failed (${response.status}): ${(await response.text()).slice(0, 240)}`);}
			if (!response.body) {throw new Error('FastFlowLM returned an empty response stream.');}
			onRaw(`[response] ${response.status} ${response.statusText} content-type=${response.headers.get('content-type') ?? 'unknown'}`);

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let completed = false;
			let responseStarted = false;
			const toolCalls = new Map<number, ToolCall>();
			while (!completed) {
				const { done, value } = await reader.read();
				const chunk = decoder.decode(value, { stream: !done });
				onRaw(chunk);
				buffer += chunk;
				const events = buffer.split(/\r?\n\r?\n/);
				buffer = events.pop() ?? '';
				for (const event of events) {
					const eventName = event.split(/\r?\n/).find(line => line.startsWith('event:'))?.slice(6).trim();
					for (const line of event.split(/\r?\n/)) {
						if (line.startsWith(':')) {
							const comment = line.slice(1).trim();
							if (comment) { onActivity(comment); }
							continue;
						}
						if (!line.startsWith('data:')) {continue;}
						const data = line.slice(5).trim();
						if (data === '[DONE]') {completed = true; break;}
						let payload: Record<string, unknown>;
						try { payload = JSON.parse(data) as Record<string, unknown>; } catch {
							onActivity(data);
							continue;
						}
						const serverActivity = activityText(payload);
						if (serverActivity) { onActivity(serverActivity); }
						if (!serverActivity && eventName && !['message', 'data'].includes(eventName)) { onActivity(`Server event: ${eventName}`); }
						const delta = (payload as {
							choices?: Array<{ delta?: { content?: string; reasoning?: string; reasoning_content?: string; thinking?: string; thinking_content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>
						}).choices?.[0]?.delta;
						const reasoning = delta?.reasoning ?? delta?.reasoning_content ?? delta?.thinking ?? delta?.thinking_content;
						if (reasoning) {
							onActivity(reasoning);
							onRaw(`[model reasoning] ${reasoning}`);
						}
						const modelThinking = reasoning ? undefined : modelThinkingText(payload);
						if (modelThinking) { onRaw(`[model thinking] ${modelThinking}`); }
						const content = delta?.content;
						if (content) {
							if (!responseStarted) { this.reportStatus(`Model "${model}" is responding.`); responseStarted = true; }
							onText(content);
						}
						for (const item of delta?.tool_calls ?? []) {
							const index = item.index ?? 0;
							const existing = toolCalls.get(index) ?? { id: item.id ?? `fastflowlm-tool-${index}`, type: 'function' as const, function: { name: '', arguments: '' } };
							existing.function.name += item.function?.name ?? '';
							existing.function.arguments += item.function?.arguments ?? '';
							toolCalls.set(index, existing);
						}
					}
				}
				if (done) {completed = true;}
			}
			if (buffer.trim()) { onRaw(`[trailing stream data] ${buffer}`); }
			for (const call of toolCalls.values()) {
				onToolCall({ ...call, function: { ...call.function, arguments: call.function.arguments || '{}' } });
			}
			this.reportStatus(`Model "${model}" completed the task.`);
		} finally {
			cancellation.dispose();
		}
	}
}

class FastFlowLMProvider implements vscode.LanguageModelChatProvider {
	public constructor(private readonly client: FastFlowLMClient) {}

	public async provideLanguageModelChatInformation(): Promise<vscode.LanguageModelChatInformation[]> {
		const configuredModel = vscode.workspace.getConfiguration('flm-vscode').get<string>('model', 'fastflowlm');
		let models: string[];
		try { models = await this.client.listModels(); } catch { models = []; }
		const available = models.length > 0 ? models : [configuredModel];
		return available.map(id => ({
			id,
			name: id,
			family: 'fastflowlm',
			version: '1',
			tooltip: `FastFlowLM model ${id}`,
			detail: 'FastFlowLM',
			maxInputTokens: MAX_INPUT_TOKENS,
			maxOutputTokens: MAX_OUTPUT_TOKENS,
			capabilities: { toolCalling: true }
		}));
	}

	public async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const requestMessages: ChatMessage[] = [];
		for (const message of messages) {
			const text = message.content.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => part.value).join('');
			const toolCalls = message.content.filter(part => part instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart[];
			const toolResults = message.content.filter(part => part instanceof vscode.LanguageModelToolResultPart) as vscode.LanguageModelToolResultPart[];
			if (toolCalls.length > 0) {
				requestMessages.push({
					role: 'assistant',
					content: text || null,
					tool_calls: toolCalls.map(call => ({ id: call.callId, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }))
				});
			} else if (toolResults.length > 0) {
				for (const result of toolResults) {
					requestMessages.push({ role: 'tool', tool_call_id: result.callId, content: result.content.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => part.value).join('') });
				}
			} else if (text) {
				requestMessages.push({ role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user', content: text });
			}
		}
		const tools: OpenAITool[] = (options.tools ?? []).map(tool => ({
			type: 'function',
			function: { name: tool.name, description: tool.description, parameters: tool.inputSchema ?? { type: 'object', properties: {} } }
		}));
		await this.client.streamChat(
			requestMessages,
			model.id,
			tools,
			options.toolMode,
			token,
			text => progress.report(new vscode.LanguageModelTextPart(text)),
			call => {
				let input: object = {};
				try { input = JSON.parse(call.function.arguments) as object; } catch { /* The server returned malformed tool JSON. */ }
				progress.report(new vscode.LanguageModelToolCallPart(call.id, call.function.name, input));
			}
		);
	}

	public provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage): Thenable<number> {
		const value = typeof text === 'string' ? text : text.content.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : '').join('');
		return Promise.resolve(Math.ceil(value.length / 4));
	}
}

class ServerManager {
	private process: ChildProcess | undefined;
	private processId: number | undefined;
	private state: ServerState = 'stopped';
	private error = '';
	private startup: Promise<void> | undefined;

	public constructor(private readonly reportStatus: StatusReporter = () => {}) {}

	public snapshot() { return { state: this.state, error: this.error, pid: this.process?.pid }; }

	public async start(): Promise<void> {
		if (this.process) {return;}
		const settings = vscode.workspace.getConfiguration('flm-vscode');
		const command = settings.get<string>('serverCommand', '').trim();
		if (!command) {throw new Error('Set FastFlowLM: Server Command before starting a local server.');}
		const args = settings.get<string[]>('serverArgs', []);
		const configuredCwd = settings.get<string>('serverCwd', '').trim();
		const cwd = configuredCwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		this.state = 'starting'; this.error = '';
		this.reportStatus(`Starting FastFlowLM server: ${command} ${args.join(' ')}`);
		const child = spawn(command, args, { cwd, windowsHide: true, detached: process.platform !== 'win32' });
		this.process = child;
		this.processId = child.pid;
		child.stdout?.on('data', data => this.reportStatus(`[server stdout] ${String(data)}`));
		child.stderr?.on('data', data => this.reportStatus(`[server stderr] ${String(data)}`));
		child.on('error', error => {
			this.cleanupProcessTree(child.pid);
			this.state = 'error'; this.error = error.message; this.reportStatus(`FastFlowLM server failed to start: ${error.message}`); this.process = undefined; this.processId = undefined;
		});
		child.on('spawn', () => { this.state = 'running'; this.reportStatus('FastFlowLM server process started.'); });
		child.on('exit', (code, signal) => {
			this.cleanupProcessTree(child.pid);
			if (this.state !== 'error') {
				this.state = 'stopped';
				this.error = code === 0 || signal === 'SIGTERM' ? '' : `Server exited with code ${code ?? signal}.`;
				this.reportStatus(this.error || 'FastFlowLM server stopped.');
			}
			this.process = undefined;
			this.processId = undefined;
		});
	}

	public async ensureRunning(): Promise<void> {
		if (!this.startup) {
			this.startup = this.startAndWaitForReady().finally(() => { this.startup = undefined; });
		}
		return this.startup;
	}

	private async startAndWaitForReady(): Promise<void> {
		await this.start();
		const settings = vscode.workspace.getConfiguration('flm-vscode');
		const baseUrl = settings.get<string>('serverUrl', 'http://127.0.0.1:8000/v1').replace(/\/$/, '');
		const apiKey = settings.get<string>('apiKey', '').trim();
		const deadline = Date.now() + 30_000;
		let lastError = this.error;
		while (Date.now() < deadline) {
			try {
				const response = await fetch(`${baseUrl}/models`, apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined);
				if (response.ok) {
					this.reportStatus('FastFlowLM server is ready.');
					return;
				}
				lastError = `Server readiness check failed (${response.status}).`;
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
			}
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		this.stop();
		throw new Error(lastError || 'Timed out waiting for FastFlowLM server to become ready.');
	}

	public stop(): void {
		if (!this.process && !this.processId) {return;}
		this.reportStatus('Stopping FastFlowLM server.');
		this.cleanupProcessTree(this.processId);
		this.process = undefined; this.processId = undefined; this.state = 'stopped'; this.error = '';
	}

	private cleanupProcessTree(processId: number | undefined): void {
		if (!processId) {return;}
		if (process.platform === 'win32') {
			try { execFileSync('taskkill', ['/pid', String(processId), '/t', '/f'], { stdio: 'ignore' }); } catch { /* The process may have already exited. */ }
			return;
		}
		try { process.kill(-processId, 'SIGTERM'); } catch { /* The process may have already exited. */ }
	}

	public async restart(): Promise<void> { this.stop(); await this.start(); }
	public dispose(): void { this.stop(); }
}

let activeServer: ServerManager | undefined;

class ChatPanel {
	private panel: vscode.WebviewPanel | undefined;
	private messages: ChatMessage[] = [];
	private model = vscode.workspace.getConfiguration('flm-vscode').get<string>('model', 'fastflowlm');

	public constructor(private readonly client: FastFlowLMClient, private readonly server: ServerManager, private readonly reportStatus: StatusReporter) {}

	public show(): void {
		if (this.panel) { this.panel.reveal(vscode.ViewColumn.Beside); return; }
		this.panel = vscode.window.createWebviewPanel('flm-vscode.chat', 'FastFlowLM', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
		this.panel.webview.html = this.html(this.panel.webview);
		this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message));
		this.panel.onDidDispose(() => this.panel = undefined);
	}

	private async handleMessage(message: { type: string; text?: string; model?: string }): Promise<void> {
		try {
			switch (message.type) {
				case 'send': await this.send(message.text ?? ''); break;
				case 'models': this.post({ type: 'models', models: await this.client.listModels() }); break;
				case 'start': await this.server.start(); this.post({ type: 'status', status: this.server.snapshot() }); break;
				case 'stop': this.server.stop(); this.post({ type: 'status', status: this.server.snapshot() }); break;
				case 'restart': await this.server.restart(); this.post({ type: 'status', status: this.server.snapshot() }); break;
				case 'model': this.model = message.model?.trim() || this.model; break;
			}
		} catch (error) { this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
	}

	private async send(text: string): Promise<void> {
		const content = text.trim(); if (!content) {return;}
		this.messages.push({ role: 'user', content }); this.post({ type: 'user', content }); this.post({ type: 'busy', busy: true });
		this.reportStatus(`Working on your task with model "${this.model}".`);
			this.post({ type: 'activity', content: `Waiting for FastFlowLM to load model "${this.model}"...` });
		try {
			let reply = '';
			const cancellation = new vscode.CancellationTokenSource();
			await this.client.streamChat(this.messages, this.model, [], vscode.LanguageModelChatToolMode.Auto, cancellation.token,
				textPart => { reply += textPart; this.post({ type: 'assistantDelta', content: textPart }); },
				() => {},
				activity => this.post({ type: 'activity', content: activity }),
				raw => this.post({ type: 'raw', content: raw })
			);
			cancellation.dispose();
			this.messages.push({ role: 'assistant', content: reply });
		} finally { this.post({ type: 'busy', busy: false }); }
	}

	private post(message: unknown): void { void this.panel?.webview.postMessage(message); }

	public activity(message: string): void { this.post({ type: 'activity', content: message }); }

	public raw(message: string): void { this.post({ type: 'raw', content: message }); }

	private html(webview: vscode.Webview): string {
		const nonce = randomBytes(16).toString('hex');
		const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
		return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>FastFlowLM</title>
<style>:root{color-scheme:light dark}body{margin:0;padding:18px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:13px var(--vscode-font-family)}h1{font-size:18px;margin:0 0 4px}p{color:var(--vscode-descriptionForeground);margin:0 0 16px}.toolbar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}button,select,textarea{font:inherit;color:inherit;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);padding:7px 9px;border-radius:3px}button{cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0}button:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.55;cursor:default}#status{border-left:3px solid var(--vscode-charts-green);padding:7px 10px;margin-bottom:8px;background:var(--vscode-textCodeBlock-background)}#status.error{border-color:var(--vscode-errorForeground)}#activity{display:grid;gap:3px;margin-bottom:14px;color:var(--vscode-descriptionForeground);font-size:11px}#activity div{padding:3px 7px;border-left:2px solid var(--vscode-charts-blue);white-space:pre-wrap}#activity .raw{font-family:var(--vscode-editor-font-family);color:var(--vscode-foreground);border-left-color:var(--vscode-charts-orange);background:var(--vscode-textCodeBlock-background)}#messages{display:grid;gap:10px;margin-bottom:14px}.message{padding:10px 12px;white-space:pre-wrap;line-height:1.45;border-radius:5px}.user{background:var(--vscode-textBlockQuote-background)}.assistant{background:var(--vscode-editor-inactiveSelectionBackground)}.composer{display:grid;gap:7px;position:sticky;bottom:0;background:var(--vscode-editor-background);padding-top:8px}textarea{resize:vertical;min-height:62px}.row{display:flex;gap:7px;align-items:center}.row select{flex:1;min-width:0}.hint{font-size:11px;color:var(--vscode-descriptionForeground)}</style></head>
<body><h1>FastFlowLM</h1><p>Chat with an OpenAI-compatible FastFlowLM server.</p><div id="status">Server status: unknown</div><div id="activity" aria-live="polite"></div><div class="toolbar"><button data-action="start">Start</button><button data-action="stop">Stop</button><button data-action="restart">Restart</button><button data-action="models">Refresh models</button></div><div id="messages"></div><div class="composer"><div class="row"><select id="model" aria-label="Model"><option>${this.escape(this.model)}</option></select><span class="hint">Configure URL and command in Settings</span></div><textarea id="prompt" placeholder="Ask FastFlowLM something..."></textarea><button id="send">Send</button></div>
<script nonce="${nonce}">const vscode=acquireVsCodeApi(),messages=document.getElementById('messages'),activity=document.getElementById('activity'),prompt=document.getElementById('prompt'),send=document.getElementById('send'),model=document.getElementById('model'),status=document.getElementById('status');let assistant;function add(role,content){const el=document.createElement('div');el.className='message '+role;el.textContent=content;messages.appendChild(el);el.scrollIntoView({behavior:'smooth',block:'nearest'});return el}function addActivity(content,raw){const item=document.createElement('div');if(raw)item.className='raw';item.textContent=content;activity.appendChild(item);item.scrollIntoView({behavior:'smooth',block:'nearest'})}function submit(){const text=prompt.value.trim();if(!text)return;vscode.postMessage({type:'send',text});prompt.value=''}send.addEventListener('click',submit);prompt.addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey))submit()});document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:button.dataset.action})));model.addEventListener('change',()=>vscode.postMessage({type:'model',model:model.value}));window.addEventListener('message',event=>{const message=event.data;if(message.type==='user'||message.type==='assistant')add(message.type,message.content);if(message.type==='assistantDelta'){if(!assistant)assistant=add('assistant','');assistant.textContent+=message.content}if(message.type==='assistant')assistant=undefined;if(message.type==='activity')addActivity(message.content,false);if(message.type==='raw')addActivity(message.content,true);if(message.type==='busy')send.disabled=message.busy;if(message.type==='error'){status.textContent=message.message;status.className='error'}if(message.type==='status'){status.className=message.status.state==='error'?'error':'';status.textContent='Server: '+message.status.state+(message.status.pid?' (PID '+message.status.pid+')':'')+(message.status.error?' - '+message.status.error:'')}if(message.type==='models'){model.replaceChildren(...message.models.map(value=>{const option=document.createElement('option');option.value=value;option.textContent=value;return option}))}});vscode.postMessage({type:'models'});</script></body></html>`;
	}

	private escape(value: string): string { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character)); }
}

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('FastFlowLM');
	let chatPanel: ChatPanel | undefined;
	const reportStatus: StatusReporter = message => {
		output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
		if (message.startsWith('[server stdout]') || message.startsWith('[server stderr]') || message.startsWith('[server raw]')) {
			chatPanel?.raw(message);
		} else {
			chatPanel?.activity(message);
		}
	};
	const server = new ServerManager(reportStatus);
	activeServer = server;
	const disposeServerOnHostExit = () => server.dispose();
	process.once('exit', disposeServerOnHostExit);
	const client = new FastFlowLMClient(reportStatus, () => server.ensureRunning());
	const chat = new ChatPanel(client, server, reportStatus);
	chatPanel = chat;
	const flmParticipant = vscode.chat.createChatParticipant('flm-vscode.flm', async (request, _context, response, token) => {
		try {
			switch (request.command) {
				case 'status': {
					const snapshot = server.snapshot();
					response.markdown(`FastFlowLM server is **${snapshot.state}**${snapshot.pid ? ` (PID ${snapshot.pid})` : ''}.`);
					return;
				}
				case 'models': response.markdown(`Available models: ${(await client.listModels()).join(', ') || 'none'}.`); return;
				case 'start': await server.start(); response.markdown('FastFlowLM server started.'); return;
				case 'stop': server.stop(); response.markdown('FastFlowLM server stopped.'); return;
				case 'restart': await server.restart(); response.markdown('FastFlowLM server restarted.'); return;
				case 'update': await checkFlmInstallation(reportStatus); response.markdown('FastFlowLM update check completed.'); return;
			}
			const model = vscode.workspace.getConfiguration('flm-vscode').get<string>('model', 'fastflowlm');
			await client.streamChat([{ role: 'user', content: request.prompt }], model, [], vscode.LanguageModelChatToolMode.Auto, token, text => response.markdown(text), () => {});
		} catch (error) { response.markdown(`FastFlowLM error: ${error instanceof Error ? error.message : String(error)}`); }
	});
	flmParticipant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'flm-vscode.png');
	context.subscriptions.push(
		flmParticipant,
		vscode.lm.registerLanguageModelChatProvider('fastflowlm', new FastFlowLMProvider(client)),
		vscode.commands.registerCommand('flm-vscode.openChat', () => chat.show()),
		vscode.commands.registerCommand('flm-vscode.checkServer', async () => {
			try { const models = await client.listModels(); void vscode.window.showInformationMessage(`FastFlowLM is reachable. ${models.length} model(s) available.`); }
			catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
		}),
		vscode.commands.registerCommand('flm-vscode.checkFlmInstallation', () => checkFlmInstallation(reportStatus)),
		vscode.commands.registerCommand('flm-vscode.startServer', async () => {
			try { await server.start(); void vscode.window.showInformationMessage('FastFlowLM server started.'); }
			catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
		}),
		vscode.commands.registerCommand('flm-vscode.stopServer', () => { server.stop(); void vscode.window.showInformationMessage('FastFlowLM server stopped.'); }),
		vscode.commands.registerCommand('flm-vscode.restartServer', async () => {
			try { await server.restart(); void vscode.window.showInformationMessage('FastFlowLM server restarted.'); }
			catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
		}),
		vscode.commands.registerCommand('flm-vscode.showActivityLog', () => output.show()),
		{ dispose: () => { process.off('exit', disposeServerOnHostExit); server.dispose(); output.dispose(); } }
	);
	if (vscode.workspace.getConfiguration('flm-vscode').get<boolean>('checkForUpdates', true)) {
		void checkFlmInstallation(reportStatus);
	}
}

// This method is called when your extension is deactivated
export function deactivate() {
	activeServer?.dispose();
	activeServer = undefined;
}
