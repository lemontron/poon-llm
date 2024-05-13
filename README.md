Connect to and stream from any OpenAI/Anthropic API. Lightweight, high performance, and simple, thoughtful API made for
developers. Tested on OpenAI, Ollama, and Claude.

```bash
npm install poon-llm
```

### OpenAI Example

``` javascript
const llm = new LLM({
    'apiBase': 'https://api.openai.com',
    'secretKey': 'key',
    'model': 'gpt-4-turbo',
    'systemPrompt': 'You are a helpful assistant.',
});

const response = await llm.chat('Why is the sky blue?');

```

### Anthropic Example

``` javascript
const llm = new LLM({
    'protocol': 'anthropic',
    'apiBase': 'https://api.anthropic.com/v1/messages',
    'secretKey': 'key',
    'headers': {'Anthropic-Version': '2023-06-01'},
    'model': 'claude-3-opus-20240229',
    'systemPrompt': 'You are a helpful assistant.',
});

const response = await llm.chat('Why is the sky blue?');
```

# Streaming

Streaming events occur at a fast rate, so to avoid crashing your
server, `poon-llm` employs an efficient method to combat this: While an async onUpdate is executing, any chunks that come in will be ignored so that onUpdate will only be called as fast as your code can handle it. For example, if you are on a
shared database that takes 1 second to write, your callbacks will fire back to back, after each write, and then
once more at the very end.

``` javascript
const response = await llm.chat('Why is the sky blue?', {
    'onUpdate': text => Drafts.updateAsync({'_id': id}, {
        $set: {'body': text}
    }),
});
```

# Chat: Other Options

| Option        | Description                                                                                                                                                                                                                                                   |
|---------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `json`        | Enable JSON output: Requests underlying LLM API to respond in JSON, also JSON-parses and returns response. _You must request the reply to be in JSON form in the system prompt. An error message will appear if the word JSON is not detected in the prompt._ |
| `onUpdate`    | Callback function that is called every time the model has more chunks to append to the response.                                                                                                                                                              |
| `context`     | Chat history for the conversation, must be an array of objects like `{'role': String ('user' or 'assistant'), 'content': String}`.                                                                                                                            |
| `temperature` | Float value controlling randomness in boltzmann sampling. Lower is less random, higher is more random.                                                                                                                                                        |
| `maxTokens`   | Integer value controlling the maximum number of tokens generated.                                                                                                                                                                                             |