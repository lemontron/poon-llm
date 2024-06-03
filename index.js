import http from 'node:http';
import https from 'node:https';
import readline from 'node:readline';
import { parseFromString } from '/node_modules/dom-parser/dist/index.js';

// Parses any single line and returns a message delta if present
const parseDelta = (buf) => {
	try {
		const data = JSON.parse(buf.toString().slice(6));
		if (data && data.delta && data.delta.text) return data.delta.text; // Anthropic
		return data.choices[0].delta.content; // OpenAI
	} catch (err) {
		return '';
	}
};

const parseJson = (msg) => {
	try {
		return JSON.parse(msg);
	} catch (err) {
		throw new Error('Failed to parse response');
	}
};

const parseXml = (msg, xml) => {
	const dom = parseFromString(msg);
	return xml.reduce((res, tag) => {
		const node = dom.getElementsByTagName(tag)[0];
		if (node) res[tag] = node.textContent;
		return res;
	}, {});
};

// Cleans the stream and emits only events parseable by parseLine and
// resolves once the whole stream ends
const consumeStreamAsync = (stream, onLine) => new Promise(resolve => {
	const rl = readline.createInterface({'input': stream});
	rl.on('line', buf => {
		const delta = parseDelta(buf);
		if (delta) onLine(delta);
	});
	rl.once('close', resolve);
});

// Chooses method based on the protocol
const request = (url, ...rest) => {
	if (url.protocol === 'http:') return http.request(url, ...rest);
	if (url.protocol === 'https:') return https.request(url, ...rest);
};

class LLM {
	constructor({
		protocol = 'openai',
		model,
		apiBase,
		secretKey,
		systemPrompt,
		headers = {},
	}) {
		if (protocol !== 'openai' && protocol !== 'anthropic') throw new Error('Invalid protocol');

		this.protocol = protocol;
		this.model = model;
		this.apiBase = apiBase;
		this.secretKey = secretKey;
		this.systemPrompt = systemPrompt;

		// Create headers for future requests
		this.headers = {'Content-Type': 'application/json', ...headers};
		if (this.protocol === 'anthropic') {
			this.headers['X-Api-Key'] = this.secretKey;
		} else if (this.protocol === 'openai') {
			if (this.secretKey) this.headers['Authorization'] = `Bearer ${this.secretKey}`;
		}
	}

	_getChatUrl = () => {
		if (this.protocol === 'openai') return new URL('/v1/chat/completions', this.apiBase);
		if (this.protocol === 'anthropic') return new URL('/v1/messages', this.apiBase);
	};

	_createMessages = (prompt, context = [], prefill) => {
		const messages = [];

		if (this.protocol === 'openai' && this.systemPrompt) {
			messages.push({'role': 'system', 'content': this.systemPrompt});
		}

		context.sort((a, b) => {
			return (a.addedOn - b.addedOn);
		}).forEach(doc => {
			messages.push({
				'role': doc.isBot ? 'assistant' : 'user',
				'content': doc.message,
			});
		});

		if (prompt) messages.push({'role': 'user', 'content': prompt});
		if (prefill) messages.push({'role': 'assistant', 'content': prefill});
		return messages;
	};

	chat = (prompt, {
		json,
		xml,
		context = [],
		maxTokens,
		temperature = 0.7,
		onUpdate,
		prefill = '',
		timeout = 30000,
	} = {}) => {
		if (typeof prompt !== 'string') throw new Error('prompt must be a string');
		if (typeof prefill !== 'string') throw new Error('prefill must be a string');
		if (typeof timeout !== 'number') throw new Error('timeout must be a number');
		if (xml && !Array.isArray(xml)) throw new Error('xml must be an array of strings');

		const parseResponse = (msg) => {
			if (json) return parseJson(msg);
			if (xml) return parseXml(msg, xml);
			return msg;
		};

		return new Promise((resolve, reject) => {
			const finalResponse = async (res) => {
				res = parseResponse(res);
				if (onUpdate) await onUpdate(res); // Send one last update before resolving
				resolve(res);
			};

			// Create request body
			const payload = {
				'model': this.model,
				'temperature': temperature,
				'stream': true,
				'messages': this._createMessages(prompt, context, prefill),
			};
			if (maxTokens) payload.max_tokens = maxTokens;
			if (json) payload.response_format = {'type': 'json_object'};
			if (this.protocol === 'anthropic') {
				if (this.systemPrompt) payload.system = this.systemPrompt;
			}

			// Logs the error message in JSON or plain text as a fallback
			const handleError = (res) => {
				let body = '';
				res.on('data', buf => body += buf.toString());
				res.on('end', () => {
					try {
						const data = JSON.parse(body);
						console.warn('[LLM Error]', res.statusCode, data);
					} catch (err) {
						console.warn('[LLM Error]', res.statusCode, body);
					}
					console.warn('payload=', payload);
				});
			};

			// Fire off the request
			const client = request(this._getChatUrl(), {
				'method': 'POST',
				'headers': this.headers,
				'timeout': timeout,
			}, res => {
				if (res.statusCode >= 400) return handleError(res);

				let msg = prefill, isUpdating = false, chain = Promise.resolve();

				let count = 0;
				consumeStreamAsync(res, delta => {
					msg += delta;
					if (onUpdate && !isUpdating) chain = chain.then(async () => {
						count++;
						// console.log('updates=', count);
						isUpdating = true;

						await onUpdate(parseResponse(msg));
						setTimeout(() => isUpdating = false, 150);
					});
				}).then(() => {
					chain.then(() => {
						finalResponse(msg);
					});
				});
			});

			client.on('timeout', () => {
				console.log('Request timed out');
				client.destroy();
				reject(new Error('Request timed out'));
			});

			client.on('error', reject); // Handle errors
			client.end(JSON.stringify(payload));
		});
	};
}

export default LLM;