Opinionated OpenAI Responses API client with streaming, server-managed history,
message/update events, and automatic tool execution.

```bash
npm install poon-llm
```

```javascript
import { OpenAI } from 'poon-llm';

const llm = new OpenAI({
  'secretKey': process.env.OPENAI_API_KEY,
  'model': 'gpt-5.4',
});

llm.on('message', message => {
  console.log('message', message);
});

llm.on('update', message => {
  console.log('update', message);
});

const response = await llm.chat('Why is the sky blue?', {
  'systemPrompt': 'Be concise.',
});

console.log(response.content);
console.log(response.lastMessageId);
```

Continue a conversation by passing `lastMessageId`:

```javascript
const first = await llm.chat('Hello');
const second = await llm.chat('Continue', {
  'lastMessageId': first.lastMessageId,
});
```

Automatic tools:

```javascript
const response = await llm.chat('What is the weather in Boston?', {
  'tools': {
    'get_weather': {
      'description': 'Look up the weather for a city',
      'parameters': {
        'type': 'object',
        'properties': {
          'city': {'type': 'string'},
        },
        'required': ['city'],
      },
      'run': async ({city}) => ({'forecast': `Sunny in ${city}`}),
    },
  },
});
```

# API

## Client options

| Name | Description |
|------|-------------|
| `secretKey` | OpenAI API key |
| `apiBase` | Override the default API base URL |
| `headers` | Extra headers to send |

## `llm.chat(prompt, options)`

| Option | Description |
|--------|-------------|
| `systemPrompt` | Instructions sent for this chat call |
| `json` | Request JSON output and parse the final `response.content` as JSON |
| `xml` | Parse the final `response.content` by extracting the listed XML tags |
| `lastMessageId` | Continue a server-managed conversation |
| `temperature` | Sampling temperature |
| `topP` | Nucleus sampling parameter |
| `maxTokens` | Maximum output tokens |
| `timeout` | Request timeout in milliseconds |
| `tools` | Object map of tool definitions and handlers |
| `onMessage` | Optional per-call listener for `message` events |
| `onUpdate` | Optional per-call listener for `update` events |

`llm.chat()` returns:

```javascript
{
  'content': String | Object,
  'lastMessageId': String | null,
  'messages': Array<Message>,
}
```
