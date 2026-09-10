import { llmEnv } from "@/lib/env";

/**
 * The model boundary.
 *
 * Three methods, because the pipeline needs three things: `complete` for steps
 * where only final text matters (query expansion, reranking, critique passes),
 * `stream` for the answer a user watches arrive, and `chat` for the
 * tool-calling loop agents run. They share one HTTP path — the differences are
 * stream-vs-not and tools-vs-no-tools, not three integrations.
 *
 * Every caller takes this interface rather than a concrete client, so the whole
 * RAG and agent layer is testable with a scripted fake and no API key.
 */

/**
 * A discriminator that is never sent to the model.
 *
 * Exists so agent tests can script a model by step ("solve the critique for
 * `risk.draft`") instead of by substring-matching prompt prose. Prompt wording is
 * expected to change; a tag is part of the call site's contract, so tests keep
 * working when a prompt is reworded.
 */
export type PromptTag = string;

export type LlmPrompt = {
  system?: string;
  user: string;
  temperature?: number;
  tag?: PromptTag;
};

export type ToolCall = {
  id: string;
  name: string;
  /** Raw JSON string, exactly as the model emitted it — parsed by the caller. */
  arguments: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
};

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type ChatResponse = {
  content: string;
  toolCalls: ToolCall[];
};

export type ChatRequest = {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  tag?: PromptTag;
};

export type LlmClient = {
  name: string;
  complete(prompt: LlmPrompt): Promise<string>;
  stream(prompt: LlmPrompt): AsyncIterable<string>;
  chat(request: ChatRequest): Promise<ChatResponse>;
};

/**
 * Parses OpenAI-compatible SSE (`data: {...}\n\n`, terminated by `data: [DONE]`).
 *
 * Exported and tested on its own because the failure that matters here is a
 * chunk boundary landing mid-line: network chunks do not respect event
 * boundaries, so a naive `split("\n")` per chunk silently drops or corrupts
 * tokens under load — and it does so intermittently, which is the worst way for
 * a bug to behave.
 */
export async function* parseOpenAiSse(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });

    let boundary = buffer.indexOf("\n");
    while (boundary >= 0) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      boundary = buffer.indexOf("\n");

      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      // The sentinel means the stream is complete. Returning rather than
      // skipping matters: anything after it is not part of this response.
      if (payload === "[DONE]") return;
      if (payload.length === 0) continue;

      try {
        const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) yield delta;
      } catch {
        // A malformed event is skipped, not fatal: the rest of the stream is
        // still a usable answer, and aborting would turn a cosmetic glitch into
        // a failed request.
        continue;
      }
    }
  }
}

/**
 * Adapts a fetch body to an async iterable. Written out rather than relying on
 * `ReadableStream`'s async-iterator support, which the DOM lib types do not
 * declare — and an explicit reader loop is where the lock release belongs.
 */
export async function* toAsyncIterable(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Wire format for one message. Tool calls have to be echoed back in OpenAI's shape. */
function wireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "assistant") {
    if (!message.toolCalls || message.toolCalls.length === 0) {
      return { role: "assistant", content: message.content };
    }
    return {
      role: "assistant",
      content: message.content.length > 0 ? message.content : null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }

  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }

  return { role: message.role, content: message.content };
}

function wireTools(tools: ToolDefinition[] | undefined): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

export function createDeepSeekLlm(): LlmClient {
  const env = llmEnv();
  const endpoint = new URL("/chat/completions", env.LLM_BASE_URL);

  const send = async (payload: Record<string, unknown>): Promise<Response> => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({ model: env.LLM_MODEL, ...payload }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `LLM request failed (${response.status} ${response.statusText}): ${text.slice(0, 500)}`,
      );
    }

    return response;
  };

  const promptMessages = (prompt: LlmPrompt): ChatMessage[] => [
    ...(prompt.system ? [{ role: "system" as const, content: prompt.system }] : []),
    { role: "user" as const, content: prompt.user },
  ];

  return {
    name: `deepseek:${env.LLM_MODEL}`,

    async complete(prompt) {
      const response = await send({
        messages: promptMessages(prompt).map(wireMessage),
        ...(prompt.temperature === undefined ? {} : { temperature: prompt.temperature }),
      });
      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("LLM response contained no message content.");
      }
      return content;
    },

    async chat(request) {
      const response = await send({
        messages: request.messages.map(wireMessage),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(wireTools(request.tools) ? { tools: wireTools(request.tools) } : {}),
      });

      const payload = (await response.json()) as {
        choices?: {
          message?: {
            content?: string | null;
            tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
          };
        }[];
      };

      const message = payload.choices?.[0]?.message;
      if (!message) throw new Error("LLM response contained no message.");

      return {
        content: typeof message.content === "string" ? message.content : "",
        toolCalls: (message.tool_calls ?? [])
          .filter((call) => call.function?.name)
          .map((call, index) => ({
            id: call.id ?? `call_${index}`,
            name: call.function?.name ?? "",
            arguments: call.function?.arguments ?? "{}",
          })),
      };
    },

    async *stream(prompt) {
      const response = await send({
        stream: true,
        messages: promptMessages(prompt).map(wireMessage),
        ...(prompt.temperature === undefined ? {} : { temperature: prompt.temperature }),
      });
      if (!response.body) {
        throw new Error("LLM stream response had no body.");
      }
      yield* parseOpenAiSse(toAsyncIterable(response.body));
    },
  };
}

/**
 * A configurable fake for tests and for running the app with no API key.
 * `respond` receives the prompt (including its tag), so a caller can script
 * different text for the expansion, reranking, and answer steps of one pipeline.
 *
 * `chat` delegates to the same function and reports no tool calls. Tests that
 * need to script a tool-calling sequence build a purpose-made fake instead of
 * growing this one — a stub with a tool-call script would be a second
 * implementation of the thing under test.
 */
export function createStubLlm(
  respond: (prompt: LlmPrompt) => string | Promise<string> = () => "",
): LlmClient {
  return {
    name: "stub",
    async complete(prompt) {
      return respond(prompt);
    },
    async chat(request) {
      const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
      return {
        content: await respond({
          user: lastUser?.content ?? "",
          temperature: request.temperature,
          tag: request.tag,
        }),
        toolCalls: [],
      };
    },
    async *stream(prompt) {
      const text = await respond(prompt);
      // Chunked as the real thing would be, so callers that accumulate deltas
      // are exercised rather than handed the whole answer at once.
      for (let offset = 0; offset < text.length; offset += 24) {
        yield text.slice(offset, offset + 24);
      }
    },
  };
}
