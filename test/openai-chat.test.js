import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenAI } from '../index.js';

const createSseResponse = (res, events) => {
	res.writeHead(200, {'Content-Type': 'text/event-stream'});
	for (const event of events) {
		res.write(`data: ${JSON.stringify(event)}\n\n`);
	}
	res.end();
};

test('OpenAI chat uses previous_response_id and emits message/update events', async () => {
	const requests = [];
	const seen = [];
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', chunk => body += chunk);
			req.on('end', () => {
				requests.push({
					'url': req.url,
					'payload': JSON.parse(body),
				});
				createSseResponse(res, [
					{'type': 'response.created', 'id': `resp_${requests.length}`},
					{'type': 'response.output_item.added', 'item': {'type': 'message', 'id': `msg_${requests.length}`, 'role': 'assistant'}},
					{'type': 'response.output_text.delta', 'item_id': `msg_${requests.length}`, 'delta': `reply-${requests.length}`},
					{'type': 'response.completed', 'id': `resp_${requests.length}`},
				]);
			});
	});
	await new Promise(resolve => server.listen(0, resolve));
	const address = server.address();
	const llm = new OpenAI({
		'apiBase': `http://127.0.0.1:${address.port}`,
		'model': 'gpt-5',
		'secretKey': 'test-key',
	});
	llm.on('message', message => seen.push({'event': 'message', 'message': message}));
	llm.on('update', message => seen.push({'event': 'update', 'message': message}));

	try {
		const first = await llm.chat('hello', {'systemPrompt': 'You are concise.'});
		assert.equal(first.content, 'reply-1');
		assert.equal(first.lastMessageId, 'resp_1');
		assert.equal(first.messages[0].type, 'message');

		const second = await llm.chat('follow up', {
			'lastMessageId': first.lastMessageId,
			'systemPrompt': 'You are concise.',
		});
		assert.equal(second.content, 'reply-2');
		assert.equal(second.lastMessageId, 'resp_2');

		assert.equal(requests[0].url, '/v1/responses');
		assert.deepEqual(requests[0].payload, {
			'model': 'gpt-5',
			'stream': true,
			'input': 'hello',
			'instructions': 'You are concise.',
		});
		assert.equal(requests[1].payload.previous_response_id, 'resp_1');
		assert.equal(requests[1].payload.input, 'follow up');
		assert.ok(!('messages' in requests[1].payload));

		assert.equal(seen[0].event, 'message');
		assert.equal(seen[0].message.type, 'message');
		assert.equal(seen[1].event, 'update');
		assert.equal(seen[1].message.content, 'reply-1');
	} finally {
		server.close();
	}
});

test('OpenAI chat forwards topP as top_p', async () => {
	const requests = [];
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', chunk => body += chunk);
		req.on('end', () => {
			requests.push(JSON.parse(body));
			createSseResponse(res, [
				{'type': 'response.created', 'id': 'resp_1'},
				{'type': 'response.output_item.added', 'item': {'type': 'message', 'id': 'msg_1', 'role': 'assistant'}},
				{'type': 'response.output_text.delta', 'item_id': 'msg_1', 'delta': 'ok'},
				{'type': 'response.completed', 'id': 'resp_1'},
			]);
		});
	});
	await new Promise(resolve => server.listen(0, resolve));
	const address = server.address();
	const llm = new OpenAI({
		'apiBase': `http://127.0.0.1:${address.port}`,
		'model': 'gpt-5',
		'secretKey': 'test-key',
	});

	try {
		await llm.chat('hello', {'topP': 0.25});
		assert.equal(requests.length, 1);
		assert.equal(requests[0].top_p, 0.25);
	} finally {
		server.close();
	}
});

test('OpenAI chat runs tools automatically and treats tool calls as messages', async () => {
	const requests = [];
	const updates = [];
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', chunk => body += chunk);
		req.on('end', () => {
			const payload = JSON.parse(body);
			requests.push(payload);
			if (requests.length === 1) {
				createSseResponse(res, [
					{'type': 'response.created', 'id': 'resp_1'},
					{
						'type': 'response.output_item.added',
						'item': {'type': 'function_call', 'id': 'fc_1', 'call_id': 'call_1', 'name': 'get_weather', 'arguments': ''},
					},
					{'type': 'response.function_call_arguments.delta', 'item_id': 'call_1', 'delta': '{"city":"Boston"}'},
					{'type': 'response.function_call_arguments.done', 'item_id': 'call_1', 'arguments': '{"city":"Boston"}'},
					{'type': 'response.completed', 'id': 'resp_1'},
				]);
				return;
			}
			createSseResponse(res, [
				{'type': 'response.created', 'id': 'resp_2'},
				{'type': 'response.output_item.added', 'item': {'type': 'message', 'id': 'msg_2', 'role': 'assistant'}},
				{'type': 'response.output_text.delta', 'item_id': 'msg_2', 'delta': 'Sunny in Boston'},
				{'type': 'response.completed', 'id': 'resp_2'},
			]);
		});
	});
	await new Promise(resolve => server.listen(0, resolve));
	const address = server.address();
	const llm = new OpenAI({
		'apiBase': `http://127.0.0.1:${address.port}`,
		'model': 'gpt-5',
		'secretKey': 'test-key',
	});
	llm.on('update', message => updates.push({...message}));

	try {
		const result = await llm.chat('weather?', {
			'tools': {
				'get_weather': {
					'description': 'Look up the weather',
					'parameters': {
						'type': 'object',
						'properties': {'city': {'type': 'string'}},
						'required': ['city'],
					},
					'run': async ({city}) => ({'forecast': `Sunny in ${city}`}),
				},
			},
		});

		assert.equal(result.content, 'Sunny in Boston');
		assert.equal(result.lastMessageId, 'resp_2');
		assert.equal(result.messages[0].type, 'tool_call');
		assert.equal(result.messages[0].status, 'completed');
		assert.deepEqual(result.messages[0].input, {'city': 'Boston'});
		assert.deepEqual(result.messages[0].output, {'forecast': 'Sunny in Boston'});
		assert.equal(result.messages[1].type, 'message');

		assert.equal(requests[0].tools[0].name, 'get_weather');
		assert.equal(requests[1].previous_response_id, 'resp_1');
		assert.deepEqual(requests[1].input, [{
			'type': 'function_call_output',
			'call_id': 'call_1',
			'output': '{"forecast":"Sunny in Boston"}',
		}]);
		assert.ok(updates.some(message => message.type === 'tool_call' && message.status === 'running'));
		assert.ok(updates.some(message => message.type === 'tool_call' && message.status === 'completed'));
	} finally {
		server.close();
	}
});

test('OpenAI chat coalesces async onUpdate calls while streaming', async () => {
	const server = http.createServer((req, res) => {
		req.on('data', () => {});
		req.on('end', () => {
			createSseResponse(res, [
				{'type': 'response.created', 'response': {'id': 'resp_1'}},
				{'type': 'response.output_item.added', 'item': {'type': 'message', 'id': 'msg_1', 'role': 'assistant'}},
				{'type': 'response.output_text.delta', 'item_id': 'msg_1', 'delta': 'A'},
				{'type': 'response.output_text.delta', 'item_id': 'msg_1', 'delta': 'B'},
				{'type': 'response.output_text.delta', 'item_id': 'msg_1', 'delta': 'C'},
				{'type': 'response.completed', 'response': {'id': 'resp_1'}},
			]);
		});
	});
	await new Promise(resolve => server.listen(0, resolve));
	const address = server.address();
	const llm = new OpenAI({
		'apiBase': `http://127.0.0.1:${address.port}`,
		'model': 'gpt-5',
		'secretKey': 'test-key',
	});
	const updates = [];

	try {
		const result = await llm.chat('hello', {
			'onUpdate': async (message) => {
				updates.push({
					'content': message.content,
					'status': message.status,
					'lastMessageId': message.lastMessageId,
				});
				await new Promise(resolve => setTimeout(resolve, 25));
			},
		});

		assert.equal(result.content, 'ABC');
		assert.equal(result.lastMessageId, 'resp_1');
		assert.equal(updates.length, 2);
		assert.deepEqual(updates[0], {
			'content': 'A',
			'status': 'streaming',
			'lastMessageId': 'resp_1',
		});
		assert.deepEqual(updates[1], {
			'content': 'ABC',
			'status': 'completed',
			'lastMessageId': 'resp_1',
		});
	} finally {
		server.close();
	}
});

test('OpenAI chat delivers updates before the stream ends', async () => {
	let releaseStream;
	const streamReleased = new Promise(resolve => releaseStream = resolve);
	const server = http.createServer((req, res) => {
		req.on('data', () => {});
		req.on('end', async () => {
			res.writeHead(200, {'Content-Type': 'text/event-stream'});
			res.write(`data: ${JSON.stringify({'type': 'response.created', 'response': {'id': 'resp_1'}})}\n\n`);
			res.write(`data: ${JSON.stringify({'type': 'response.output_item.added', 'item': {'type': 'message', 'id': 'msg_1', 'role': 'assistant'}})}\n\n`);
			res.write(`data: ${JSON.stringify({'type': 'response.output_text.delta', 'item_id': 'msg_1', 'delta': 'Hello'})}\n\n`);
			await streamReleased;
			res.write(`data: ${JSON.stringify({'type': 'response.completed', 'response': {'id': 'resp_1'}})}\n\n`);
			res.end();
		});
	});
	await new Promise(resolve => server.listen(0, resolve));
	const address = server.address();
	const llm = new OpenAI({
		'apiBase': `http://127.0.0.1:${address.port}`,
		'model': 'gpt-5',
		'secretKey': 'test-key',
	});
	let resolved = false;
	let firstUpdate;
	let resolveUpdate;
	const firstUpdateSeen = new Promise(resolve => resolveUpdate = resolve);

	try {
		const chatPromise = llm.chat('hello', {
			'onUpdate': async (message) => {
				if (!firstUpdate) {
					firstUpdate = message;
					resolveUpdate();
				}
			},
		}).then(result => {
			resolved = true;
			return result;
		});

		await firstUpdateSeen;
		assert.equal(firstUpdate.content, 'Hello');
		assert.equal(firstUpdate.status, 'streaming');
		assert.equal(resolved, false);

		releaseStream();
		const result = await chatPromise;
		assert.equal(result.content, 'Hello');
		assert.equal(result.lastMessageId, 'resp_1');
	} finally {
		server.close();
	}
});
