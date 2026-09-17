import * as vscode from 'vscode';
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

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
type ExternalAgent = {
	name: string;
	command: string;
	args: string[];
	versionArgs: string[];
	cwd?: string;
	env?: Record<string, string>;
	latestVersionUrl?: string;
	latestVersionField?: string;
	installCommand?: string;
	installArgs: string[];
};
type PersistentMemoryEntry = { content: string; updatedAt: string };
type PersistentMemory = Record<string, PersistentMemoryEntry>;
type AgentActivity = { agent: string; action: 'started' | 'completed' | 'failed'; timestamp: string; detail?: string };
type WorkspaceFileArguments = { path?: unknown; content?: unknown };
const MAX_INPUT_TOKENS = 24576;
const MAX_OUTPUT_TOKENS = 4096;
const CHARS_PER_TOKEN = 4;
const STREAM_TIMEOUT_MS = 120_000;
const MAX_AGENT_ACTIVITY = 100;
const MAX_PERSISTENT_MEMORY_BYTES = 512 * 1024;
const FLM_INSTALLER_URL = 'https://github.com/ROCm/FastFlowLM/releases/latest/download/flm-setup.msi';
const FLM_LATEST_RELEASE_API = 'https://api.github.com/repos/ROCm/FastFlowLM/releases/latest';
const SELECTED_AGENT_STORAGE_KEY = 'flm-vscode.selectedAgent';
const externalAgentSessionChecks = new Map<string, Promise<void>>();
let selectedAgentState: vscode.Memento | undefined;
const workspaceFileTools: OpenAITool[] = [
	{
		type: 'function',
		function: {
			name: 'workspace_list_files',
			description: 'List entries in the current VS Code workspace folder. Paths are relative to that folder.',
			parameters: { type: 'object', properties: { path: { type: 'string', description: 'Optional workspace-relative directory. Defaults to the workspace root.' } }, additionalProperties: false }
		}
	},
	{
		type: 'function',
		function: {
			name: 'workspace_read_file',
			description: 'Read a UTF-8 text file from the current VS Code workspace folder.',
			parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string', description: 'Workspace-relative file path.' } }, additionalProperties: false }
		}
	},
	{
		type: 'function',
		function: {
			name: 'workspace_write_file',
			description: 'Write a UTF-8 text file in the current VS Code workspace folder. Use only when the user has requested a file change; the user must confirm the write.',
			parameters: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string', description: 'Workspace-relative file path.' }, content: { type: 'string', description: 'Complete file contents.' } }, additionalProperties: false }
		}
	}
];

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

function verifyWindowsInstallerSignature(installerPath: string): void {
	try {
		execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$signature = Get-AuthenticodeSignature -LiteralPath ([Environment]::GetEnvironmentVariable('FLM_INSTALLER_PATH')); if ($signature.Status -ne 'Valid') { exit 1 }"], {
			stdio: 'ignore',
			env: { ...process.env, FLM_INSTALLER_PATH: installerPath }
		});
	} catch {
		throw new Error('FastFlowLM installer signature validation failed. The installer was not run.');
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
		reportStatus('Verifying the FastFlowLM installer signature.');
		verifyWindowsInstallerSignature(installerPath);
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

	public async resolveModel(preferred: string): Promise<string> {
		const models = await this.listModels();
		if (!models.length || models.includes(preferred)) {return preferred;}
		const fallback = models[0];
		this.reportStatus(`Configured model "${preferred}" is unavailable; using "${fallback}".`);
		return fallback;
	}

	public async chat(messages: ChatMessage[], model: string): Promise<string> {
		this.reportStatus(`Sending task to model "${model}".`);
		await recordAgentActivity('flm', 'started', model);
		try {
			const response = await this.request(`${this.baseUrl}/chat/completions`, {
				method: 'POST', headers: this.headers(), body: JSON.stringify({ model, messages, stream: false, max_tokens: MAX_OUTPUT_TOKENS })
			});
			if (!response.ok) {throw new Error(`Chat request failed (${response.status}): ${(await response.text()).slice(0, 240)}`);}
			const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
			const content = payload.choices?.[0]?.message?.content;
			if (!content) {throw new Error('FastFlowLM returned no assistant content.');}
			await recordAgentActivity('flm', 'completed', model);
			this.reportStatus(`Model "${model}" completed the task.`);
			return content;
		} catch (error) {
			await recordAgentActivity('flm', 'failed', error instanceof Error ? error.message : String(error));
			throw error;
		}
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
		await recordAgentActivity('flm', 'started', model);
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		let timedOut = false;
		const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, STREAM_TIMEOUT_MS);
		const emitRaw = (data: string) => {
			if (this.settings.get<boolean>('debugStreaming', false)) {onRaw(data);}
		};
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
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
			emitRaw(`[response] ${response.status} ${response.statusText} content-type=${response.headers.get('content-type') ?? 'unknown'}`);

			const streamReader = response.body.getReader();
			reader = streamReader;
			const decoder = new TextDecoder();
			let buffer = '';
			let completed = false;
			let receivedDone = false;
			let responseStarted = false;
			const toolCalls = new Map<number, ToolCall>();
			while (!completed) {
				const { done, value } = await streamReader.read();
				const chunk = decoder.decode(value, { stream: !done });
				emitRaw(chunk);
				buffer += chunk;
				const events = buffer.split(/\r?\n\r?\n/);
				buffer = events.pop() ?? '';
				for (const event of events) {
					const eventName = event.split(/\r?\n/).find(line => line.startsWith('event:'))?.slice(6).trim();
					const comments = event.split(/\r?\n/).filter(line => line.startsWith(':')).map(line => line.slice(1).trim()).filter(Boolean);
					for (const comment of comments) { onActivity(comment); }
					const dataLines = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
					if (!dataLines.length) {continue;}
					const data = dataLines.join('\n').trim();
					if (data === '[DONE]') {completed = true; receivedDone = true; break;}
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
						emitRaw(`[model reasoning] ${reasoning}`);
					}
					const modelThinking = reasoning ? undefined : modelThinkingText(payload);
					if (modelThinking) { emitRaw(`[model thinking] ${modelThinking}`); }
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
				if (done) {completed = true;}
			}
			if (buffer.trim()) { emitRaw(`[trailing stream data] ${buffer}`); }
			if (!receivedDone) {throw new Error('FastFlowLM closed the response stream before [DONE].');}
			for (const call of toolCalls.values()) {
				onToolCall({ ...call, function: { ...call.function, arguments: call.function.arguments || '{}' } });
			}
			await recordAgentActivity('flm', 'completed', model);
			this.reportStatus(`Model "${model}" completed the task.`);
		} catch (error) {
			if (timedOut) {throw new Error(`FastFlowLM response timed out after ${STREAM_TIMEOUT_MS / 1000} seconds.`);}
			await recordAgentActivity('flm', 'failed', error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			await reader?.cancel().catch(() => {});
			clearTimeout(timeout);
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
		await new Promise<void>((resolve, reject) => {
			const onSpawn = () => { child.removeListener('error', onError); resolve(); };
			const onError = (error: Error) => { child.removeListener('spawn', onSpawn); reject(error); };
			child.once('spawn', onSpawn);
			child.once('error', onError);
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
			if (this.state === 'error') {throw new Error(this.error || 'FastFlowLM server failed to start.');}
			if (this.state === 'stopped') {throw new Error('FastFlowLM server stopped before it became ready.');}
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
	private cancellation: vscode.CancellationTokenSource | undefined;

	public constructor(private readonly client: FastFlowLMClient, private readonly server: ServerManager, private readonly reportStatus: StatusReporter) {}

	public show(): void {
		if (this.panel) { this.panel.reveal(vscode.ViewColumn.Beside); return; }
		this.panel = vscode.window.createWebviewPanel('flm-vscode.chat', 'FastFlowLM', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
		this.panel.webview.html = this.html();
		this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message));
		this.panel.onDidDispose(() => { this.cancel(); this.panel = undefined; });
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
		if (this.cancellation) {return;}
		this.model = await this.client.resolveModel(this.model);
		this.messages.push({ role: 'user', content }); this.post({ type: 'user', content }); this.post({ type: 'busy', busy: true });
		this.reportStatus(`Working on your task with model "${this.model}".`);
			this.post({ type: 'activity', content: `Waiting for FastFlowLM to load model "${this.model}"...` });
		const cancellation = new vscode.CancellationTokenSource();
		this.cancellation = cancellation;
		try {
			let reply = '';
			await this.client.streamChat(this.messages, this.model, [], vscode.LanguageModelChatToolMode.Auto, cancellation.token,
				textPart => { reply += textPart; this.post({ type: 'assistantDelta', content: textPart }); },
				() => {},
				activity => this.post({ type: 'activity', content: activity }),
				raw => this.post({ type: 'raw', content: raw })
			);
			this.messages.push({ role: 'assistant', content: reply });
		} finally {
			cancellation.dispose();
			if (this.cancellation === cancellation) {this.cancellation = undefined;}
			this.post({ type: 'busy', busy: false });
		}
	}

	private cancel(): void { this.cancellation?.cancel(); }

	private post(message: unknown): void { void this.panel?.webview.postMessage(message); }

	public activity(message: string): void { this.post({ type: 'activity', content: message }); }

	public raw(message: string): void { this.post({ type: 'raw', content: message }); }

	private html(): string {
		const nonce = randomBytes(16).toString('hex');
		const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
		return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>FastFlowLM</title>
<style>:root{color-scheme:light dark}body{margin:0;padding:18px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:13px var(--vscode-font-family)}h1{font-size:18px;margin:0 0 4px}p{color:var(--vscode-descriptionForeground);margin:0 0 16px}.toolbar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}button,select,textarea{font:inherit;color:inherit;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);padding:7px 9px;border-radius:3px}button{cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0}button:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.55;cursor:default}#status{border-left:3px solid var(--vscode-charts-green);padding:7px 10px;margin-bottom:8px;background:var(--vscode-textCodeBlock-background)}#status.error{border-color:var(--vscode-errorForeground)}#activity{display:grid;gap:3px;margin-bottom:14px;color:var(--vscode-descriptionForeground);font-size:11px}#activity div{padding:3px 7px;border-left:2px solid var(--vscode-charts-blue);white-space:pre-wrap}#activity .raw{font-family:var(--vscode-editor-font-family);color:var(--vscode-foreground);border-left-color:var(--vscode-charts-orange);background:var(--vscode-textCodeBlock-background)}#messages{display:grid;gap:10px;margin-bottom:14px}.message{padding:10px 12px;white-space:pre-wrap;line-height:1.45;border-radius:5px}.user{background:var(--vscode-textBlockQuote-background)}.assistant{background:var(--vscode-editor-inactiveSelectionBackground)}.composer{display:grid;gap:7px;position:sticky;bottom:0;background:var(--vscode-editor-background);padding-top:8px}textarea{resize:vertical;min-height:62px}.row{display:flex;gap:7px;align-items:center}.row select{flex:1;min-width:0}.hint{font-size:11px;color:var(--vscode-descriptionForeground)}</style></head>
<body><h1>FastFlowLM</h1><p>Chat with an OpenAI-compatible FastFlowLM server.</p><div id="status">Server status: unknown</div><div id="activity" aria-live="polite"></div><div class="toolbar"><button data-action="start">Start</button><button data-action="stop">Stop</button><button data-action="restart">Restart</button><button data-action="models">Refresh models</button></div><div id="messages"></div><div class="composer"><div class="row"><select id="model" aria-label="Model"><option>${this.escape(this.model)}</option></select><span class="hint">Configure URL and command in Settings</span></div><textarea id="prompt" placeholder="Ask FastFlowLM something..."></textarea><button id="send">Send</button></div>
<script nonce="${nonce}">const vscode=acquireVsCodeApi(),messages=document.getElementById('messages'),activity=document.getElementById('activity'),prompt=document.getElementById('prompt'),send=document.getElementById('send'),model=document.getElementById('model'),status=document.getElementById('status');let assistant;function add(role,content){const el=document.createElement('div');el.className='message '+role;el.textContent=content;messages.appendChild(el);el.scrollIntoView({behavior:'smooth',block:'nearest'});return el}function addActivity(content,raw){const item=document.createElement('div');if(raw)item.className='raw';item.textContent=content;activity.appendChild(item);item.scrollIntoView({behavior:'smooth',block:'nearest'})}function submit(){const text=prompt.value.trim();if(!text)return;vscode.postMessage({type:'send',text});prompt.value=''}send.addEventListener('click',submit);prompt.addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey))submit()});document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:button.dataset.action})));model.addEventListener('change',()=>vscode.postMessage({type:'model',model:model.value}));window.addEventListener('message',event=>{const message=event.data;if(message.type==='user'||message.type==='assistant')add(message.type,message.content);if(message.type==='assistantDelta'){if(!assistant)assistant=add('assistant','');assistant.textContent+=message.content}if(message.type==='assistant')assistant=undefined;if(message.type==='activity')addActivity(message.content,false);if(message.type==='raw')addActivity(message.content,true);if(message.type==='busy')send.disabled=message.busy;if(message.type==='error'){status.textContent=message.message;status.className='error'}if(message.type==='status'){status.className=message.status.state==='error'?'error':'';status.textContent='Server: '+message.status.state+(message.status.pid?' (PID '+message.status.pid+')':'')+(message.status.error?' - '+message.status.error:'')}if(message.type==='models'){model.replaceChildren(...message.models.map(value=>{const option=document.createElement('option');option.value=value;option.textContent=value;return option}))}});vscode.postMessage({type:'models'});</script></body></html>`;
	}

	private escape(value: string): string { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character)); }
}

function participantHistory(history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (const turn of history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			if (turn.prompt.trim()) {messages.push({ role: 'user', content: turn.prompt });}
			continue;
		}
		const content = turn.response.filter(part => part instanceof vscode.ChatResponseMarkdownPart).map(part => part.value.value).join('');
		if (content.trim()) {messages.push({ role: 'assistant', content });}
	}
	return messages;
}

export function requestedChatModels(prompt: string, includeFlm = false): string[] {
	const mentions = prompt.match(/(?:^|\s)@([A-Za-z][\w.-]*)/g) ?? [];
	return [...new Set(mentions.map(value => value.trim().slice(1).toLowerCase()).filter(value => includeFlm || value !== 'flm'))];
}

const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024;
const MAX_WORKSPACE_TOOL_ROUNDS = 16;

function workspaceRoot(): string {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {throw new Error('Open a workspace before asking @flm to access files.');}
	return resolve(folder.uri.fsPath);
}

function workspacePath(pathValue: unknown, allowRoot = false): string {
	if (typeof pathValue !== 'string' || (!allowRoot && !pathValue.trim())) {throw new Error('A workspace-relative path is required.');}
	const root = workspaceRoot();
	const path = resolve(root, pathValue || '.');
	if (path !== root && !path.startsWith(`${root}${sep}`)) {throw new Error('File path must stay inside the current workspace folder.');}
	return path;
}

async function verifyWorkspacePath(path: string, forWrite = false): Promise<void> {
	const root = workspaceRoot();
	const existingPath = forWrite ? dirname(path) : path;
	try {
		const realRoot = await fs.realpath(root);
		const realPath = await fs.realpath(existingPath);
		if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${sep}`)) {throw new Error('File path must stay inside the current workspace folder.');}
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			if (forWrite) {throw new Error('The destination directory must already exist inside the workspace.');}
		}
		throw error;
	}
}

async function executeWorkspaceTool(name: string, argumentsValue: WorkspaceFileArguments): Promise<string> {
	if (name === 'workspace_list_files') {
		const directory = workspacePath(argumentsValue.path ?? '.', true);
		await verifyWorkspacePath(directory);
		const entries = await fs.readdir(directory, { withFileTypes: true });
		return entries.filter(entry => !entry.name.startsWith('.') && !['node_modules', 'dist', 'out'].includes(entry.name))
			.map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name).sort().join('\n') || '(empty directory)';
	}
	if (typeof argumentsValue.path !== 'string' || !argumentsValue.path.trim()) {throw new Error('A workspace-relative file path is required.');}
	const path = workspacePath(argumentsValue.path);
	if (name === 'workspace_read_file') {
		await verifyWorkspacePath(path);
		const stats = await fs.stat(path);
		if (stats.size > MAX_WORKSPACE_FILE_BYTES) {throw new Error('Files larger than 1 MB cannot be read by @flm.');}
		return fs.readFile(path, 'utf8');
	}
	if (name === 'workspace_write_file') {
		if (typeof argumentsValue.content !== 'string') {throw new Error('File content must be a string.');}
		if (Buffer.byteLength(argumentsValue.content, 'utf8') > MAX_WORKSPACE_FILE_BYTES) {throw new Error('Files larger than 1 MB cannot be written by @flm.');}
		if (!vscode.workspace.getConfiguration('flm-vscode').get<boolean>('allowWorkspaceWrites', true)) {return 'Workspace writes are disabled in FastFlowLM settings.';}
		await verifyWorkspacePath(path, true);
		const relativePath = relative(workspaceRoot(), path);
		const choice = await vscode.window.showWarningMessage(`Allow @flm to write ${relativePath}?`, { modal: true }, 'Write File');
		if (choice !== 'Write File') {return 'The user declined the file write.';}
		await fs.writeFile(path, argumentsValue.content, 'utf8');
		return `Wrote ${relativePath}.`;
	}
	throw new Error(`Unknown workspace tool: ${name}`);
}

async function runWorkspaceAgent(
	client: FastFlowLMClient,
	messages: ChatMessage[],
	model: string,
	response: vscode.ChatResponseStream,
	token: vscode.CancellationToken
): Promise<void> {
	for (let round = 0; round < MAX_WORKSPACE_TOOL_ROUNDS; round++) {
		const toolCalls: ToolCall[] = [];
		let reply = '';
		await client.streamChat(messages, model, workspaceFileTools, vscode.LanguageModelChatToolMode.Auto, token,
			text => { reply += text; response.markdown(text); },
			call => toolCalls.push(call)
		);
		if (!toolCalls.length) {return;}
		messages.push({
			role: 'assistant',
			content: reply || null,
			tool_calls: toolCalls
		});
		for (const call of toolCalls) {
			let result = '';
			try {
				const argumentsValue = JSON.parse(call.function.arguments) as WorkspaceFileArguments;
				result = await executeWorkspaceTool(call.function.name, argumentsValue);
			} catch (error) {
				result = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
			}
			messages.push({ role: 'tool', tool_call_id: call.id, content: result });
		}
	}
	throw new Error(`FastFlowLM exceeded the ${MAX_WORKSPACE_TOOL_ROUNDS}-round workspace tool limit. Try a narrower request.`);
}

async function selectNamedChatModel(mention: string): Promise<vscode.LanguageModelChat | undefined> {
	const models = await vscode.lm.selectChatModels();
	return models.find(candidate => [candidate.vendor, candidate.name, candidate.id, candidate.family]
		.some(value => value.toLowerCase() === mention));
}

function externalAgentByName(mention: string): ExternalAgent | undefined {
	const normalized = mention.trim().toLowerCase();
	return configuredExternalAgents().find(agent => agent.name === normalized);
}

function configuredExternalAgents(): ExternalAgent[] {
	const configured = vscode.workspace.getConfiguration('flm-vscode').get<unknown[]>('externalAgents', []);
	return configured.flatMap(value => {
		if (!value || typeof value !== 'object') {return [];}
		const agent = value as Record<string, unknown>;
		const name = typeof agent.name === 'string' ? agent.name.trim().toLowerCase() : '';
		const command = typeof agent.command === 'string' ? agent.command.trim() : '';
		const args = Array.isArray(agent.args) ? agent.args.filter((arg): arg is string => typeof arg === 'string') : [];
		const versionArgs = Array.isArray(agent.versionArgs) ? agent.versionArgs.filter((arg): arg is string => typeof arg === 'string') : ['--version'];
		const installArgs = Array.isArray(agent.installArgs) ? agent.installArgs.filter((arg): arg is string => typeof arg === 'string') : [];
		if (!name || !command) {return [];}
		return [{ name, command, args, versionArgs, installArgs, ...(typeof agent.cwd === 'string' && agent.cwd.trim() ? { cwd: agent.cwd.trim() } : {}), ...(typeof agent.latestVersionUrl === 'string' && agent.latestVersionUrl.trim() ? { latestVersionUrl: agent.latestVersionUrl.trim() } : {}), ...(typeof agent.latestVersionField === 'string' && agent.latestVersionField.trim() ? { latestVersionField: agent.latestVersionField.trim() } : {}), ...(typeof agent.installCommand === 'string' && agent.installCommand.trim() ? { installCommand: agent.installCommand.trim() } : {}), ...(agent.env && typeof agent.env === 'object' && !Array.isArray(agent.env) ? { env: Object.fromEntries(Object.entries(agent.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) } : {}) }];
	});
}

function externalAgentPrompt(messages: ChatMessage[]): string {
	return messages.map(message => `${message.role.toUpperCase()}:\n${message.content ?? ''}`).join('\n\n');
}

function resolveWindowsCommand(command: string): string {
	if (process.platform !== 'win32' || extname(command) || command.includes('\\') || command.includes('/')) {return command;}
	try {
		const matches = String(execFileSync('where.exe', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
			.split(/\r?\n/).map(match => match.trim()).filter(Boolean);
		return matches.find(match => ['.exe', '.cmd', '.com', '.bat'].includes(extname(match).toLowerCase())) ?? matches[0] ?? command;
	} catch {
		return command;
	}
}

function persistentMemoryPath(): string {
	const configured = vscode.workspace.getConfiguration('flm-vscode').get<string>('memoryFile', '.flm/memory.json').trim();
	return workspacePath(configured);
}

async function recordAgentActivity(agent: string, action: AgentActivity['action'], detail?: string): Promise<void> {
	try {
		const path = persistentMemoryPath();
		let memory: PersistentMemory = {};
		try {
			memory = JSON.parse(await fs.readFile(path, 'utf8')) as PersistentMemory;
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {return;}
		}
		const existing = memory['agent-activity'];
		let activities: AgentActivity[] = [];
		if (existing) {
			try {
				const parsed = JSON.parse(existing.content) as unknown;
				if (Array.isArray(parsed)) {activities = parsed as AgentActivity[];}
			} catch { /* Replace malformed activity history with a valid bounded history. */ }
		}
		activities.push({ agent, action, timestamp: new Date().toISOString(), ...(detail ? { detail: detail.slice(0, 240) } : {}) });
		memory['agent-activity'] = { content: JSON.stringify(activities.slice(-MAX_AGENT_ACTIVITY)), updatedAt: new Date().toISOString() };
		const serialized = JSON.stringify(memory, null, '\t');
		if (Buffer.byteLength(serialized, 'utf8') > MAX_PERSISTENT_MEMORY_BYTES) {return;}
		await fs.mkdir(dirname(path), { recursive: true });
		const temporaryPath = `${path}.${process.pid}.tmp`;
		await fs.writeFile(temporaryPath, `${serialized}\n`, 'utf8');
		await fs.rename(temporaryPath, path);
	} catch {
		// Activity persistence must never prevent an agent from answering.
	}
}

function externalAgentVersion(agent: ExternalAgent): string | undefined {
	try {
		const output = execFileSync(resolveWindowsCommand(agent.command), agent.versionArgs, { cwd: agent.cwd, env: { ...process.env, ...agent.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		return String(output).match(/\d+(?:\.\d+){1,3}/)?.[0];
	} catch {
		return undefined;
	}
}

function versionField(payload: unknown, field = 'version'): unknown {
	return field.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, payload);
}

async function latestExternalAgentVersion(agent: ExternalAgent): Promise<string | undefined> {
	if (!agent.latestVersionUrl) {return undefined;}
	try {
		const response = await fetch(agent.latestVersionUrl, { headers: { Accept: 'application/json', 'User-Agent': 'flm-vscode' } });
		if (!response.ok) {return undefined;}
		const payload = await response.json() as unknown;
		const value = versionField(payload, agent.latestVersionField);
		return typeof value === 'string' ? value.match(/\d+(?:\.\d+){1,3}/)?.[0] : undefined;
	} catch {
		return undefined;
	}
}

async function installExternalAgent(agent: ExternalAgent, latest: string | undefined): Promise<void> {
	const installCommand = agent.installCommand;
	if (!installCommand) {throw new Error(`Configure installCommand and installArgs for @${agent.name} before installing it.`);}
	const args = agent.installArgs.map(argument => argument.replaceAll('{version}', latest ?? 'latest'));
	await new Promise<void>((resolve, reject) => {
		const installer: ChildProcess = spawn(resolveWindowsCommand(installCommand), args, { cwd: agent.cwd, windowsHide: false, env: { ...process.env, ...agent.env } });
		installer.stdout?.on('data', (data: Buffer) => console.log(`[${agent.name} installer] ${data.toString().trimEnd()}`));
		installer.stderr?.on('data', (data: Buffer) => console.log(`[${agent.name} installer] ${data.toString().trimEnd()}`));
		installer.on('error', reject);
		installer.on('exit', code => code === 0 ? resolve() : reject(new Error(`${agent.name} installer exited with code ${code ?? 'unknown'}.`)));
	});
}

async function performExternalAgentInstallationCheck(agent: ExternalAgent): Promise<void> {
	const installed = externalAgentVersion(agent);
	const latest = await latestExternalAgentVersion(agent);
	if (!installed) {
		const choice = await vscode.window.showWarningMessage(`${agent.name} is not installed or is not available on PATH.`, 'Download and Install');
		if (choice !== 'Download and Install') {
			throw new Error(`${agent.name} is required to handle this request.`);
		}
		await installExternalAgent(agent, latest);
		return;
	}
	if (latest && compareFlmVersions(latest, installed) > 0) {
		const choice = await vscode.window.showWarningMessage(`${agent.name} ${installed} is installed, but ${latest} is available.`, 'Download and Install');
		if (choice === 'Download and Install') {await installExternalAgent(agent, latest);}
	}
}

function ensureExternalAgentInstalled(agent: ExternalAgent): Promise<void> {
	const sessionKey = `${agent.name}:${agent.command}`;
	const existing = externalAgentSessionChecks.get(sessionKey);
	if (existing) {return existing;}
	const check = performExternalAgentInstallationCheck(agent);
	externalAgentSessionChecks.set(sessionKey, check);
	return check;
}

function normalizeSelectedAgent(value: string | undefined): string {
	const normalized = (value ?? 'none').trim().toLowerCase();
	return normalized === 'fastflowlm' ? 'none' : normalized;
}

export function readSelectedAgentPreference(configuration: vscode.WorkspaceConfiguration, state: vscode.Memento | undefined): string {
	const fromState = state?.get<string>(SELECTED_AGENT_STORAGE_KEY);
	const fromConfig = configuration.get<string>('selectedAgent', 'none');
	return normalizeSelectedAgent(fromState ?? fromConfig ?? 'none');
}

function selectedExternalAgent(): ExternalAgent | undefined {
	const selected = readSelectedAgentPreference(vscode.workspace.getConfiguration('flm-vscode'), selectedAgentState);
	if (!selected || selected === 'none' || selected === 'fastflowlm') {return undefined;}
	return configuredExternalAgents().find(agent => agent.name === selected);
}

async function ensureSelectedExternalAgent(reportStatus: StatusReporter): Promise<ExternalAgent | undefined> {
	const agent = selectedExternalAgent();
	if (!agent) {return undefined;}
	try {
		await ensureExternalAgentInstalled(agent);
		reportStatus(`${agent.name} is installed and ready for this session.`);
		return agent;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		reportStatus(`${agent.name} is not ready: ${message}`);
		throw error;
	}
}

async function invokeExternalAgent(agent: ExternalAgent, messages: ChatMessage[], token: vscode.CancellationToken): Promise<string> {
	await recordAgentActivity(agent.name, 'started');
	try {
		await ensureExternalAgentInstalled(agent);
		const prompt = externalAgentPrompt(messages);
		const args = agent.args.map(argument => argument.replaceAll('{prompt}', prompt));
		const child = spawn(resolveWindowsCommand(agent.command), args, {
			cwd: agent.cwd,
			windowsHide: true,
			env: { ...process.env, ...agent.env }
		});
		let output = '';
		let errorOutput = '';
		const cancellation = token.onCancellationRequested(() => child.kill());
		try {
			if (!args.some(argument => argument.includes('{prompt}'))) {child.stdin.write(prompt);}
			child.stdin.end();
			child.stdout.on('data', data => output += String(data));
			child.stderr.on('data', data => errorOutput += String(data));
			const exitCode = await new Promise<number | null>((resolve, reject) => {
				child.on('error', reject);
				child.on('exit', resolve);
			});
			if (exitCode !== 0) {throw new Error(`${agent.name} exited with code ${exitCode ?? 'unknown'}${errorOutput.trim() ? `: ${errorOutput.trim().slice(0, 240)}` : '.'}`);}
			if (!output.trim()) {throw new Error(`${agent.name} returned no response.`);}
			await recordAgentActivity(agent.name, 'completed');
			return output.trim();
		} finally {
			cancellation.dispose();
			if (!child.killed && child.exitCode === null) {child.kill();}
		}
	} catch (error) {
		await recordAgentActivity(agent.name, 'failed', error instanceof Error ? error.message : String(error));
		throw error;
	}
}

async function runExternalParticipant(
	name: string,
	request: vscode.ChatRequest,
	context: vscode.ChatContext,
	response: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
	client: FastFlowLMClient
): Promise<void> {
	const agent = externalAgentByName(name);
	if (!agent) {throw new Error(`No external harness is configured for @${name}. Add it to flm-vscode.externalAgents.`);}
	const messages = participantHistory(context.history);
	messages.push({ role: 'user', content: request.prompt });
	const ownReply = await invokeExternalAgent(agent, messages, token);
	response.markdown(ownReply);
	messages.push({ role: 'assistant', content: ownReply });

	for (const mention of requestedChatModels(request.prompt, true).filter(candidate => candidate !== name)) {
		if (token.isCancellationRequested) {return;}
		const peer = externalAgentByName(mention);
		if (peer) {
			const peerReply = await invokeExternalAgent(peer, messages, token);
			response.markdown(`\n\n**${peer.name}:**\n\n${peerReply}`);
			messages.push({ role: 'assistant', content: peerReply });
			continue;
		}
		if (mention === 'flm') {
			const configuredModel = vscode.workspace.getConfiguration('flm-vscode').get<string>('model', 'fastflowlm');
			const model = await client.resolveModel(configuredModel);
			const flmReply = await client.chat(messages, model);
			response.markdown(`\n\n**flm:**\n\n${flmReply}`);
			messages.push({ role: 'assistant', content: flmReply });
		}
	}
}

class MultiAgentCoordinator {
	public constructor(private readonly client: FastFlowLMClient, private readonly reportStatus: StatusReporter = () => {}) {}

	public async collaborate(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		response: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<void> {
		const requested = requestedChatModels(request.prompt);
		const configuredModel = vscode.workspace.getConfiguration('flm-vscode').get<string>('model', 'fastflowlm');
		const flmModel = await this.client.resolveModel(configuredModel);
		const messages = participantHistory(context.history);
		messages.push({ role: 'user', content: request.prompt });
		this.reportStatus(`Collaborating with FastFlowLM (${flmModel}).`);
		response.markdown(`**FastFlowLM (${flmModel}):**\n\n`);
		let flmReply = '';
		await this.client.streamChat(messages, flmModel, [], vscode.LanguageModelChatToolMode.Auto, token, text => {
			flmReply += text;
			response.markdown(text);
		}, () => {});
		messages.push({ role: 'assistant', content: flmReply });
		response.markdown('\n\n');

		const agents: vscode.LanguageModelChat[] = [];
		const externalAgents = configuredExternalAgents();
		for (const mention of requested) {
			const externalAgent = externalAgents.find(agent => agent.name === mention);
			if (externalAgent) {
				if (token.isCancellationRequested) {return;}
				this.reportStatus(`Collaborating with ${externalAgent.name}.`);
				response.markdown(`**${externalAgent.name}:**\n\n`);
				const content = await invokeExternalAgent(externalAgent, messages, token);
				response.markdown(content);
				messages.push({ role: 'assistant', content });
				response.markdown('\n\n');
				continue;
			}
			const model = await selectNamedChatModel(mention);
			if (!model) {throw new Error(`No language model is available for @${mention}.`);}
			if (!agents.some(agent => agent.id === model.id)) {agents.push(model);}
		}
		if (!agents.length) {throw new Error('Collaboration needs at least one explicitly mentioned @agent, such as @Copilot.');}
		for (const [index, agent] of agents.entries()) {
			if (token.isCancellationRequested) {return;}
			const label = agent.name || agent.id;
			messages.push({ role: 'user', content: `Act as ${label}. Review the other agent's response above and continue solving the original task. Return only your useful response.` });
			this.reportStatus(`Collaborating with ${label} (${agent.vendor}).`);
			response.markdown(`**${label}:**\n\n`);
			const reply = await agent.sendRequest(messages.map(message => message.role === 'assistant'
				? vscode.LanguageModelChatMessage.Assistant(message.content ?? '')
				: vscode.LanguageModelChatMessage.User(message.content ?? '')), {
				justification: 'Allow @flm to coordinate explicitly addressed language models on a shared task.'
			}, token);
			let content = '';
			for await (const part of reply.stream) {
				if (part instanceof vscode.LanguageModelTextPart) {
					content += part.value;
					response.markdown(part.value);
				}
			}
			messages.push({ role: 'assistant', content });
			response.markdown('\n\n');
		}
	}
}

async function delegateToChatModel(
	mention: string,
	messages: ChatMessage[],
	response: vscode.ChatResponseStream,
	token: vscode.CancellationToken
): Promise<boolean> {
	const externalAgent = configuredExternalAgents().find(agent => agent.name === mention);
	if (externalAgent) {
		response.markdown(await invokeExternalAgent(externalAgent, messages, token));
		return true;
	}
	const model = await selectNamedChatModel(mention);
	if (!model) {return false;}
	const requestMessages = messages.map(message => message.role === 'assistant'
		? vscode.LanguageModelChatMessage.Assistant(message.content ?? '')
		: vscode.LanguageModelChatMessage.User(message.content ?? ''));
	const modelResponse = await model.sendRequest(requestMessages, {
		justification: 'Allow @flm to pass an explicitly addressed chat request to another language model.'
	}, token);
	for await (const part of modelResponse.stream) {
		if (part instanceof vscode.LanguageModelTextPart) {response.markdown(part.value);}
	}
	return true;
}

export async function updateSelectedAgent(value: string, state: vscode.Memento | undefined = selectedAgentState): Promise<boolean> {
	const normalized = normalizeSelectedAgent(value);
	if (!state) {return false;}
	await state.update(SELECTED_AGENT_STORAGE_KEY, normalized === 'none' ? undefined : normalized);
	return true;
}

async function selectAgent(): Promise<void> {
	const agents = configuredExternalAgents();
	const items = [
		{ label: 'FastFlowLM', description: 'Use the configured FastFlowLM model.', value: 'none' },
		...agents.map(agent => ({ label: agent.name, description: `Use the configured ${agent.name} harness.`, value: agent.name }))
	];
	const choice = await vscode.window.showQuickPick(items, {
		placeHolder: 'Choose the default harness or agent for @flm requests',
		canPickMany: false
	});
	if (!choice) {return;}
	const updated = await updateSelectedAgent(choice.value, selectedAgentState);
	if (!updated) {
		void vscode.window.showWarningMessage('The selected agent preference could not be saved to user settings in this VS Code session, but the command still completed.');
	}
	if (choice.value === 'none') {
		void vscode.window.showInformationMessage('FastFlowLM is now the default @flm harness.');
		return;
	}
	const agent = agents.find(candidate => candidate.name === choice.value);
	if (agent) {
		await ensureExternalAgentInstalled(agent);
		void vscode.window.showInformationMessage(`${agent.name} is now the default @flm harness.`);
	}
}

export function activate(context: vscode.ExtensionContext) {
	selectedAgentState = context.globalState;
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
	const coordinator = new MultiAgentCoordinator(client, reportStatus);
	const registerExternalParticipant = (id: string, name: string) => {
		const participant = vscode.chat.createChatParticipant(id, async (request, context, response, token) => {
			try {
				if (request.command === 'status') {
					const configured = externalAgentByName(name);
					response.markdown(configured ? `@${name} is configured and ready to check its harness.` : `@${name} is not configured.`);
					return;
				}
				await runExternalParticipant(name, request, context, response, token, client);
			} catch (error) {
				response.markdown(`@${name} error: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
		participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'flm-vscode.png');
		return participant;
	};
	const flmParticipant = vscode.chat.createChatParticipant('flm-vscode.flm', async (request, context, response, token) => {
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
				case 'collaborate': await coordinator.collaborate(request, context, response, token); return;
			}
			const messages = participantHistory(context.history);
			messages.push({ role: 'user', content: request.prompt });
			const mentions = requestedChatModels(request.prompt);
			if (mentions.length) {
				await coordinator.collaborate(request, context, response, token);
				return;
			}
			const selectedAgent = await ensureSelectedExternalAgent(reportStatus);
			if (selectedAgent) {
				response.markdown(await invokeExternalAgent(selectedAgent, messages, token));
				return;
			}
			const configuredModel = vscode.workspace.getConfiguration('flm-vscode').get<string>('model', 'fastflowlm');
			const model = await client.resolveModel(configuredModel);
			await runWorkspaceAgent(client, messages, model, response, token);
		} catch (error) { response.markdown(`FastFlowLM error: ${error instanceof Error ? error.message : String(error)}`); }
	});
	flmParticipant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'flm-vscode.png');
	const claudeParticipant = registerExternalParticipant('flm-vscode.claude', 'claude');
	const hermesParticipant = registerExternalParticipant('flm-vscode.hermes', 'hermes');
	const deepseekParticipant = registerExternalParticipant('flm-vscode.deepseek', 'deepseek');
	context.subscriptions.push(
		flmParticipant,
		claudeParticipant,
		hermesParticipant,
		deepseekParticipant,
		vscode.lm.registerLanguageModelChatProvider('fastflowlm', new FastFlowLMProvider(client)),
		vscode.commands.registerCommand('flm-vscode.openChat', () => chat.show()),
		vscode.commands.registerCommand('flm-vscode.checkServer', async () => {
			try { const models = await client.listModels(); void vscode.window.showInformationMessage(`FastFlowLM is reachable. ${models.length} model(s) available.`); }
			catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
		}),
		vscode.commands.registerCommand('flm-vscode.checkFlmInstallation', () => checkFlmInstallation(reportStatus)),
		vscode.commands.registerCommand('flm-vscode.selectAgent', () => selectAgent()),
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
	if (vscode.workspace.getConfiguration('flm-vscode').get<boolean>('checkForUpdates', true) && !selectedExternalAgent()) {
		void checkFlmInstallation(reportStatus);
	}
	void ensureSelectedExternalAgent(reportStatus).catch(() => {});
}

// This method is called when your extension is deactivated
export function deactivate() {
	activeServer?.dispose();
	activeServer = undefined;
}
