import http from 'node:http';
import https from 'node:https';
import readline from 'node:readline';

// First parser, tries to parse JSON
export const parseJson = (msg) => {
	try {
		return JSON.parse(msg);
	} catch (err) {
		throw new Error('Failed to parse response');
	}
};

const extractTags = (text) => {
	let matches;
	const regex = /<(\w+)>([\s\S]*?)(?:<\/\1>|$)/g;
	const res = {};

	while ((matches = regex.exec(text)) !== null) {
		const key = matches[1].toLowerCase();
		const val = matches[2].trim();

		if (typeof res[key] === 'string') { // promote to array
			res[key] = [res[key], val];
		} else if (Array.isArray(res[key])) { // append to existing array
			res[key].push(val);
		} else { // first time we see this key
			res[key] = val;
		}
	}

	return res;
};

// Better parser, tries to parse XML using array of known tags
export const parseXml = (msg, xmlTags) => {
	try {
		const data = extractTags(msg);
		return xmlTags.reduce((res, tag) => {
			tag = tag.toLowerCase();
			if (data[tag]) res[tag] = data[tag];
			return res;
		}, {});
	} catch (err) {
		console.warn(msg);
		throw err;
	}
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

export const prettyResponse = (data) => {
	try {
		return JSON.parse(data);
	} catch (err) {
		return data;
	}
};