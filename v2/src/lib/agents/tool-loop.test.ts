import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/lib/llm/client";

import { createFakeTools } from "./testing/fake-model";
import { MAX_TOOL_ITERATIONS, runToolLoop, toolDefinitions } from "./tool-loop";

const context = { projectId: "project-1", runId: "run-1" };

const toolCall = (name: string, args: Record<string, unknown> = {}, id = "call_1") => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

const lastChatRequest = (requests: ChatMessage[][]): ChatMessage[] => requests.at(-1) ?? [];

describe("toolDefinitions", () => {
  it("exposes each tool's name, description, and argument schema to the model", () => {
    const { tools } = createFakeTools();
    const definitions = toolDefinitions([tools.knowledgeBase]);

    expect(definitions[0]?.name).toBe("queryKnowledgeBase");
    expect(definitions[0]?.parameters).toMatchObject({ type: "object" });
    expect(definitions[0]?.description.length).toBeGreaterThan(0);
  });
});

describe("runToolLoop", () => {
  /** A model whose chat replies are scripted per turn, recording each request. */
  function scriptedModel(turns: (((messages: ChatMessage[]) => unknown) | unknown)[]) {
    const requests: ChatMessage[][] = [];
    let index = 0;

    return {
      requests,
      llm: {
        name: "scripted",
        async complete() {
          return "";
        },
        async chat({ messages }: { messages: ChatMessage[] }) {
          requests.push(messages);
          const turn = turns[index];
          index += 1;
          if (turn === undefined) throw new Error("scripted model ran out of turns");
          const resolved = typeof turn === "function" ? (turn as (m: ChatMessage[]) => unknown)(messages) : turn;
          return resolved as { content: string; toolCalls: never[] };
        },
        async *stream() {
          yield "";
        },
      },
    };
  }

  it("executes a requested tool and returns the model's final answer", async () => {
    const { tools, countOf } = createFakeTools();
    const model = scriptedModel([
      { content: "", toolCalls: [toolCall("queryKnowledgeBase", { question: "what services exist?" })] },
      { content: "Three services exist.", toolCalls: [] },
    ]);

    const result = await runToolLoop({
      llm: model.llm,
      messages: [{ role: "user", content: "investigate" }],
      tools: [tools.knowledgeBase],
      context,
    });

    expect(result.content).toBe("Three services exist.");
    expect(result.iterations).toBe(2);
    expect(result.stoppedEarly).toBe(false);
    expect(result.invocations).toHaveLength(1);
    expect(result.invocations[0]?.ok).toBe(true);
    expect(countOf("knowledgeBase")).toBe(1);
  });

  it("passes the run's scope through to the tool", async () => {
    const { tools, invocations } = createFakeTools();
    const model = scriptedModel([
      { content: "", toolCalls: [toolCall("queryKnowledgeBase", { question: "q" })] },
      { content: "done", toolCalls: [] },
    ]);

    await runToolLoop({
      llm: model.llm,
      messages: [{ role: "user", content: "go" }],
      tools: [tools.knowledgeBase],
      context,
    });

    expect(invocations[0]?.context).toEqual({ projectId: "project-1", runId: "run-1" });
  });

  it("echoes the assistant's tool_calls and the tool result back to the model", async () => {
    // Without the echo the model sees tool output with no record of having asked
    // for it, and answers as if the data arrived unbidden.
    const { tools } = createFakeTools();
    const model = scriptedModel([
      { content: "checking", toolCalls: [toolCall("queryKnowledgeBase", { question: "q" })] },
      { content: "done", toolCalls: [] },
    ]);

    await runToolLoop({
      llm: model.llm,
      messages: [{ role: "user", content: "go" }],
      tools: [tools.knowledgeBase],
      context,
    });

    const second = lastChatRequest(model.requests);
    const assistant = second.find((message) => message.role === "assistant");
    const tool = second.find((message) => message.role === "tool");

    expect(assistant).toMatchObject({ role: "assistant", content: "checking" });
    expect(assistant && "toolCalls" in assistant ? assistant.toolCalls?.[0]?.name : undefined).toBe(
      "queryKnowledgeBase",
    );
    expect(tool).toMatchObject({ role: "tool", toolCallId: "call_1", name: "queryKnowledgeBase" });
  });

  it("feeds an unknown tool name back as text instead of throwing", async () => {
    const { tools } = createFakeTools();
    const model = scriptedModel([
      { content: "", toolCalls: [toolCall("deleteEverything", {})] },
      { content: "I will use a tool that exists.", toolCalls: [] },
    ]);

    const result = await runToolLoop({
      llm: model.llm,
      messages: [{ role: "user", content: "go" }],
      tools: [tools.knowledgeBase],
      context,
    });

    expect(result.invocations[0]?.ok).toBe(false);
    expect(result.invocations[0]?.content).toContain("no tool named");
    expect(result.invocations[0]?.content).toContain("queryKnowledgeBase");
    expect(result.content).toContain("I will use a tool that exists.");
  });

  it("feeds unparseable arguments back as text", async () => {
    const { tools } = createFakeTools();
    const model = scriptedModel([
      { content: "", toolCalls: [{ id: "c1", name: "queryKnowledgeBase", arguments: "{not json" }] },
      { content: "retrying", toolCalls: [] },
    ]);

    const result = await runToolLoop({
      llm: model.llm,
      messages: [{ role: "user", content: "go" }],
      tools: [tools.knowledgeBase],
      context,
    });

    expect(result.invocations[0]?.ok).toBe(false);
    expect(result.invocations[0]?.content).toContain("not valid JSON");
  });

  it("feeds a thrown tool error back as text", async () => {
    // A tool that throws must not abort a run: the model can often continue with
    // the rest of its investigation and report the gap honestly.
    const exploding = {
      name: "boom",
      description: "explodes",
      parameters: { type: "object", properties: {} },
      async run() {
        throw new Error("socket closed");
      },
    };

    const model = scriptedModel([
      { content: "", toolCalls: [toolCall("boom", {})] },
      { content: "that tool is down; here is what I have", toolCalls: [] },
    ]);

    const result = await runToolLoop({
      llm: model.llm,
      messages: [{ role: "user", content: "go" }],
      tools: [exploding],
      context,
    });

    expect(result.invocations[0]?.ok).toBe(false);
    expect(result.invocations[0]?.content).toContain("socket closed");
    expect(result.content).toContain("that tool is down");
  });

  it("runs several tool calls from one turn", async () => {
    const { tools, countOf } = createFakeTools();
    const model = scriptedModel([
      {
        content: "",
        toolCalls: [
          toolCall("queryKnowledgeBase", { question: "a" }, "c1"),
          toolCall("checkApiHealth", { serviceName: "A" }, "c2"),
        ],
      },
      { content: "done", toolCalls: [] },
    ]);

    const result = await runToolLoop({
      llm: model.llm,
      messages: [{ role: "user", content: "go" }],
      tools: [tools.knowledgeBase, tools.checkApiHealth],
      context,
    });

    expect(result.invocations).toHaveLength(2);
    expect(countOf("knowledgeBase")).toBe(1);
    expect(countOf("checkApiHealth")).toBe(1);
  });

  it("stops at the iteration ceiling and reports that it was stopped", async () => {
    // A model that keeps asking for tools forever must not run forever. The flag
    // matters as much as the stop: "the model finished" and "the model was cut
    // off" are different states, and conflating them hides a broken prompt.
    const { tools } = createFakeTools();
    const model = scriptedModel(
      Array.from({ length: 20 }, () => ({
        content: "still looking",
        toolCalls: [toolCall("queryKnowledgeBase", { question: "again" })],
      })),
    );

    const result = await runToolLoop({
      llm: model.llm,
      messages: [{ role: "user", content: "go" }],
      tools: [tools.knowledgeBase],
      context,
      maxIterations: 3,
    });

    expect(result.iterations).toBe(3);
    expect(result.stoppedEarly).toBe(true);
    expect(result.invocations).toHaveLength(3);
    expect(model.requests).toHaveLength(3);
  });

  it("uses the default ceiling when none is given", async () => {
    const { tools } = createFakeTools();
    const model = scriptedModel(
      Array.from({ length: 20 }, () => ({
        content: "",
        toolCalls: [toolCall("queryKnowledgeBase", { question: "again" })],
      })),
    );

    const result = await runToolLoop({
      llm: model.llm,
      messages: [{ role: "user", content: "go" }],
      tools: [tools.knowledgeBase],
      context,
    });

    expect(MAX_TOOL_ITERATIONS).toBeLessThan(20);
    expect(model.requests).toHaveLength(MAX_TOOL_ITERATIONS);
    expect(result.iterations).toBe(MAX_TOOL_ITERATIONS);
    expect(result.stoppedEarly).toBe(true);
  });

  it("returns immediately when the model wants no tools", async () => {
    const { tools } = createFakeTools();
    const model = scriptedModel([{ content: "no investigation needed", toolCalls: [] }]);

    const result = await runToolLoop({
      llm: model.llm,
      messages: [{ role: "user", content: "go" }],
      tools: [tools.knowledgeBase],
      context,
    });

    expect(result.iterations).toBe(1);
    expect(result.invocations).toEqual([]);
  });
});
