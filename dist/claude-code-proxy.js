/*******************************************************************************
*                                                                              *
*                            Claude Code Proxy                                 *
*                                                                              *
*******************************************************************************/
"use strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
/**** argument parsing ****/
const CLIArgs = process.argv.slice(2);
if (CLIArgs.includes("--help")) {
    console.log(`
Usage: claude-code-proxy [--port <n>] [--help]

Options:
  --port <n>   port to listen on (overrides $PORT env var, default: 3000)
  --help       show this help

Endpoints:
  POST /v1/chat/completions   chat completion (streaming, session_id)
  POST /v1/completions        text completion (streaming)
  GET  /v1/models             list available models
  GET  /health                health check → {"status":"ok"}
    `.trim());
    process.exit(0);
}
const PortFlagIndex = CLIArgs.indexOf("--port");
const Port = (() => {
    if (PortFlagIndex < 0) {
        return Number(process.env["PORT"] ?? 3000);
    }
    const RawValue = CLIArgs.at(PortFlagIndex + 1);
    const Value = Number(RawValue);
    if ((RawValue == null) || (!Number.isInteger(Value)) || (Value < 1) || (Value > 65535)) {
        console.error((RawValue == null)
            ? "--port requires a numeric argument"
            : `Invalid --port value: "${RawValue}" (must be an integer from 1 to 65535)`);
        process.exit(1);
    }
    return Value;
})();
//----------------------------------------------------------------------------//
//                             Messages → NDJSON                              //
//----------------------------------------------------------------------------//
/**** normalizedContent ****/
function normalizedContent(Content) {
    return (typeof Content === "string")
        ? [{ type: "text", text: Content }]
        : Content;
}
/**** MessagesAsNDJSON ****/
function MessagesAsNDJSON(Messages) {
    return Messages
        .filter((Msg) => (Msg.role !== "system"))
        .map((Msg) => ({
        type: (Msg.role === "user") ? "user" : "assistant",
        message: { role: Msg.role, content: normalizedContent(Msg.content) },
    }))
        .map((Event) => JSON.stringify(Event))
        .join("\n") + "\n";
}
/**** extractedSystemPrompt ****/
function extractedSystemPrompt(Messages) {
    const SystemMsg = Messages.find((Msg) => (Msg.role === "system"));
    if (SystemMsg == null) {
        return undefined;
    }
    if (typeof SystemMsg.content === "string") {
        return SystemMsg.content;
    }
    return SystemMsg.content // content array: merge all text blocks
        .filter((Block) => (Block.type === "text"))
        .map((Block) => Block.text)
        .join("\n");
}
//----------------------------------------------------------------------------//
//                           Invoke Claude Code CLI                           //
//----------------------------------------------------------------------------//
/**** ContentAsString ****/
function ContentAsString(Content) {
    if (typeof Content === "string") {
        return Content;
    }
    return Content
        .filter((Block) => (Block.type === "text"))
        .map((Block) => (Block.text ?? ""))
        .join("");
}
/**** TextExtractedFromStreamJSON ****/
function TextExtractedFromStreamJSON(Raw) {
    return Raw.split("\n")
        .filter((Line) => (Line.trim() !== ""))
        .reduce((LastText, Line) => {
        try {
            const Event = JSON.parse(Line);
            if ((Event.type === "assistant") && (Event.message?.content != null)) {
                const Text = ContentAsString(Event.message.content);
                if (Text != null) {
                    return Text;
                }
            }
        }
        catch { /* ignore */ }
        return LastText;
    }, "");
}
/**** ResponseFromClaudeCode ****/
async function ResponseFromClaudeCode(NDJSON, SystemPrompt, SessionId) {
    const Args = [
        "--print", "--verbose", "--input-format", "stream-json",
        "--output-format", "stream-json", "--dangerously-skip-permissions",
    ];
    if (SystemPrompt != null) {
        Args.push("--system-prompt", SystemPrompt);
    }
    const UsedSessionId = SessionId ?? randomUUID();
    Args.push("--session-id", UsedSessionId);
    const { promise, resolve, reject } = Promise.withResolvers();
    const Process = spawn("claude", Args, {
        env: process.env, stdio: ["pipe", "pipe", "pipe"],
    });
    let StdOut = "", StdErr = "";
    Process.stdout.on("data", (Chunk) => (StdOut += Chunk.toString()));
    Process.stderr.on("data", (Chunk) => (StdErr += Chunk.toString()));
    Process.stdin.write(NDJSON, "utf8");
    Process.stdin.end();
    const Timer = setTimeout(() => {
        Process.kill("SIGTERM");
        reject(new Error("claude CLI timed out after 120 s"));
    }, 120_000);
    Process.on("close", (Code) => {
        clearTimeout(Timer);
        if (StdErr.trim()) {
            console.error("[claude stderr]", StdErr.trim());
        }
        if (Code !== 0) {
            return reject(new Error(`claude exited with code ${Code}: ${StdErr.trim()}`));
        }
        resolve({ Text: TextExtractedFromStreamJSON(StdOut), SessionId: UsedSessionId });
    });
    Process.on("error", (Signal) => { clearTimeout(Timer); reject(Signal); });
    return promise;
}
/**** ResponseFromClaudeCodeStreaming ****/
async function ResponseFromClaudeCodeStreaming(NDJSON, onToken, SystemPrompt, SessionId) {
    const Args = [
        "--print", "--verbose", "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--include-partial-messages", "--dangerously-skip-permissions",
    ];
    if (SystemPrompt != null) {
        Args.push("--system-prompt", SystemPrompt);
    }
    const UsedSessionId = SessionId ?? randomUUID();
    Args.push("--session-id", UsedSessionId);
    const { promise, resolve, reject } = Promise.withResolvers();
    const Process = spawn("claude", Args, {
        env: process.env, stdio: ["pipe", "pipe", "pipe"],
    });
    let LineBuffer = "", LastText = "", StdErr = "";
    Process.stdout.on("data", (Chunk) => {
        LineBuffer += Chunk.toString();
        const Lines = LineBuffer.split("\n");
        LineBuffer = Lines.pop() ?? "";
        Lines
            .filter((Line) => (Line.trim() !== ""))
            .forEach((Line) => {
            try {
                const Event = JSON.parse(Line);
                // partial and final assistant text messages
                if ((Event.type === "assistant") && (Event.message?.content != null)) {
                    const Text = ContentAsString(Event.message.content);
                    if (Text.length > LastText.length) {
                        onToken(Text.slice(LastText.length));
                        LastText = Text;
                    }
                }
            }
            catch { /* not valid JSON → ignore */ }
        });
    });
    Process.stderr.on("data", (Chunk) => (StdErr += Chunk.toString()));
    Process.stdin.write(NDJSON, "utf8");
    Process.stdin.end();
    const Timer = setTimeout(() => {
        Process.kill("SIGTERM");
        reject(new Error("claude CLI timed out after 120 s"));
    }, 120_000);
    Process.on("close", (Code) => {
        clearTimeout(Timer);
        if (StdErr.trim()) {
            console.error("[claude stderr]", StdErr.trim());
        }
        if (Code !== 0) {
            return reject(new Error(`claude exited with code ${Code}: ${StdErr.trim()}`));
        }
        resolve(UsedSessionId);
    });
    Process.on("error", (Signal) => { clearTimeout(Timer); reject(Signal); });
    return promise;
}
//----------------------------------------------------------------------------//
//                             Response Builders                              //
//----------------------------------------------------------------------------//
/**** buildChatResponse ****/
function buildChatResponse(Content, Model, SessionId) {
    const now = Date.now();
    return {
        id: `chatcmpl-${now}`,
        object: "chat.completion",
        created: Math.floor(now / 1000),
        model: Model,
        _session_id: SessionId, // non-standard: session id for follow-up requests
        choices: [
            { index: 0, message: { role: "assistant", content: Content }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: -1, completion_tokens: -1, total_tokens: -1 },
    };
}
/**** buildTextResponse ****/
function buildTextResponse(Text, Model) {
    const now = Date.now();
    return {
        id: `cmpl-${now}`,
        object: "text_completion",
        created: Math.floor(now / 1000),
        model: Model,
        choices: [{ text: Text, index: 0, logprobs: null, finish_reason: "stop" }],
        usage: { prompt_tokens: -1, completion_tokens: -1, total_tokens: -1 },
    };
}
/**** SSEChunk ****/
function SSEChunk(Delta, Model) {
    const now = Date.now();
    return "data: " + JSON.stringify({
        id: `chatcmpl-${now}`,
        object: "chat.completion.chunk",
        created: Math.floor(now / 1000),
        model: Model,
        choices: [{ index: 0, delta: { content: Delta }, finish_reason: null }],
    }) + "\n\n";
}
//----------------------------------------------------------------------------//
//                               HTTP Helpers                                 //
//----------------------------------------------------------------------------//
/**** sendJSON ****/
function sendJSON(Response, Status, Body) {
    const Payload = JSON.stringify(Body, null, 2);
    Response.writeHead(Status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(Payload),
        "Access-Control-Allow-Origin": "*",
    });
    Response.end(Payload);
}
/**** sendError ****/
function sendError(Response, Status, Msg) {
    sendJSON(Response, Status, { error: { message: Msg, type: "proxy_error", code: Status } });
}
/**** readBody ****/
async function readBody(Request) {
    const { promise, resolve, reject } = Promise.withResolvers();
    const Chunks = [];
    Request.on("data", (Chunk) => Chunks.push(Chunk));
    Request.on("end", () => resolve(Buffer.concat(Chunks).toString("utf8")));
    Request.on("error", reject);
    return promise;
}
//----------------------------------------------------------------------------//
//                              Route Handlers                                //
//----------------------------------------------------------------------------//
/**** handleChatCompletions ****/
async function handleChatCompletions(Request, Response) {
    let Body;
    try {
        Body = JSON.parse(await readBody(Request));
    }
    catch {
        return sendError(Response, 400, "Invalid JSON body");
    }
    if ((!Array.isArray(Body.messages)) || (Body.messages.length === 0)) {
        return sendError(Response, 400, "`messages` must be a non-empty array");
    }
    const Model = Body.model ?? "claude-code-proxy";
    const SystemPrompt = extractedSystemPrompt(Body.messages);
    const NDJSON = MessagesAsNDJSON(Body.messages);
    const SessionId = Body.session_id;
    console.log(`[chat] messages=${Body.messages.length}` +
        ((SessionId != null) ? ` session=${SessionId}` : " (new)") +
        (Body.stream ? " stream=true" : ""));
    if (Body.stream) {
        Response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
        });
        try {
            await ResponseFromClaudeCodeStreaming(NDJSON, (Token) => Response.write(SSEChunk(Token, Model)), SystemPrompt, SessionId);
        }
        catch (Signal) {
            console.error("[chat/stream]", Signal);
            Response.write(SSEChunk(`\n\n[Proxy error: ${Signal.message}]`, Model));
        }
        Response.write("data: [DONE]\n\n");
        Response.end();
        return;
    }
    try {
        const { Text, SessionId: SID } = await ResponseFromClaudeCode(NDJSON, SystemPrompt, SessionId);
        sendJSON(Response, 200, buildChatResponse(Text, Model, SID));
    }
    catch (Signal) {
        console.error("[chat]", Signal);
        sendError(Response, 502, `Claude Code error: ${Signal.message}`);
    }
}
/**** handleTextCompletions ****/
async function handleTextCompletions(Request, Response) {
    let Body;
    try {
        Body = JSON.parse(await readBody(Request));
    }
    catch {
        return sendError(Response, 400, "Invalid JSON body");
    }
    if ((typeof Body.prompt !== "string") || (!Body.prompt.trim())) {
        return sendError(Response, 400, "`prompt` must be a non-empty string");
    }
    const Model = Body.model ?? "claude-code-proxy";
    const NDJSON = MessagesAsNDJSON([{ role: "user", content: Body.prompt }]);
    console.log(`[text] prompt_len=${Body.prompt.length}`);
    if (Body.stream) {
        Response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
        });
        try {
            await ResponseFromClaudeCodeStreaming(NDJSON, (Token) => Response.write(SSEChunk(Token, Model)));
        }
        catch (Signal) {
            console.error("[text/stream]", Signal);
            Response.write(SSEChunk(`\n\n[Proxy error: ${Signal.message}]`, Model));
        }
        Response.write("data: [DONE]\n\n");
        Response.end();
        return;
    }
    try {
        const { Text } = await ResponseFromClaudeCode(NDJSON);
        sendJSON(Response, 200, buildTextResponse(Text, Model));
    }
    catch (Signal) {
        console.error("[text]", Signal);
        sendError(Response, 502, `Claude Code error: ${Signal.message}`);
    }
}
//----------------------------------------------------------------------------//
//                            Prerequisites Check                             //
//----------------------------------------------------------------------------//
/**** assertThatClaudeIsInstalled ****/
async function assertThatClaudeIsInstalled() {
    const { promise, resolve } = Promise.withResolvers();
    const Process = spawn("claude", ["--version"], {
        env: process.env, stdio: "ignore",
    });
    Process.on("error", (Signal) => {
        if (Signal.code === "ENOENT") {
            console.error("\n  Claude Code CLI not found – please install and authenticate:\n\n" +
                "    npm install -g @anthropic-ai/claude-code\n" +
                "    claude auth login\n");
            process.exit(1);
        }
        resolve();
    });
    Process.on("close", resolve);
    return promise;
}
/**** assertThatClaudeIsAuthenticated ****/
async function assertThatClaudeIsAuthenticated() {
    const { promise, resolve } = Promise.withResolvers();
    const Process = spawn("claude", ["auth", "status"], {
        env: process.env, stdio: ["pipe", "pipe", "pipe"],
    });
    let Output = "";
    Process.stdout?.on("data", (Chunk) => (Output += Chunk.toString()));
    Process.stderr?.on("data", (Chunk) => (Output += Chunk.toString()));
    const Timer = setTimeout(() => { Process.kill("SIGTERM"); resolve(); }, 5_000);
    Process.on("error", () => { clearTimeout(Timer); resolve(); });
    Process.on("close", (Code) => {
        clearTimeout(Timer);
        if (Code !== 0) {
            const Lower = Output.toLowerCase();
            if (Lower.includes("not logged in") ||
                Lower.includes("not authenticated") ||
                Lower.includes("please login") ||
                Lower.includes("please log in") ||
                Lower.includes("run: claude auth login") ||
                Lower.includes("run claude auth login")) {
                console.error("\n  Claude Code is not authenticated – please log in:\n\n" +
                    "    claude auth login\n");
                process.exit(1);
            }
        }
        resolve();
    });
    return promise;
}
//----------------------------------------------------------------------------//
//                                  Server                                    //
//----------------------------------------------------------------------------//
const Server = http.createServer(async (Request, Response) => {
    const Method = (Request.method?.toUpperCase() ?? "GET");
    const Path = (Request.url ?? "/").split("?")[0];
    if (Method === "OPTIONS") {
        Response.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        });
        return Response.end();
    }
    try {
        switch (true) {
            case ((Method === "POST") && (Path === "/v1/chat/completions")):
                return await handleChatCompletions(Request, Response);
            case ((Method === "POST") && (Path === "/v1/completions")):
                return await handleTextCompletions(Request, Response);
            case ((Method === "GET") && (Path === "/v1/models")):
                return sendJSON(Response, 200, {
                    object: "list",
                    data: [{
                            id: "claude-code-proxy", object: "model",
                            created: 1_700_000_000, owned_by: "anthropic",
                        }],
                });
            case ((Method === "GET") && ((Path === "/") || (Path === "/health"))):
                return sendJSON(Response, 200, { status: "ok" });
            default:
                sendError(Response, 404, `Not found: ${Method} ${Path}`);
        }
    }
    catch (Signal) {
        console.error("[server] unhandled:", Signal);
        sendError(Response, 500, "Internal server error");
    }
});
await assertThatClaudeIsInstalled();
await assertThatClaudeIsAuthenticated();
Server.listen(Port, () => {
    console.log(`Claude Code Proxy  →  http://localhost:${Port}`);
    console.log("  POST /v1/chat/completions   (stream-json input, SSE streaming, sessions)");
    console.log("  POST /v1/completions        (stream-json input, SSE streaming)");
    console.log("  GET  /v1/models");
});
Server.on("error", (Signal) => { console.error("[server] fatal:", Signal); process.exit(1); });
