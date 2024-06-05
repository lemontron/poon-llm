import http from 'node:http';
import https from 'node:https';
import readline from 'node:readline';
import { parseFromString } from '/node_modules/dom-parser/dist/index.js';

// First parser, tries to parse JSON
export const parseJson = (msg) => {
	try {
		return JSON.parse(msg);
	} catch (err) {
		throw new Error('Failed to parse response');
	}
};

// Better parser, tries to parse XML using array of known tags
export const parseXml = (msg, xmlTags) => {
	const dom = parseFromString(msg);
	return xmlTags.reduce((res, tag) => {
		const node = dom.getElementsByTagName(tag)[0];
		if (node) res[tag] = node.textContent.trim();
		return res;
	}, {});
};

// Chooses method based on the protocol
export const request = (url, ...rest) => {
	if (url.protocol === 'http:') return http.request(url, ...rest);
	if (url.protocol === 'https:') return https.request(url, ...rest);
};

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

// Cleans the stream and emits only events parseable by parseLine and
// resolves once the whole stream ends
export const consumeStreamAsync = (stream, onLine) => new Promise(resolve => {
	const rl = readline.createInterface({'input': stream});
	rl.on('line', buf => {
		const delta = parseDelta(buf);
		if (delta) onLine(delta);
	});
	rl.once('close', resolve);
});