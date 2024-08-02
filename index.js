import { request, consumeStreamAsync, parseJson, parseXml, prettyResponse } from './util.js';
import Mustache from 'mustache';

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

	_createMessages = (prompt, image, context = [], prefill) => {
		const messages = [];
		if (this.protocol === 'openai' && this.systemPrompt) {
			messages.push({'role': 'system', 'content': this.systemPrompt});
		}
		messages.push(...context); // Add context messages

		// This is the user's content
		if (image) {
			messages.push({
				'role': 'user',
				'content': [
					{'type': 'text', 'text': prompt},
					{'type': 'image_url', 'image_url': {'url': image}},
				],
			});
		} else {
			messages.push({'role': 'user', 'content': prompt});
		}

		if (prefill) messages.push({'role': 'assistant', 'content': prefill}); // I think this only works for Anthropic
		return messages;
	};

	template = async (opts) => {
		if (typeof opts.template !== 'string') throw new Error('Template must be a string');
		if (typeof opts.data !== 'object') throw new Error('Data must be an object');
		const prompt = Mustache.render(opts.template, opts.data);
		return this.chat(prompt, opts);
	};

	chat = (prompt, {
		image,
		json,
		xml,
		context = [],
		maxTokens,
		temperature = 0.7,
		onUpdate,
		prefill = '',
		timeout = 30000,
		debug = false,
	} = {}) => {
		if (typeof prompt !== 'string') throw new Error('Prompt must be a string');
		if (typeof prefill !== 'string') throw new Error('Prefill must be a string');
		if (typeof timeout !== 'number') throw new Error('Timeout must be a number');
		if (xml && !Array.isArray(xml)) throw new Error('XML must be an array of strings');
		if (xml && json) throw new Error('Choose either XML or JSON, not both');

		const payload = {
			'model': this.model,
			'temperature': temperature,
			'stream': true,
			'messages': this._createMessages(prompt, image, context, prefill),
		};
		if (debug) {
			console.log('[LLM Messages]');
			payload.messages.forEach(msg => console.log('==>', msg.role, msg.content));
		}
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
					const error = prettyResponse(body);
					console.warn('[LLM]', 'StatusCode=', res.statusCode, 'Body=', error);
					console.warn('Payload=', payload);
					reject(new Error(`LLM failed, ${res.statusCode}, ${JSON.stringify(error)}`));
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
					if (debug) console.log('Delta=', count);
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


