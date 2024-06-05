**Get better results from your LLM's!** Connect to and stream from any OpenAI/Anthropic API. Lightweight, high
performance,
and simple, thoughtful API made for
developers, encouraging use of CoT. Tested on OpenAI, Ollama, and Claude.

```bash
npm install poon-llm
```

### OpenAI Example

``` javascript
import { OpenAI } from 'poon-llm';

const llm = new OpenAI({'secretKey': 'key', 'model': 'gpt-4o'});
const response = await llm.chat('Why is the sky blue?');
```

### Ollama Example

``` javascript
const llm = new OpenAI({'apiBase': 'http://10.0.0.20', 'model': 'llama3'});
const response = await llm.chat('Why is the sky blue?');
```

### Anthropic Example

``` javascript
import { Anthropic } from 'poon-llm';

const llm = new Anthropic({
    'secretKey': 'key',
    'model': 'claude-3-opus-20240229',
    'headers': {'Anthropic-Version': '2023-06-01'},
});
const response = await llm.chat('Why is the sky blue?');
```

# Streaming

Streaming events occur at a fast rate, so to avoid crashing your
server, `poon-llm` employs an efficient method to combat this: While an async onUpdate is executing, any chunks that
come in will be ignored so that onUpdate will only be called as fast as your code can handle it. For example, if you are
on a
shared database that takes 1 second to write, your callbacks will fire back to back, after each write, and then
once more at the very end.

``` javascript
const response = await llm.chat('Why is the sky blue?', {
    'onUpdate': text => Drafts.updateAsync({'_id': id}, {
        $set: {'body': text}
    }),
});
```

# API Documentation

## New Client - Options

Apples to `new OpenAI(options)`, `new Anthropic(options)`

| Name           | Description                                                        |
|----------------|--------------------------------------------------------------------|
| `secretKey`    | Secret API key (Required for most API's)                           |
| `apiBase`      | Specifies new base URL. Overrides the built-in defaults (Optional) |
| `systemPrompt` | Prompt to use for all chats                                        |
| `headers`      | Object containing headers to send (Required for Anthropic)         |

## Chat Options

Applies to individual chat calls - `llm.chat(message, options)`.

| Option        | Description                                                                                                                                                                                                                                                   |
|---------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `json`        | Enable JSON output: Requests underlying LLM API to respond in JSON, also JSON-parses and returns response. _You must request the reply to be in JSON form in the system prompt. An error message will appear if the word JSON is not detected in the prompt._ |
| `xml`         | Array containing XML tags to parse. Causes the output to be an object with the keys specified by the array.                                                                                                                                                   |
| `onUpdate`    | Callback function that is called every time the model has more chunks to append to the response.                                                                                                                                                              |
| `context`     | Chat history for the conversation, must be an array of objects like `{'role': String ('user' or 'assistant'), 'content': String}`.                                                                                                                            |
| `temperature` | Float value controlling randomness in boltzmann sampling. Lower is less random, higher is more random.                                                                                                                                                        |
| `maxTokens`   | Integer value controlling the maximum number of tokens generated.                                                                                                                                                                                             |
| `prefill`     | String to prefill the LLM's response with. Useful for CoT.                                                                                                                                                                                                    |

# Chain of Thought Example

Although JSON option is available, XML is generally better for prompts with Chain of Thought,
because the LLM has an easier time formatting it, as it just needs to understand delimiters, rather than
strict adherence to a certain syntax. XML is also easier to stream.

``` javascript
const response = await llm.chat(chatString, {
    'prefill': '<scratchpad>',
    'maxTokens': 2048,
    'xml': true,
});
```