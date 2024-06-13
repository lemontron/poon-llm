import { request, consumeStreamAsync, parseJson, parseXml } from './util.js';

export default class LLM {
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
		messages.push(...context); // Add context messages
		if (prompt) messages.push({'role': 'user', 'content': prompt});
		if (prefill) messages.push({'role': 'assistant', 'content': prefill}); // I think this only works for Anthropic
		return messages;
	};

	chat = (prompt, {
		data,
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
		if (xml && json) throw new Error('choose either xml or json, not both');
		if (data) prompt = applyTemplate(prompt, data);

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

		const parseResponse = (msg) => {
			if (json) return parseJson(msg);
			if (xml) return parseXml(msg, xml);
			return msg;
		};

		return new Promise((resolve, reject) => {
			const finalResponse = async (res) => {
				res = parseResponse(res);
				if (onUpdate) await onUpdate(res, null); // Send one last update before resolving
				resolve(res);
			};

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
					console.warn('[ORIGINAL PARAMS]', payload);
				});
			};

			// Fire off the request
			const client = request(this._getChatUrl(), {
				'method': 'POST',
				'headers': this.headers,
				'timeout': timeout,
			}, async (res) => {
				if (res.statusCode >= 400) return handleError(res);

				let msg = prefill, isUpdating = false, chain = Promise.resolve();

				let count = 0;
				await consumeStreamAsync(res, delta => {
					msg += delta;
					if (onUpdate && !isUpdating) chain = chain.then(async () => {
						count++;
						isUpdating = true;
						await onUpdate(parseResponse(msg), count);
						setTimeout(() => isUpdating = false, 150);
					});
				});
				await chain;
				await finalResponse(msg);
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

export class OpenAI extends LLM {
	constructor(opts) {
		super({
			'protocol': 'openai',
			'apiBase': 'https://api.openai.com',
			...opts,
		});
	}
}

export class Anthropic extends LLM {
	constructor(opts) {
		super({
			'protocol': 'anthropic',
			'apiBase': 'https://api.anthropic.com/v1/messages',
			...opts,
		});
	}
}

export const applyTemplate = (template, data) => {
	Object.keys(data).forEach(key => {
		template = template.replace(new RegExp(`{{${key}}}`, 'g'), data[key]);
	});
	if (template.includes('{{')) throw new Error('Missing data for template');
	return template;
};