import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type ChatMessage = {
	role: 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_call_id?: string;
	tool_calls?: ToolCall[];
};
type OpenAITool = { type: 'function'; function: { name: string; description: string; parameters: object } };
type ServerState = 'stopped' | 'starting' | 'running' | 'error';
const MAX_INPUT_TOKENS = 24576;
const MAX_OUTPUT_TOKENS = 4096;
const CHARS_PER_TOKEN = 4;

function limitMessages(messages: ChatMessage[]): ChatMessage[] {
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

class FastFlowLMClient {
	private get settings() { return vscode.workspace.getConfiguration('flm-vscode'); }
	private get baseUrl() { return this.settings.get<string>('serverUrl', 'http://127.0.0.1:8000/v1').replace(/\/$/, ''); }
	private async request(url: string, init?: RequestInit): Promise<Response> {
		try {
			return await fetch(url, init);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Cannot reach FastFlowLM at ${this.baseUrl}. Start the server or update FastFlowLM: Server URL. ${detail}`);
		}
	}
	private headers(): Record<string, string> {
		const apiKey = this.settings.get<string>('apiKey', '').trim();
		return { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
	}

	public async listModels(): Promise<string[]> {
		const response = await this.request(`${this.baseUrl}/models`, { headers: this.headers() });
		if (!response.ok) {throw new Error(`Model request failed (${response.status}).`);}
		const payload = await response.json() as { data?: Array<{ id?: string }> };
		return (payload.data ?? []).map(model => model.id).filter((id): id is string => Boolean(id));
	}

	public async chat(messages: ChatMessage[], model: string): Promise<string> {
		const response = await this.request(`${this.baseUrl}/chat/completions`, {
			method: 'POST', headers: this.headers(), body: JSON.stringify({ model, messages, stream: false, max_tokens: MAX_OUTPUT_TOKENS })
		});
		if (!response.ok) {throw new Error(`Chat request failed (${response.status}): ${(await response.text()).slice(0, 240)}`);}
		const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
		const content = payload.choices?.[0]?.message?.content;
		if (!content) {throw new Error('FastFlowLM returned no assistant content.');}
		return content;
	}

	public async streamChat(
		messages: ChatMessage[],
		model: string,
		tools: OpenAITool[],
		toolMode: vscode.LanguageModelChatToolMode,
		token: vscode.CancellationToken,
		onText: (text: string) => void,
		onToolCall: (call: ToolCall) => void
	): Promise<void> {
		messages = limitMessages(messages);
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

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let completed = false;
			const toolCalls = new Map<number, ToolCall>();
			while (!completed) {
				const { done, value } = await reader.read();
				buffer += decoder.decode(value, { stream: !done });
				const events = buffer.split(/\r?\n\r?\n/);
				buffer = events.pop() ?? '';
				for (const event of events) {
					for (const line of event.split(/\r?\n/)) {
						if (!line.startsWith('data:')) {continue;}
						const data = line.slice(5).trim();
						if (data === '[DONE]') {completed = true; break;}
						const delta = (JSON.parse(data) as {
							choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>
						}).choices?.[0]?.delta;
						const content = delta?.content;
						if (content) {onText(content);}
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
			for (const call of toolCalls.values()) {
				onToolCall({ ...call, function: { ...call.function, arguments: call.function.arguments || '{}' } });
			}
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
	private state: ServerState = 'stopped';
	private error = '';

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
		this.process = spawn(command, args, { cwd, shell: true, windowsHide: true });
		this.process.on('error', error => { this.state = 'error'; this.error = error.message; this.process = undefined; });
		this.process.on('spawn', () => this.state = 'running');
		this.process.on('exit', (code, signal) => {
			if (this.state !== 'error') {
				this.state = 'stopped';
				this.error = code === 0 || signal === 'SIGTERM' ? '' : `Server exited with code ${code ?? signal}.`;
			}
			this.process = undefined;
		});
	}

	public stop(): void {
		if (!this.process) {return;}
		this.process.kill(); this.process = undefined; this.state = 'stopped'; this.error = '';
	}

	public async restart(): Promise<void> { this.stop(); await this.start(); }
	public dispose(): void { this.stop(); }
}

class ChatPanel {
	private panel: vscode.WebviewPanel | undefined;
	private messages: ChatMessage[] = [];
	private model = vscode.workspace.getConfiguration('flm-vscode').get<string>('model', 'fastflowlm');

	public constructor(private readonly client: FastFlowLMClient, private readonly server: ServerManager) {}

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
		try {
			const reply = await this.client.chat(this.messages, this.model);
			this.messages.push({ role: 'assistant', content: reply }); this.post({ type: 'assistant', content: reply });
		} finally { this.post({ type: 'busy', busy: false }); }
	}

	private post(message: unknown): void { void this.panel?.webview.postMessage(message); }

	private html(webview: vscode.Webview): string {
		const nonce = randomBytes(16).toString('hex');
		const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
		return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>FastFlowLM</title>
<style>:root{color-scheme:light dark}body{margin:0;padding:18px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:13px var(--vscode-font-family)}h1{font-size:18px;margin:0 0 4px}p{color:var(--vscode-descriptionForeground);margin:0 0 16px}.toolbar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}button,select,textarea{font:inherit;color:inherit;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);padding:7px 9px;border-radius:3px}button{cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0}button:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.55;cursor:default}#status{border-left:3px solid var(--vscode-charts-green);padding:7px 10px;margin-bottom:14px;background:var(--vscode-textCodeBlock-background)}#status.error{border-color:var(--vscode-errorForeground)}#messages{display:grid;gap:10px;margin-bottom:14px}.message{padding:10px 12px;white-space:pre-wrap;line-height:1.45;border-radius:5px}.user{background:var(--vscode-textBlockQuote-background)}.assistant{background:var(--vscode-editor-inactiveSelectionBackground)}.composer{display:grid;gap:7px;position:sticky;bottom:0;background:var(--vscode-editor-background);padding-top:8px}textarea{resize:vertical;min-height:62px}.row{display:flex;gap:7px;align-items:center}.row select{flex:1;min-width:0}.hint{font-size:11px;color:var(--vscode-descriptionForeground)}</style></head>
<body><h1>FastFlowLM</h1><p>Chat with an OpenAI-compatible FastFlowLM server.</p><div id="status">Server status: unknown</div><div class="toolbar"><button data-action="start">Start</button><button data-action="stop">Stop</button><button data-action="restart">Restart</button><button data-action="models">Refresh models</button></div><div id="messages"></div><div class="composer"><div class="row"><select id="model" aria-label="Model"><option>${this.escape(this.model)}</option></select><span class="hint">Configure URL and command in Settings</span></div><textarea id="prompt" placeholder="Ask FastFlowLM something..."></textarea><button id="send">Send</button></div>
<script nonce="${nonce}">const vscode=acquireVsCodeApi(),messages=document.getElementById('messages'),prompt=document.getElementById('prompt'),send=document.getElementById('send'),model=document.getElementById('model'),status=document.getElementById('status');function add(role,content){const el=document.createElement('div');el.className='message '+role;el.textContent=content;messages.appendChild(el);el.scrollIntoView({behavior:'smooth',block:'nearest'})}function submit(){const text=prompt.value.trim();if(!text)return;vscode.postMessage({type:'send',text});prompt.value=''}send.addEventListener('click',submit);prompt.addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey))submit()});document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:button.dataset.action})));model.addEventListener('change',()=>vscode.postMessage({type:'model',model:model.value}));window.addEventListener('message',event=>{const message=event.data;if(message.type==='user'||message.type==='assistant')add(message.type,message.content);if(message.type==='busy')send.disabled=message.busy;if(message.type==='error'){status.textContent=message.message;status.className='error'}if(message.type==='status'){status.className=message.status.state==='error'?'error':'';status.textContent='Server: '+message.status.state+(message.status.pid?' (PID '+message.status.pid+')':'')+(message.status.error?' - '+message.status.error:'')}if(message.type==='models'){model.replaceChildren(...message.models.map(value=>{const option=document.createElement('option');option.value=value;option.textContent=value;return option}))}});vscode.postMessage({type:'models'});</script></body></html>`;
	}

	private escape(value: string): string { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character)); }
}

export function activate(context: vscode.ExtensionContext) {
	const client = new FastFlowLMClient();
	const server = new ServerManager();
	const chat = new ChatPanel(client, server);
	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider('fastflowlm', new FastFlowLMProvider(client)),
		vscode.commands.registerCommand('flm-vscode.openChat', () => chat.show()),
		vscode.commands.registerCommand('flm-vscode.checkServer', async () => {
			try { const models = await client.listModels(); void vscode.window.showInformationMessage(`FastFlowLM is reachable. ${models.length} model(s) available.`); }
			catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
		}),
		vscode.commands.registerCommand('flm-vscode.startServer', async () => {
			try { await server.start(); void vscode.window.showInformationMessage('FastFlowLM server started.'); }
			catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
		}),
		vscode.commands.registerCommand('flm-vscode.stopServer', () => { server.stop(); void vscode.window.showInformationMessage('FastFlowLM server stopped.'); }),
		vscode.commands.registerCommand('flm-vscode.restartServer', async () => {
			try { await server.restart(); void vscode.window.showInformationMessage('FastFlowLM server restarted.'); }
			catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
		}),
		{ dispose: () => server.dispose() }
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
