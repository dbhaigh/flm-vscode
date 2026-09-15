import * as assert from 'assert';
import { createServer, Server } from 'node:http';

import * as vscode from 'vscode';
import { FastFlowLMClient, limitMessages } from '../extension';

suite('Extension Test Suite', () => {
	test('activates and registers the extension commands', async () => {
		const extension = vscode.extensions.getExtension('AndrewHaigh.flm-vscode');
		assert.ok(extension, 'The extension must be available in the test host.');
		await extension.activate();
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('flm-vscode.openChat'));
	});

	test('publishes the expected extension contributions', () => {
		const extension = vscode.extensions.getExtension('AndrewHaigh.flm-vscode');
		assert.ok(extension, 'The extension must be available in the test host.');
		const manifest = extension.packageJSON as { contributes?: { commands?: Array<{ command: string }>; languageModelChatProviders?: Array<{ vendor: string }> } };
		assert.deepStrictEqual(manifest.contributes?.commands?.map(command => command.command), [
			'flm-vscode.openChat',
			'flm-vscode.checkServer',
			'flm-vscode.startServer',
			'flm-vscode.stopServer',
			'flm-vscode.restartServer'
		]);
		assert.deepStrictEqual(manifest.contributes?.languageModelChatProviders?.map(provider => provider.vendor), ['fastflowlm']);
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

	test('lists models and sends chat requests to an OpenAI-compatible server', async () => {
		let receivedBody: Record<string, unknown> | undefined;
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
			const client = new FastFlowLMClient();
			assert.deepStrictEqual(await client.listModels(), ['test-model']);
			assert.strictEqual(await client.chat([{ role: 'user', content: 'hello' }], 'test-model'), 'test reply');
			assert.strictEqual(receivedBody?.model, 'test-model');
			assert.strictEqual(receivedBody?.stream, false);
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
