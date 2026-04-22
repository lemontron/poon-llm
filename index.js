import { EventEmitter } from 'node:events';
import { request, consumeStreamAsync, parseJson, parseXml, prettyResponse } from './util.js';

export default class OpenAI extends EventEmitter {
	constructor({
		model,
		apiBase = 'https://api.openai.com',
		secretKey,
		headers = {},
	}) {
		super();
		this.model = model;
		this.apiBase = apiBase;
		this.headers = {'Content-Type': 'application/json', ...headers};
		if (secretKey) this.headers['Authorization'] = `Bearer ${secretKey}`;
	}

	chat = async (prompt, {
		image,
		json,
		xml,
		lastMessageId,
		systemPrompt,
		maxTokens,
		temperature,
		topP,
		onMessage,
		onUpdate,
		timeout = 60000,
		debug = false,
		tools,
	} = {}) => {
		if (typeof prompt !== 'string') throw new Error('Prompt must be a string');
		if (typeof timeout !== 'number') throw new Error('Timeout must be a number');
		if (topP !== undefined && typeof topP !== 'number') throw new Error('topP must be a number');
		if (xml && !Array.isArray(xml)) throw new Error('XML must be an array of strings');
		if (xml && json) throw new Error('Choose either XML or JSON, not both');
		if (lastMessageId && typeof lastMessageId !== 'string') throw new Error('lastMessageId must be a string');
		if (tools && (typeof tools !== 'object' || Array.isArray(tools))) throw new Error('tools must be an object');

		const toolDefinitions = [];
		const toolHandlers = {};
		for (const [name, tool] of Object.entries(tools || {})) {
			if (typeof tool === 'function') {
				toolHandlers[name] = tool;
				toolDefinitions.push({
					'type': 'function',
					'name': name,
					'description': `${name} tool`,
					'parameters': {'type': 'object', 'properties': {}, 'additionalProperties': true},
				});
				continue;
			}
			if (!tool || typeof tool !== 'object') throw new Error(`Invalid tool: ${name}`);
			if (typeof tool.run !== 'function') throw new Error(`Tool "${name}" must define a run function`);
			toolHandlers[name] = tool.run;
			toolDefinitions.push({
				'type': 'function',
				'name': name,
				'description': tool.description || `${name} tool`,
				'parameters': tool.parameters || tool.inputSchema || {'type': 'object', 'properties': {}, 'additionalProperties': true},
			});
		}

		let latestUpdate = null;
		let isUpdating = false;
		let updateCount = 0;
		let chain = Promise.resolve();
		const delay = () => new Promise(resolve => setTimeout(resolve, 150));
		const sendUpdate = (message) => {
			this.emit('update', message);
			if (!onUpdate) return;
			latestUpdate = message;
			if (isUpdating) return;
			chain = chain.then(async () => {
				while (latestUpdate) {
					const next = latestUpdate;
					latestUpdate = null;
					updateCount++;
					isUpdating = true;
					await onUpdate(next, updateCount);
					await delay();
					isUpdating = false;
				}
			});
		};

		const state = {
			'messages': [],
			'toolCalls': new Map(),
			'assistantMessage': null,
			'lastMessageId': lastMessageId || null,
		};

		let input = !image ? prompt : [{
			'role': 'user',
			'content': [
				{'type': 'input_text', 'text': prompt},
				{'type': 'input_image', 'image_url': image},
			],
		}];

		while (true) {
			const payload = {
				'model': this.model,
				'stream': true,
				'input': input,
			};
			if (temperature !== undefined) payload.temperature = temperature;
			if (topP !== undefined) payload.top_p = topP;
			if (systemPrompt) payload.instructions = systemPrompt;
			if (state.lastMessageId) payload.previous_response_id = state.lastMessageId;
			if (maxTokens) payload.max_output_tokens = maxTokens;
			if (json) payload.text = {'format': {'type': 'json_object'}};
			if (toolDefinitions.length) payload.tools = toolDefinitions;
			if (debug) console.log('[LLM Payload]', payload);

			const startCount = state.messages.length;
			await new Promise((resolve, reject) => {
				const handleError = (res) => {
					let body = '';
					res.on('data', buf => body += buf.toString());
					res.on('end', () => {
						const error = prettyResponse(body);
						console.warn('[LLM]', 'StatusCode=', res.statusCode, 'Body=', error);
						console.warn('Payload=', payload);
						reject(new Error(`LLM failed, ${res.statusCode}, ${JSON.stringify(error)}`));
					});
				};

				const client = request(new URL('/v1/responses', this.apiBase), {
					'method': 'POST',
					'headers': this.headers,
					'timeout': timeout,
				}, async (res) => {
					if (res.statusCode >= 400) return handleError(res);
					await consumeStreamAsync(res, async (event) => {
						if (debug) console.log('[LLM Event]', event.type, event);

						if (event.type === 'response.created' || event.type === 'response.completed') {
							const responseId = event.id || event.response?.id || null;
							if (responseId) state.lastMessageId = responseId;
							if (state.assistantMessage && state.assistantMessage.lastMessageId !== state.lastMessageId) {
								state.assistantMessage.lastMessageId = state.lastMessageId;
								sendUpdate(state.assistantMessage);
							}
							return;
						}

						if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
							const _id = event.item.call_id || event.item.id;
							if (!_id) throw new Error('Tool call id missing from API response');
							const message = {
								'_id': _id,
								'role': 'tool',
								'type': 'tool_call',
								'name': event.item.name,
								'tool': event.item.name,
								'arguments': event.item.arguments || '',
								'options': event.item.arguments || '',
								'input': null,
								'output': null,
								'result': null,
								'status': 'requested',
								'lastMessageId': state.lastMessageId,
							};
							state.toolCalls.set(message._id, message);
							state.messages.push(message);
							this.emit('message', message);
							if (onMessage) await onMessage(message);
							return;
						}

						if (event.type === 'response.output_item.added' && event.item?.type === 'message') {
							if (!event.item.id) throw new Error('Assistant message id missing from API response');
							state.assistantMessage = {
								'_id': event.item.id,
								'role': 'assistant',
								'type': 'message',
								'text': '',
								'content': '',
								'status': 'streaming',
								'lastMessageId': state.lastMessageId,
							};
							state.messages.push(state.assistantMessage);
							this.emit('message', state.assistantMessage);
							if (onMessage) await onMessage(state.assistantMessage);
							return;
						}

						if (event.type === 'response.function_call_arguments.delta') {
							const message = state.toolCalls.get(event.item_id || event.call_id);
							if (!message) return;
							message.arguments += event.delta || '';
							message.options = message.arguments;
							try {
								message.input = JSON.parse(message.arguments);
							} catch (err) {}
							sendUpdate(message);
							return;
						}

						if (event.type === 'response.function_call_arguments.done') {
							const message = state.toolCalls.get(event.item_id || event.call_id);
							if (!message) return;
							message.arguments = event.arguments || message.arguments;
							message.options = message.arguments;
							try {
								message.input = JSON.parse(message.arguments || '{}');
							} catch (err) {
								throw new Error(`Tool "${message.name}" emitted invalid JSON arguments`);
							}
							sendUpdate(message);
							return;
						}

						if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
							const message = state.toolCalls.get(event.item.call_id || event.item.id);
							if (!message) return;
							message.arguments = event.item.arguments || message.arguments;
							message.options = message.arguments;
							if (message.arguments && !message.input) {
								try {
									message.input = JSON.parse(message.arguments);
								} catch (err) {
									throw new Error(`Tool "${message.name}" emitted invalid JSON arguments`);
								}
							}
							sendUpdate(message);
							return;
						}

						if (event.type === 'response.output_text.delta') {
							if (!state.assistantMessage) {
								if (!event.item_id) throw new Error('Assistant message id missing from API response');
								state.assistantMessage = {
									'_id': event.item_id,
									'role': 'assistant',
									'type': 'message',
									'text': '',
									'content': '',
									'status': 'streaming',
									'lastMessageId': state.lastMessageId,
								};
								state.messages.push(state.assistantMessage);
								this.emit('message', state.assistantMessage);
								if (onMessage) await onMessage(state.assistantMessage);
							}
							state.assistantMessage.content += event.delta || '';
							state.assistantMessage.text = state.assistantMessage.content;
							sendUpdate(state.assistantMessage);
						}
					});
					resolve();
				});

				client.on('timeout', () => {
					client.destroy();
					reject(new Error('Request timed out'));
				});
				client.on('error', reject);
				client.end(JSON.stringify(payload));
			});

			const freshToolMessages = state.messages.slice(startCount).filter(message => message.type === 'tool_call');
			if (!freshToolMessages.length) break;

			const outputs = [];
			for (const message of freshToolMessages) {
				const handler = toolHandlers[message.name];
				if (!handler) throw new Error(`No tool handler registered for "${message.name}"`);
				message.status = 'running';
				sendUpdate(message);
				try {
					const output = await handler(message.input || {});
					message.output = output;
					message.result = output;
					message.status = 'completed';
					sendUpdate(message);
					outputs.push({
						'type': 'function_call_output',
						'call_id': message._id,
						'output': typeof output === 'string' ? output : JSON.stringify(output),
					});
				} catch (err) {
					message.error = err.message;
					message.status = 'failed';
					sendUpdate(message);
					throw err;
				}
			}
			input = outputs;
		}

		if (state.assistantMessage) state.assistantMessage.status = 'completed';
		if (state.assistantMessage) sendUpdate(state.assistantMessage);
		while (latestUpdate || isUpdating) await chain;
		const content = json
			? parseJson(state.assistantMessage?.content || '')
			: xml
				? parseXml(state.assistantMessage?.content || '', xml)
				: (state.assistantMessage?.content || '');
		if (state.assistantMessage) {
			state.assistantMessage.content = content;
			state.assistantMessage.text = content;
		}

		return {
			'content': content,
			'lastMessageId': state.lastMessageId,
			'messages': state.messages,
		};
	};
}

export { OpenAI };
