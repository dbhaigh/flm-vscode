import * as assert from 'assert';
import { createServer, Server } from 'node:http';

import * as vscode from 'vscode';
import { buildChatCompletionRequest, FastFlowLMCodexBridge, mapResponsesInputToChatMessages } from '../codex-flm-bridge';
import { compareFlmVersions, externalAgentArguments, externalAgentError, externalAgentWorkingDirectory, FastFlowLMClient, limitMessages, mergePiFastFlowLMProvider, parseFlmVersion, readSelectedAgentPreference, requestedChatModels, updateSelectedAgent } from '../extension';

suite('Extension Test Suite', () => {
	test('activates and registers the extension commands', async () => {
		const extension = vscode.extensions.getExtension('AndrewHaigh.flm-vscode');
		assert.ok(extension, 'The extension must be available in the test host.');
		await extension.activate();
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('flm-vscode.openChat'));
		assert.ok(commands.includes('flm-vscode.checkFlmInstallation'));
	});

	test('publishes the expected extension contributions', () => {
		const extension = vscode.extensions.getExtension('AndrewHaigh.flm-vscode');
		assert.ok(extension, 'The extension must be available in the test host.');
		const manifest = extension.packageJSON as {
			contributes?: {
				commands?: Array<{ command: string }>;
				languageModelChatProviders?: Array<{ vendor: string }>;
				chatParticipants?: Array<{ id: string; name: string }>;
				configuration?: { properties?: Record<string, { password?: boolean; default?: unknown }> };
			};
		};
		assert.deepStrictEqual(manifest.contributes?.commands?.map(command => command.command), [
			'flm-vscode.openChat',
			'flm-vscode.checkServer',
			'flm-vscode.checkFlmInstallation',
			'flm-vscode.selectAgent',
			'flm-vscode.startServer',
			'flm-vscode.stopServer',
			'flm-vscode.restartServer',
			'flm-vscode.showActivityLog'
		]);
		assert.deepStrictEqual(manifest.contributes?.languageModelChatProviders?.map(provider => provider.vendor), ['fastflowlm']);
		assert.deepStrictEqual(
			manifest.contributes?.chatParticipants?.map(participant => participant.name).sort(),
			['aider', 'codex', 'copilot', 'flm', 'hermes', 'opencode', 'pi']
		);
		const externalAgents = manifest.contributes?.configuration?.properties?.['flm-vscode.externalAgents']?.default as Array<{ name?: string; args?: string[] }>;
		assert.deepStrictEqual(externalAgents.find(agent => agent.name === 'aider')?.args, ['--no-fancy-input', '--no-pretty', '--no-check-update', '--no-show-release-notes', '--yes-always', '--message', '{prompt}']);
		assert.deepStrictEqual(externalAgents.find(agent => agent.name === 'codex')?.args, ['exec', '{prompt}']);
		assert.deepStrictEqual(externalAgents.find(agent => agent.name === 'hermes')?.args, ['-z', '{prompt}']);
		assert.deepStrictEqual(externalAgents.find(agent => agent.name === 'opencode')?.args, ['run', '{prompt}']);
		assert.deepStrictEqual(externalAgents.find(agent => agent.name === 'pi')?.args, ['--print', '{prompt}']);
	});

	test('limits chat history to the configured input budget', () => {
		const messages = [
			{ role: 'user' as const, content: 'a'.repeat(50_000) },
			{ role: 'assistant' as const, content: 'latest' }
		];
		const limited = limitMessages(messages);
		assert.strictEqual(limited.at(-1)?.content, 'latest');
		assert.ok(limited.reduce((total, message) => total + (message.content?.length ?? 0), 0) <= 24576 * 4);
	});

	test('explains oversized external harness requests', () => {
		assert.strictEqual(
			externalAgentError('hermes', 2, 'HTTP 400: Max length reached!').message,
			'hermes rejected the request because its context is too long. Start a new chat or ask with less conversation history.'
		);
	});

	test('routes Aider to the configured FastFlowLM endpoint and respects explicit flags', () => {
		assert.deepStrictEqual(
			externalAgentArguments('aider', ['--message', '{prompt}'], 'review this', 'http://127.0.0.1:8000/v1', 'qwen3.5:2b', ''),
			['--model', 'openai/qwen3.5:2b', '--openai-api-base', 'http://127.0.0.1:8000/v1', '--openai-api-key', 'dummy_key', '--no-gitignore', '--no-show-model-warnings', '--yes-always', '--message', 'review this']
		);
		assert.deepStrictEqual(
			externalAgentArguments('aider', [], 'review this', 'url', 'model', ''),
			['--model', 'openai/model', '--openai-api-base', 'url', '--openai-api-key', 'dummy_key', '--no-gitignore', '--no-show-model-warnings', '--yes-always', '--message', 'review this']
		);
		assert.deepStrictEqual(
			externalAgentArguments('aider', ['--model', 'openai/custom', '--openai-api-base=http://custom/v1', '--message', '{prompt}'], 'review this', 'http://127.0.0.1:8000/v1', 'qwen3.5:2b', 'secret'),
			['--openai-api-key', 'secret', '--no-gitignore', '--no-show-model-warnings', '--yes-always', '--model', 'openai/custom', '--openai-api-base=http://custom/v1', '--message', 'review this']
		);
		assert.deepStrictEqual(
			externalAgentArguments('aider', ['--message', '{prompt}'], 'review this', 'http://127.0.0.1:8000/v1', 'qwen3.5:2b', '', false),
			['--model', 'openai/qwen3.5:2b', '--openai-api-base', 'http://127.0.0.1:8000/v1', '--openai-api-key', 'dummy_key', '--no-gitignore', '--no-show-model-warnings', '--yes-always', '--no-git', '--message', 'review this']
		);
		assert.deepStrictEqual(
			externalAgentArguments('aider', ['--gitignore', '--message', '{prompt}'], 'review this', 'url', 'model', ''),
			['--model', 'openai/model', '--openai-api-base', 'url', '--openai-api-key', 'dummy_key', '--no-show-model-warnings', '--yes-always', '--gitignore', '--message', 'review this']
		);
		assert.deepStrictEqual(externalAgentArguments('pi', ['--print', '{prompt}'], 'review this', 'url', 'model', ''), ['--provider', 'flm-vscode', '--model', 'model', '--print', 'review this']);
		assert.deepStrictEqual(externalAgentArguments('pi', ['--provider', 'anthropic', '--model', 'sonnet', '--print', '{prompt}'], 'review this', 'url', 'model', ''), ['--provider', 'anthropic', '--model', 'sonnet', '--print', 'review this']);
	});

	test('uses the configured external-agent cwd before the workspace folder', () => {
		assert.strictEqual(externalAgentWorkingDirectory(undefined, 'C:\\workspace'), 'C:\\workspace');
		assert.strictEqual(externalAgentWorkingDirectory('C:\\agent-project', 'C:\\workspace'), 'C:\\agent-project');
	});

	test('routes Codex through a per-process FastFlowLM Responses provider', () => {
		assert.deepStrictEqual(externalAgentArguments('codex', ['exec', '{prompt}'], 'review this', 'http://127.0.0.1:43210/v1', 'qwen3.5:2b', '', true, 'bridge-token'), [
			'exec',
			'-c', 'model_provider="flm-vscode"',
			'-c', 'model_providers.flm-vscode.name="FastFlowLM"',
			'-c', 'model_providers.flm-vscode.base_url="http://127.0.0.1:43210/v1"',
			'-c', 'model_providers.flm-vscode.wire_api="responses"',
			'-c', 'model_providers.flm-vscode.requires_openai_auth=false',
			'-c', 'model_providers.flm-vscode.http_headers={Authorization="Bearer bridge-token"}',
			'--model', 'qwen3.5:2b',
			'review this'
		]);
	});

	test('maps Codex Responses messages and function tools to Chat Completions', () => {
		const payload = buildChatCompletionRequest({
			instructions: 'Be concise.',
			input: [
				{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List files.' }] },
				{ type: 'function_call_output', call_id: 'call-1', output: 'a.ts' }
			],
			tools: [{ type: 'function', name: 'list_files', description: 'List files', parameters: { type: 'object' }, strict: true }],
			max_output_tokens: 100
		}, 'qwen3.5:2b');
		assert.deepStrictEqual(payload.messages, [
			{ role: 'user', content: 'Be concise.\n\nList files.' },
			{ role: 'tool', tool_call_id: 'call-1', content: 'a.ts' }
		]);
		assert.deepStrictEqual(payload.tools, [{ type: 'function', function: { name: 'list_files', description: 'List files', parameters: { type: 'object' }, strict: true } }]);
		assert.strictEqual(payload.max_tokens, 100);
		assert.deepStrictEqual(mapResponsesInputToChatMessages('System instruction', 'Hi'), [{ role: 'user', content: 'System instruction\n\nHi' }]);
	});

	test('forwards Codex Responses calls to FastFlowLM and returns a Responses result', async () => {
		let receivedBody: Record<string, unknown> | undefined;
		let receivedAuthorization: string | undefined;
		const flm = createServer((request, response) => {
			if (request.method === 'GET') {
				response.setHeader('Content-Type', 'application/json');
				response.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3.5:2b' }] }));
				return;
			}
			let body = '';
			request.on('data', chunk => body += chunk);
			request.on('end', () => {
				receivedBody = JSON.parse(body) as Record<string, unknown>;
				receivedAuthorization = request.headers.authorization;
				response.setHeader('Content-Type', 'application/json');
				response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'FastFlowLM reply' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
			});
		});
		await listen(flm);
		const address = flm.address();
		assert.ok(address && typeof address !== 'string');
		const bridge = new FastFlowLMCodexBridge(`http://127.0.0.1:${address.port}/v1`, 'qwen3.5:2b', 'local-key');
		await bridge.start();
		try {
			const headers = { Authorization: `Bearer ${bridge.authorizationToken}` };
			const models = await fetch(`${bridge.baseUrl}/models?client_version=0.159.3`, { headers });
			assert.strictEqual(models.status, 200);
			const catalog = await models.json() as { models: Array<{ slug: string; model_messages: { instructions_template: string } }> };
			assert.deepStrictEqual(catalog.models.map(model => model.slug), ['qwen3.5:2b']);
			assert.strictEqual(catalog.models[0].model_messages.instructions_template, '');
			const response = await fetch(`${bridge.baseUrl}/responses?client_version=0.159.3`, {
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify({ instructions: 'Be brief.', input: 'Say hello.', stream: false })
			});
			assert.strictEqual(response.status, 200);
			const result = await response.json() as { object: string; model: string; output: Array<{ type: string; content?: Array<{ text: string }> }>; usage: { total_tokens: number } };
			assert.strictEqual(result.object, 'response');
			assert.strictEqual(result.model, 'qwen3.5:2b');
			assert.strictEqual(result.output[0].content?.[0].text, 'FastFlowLM reply');
			assert.strictEqual(result.usage.total_tokens, 5);
			assert.deepStrictEqual((receivedBody?.messages as Array<{ role: string; content: string }>).map(message => message.role), ['user']);
			assert.strictEqual(receivedAuthorization, 'Bearer local-key');
		} finally {
			await bridge.close();
			await close(flm);
		}
	});

	test('merges the FastFlowLM Pi provider without discarding other Pi providers', () => {
		const updated = mergePiFastFlowLMProvider({
			settings: { theme: 'dark' },
			providers: {
				openai: { baseUrl: 'https://api.openai.com/v1' },
				'flm-vscode': { models: [{ id: 'old-model' }, { id: 'qwen3.5:2b', name: 'old name' }] }
			}
		}, 'http://127.0.0.1:52625/v1', 'qwen3.5:2b');
		const providers = updated.providers as Record<string, { baseUrl?: string; api?: string; apiKey?: string; models?: Array<{ id: string }> }>;
		assert.deepStrictEqual(updated.settings, { theme: 'dark' });
		assert.deepStrictEqual(providers.openai, { baseUrl: 'https://api.openai.com/v1' });
		assert.strictEqual(providers['flm-vscode'].baseUrl, 'http://127.0.0.1:52625/v1');
		assert.strictEqual(providers['flm-vscode'].api, 'openai-completions');
		assert.strictEqual(providers['flm-vscode'].apiKey, '$FLM_VSCODE_PI_API_KEY');
		assert.deepStrictEqual(providers['flm-vscode'].models?.map(configuredModel => configuredModel.id), ['old-model', 'qwen3.5:2b']);
	});

	test('parses and compares FLM versions', () => {
		assert.strictEqual(parseFlmVersion('{ "version": "1.0.4" }'), '1.0.4');
		assert.strictEqual(parseFlmVersion('FLM v1.0.4'), '1.0.4');
		assert.strictEqual(compareFlmVersions('v1.0.5', '1.0.4'), 1);
		assert.strictEqual(compareFlmVersions('1.0.4', '1.0.5'), -1);
		assert.strictEqual(compareFlmVersions('1.0.5', '1.0.5'), 0);
	});

	test('extracts unique addressed agents without routing @flm to itself', () => {
		assert.deepStrictEqual(requestedChatModels('@flm /collaborate @Copilot @qwen @Copilot review this'), ['copilot', 'qwen']);
	});

	test('recognizes external harness mentions', () => {
		assert.deepStrictEqual(requestedChatModels('@flm ask @hermes and @qwen to review this'), ['hermes', 'qwen']);
		assert.deepStrictEqual(requestedChatModels('@hermes ask @flm and @qwen to review this', true), ['hermes', 'flm', 'qwen']);
	});

	test('preserves external harness failure output', () => {
		assert.strictEqual(externalAgentError('hermes', 1, '', 'login required').message, 'hermes exited with code 1: login required');
		assert.strictEqual(externalAgentError('hermes', 1, 'request failed').message, 'hermes exited with code 1: request failed');
	});

	test('prioritizes persisted state over stale configuration values', () => {
		const config = {
			get: () => 'hermes'
		} as unknown as vscode.WorkspaceConfiguration;
		const state = {
			get: (key: string) => key === 'flm-vscode.selectedAgent' ? 'hermes' : undefined
		} as vscode.Memento;
		assert.strictEqual(readSelectedAgentPreference(config, state), 'hermes');
	});

	test('handles an unregistered selectedAgent configuration gracefully', async () => {
		const state = {
			update: async () => undefined,
			get: () => undefined
		} as unknown as vscode.Memento;
		assert.strictEqual(await updateSelectedAgent('none', state), true);
	});

	test('lists models and sends chat requests to an OpenAI-compatible server', async () => {
		let receivedBody: Record<string, unknown> | undefined;
		const statuses: string[] = [];
		const server = createServer((request, response) => {
			if (request.url === '/v1/models') {
				response.setHeader('Content-Type', 'application/json');
				response.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
				return;
			}
			if (request.url === '/v1/chat/completions') {
				let body = '';
				request.on('data', chunk => body += chunk);
				request.on('end', () => {
					receivedBody = JSON.parse(body) as Record<string, unknown>;
					response.setHeader('Content-Type', 'application/json');
					response.end(JSON.stringify({ choices: [{ message: { content: 'test reply' } }] }));
				});
				return;
			}
			response.statusCode = 404;
			response.end();
		});
		await listen(server);
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		const configuration = vscode.workspace.getConfiguration('flm-vscode');
		const originalUrl = configuration.get<string>('serverUrl');
		await configuration.update('serverUrl', `http://127.0.0.1:${address.port}/v1`, vscode.ConfigurationTarget.Global);
		try {
			const client = new FastFlowLMClient(status => statuses.push(status));
			assert.deepStrictEqual(await client.listModels(), ['test-model']);
			assert.strictEqual(await client.resolveModel('missing-model'), 'test-model');
			assert.strictEqual(await client.chat([{ role: 'user', content: 'hello' }], 'test-model'), 'test reply');
			assert.strictEqual(receivedBody?.model, 'test-model');
			assert.strictEqual(receivedBody?.stream, false);
			assert.deepStrictEqual(statuses, [
				`Checking available models at http://127.0.0.1:${address.port}/v1/models.`,
				'Available models: test-model.',
				`Checking available models at http://127.0.0.1:${address.port}/v1/models.`,
				'Available models: test-model.',
				'Configured model "missing-model" is unavailable; using "test-model".',
				'Sending task to model "test-model".',
				'Model "test-model" completed the task.'
			]);
		} finally {
			await configuration.update('serverUrl', originalUrl, vscode.ConfigurationTarget.Global);
			await close(server);
		}
	});

	test('reports model download and load activity from streaming events', async () => {
		const activity: string[] = [];
		const raw: string[] = [];
		const server = createServer((_request, response) => {
			response.setHeader('Content-Type', 'text/event-stream');
			response.write(': loading model from registry\n\n');
			response.write('event: model\ndata: {"status":"Downloading model","progress":0.5}\n\n');
			response.write('data: model loaded from local cache\n\n');
			response.write('data: {"raw_output":"model weights loaded"}\n\n');
			response.write('data: {"choices":[{"delta":{"reasoning":"checking the prompt"}}]}\n\n');
			response.write('data: {"choices":[{"delta":{"content":"reply"}}]}\n\n');
			response.end('data: [DONE]\n\n');
		});
		await listen(server);
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		const configuration = vscode.workspace.getConfiguration('flm-vscode');
		const originalUrl = configuration.get<string>('serverUrl');
		const originalDebugStreaming = configuration.get<boolean>('debugStreaming');
		await configuration.update('serverUrl', `http://127.0.0.1:${address.port}/v1`, vscode.ConfigurationTarget.Global);
		await configuration.update('debugStreaming', true, vscode.ConfigurationTarget.Global);
		try {
			const client = new FastFlowLMClient();
			let response = '';
			const cancellation = new vscode.CancellationTokenSource();
			await client.streamChat(
				[{ role: 'user', content: 'hello' }], 'test-model', [], vscode.LanguageModelChatToolMode.Auto, cancellation.token,
				text => response += text, () => {}, message => activity.push(message), chunk => raw.push(chunk)
			);
			cancellation.dispose();
			assert.strictEqual(response, 'reply');
			assert.deepStrictEqual(activity, ['loading model from registry', 'Downloading model', 'model loaded from local cache', 'model weights loaded', 'checking the prompt']);
			assert.ok(raw.some(chunk => chunk.includes('Downloading model')));
			assert.ok(raw.some(chunk => chunk.includes('[model reasoning] checking the prompt')));
			assert.ok(raw.some(chunk => chunk.includes('content-type=text/event-stream')));
		} finally {
			await configuration.update('serverUrl', originalUrl, vscode.ConfigurationTarget.Global);
			await configuration.update('debugStreaming', originalDebugStreaming, vscode.ConfigurationTarget.Global);
			await close(server);
		}
	});

	test('accepts multiline SSE data fields', async () => {
		const server = createServer((_request, response) => {
			response.setHeader('Content-Type', 'text/event-stream');
			response.end('data: {"choices":[\ndata: {"delta":{"content":"reply"}}]}\n\ndata: [DONE]\n\n');
		});
		await listen(server);
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		const configuration = vscode.workspace.getConfiguration('flm-vscode');
		const originalUrl = configuration.get<string>('serverUrl');
		await configuration.update('serverUrl', `http://127.0.0.1:${address.port}/v1`, vscode.ConfigurationTarget.Global);
		try {
			const client = new FastFlowLMClient();
			let response = '';
			const cancellation = new vscode.CancellationTokenSource();
			await client.streamChat([{ role: 'user', content: 'hello' }], 'test-model', [], vscode.LanguageModelChatToolMode.Auto, cancellation.token, text => response += text, () => {});
			cancellation.dispose();
			assert.strictEqual(response, 'reply');
		} finally {
			await configuration.update('serverUrl', originalUrl, vscode.ConfigurationTarget.Global);
			await close(server);
		}
	});

	test('rejects a stream that closes before [DONE]', async () => {
		const server = createServer((_request, response) => {
			response.setHeader('Content-Type', 'text/event-stream');
			response.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
		});
		await listen(server);
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		const configuration = vscode.workspace.getConfiguration('flm-vscode');
		const originalUrl = configuration.get<string>('serverUrl');
		await configuration.update('serverUrl', `http://127.0.0.1:${address.port}/v1`, vscode.ConfigurationTarget.Global);
		try {
			const client = new FastFlowLMClient();
			const cancellation = new vscode.CancellationTokenSource();
			await assert.rejects(
				client.streamChat([{ role: 'user', content: 'hello' }], 'test-model', [], vscode.LanguageModelChatToolMode.Auto, cancellation.token, () => {}, () => {}),
				/FastFlowLM closed the response stream before \[DONE\]/
			);
			cancellation.dispose();
		} finally {
			await configuration.update('serverUrl', originalUrl, vscode.ConfigurationTarget.Global);
			await close(server);
		}
	});

	if (process.env.FLM_E2E_URL) {
		test('streams a response from a live FastFlowLM server', async () => {
			const configuration = vscode.workspace.getConfiguration('flm-vscode');
			const originalUrl = configuration.get<string>('serverUrl');
			await configuration.update('serverUrl', process.env.FLM_E2E_URL, vscode.ConfigurationTarget.Global);
			try {
				const client = new FastFlowLMClient();
				const models = await client.listModels();
				assert.ok(models.includes('qwen3.5:2b'), 'The live server must expose qwen3.5:2b.');
				let response = '';
				const cancellation = new vscode.CancellationTokenSource();
				await client.streamChat(
					[{ role: 'user', content: 'Reply with exactly: FastFlowLM EXTENSION E2E OK' }],
					'qwen3.5:2b',
					[],
					vscode.LanguageModelChatToolMode.Auto,
					cancellation.token,
					text => response += text,
					() => { throw new Error('Unexpected tool call in live smoke test.'); }
				);
				cancellation.dispose();
				assert.match(response, /FastFlowLM.*E2E.*OK/i);
			} finally {
				await configuration.update('serverUrl', originalUrl, vscode.ConfigurationTarget.Global);
			}
		});
	}

});

function listen(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
