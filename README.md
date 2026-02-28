# Claude Code Proxy

An OpenAI-compatible HTTP server that routes all requests through the **Claude
Code CLI** (`claude`) – with full conversation history via `--input-format
stream-json`, session management, and SSE streaming.

## Prerequisites

- Node.js ≥ 18
- [Claude Code](https://code.claude.com) installed and authenticated

  ```bash
  npm install -g @anthropic-ai/claude-code
  claude auth login
  ```

At startup the proxy automatically checks both conditions and prints a
remediation hint if either one fails.

## Installation & Start

```bash
npm install

# Development (hot-reload)
npm run dev

# Production
npm run build && npm start

# Custom port (argument takes precedence over env var)
npm run dev -- --port 8080
PORT=8080 npm run dev
```

## Command-Line Options

```
Usage: claude-code-proxy [--port <n>] [--help]

Options:
  --port <n>   port to listen on (overrides $PORT env var, default: 3000)
  --help       show this help

Endpoints:
  POST /v1/chat/completions   chat completion (streaming, session_id)
  POST /v1/completions        text completion (streaming)
  GET  /v1/models             list available models
  GET  /health                health check → {"status":"ok"}
```

**Port resolution order:** `--port` argument → `$PORT` environment variable →
default `3000`.

## Endpoints

### `POST /v1/chat/completions`

Full chat conversation. The entire `messages[]` history is passed as NDJSON to
the Claude Code CLI.

#### Request Body

| Parameter    | Type               | Required | Supported    | Description |
|--------------|--------------------|----------|--------------|-------------|
| `messages`   | `Message[]`        | ✅ yes   | ✅ full      | Conversation history (all roles, any length). System messages are passed as `--system-prompt`; user and assistant turns are sent as NDJSON via stdin. |
| `stream`     | `boolean`          | –        | ✅ full      | If `true`: Server-Sent Events (SSE) in OpenAI chunk format (`data: {...}\n\n`, terminated with `data: [DONE]\n\n`). |
| `model`      | `string`           | –        | ⚠️ mirrored | Reflected in the response but not forwarded to the CLI. Claude Code uses the model configured in `~/.claude/settings.json`. |
| `session_id` | `string` (UUID)    | –        | ✅ full      | **Non-standard.** Continues a conversation at CLI level (`--session-id`). If omitted, a new UUID is generated. The UUID used is always returned as `_session_id` in the response. |
| `max_tokens` | `number`           | –        | ❌ ignored   | The Claude Code CLI offers no corresponding flag. Accepted but ignored. |
| `temperature`| `number`           | –        | ❌ ignored   | The Claude Code CLI offers no corresponding flag. Accepted but ignored. |

#### `Message` Object

| Field     | Type                       | Required | Description |
|-----------|----------------------------|----------|-------------|
| `role`    | `string`                   | ✅ yes   | `"system"`, `"user"`, or `"assistant"` |
| `content` | `string` or `Block[]`      | ✅ yes   | Plain text string **or** array of content blocks (see below). |

#### Content Blocks in `content`

`content` can be either a plain string or an array of the following block types:

**Text block** (always supported)
```jsonc
{ "type": "text", "text": "Your question here" }
```

**Image block** (base64-encoded, ⚠️ experimental — see note below)
```jsonc
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/png",   // image/jpeg | image/png | image/gif | image/webp
    "data": "<base64-string>"
  }
}
```

**Document block** (PDF, base64-encoded, ⚠️ experimental — see note below)
```jsonc
{
  "type": "document",
  "source": {
    "type": "base64",
    "media_type": "application/pdf",
    "data": "<base64-string>"
  },
  "title": "Optional title"   // optional
}
```

> ⚠️ **Note on image and document blocks:** The proxy forwards these blocks in
> the correct NDJSON format to the Claude Code CLI. Whether the CLI actually
> passes multimodal content through to the Anthropic API is **not officially
> documented** and may vary by CLI version. Plain text blocks work reliably.
> Images and PDFs should be tested — alternatively, file content can be
> embedded as text in the prompt (e.g. a base64 string with an interpretation
> instruction).

**Example: Mixed message with text and image**
```jsonc
{
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What does this diagram show?" },
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": "iVBORw0KGgoAAAANSUhEUgAA..."
          }
        }
      ]
    }
  ]
}
```

#### Response Body (non-streaming)

```jsonc
{
  "id": "chatcmpl-1234567890",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "claude-code-proxy",        // mirrored input value
  "_session_id": "550e8400-...",       // non-standard: use for follow-up requests
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "..." },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": -1,               // not available (CLI provides no token counts)
    "completion_tokens": -1,
    "total_tokens": -1
  }
}
```

#### Response Body (streaming, `stream: true`)

Each chunk is an SSE event:
```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1700000000,"model":"claude-code-proxy","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: [DONE]
```

### `POST /v1/completions`

Simple text completion. The `prompt` string is treated as a single user message.

#### Request Body

| Parameter    | Type     | Required | Supported    | Description |
|--------------|----------|----------|--------------|-------------|
| `prompt`     | `string` | ✅ yes   | ✅ full      | Input text. Passed to the CLI as a `user` message. |
| `stream`     | `boolean`| –        | ✅ full      | Same as `/v1/chat/completions`. |
| `model`      | `string` | –        | ⚠️ mirrored | Reflected but not forwarded. |
| `max_tokens` | `number` | –        | ❌ ignored   | Ignored. |
| `temperature`| `number` | –        | ❌ ignored   | Ignored. |

> No session management: `/v1/completions` always starts a new session.

#### Response Body (non-streaming)

```jsonc
{
  "id": "cmpl-1234567890",
  "object": "text_completion",
  "created": 1700000000,
  "model": "claude-code-proxy",
  "choices": [{
    "text": "...",
    "index": 0,
    "logprobs": null,
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": -1, "completion_tokens": -1, "total_tokens": -1 }
}
```

### `GET /v1/models`

Returns the list of available (proxy) models.

```jsonc
{
  "object": "list",
  "data": [{
    "id": "claude-code-proxy",
    "object": "model",
    "created": 1700000000,
    "owned_by": "anthropic"
  }]
}
```

### `GET /health`

Health check. Returns `{"status":"ok"}` with HTTP 200.

## How It Works

```
Client (OpenAI format)
       │
       ▼
  HTTP Server (Node.js)
       │
       ├─ system message  ──────►  --system-prompt "..."
       │
       ├─ messages[]  ──────────►  NDJSON via stdin:
       │                           {"type":"user","message":{"role":"user","content":[...]}}
       │                           {"type":"assistant","message":{"role":"assistant","content":[...]}}
       │                           ...
       │
       ├─ session_id  ──────────►  --session-id <uuid>
       │
       └─► claude --print
               --input-format stream-json
               --output-format stream-json
               --session-id <uuid>
               [--system-prompt "..."]
               [--include-partial-messages]   ← only when stream: true
                       │
                       ▼
           parse stream-json output → extract text
                       │
                       ▼
           OpenAI response format → client
```

## Session Management

Every response from `/v1/chat/completions` includes the non-standard field
`_session_id`. This UUID can be sent back in the next request as `session_id`
to continue the conversation at CLI level:

```jsonc
// Second turn: include session_id from the previous response
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "messages": [
    { "role": "user",      "content": "Hello!" },
    { "role": "assistant", "content": "Hello! How can I help?" },
    { "role": "user",      "content": "Explain quantum computing." }
  ]
}
```

> **Note:** Because OpenAI-compatible clients typically send the full
> `messages[]` history anyway, the proxy works correctly **without** `session_id`
> too — the entire history is passed as NDJSON.

## Examples

### Multi-turn Chat (curl)

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "role": "system",    "content": "You are a helpful assistant." },
      { "role": "user",      "content": "What is the capital of France?" },
      { "role": "assistant", "content": "The capital of France is Paris." },
      { "role": "user",      "content": "How many people live there?" }
    ]
  }'
```

### Streaming (curl)

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{ "stream": true, "messages": [{ "role": "user", "content": "Explain quantum computing." }] }'
```

### With OpenAI SDK (TypeScript)

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "dummy",                       // ignored by the proxy
  baseURL: "http://localhost:3000/v1",
});

// First turn
const r1 = await client.chat.completions.create({
  model: "claude-code-proxy",
  messages: [{ role: "user", content: "Hello!" }],
});
const sessionId     = (r1 as any)._session_id;
const assistantReply = r1.choices[0].message.content ?? "";

// Follow-up turn – send full history + session_id
const r2 = await (client.chat.completions as any).create({
  model: "claude-code-proxy",
  session_id: sessionId,
  messages: [
    { role: "user",      content: "Hello!" },
    { role: "assistant", content: assistantReply },
    { role: "user",      content: "How are you?" },
  ],
});
console.log(r2.choices[0].message.content);
```

## Parameter Support Overview

| Parameter      | `/v1/chat/completions` | `/v1/completions` |
|----------------|------------------------|-------------------|
| `messages`     | ✅ full                 | –                 |
| `messages[].content` as string | ✅ | –             |
| `messages[].content` as block array (text) | ✅ | – |
| `messages[].content` as block array (image/PDF) | ⚠️ experimental | – |
| `prompt`       | –                      | ✅ full            |
| `stream`       | ✅ full (SSE)           | ✅ full (SSE)      |
| `model`        | ⚠️ mirrored, CLI ignores it | ⚠️ mirrored   |
| `session_id`   | ✅ non-standard         | ❌ not available   |
| `max_tokens`   | ❌ ignored              | ❌ ignored         |
| `temperature`  | ❌ ignored              | ❌ ignored         |
| `n`            | ❌ not supported        | ❌ not supported   |
| `logprobs`     | ❌ not supported        | ❌ not supported   |
| `functions` / `tools` | ❌ not supported | ❌ not supported  |
| Token counts in `usage` | ❌ always `-1` | ❌ always `-1`  |

## License ##

[MIT License](LICENSE.md)
