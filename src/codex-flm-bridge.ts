import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

type BridgeToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type BridgeMessage = { role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'; content: string | null; tool_call_id?: string; tool_calls?: BridgeToolCall[] };
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function contentText(content: unknown): string {
	if (typeof content === 'string') {return content;}
	if (!Array.isArray(content)) {return '';}
	return content.map(part => {
		const item = object(part);
		if (typeof item.text === 'string') {return item.text;}
		if (item.type === 'image' || item.type === 'input_image') {throw new Error('FastFlowLM Codex bridge does not support image input.');}
		return '';
	}).join('');
}

export function mapResponsesInputToChatMessages(instructions: unknown, input: unknown): BridgeMessage[] {
	const messages: BridgeMessage[] = [];
	const instructionParts = typeof instructions === 'string' && instructions.trim() ? [instructions] : [];
	const addUserContent = (content: string) => {
		const prefix = instructionParts.length ? `${instructionParts.join('\n\n')}\n\n` : '';
		instructionParts.length = 0;
		messages.push({ role: 'user', content: `${prefix}${content}` });
	};
	if (typeof input === 'string') {
		addUserContent(input);
		if (instructionParts.length) {addUserContent('');}
		return messages;
	}
	if (!Array.isArray(input)) {
		if (instructionParts.length) {addUserContent('');}
		return messages;
	}
	for (const value of input) {
		const item = object(value);
		if (item.type === 'function_call') {
			if (typeof item.name !== 'string') {throw new Error('Codex sent a function call without a name.');}
			messages.push({
				role: 'assistant',
				content: null,
				tool_calls: [{
					id: typeof item.call_id === 'string' ? item.call_id : randomUUID(),
					type: 'function',
					function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) }
				}]
			});
			continue;
		}
		if (item.type === 'function_call_output') {
			messages.push({ role: 'tool', tool_call_id: String(item.call_id ?? ''), content: contentText(item.output) });
			continue;
		}
		if (item.type === 'message' || typeof item.role === 'string') {
			const role = item.role;
			if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(String(role))) {continue;}
			const content = contentText(item.content);
			if (role === 'system' || role === 'developer') {if (content.trim()) {instructionParts.push(content);} continue;}
			if (role === 'user') {addUserContent(content); continue;}
			messages.push({ role: role as BridgeMessage['role'], content });
		}
	}
	if (instructionParts.length) {addUserContent('');}
	return messages;
}

export function buildChatCompletionRequest(payload: JsonObject, model: string): JsonObject {
	const messages = mapResponsesInputToChatMessages(payload.instructions, payload.input);
	const request: JsonObject = { model, messages, stream: false };
	if (typeof payload.max_output_tokens === 'number') {request.max_tokens = payload.max_output_tokens;}
	if (typeof payload.temperature === 'number') {request.temperature = payload.temperature;}
	if (typeof payload.top_p === 'number') {request.top_p = payload.top_p;}
	if (Array.isArray(payload.tools)) {
		request.tools = payload.tools.flatMap(value => {
			const tool = object(value);
			if (tool.type !== 'function' || typeof tool.name !== 'string') {return [];}
			return [{ type: 'function', function: {
				name: tool.name,
				...(typeof tool.description === 'string' ? { description: tool.description } : {}),
				parameters: object(tool.parameters),
				...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {})
			} }];
		});
	}
	if (payload.tool_choice === 'auto' || payload.tool_choice === 'none' || payload.tool_choice === 'required') {
		request.tool_choice = payload.tool_choice;
	} else if (payload.tool_choice && typeof payload.tool_choice === 'object') {
		const choice = object(payload.tool_choice);
		if (choice.type === 'function' && typeof object(choice).name === 'string') {
			request.tool_choice = { type: 'function', function: { name: object(choice).name } };
		}
	}
	return request;
}

function responseItems(completion: JsonObject): JsonObject[] {
	const message = object(object(completion.choices instanceof Array ? completion.choices[0] : undefined).message);
	const items: JsonObject[] = [];
	const text = typeof message.content === 'string' ? message.content : '';
	if (text) {
		items.push({
			id: `msg_${randomUUID().replaceAll('-', '')}`,
			type: 'message',
			status: 'completed',
			role: 'assistant',
			content: [{ type: 'output_text', text, annotations: [] }]
		});
	}
	if (Array.isArray(message.tool_calls)) {
		for (const value of message.tool_calls) {
			const call = object(value);
			const fn = object(call.function);
			if (typeof fn.name !== 'string') {continue;}
			items.push({
				id: `fc_${randomUUID().replaceAll('-', '')}`,
				type: 'function_call',
				status: 'completed',
				call_id: typeof call.id === 'string' ? call.id : randomUUID(),
				name: fn.name,
				arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}'
			});
		}
	}
	return items;
}

function responsesResult(completion: JsonObject, model: string, id = `resp_${randomUUID().replaceAll('-', '')}`): JsonObject {
	const usage = object(completion.usage);
	return {
		id,
		object: 'response',
		created_at: Math.floor(Date.now() / 1000),
		status: 'completed',
		model,
		output: responseItems(completion),
		usage: {
			input_tokens: Number(usage.prompt_tokens ?? 0),
			output_tokens: Number(usage.completion_tokens ?? 0),
			total_tokens: Number(usage.total_tokens ?? 0)
		}
	};
}

function sendEvent(response: ServerResponse, type: string, payload: JsonObject): void {
	response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function sendStreamedResponse(response: ServerResponse, result: JsonObject): void {
	response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
	const initial = { ...result, status: 'in_progress', output: [] };
	sendEvent(response, 'response.created', { response: initial });
	sendEvent(response, 'response.in_progress', { response: initial });
	const output = result.output as JsonObject[];
	output.forEach((item, outputIndex) => {
		sendEvent(response, 'response.output_item.added', { output_index: outputIndex, item: { ...item, status: 'in_progress', content: item.content ?? [] } });
		if (item.type === 'message') {
			const content = Array.isArray(item.content) ? object(item.content[0]) : {};
			sendEvent(response, 'response.content_part.added', { item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '' } });
			const text = typeof content.text === 'string' ? content.text : '';
			if (text) {sendEvent(response, 'response.output_text.delta', { item_id: item.id, output_index: outputIndex, content_index: 0, delta: text });}
			sendEvent(response, 'response.output_text.done', { item_id: item.id, output_index: outputIndex, content_index: 0, text });
			sendEvent(response, 'response.content_part.done', { item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
		} else if (item.type === 'function_call') {
			const args = typeof item.arguments === 'string' ? item.arguments : '{}';
			if (args) {sendEvent(response, 'response.function_call_arguments.delta', { item_id: item.id, output_index: outputIndex, delta: args });}
			sendEvent(response, 'response.function_call_arguments.done', { item_id: item.id, output_index: outputIndex, arguments: args });
		}
		sendEvent(response, 'response.output_item.done', { output_index: outputIndex, item });
	});
	sendEvent(response, 'response.completed', { response: result });
	response.end();
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
	let body = '';
	for await (const chunk of request) {
		body += String(chunk);
		if (Buffer.byteLength(body, 'utf8') > 10 * 1024 * 1024) {throw new Error('Codex request exceeds the 10 MB bridge limit.');}
	}
	const parsed: unknown = JSON.parse(body);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {throw new Error('Codex request must be a JSON object.');}
	return parsed as JsonObject;
}

export class FastFlowLMCodexBridge {
	private server?: Server;
	private readonly bridgeToken = randomBytes(32).toString('hex');
	public constructor(private readonly serverUrl: string, private readonly model: string, private readonly apiKey: string) {}
	public get authorizationToken(): string {return this.bridgeToken;}
	public get baseUrl(): string {
		const address = this.server?.address();
		if (!address || typeof address === 'string') {throw new Error('FastFlowLM Codex bridge is not listening.');}
		return `http://127.0.0.1:${(address as AddressInfo).port}/v1`;
	}
	public async start(): Promise<void> {
		if (this.server) {return;}
		const server = createServer((request, response) => { void this.handle(request, response); });
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
		});
		this.server = server;
	}
	public async close(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (!server) {return;}
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.headers.authorization !== `Bearer ${this.bridgeToken}`) {
			response.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Invalid Codex bridge authorization.' } }));
			return;
		}
		const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
		if (request.method === 'GET' && pathname === '/v1/models') {
			try {
				const models = await fetch(`${this.serverUrl.replace(/\/$/, '')}/models`, {
				headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}
				});
				if (!models.ok) {
					response.writeHead(models.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: `FastFlowLM model request failed (${models.status}).` } }));
					return;
				}
				const payload = await models.json() as { data?: Array<{ id?: unknown }> };
				const available = new Set((payload.data ?? []).map(model => model.id).filter((id): id is string => typeof id === 'string'));
				if (!available.has(this.model)) {throw new Error(`Configured model ${this.model} is not available on FastFlowLM.`);}
				const body = JSON.stringify({ models: [{
					slug: this.model,
					display_name: this.model,
					description: 'FastFlowLM local model.',
					default_reasoning_level: null,
					supported_reasoning_levels: [],
					shell_type: 'unified_exec',
					visibility: 'list',
					supported_in_api: true,
					priority: 1,
					availability_nux: null,
					upgrade: null,
					model_messages: { instructions_template: '' },
					include_skills_usage_instructions: false,
					include_plugin_usage_instructions: false,
					include_apps_usage_instructions: false,
					default_reasoning_summary: 'none',
					support_verbosity: false,
					default_verbosity: null,
					apply_patch_tool_type: null,
					truncation_policy: { mode: 'bytes', limit: 10000 },
					context_window: 32768,
					experimental_supported_tools: [],
					base_instructions: ''
				}] });
				response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body, 'utf8')) }).end(body);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				response.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: `Cannot query FastFlowLM models: ${message}` } }));
			}
			return;
		}
		if (request.method !== 'POST' || pathname !== '/v1/responses') {
			response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Unknown Codex bridge endpoint.' } }));
			return;
		}
		const controller = new AbortController();
		response.on('close', () => { if (!response.writableEnded) {controller.abort();} });
		try {
			const payload = await readJson(request);
			const completion = await fetch(`${this.serverUrl.replace(/\/$/, '')}/chat/completions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
				body: JSON.stringify(buildChatCompletionRequest(payload, this.model)),
				signal: controller.signal
			});
			if (!completion.ok) {
				const detail = (await completion.text()).slice(0, 1000);
				response.writeHead(completion.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: `FastFlowLM request failed (${completion.status}): ${detail}` } }));
				return;
			}
			const completionPayload = await completion.json() as JsonObject;
			if (typeof completionPayload.error === 'string' && completionPayload.error.trim()) {
				response.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: `FastFlowLM error: ${completionPayload.error.slice(0, 2000)}` } }));
				return;
			}
			const result = responsesResult(completionPayload, this.model);
			if (!(result.output as JsonObject[]).length) {
				response.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'FastFlowLM returned no assistant text or tool calls.' } }));
				return;
			}
			if (payload.stream === true) {sendStreamedResponse(response, result);}
			else {response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));}
		} catch (error) {
			if (controller.signal.aborted) {return;}
			const message = error instanceof Error ? error.message : String(error);
			response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message } }));
		}
	}
}