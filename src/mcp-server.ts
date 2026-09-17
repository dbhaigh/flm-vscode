import { promises as fs } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

type JsonRpcRequest = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type MemoryEntry = { content: string; updatedAt: string };
type MemoryStore = Record<string, MemoryEntry>;

const serverUrl = (process.env.FLM_SERVER_URL ?? 'http://127.0.0.1:8000/v1').replace(/\/$/, '');
const apiKey = process.env.FLM_API_KEY?.trim();
const defaultModel = process.env.FLM_MODEL?.trim() || undefined;
const projectRoot = resolve(process.env.FLM_PROJECT_ROOT || process.cwd());
const maxMemoryEntryBytes = 64 * 1024;
const maxMemoryBytes = 512 * 1024;

const tools = [
	{
		name: 'fastflowlm_models',
		description: 'List models available from the configured FastFlowLM server.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false }
	},
	{
		name: 'fastflowlm_chat',
		description: 'Send a coding or project task to FastFlowLM. Include relevant file contents in context when the task needs repository details.',
		inputSchema: {
			type: 'object', required: ['prompt'], additionalProperties: false,
			properties: {
				prompt: { type: 'string', description: 'The task or question for the model.' },
				context: { type: 'string', description: 'Optional project context or file contents.' },
				model: { type: 'string', description: 'Optional model identifier.' }
			}
		}
	},
	{
		name: 'project_list_files',
		description: 'List files in the configured project, excluding dependency and build directories.',
		inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Optional project-relative directory.' } }, additionalProperties: false }
	},
	{
		name: 'project_read_file',
		description: 'Read a UTF-8 text file from the configured project.',
		inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string', description: 'Project-relative file path.' } }, additionalProperties: false }
	},
	{
		name: 'project_write_file',
		description: 'Write a UTF-8 text file in the configured project. Use only when the user has asked for a code change.',
		inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string', description: 'Project-relative file path.' }, content: { type: 'string', description: 'Complete new file contents.' } }, additionalProperties: false }
	},
	{
		name: 'memory_read',
		description: 'Read persistent project memory. Omit key to read all remembered decisions, conventions, and outstanding work.',
		inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'Optional memory key to read.' } }, additionalProperties: false }
	},
	{
		name: 'memory_write',
		description: 'Save a durable project memory entry for future harness sessions. Prefer concise facts, decisions, and next steps.',
		inputSchema: { type: 'object', required: ['key', 'content'], properties: { key: { type: 'string', description: 'Stable memory key, such as architecture or next-steps.' }, content: { type: 'string', description: 'Memory content.' } }, additionalProperties: false }
	},
	{
		name: 'memory_delete',
		description: 'Delete a persistent project memory entry when it is obsolete.',
		inputSchema: { type: 'object', required: ['key'], properties: { key: { type: 'string', description: 'Memory key to delete.' } }, additionalProperties: false }
	}
];

function result(text: string, isError = false): ToolResult {
	return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function projectPath(pathValue: unknown): string {
	if (typeof pathValue !== 'string' || !pathValue.trim()) {throw new Error('A project-relative path is required.');}
	const path = resolve(projectRoot, pathValue);
	const root = projectRoot.endsWith(sep) ? projectRoot : `${projectRoot}${sep}`;
	if (path !== projectRoot && !path.startsWith(root)) {throw new Error('Project path must stay inside the configured project root.');}
	return path;
}

function memoryPath(): string {
	return process.env.FLM_MEMORY_FILE ? projectPath(process.env.FLM_MEMORY_FILE) : resolve(projectRoot, '.flm', 'memory.json');
}

async function readMemory(): Promise<MemoryStore> {
	try {
		const parsed = JSON.parse(await fs.readFile(memoryPath(), 'utf8')) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {throw new Error('Memory file must contain an object.');}
		return parsed as MemoryStore;
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {return {};}
		throw new Error(`Could not read project memory: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function writeMemory(memory: MemoryStore): Promise<void> {
	const serialized = JSON.stringify(memory, null, '\t');
	if (Buffer.byteLength(serialized, 'utf8') > maxMemoryBytes) {throw new Error('Project memory is limited to 512 KB.');}
	const path = memoryPath();
	await fs.mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	await fs.writeFile(temporaryPath, `${serialized}\n`, 'utf8');
	await fs.rename(temporaryPath, path);
}

async function readMemoryTool(argumentsValue: Record<string, unknown>): Promise<string> {
	const memory = await readMemory();
	if (argumentsValue.key === undefined) {return JSON.stringify(memory, null, 2) || '{}';}
	if (typeof argumentsValue.key !== 'string' || !argumentsValue.key.trim()) {throw new Error('Memory key must be a non-empty string.');}
	const entry = memory[argumentsValue.key];
	return entry ? JSON.stringify(entry, null, 2) : `(no memory found for key: ${argumentsValue.key})`;
}

async function writeMemoryTool(argumentsValue: Record<string, unknown>): Promise<string> {
	if (typeof argumentsValue.key !== 'string' || !argumentsValue.key.trim()) {throw new Error('Memory key must be a non-empty string.');}
	if (typeof argumentsValue.content !== 'string' || !argumentsValue.content.trim()) {throw new Error('Memory content must be a non-empty string.');}
	if (Buffer.byteLength(argumentsValue.content, 'utf8') > maxMemoryEntryBytes) {throw new Error('Each memory entry is limited to 64 KB.');}
	const memory = await readMemory();
	memory[argumentsValue.key] = { content: argumentsValue.content, updatedAt: new Date().toISOString() };
	await writeMemory(memory);
	return `Saved project memory: ${argumentsValue.key}.`;
}

async function deleteMemoryTool(argumentsValue: Record<string, unknown>): Promise<string> {
	if (typeof argumentsValue.key !== 'string' || !argumentsValue.key.trim()) {throw new Error('Memory key must be a non-empty string.');}
	const memory = await readMemory();
	if (!memory[argumentsValue.key]) {return `(no memory found for key: ${argumentsValue.key})`;}
	delete memory[argumentsValue.key];
	await writeMemory(memory);
	return `Deleted project memory: ${argumentsValue.key}.`;
}

function headers(): Record<string, string> {
	return { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
}

async function models(): Promise<string[]> {
	const response = await fetch(`${serverUrl}/models`, { headers: headers() });
	if (!response.ok) {throw new Error(`FastFlowLM model request failed (${response.status}).`);}
	const payload = await response.json() as { data?: Array<{ id?: unknown }> };
	return (payload.data ?? []).map(model => model.id).filter((id): id is string => typeof id === 'string' && Boolean(id));
}

async function chat(argumentsValue: Record<string, unknown>): Promise<string> {
	const prompt = argumentsValue.prompt;
	if (typeof prompt !== 'string' || !prompt.trim()) {throw new Error('The prompt must be a non-empty string.');}
	const context = typeof argumentsValue.context === 'string' && argumentsValue.context.trim() ? `\n\nProject context:\n${argumentsValue.context}` : '';
	const requestedModel = typeof argumentsValue.model === 'string' ? argumentsValue.model.trim() : '';
	const available = await models();
	const model = requestedModel || defaultModel || available[0];
	if (!model) {throw new Error('FastFlowLM reported no models. Set FLM_MODEL or start a server with an available model.');}
	const response = await fetch(`${serverUrl}/chat/completions`, {
		method: 'POST', headers: headers(), body: JSON.stringify({ model, messages: [{ role: 'user', content: `${prompt}${context}` }], stream: false })
	});
	if (!response.ok) {throw new Error(`FastFlowLM chat request failed (${response.status}): ${(await response.text()).slice(0, 240)}`);}
	const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
	const content = payload.choices?.[0]?.message?.content;
	if (typeof content !== 'string' || !content) {throw new Error('FastFlowLM returned no assistant content.');}
	return `[model: ${model}]\n${content}`;
}

async function listFiles(pathValue: unknown): Promise<string> {
	const directory = projectPath(pathValue || '.');
	const entries = await fs.readdir(directory, { withFileTypes: true });
	return entries.filter(entry => !entry.name.startsWith('.') && !['node_modules', 'dist', 'out'].includes(entry.name))
		.map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name).sort().join('\n') || '(empty directory)';
}

async function callTool(name: string, argumentsValue: Record<string, unknown>): Promise<ToolResult> {
	switch (name) {
		case 'fastflowlm_models': return result((await models()).join('\n') || '(no models available)');
		case 'fastflowlm_chat': return result(await chat(argumentsValue));
		case 'project_list_files': return result(await listFiles(argumentsValue.path));
		case 'project_read_file': return result(await fs.readFile(projectPath(argumentsValue.path), 'utf8'));
		case 'project_write_file': {
			if (typeof argumentsValue.content !== 'string') {throw new Error('File content must be a string.');}
			const path = projectPath(argumentsValue.path);
			await fs.mkdir(dirname(path), { recursive: true });
			await fs.writeFile(path, argumentsValue.content, 'utf8');
			return result(`Wrote ${relative(projectRoot, path)}.`);
		}
		case 'memory_read': return result(await readMemoryTool(argumentsValue));
		case 'memory_write': return result(await writeMemoryTool(argumentsValue));
		case 'memory_delete': return result(await deleteMemoryTool(argumentsValue));
		default: throw new Error(`Unknown tool: ${name}`);
	}
}

function response(id: number | string | undefined, resultValue: unknown): string {
	return JSON.stringify({ jsonrpc: '2.0', id, result: resultValue });
}

async function handle(request: JsonRpcRequest): Promise<string | undefined> {
	if (!request.method || request.id === undefined) {return undefined;}
	try {
		switch (request.method) {
			case 'initialize': return response(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fastflowlm-project-bridge', version: '0.1.2' } });
			case 'tools/list': return response(request.id, { tools });
			case 'tools/call': {
				const name = request.params?.name;
				if (typeof name !== 'string') {throw new Error('Tool name is required.');}
				return response(request.id, await callTool(name, (request.params?.arguments ?? {}) as Record<string, unknown>));
			}
			default: return response(request.id, {});
		}
	} catch (error) {
		return response(request.id, { error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
	}
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = Promise.resolve();
input.on('line', line => {
	pending = pending.then(async () => {
		try {
			const request = JSON.parse(line) as JsonRpcRequest;
			const reply = await handle(request);
			if (reply) { process.stdout.write(`${reply}\n`); }
		} catch (error) {
			process.stdout.write(`${response(undefined, { error: { code: -32700, message: error instanceof Error ? error.message : String(error) } })}\n`);
		}
	});
});