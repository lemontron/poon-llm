import http from 'node:http';
import https from 'node:https';
import readline from 'node:readline';

const parseLine = (buf) => {
	try {
		const data = JSON.parse(buf.toString().slice(6));
		if (data && data.delta && data.delta.text) return data.delta.text;
		return data.choices[0].delta.content;
	} catch (err) {
		return '';
	}
};

const consumeStreamAsync = (stream, onLine) => new Promise(resolve => {
	const rl = readline.createInterface({'input': stream});
	rl.on('line', buf => {
		const delta = parseLine(buf);
		if (delta) onLine(delta);
	});
	rl.once('close', resolve);
});

// Use the correct request method based on the URL protocol
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
		if (this.protocol === 'openai') messages.push({'role': 'system', 'content': this.systemPrompt});

		context.sort((a, b) => {
			return (a.addedOn - b.addedOn);
		}).forEach(doc => {
			messages.push({
				'role': doc.isBot ? 'assistant' : 'user',
				'content': doc.message,
			});
		});

		messages.push({'role': 'user', 'content': prompt});
		if (prefill) messages.push({'role': 'assistant', 'content': prefill});
		return messages;
	};

	chat = (prompt, {
		json,
		context = [],
		maxTokens,
		temperature = 0.7,
		onUpdate,
		prefill = '',
	} = {}) => new Promise((resolve, reject) => {

		const finalResponse = async (response) => {
			if (onUpdate) await onUpdate(response);
			if (json) {
				try {
					resolve(JSON.parse(response));
				} catch (err) {
					console.warn('Failed to parse response:', response);
					reject(new Error('Failed to parse response'));
				}
			} else {
				resolve(response);
			}
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
			});
		};

		const client = request(this._getChatUrl(), {
			'method': 'POST',
			'headers': this.headers,
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
					await onUpdate(msg);
					setTimeout(() => isUpdating = false, 150);
				});
			}).then(() => {
				chain.then(() => {
					finalResponse(msg);
				});
			});
		});

		client.on('error', reject); // Handle errors
		client.end(JSON.stringify(payload));
	});
}

export default LLM;