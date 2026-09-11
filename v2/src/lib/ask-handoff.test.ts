// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ASK_HANDOFF_EVENT,
  onAskRequest,
  requestAsk,
  type AskHandoffRequest,
} from "./ask-handoff";

/**
 * The handoff channel between a report control and the ask bar.
 *
 * It is a window event rather than a chat client on purpose: the ask bar is the
 * only surface that talks to `/api/ask`, and a second one would be a second
 * conversational system. What is asserted here is therefore the channel's
 * contract — a well-formed request crosses, a malformed one does not, and
 * unsubscribing stops delivery.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const REQUEST: AskHandoffRequest = {
  projectId: "project-1",
  question: "Why is OrderService rated critical?",
  context: "Report · Risk finding: OrderService (critical risk)",
};

describe("requestAsk", () => {
  it("publishes the question, its project and its context", () => {
    const received: AskHandoffRequest[] = [];
    const unsubscribe = onAskRequest((request) => received.push(request));

    requestAsk(REQUEST);

    expect(received).toEqual([REQUEST]);
    unsubscribe();
  });

  it("refuses a request with no question or no project", () => {
    const spy = vi.fn();
    const unsubscribe = onAskRequest(spy);

    requestAsk({ ...REQUEST, question: "   " });
    requestAsk({ ...REQUEST, projectId: "" });

    expect(spy).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("delivers to every subscriber", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = onAskRequest(first);
    const unsubscribeSecond = onAskRequest(second);

    requestAsk(REQUEST);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    unsubscribeFirst();
    unsubscribeSecond();
  });
});

describe("onAskRequest", () => {
  it("stops delivering once unsubscribed", () => {
    const handler = vi.fn();
    const unsubscribe = onAskRequest(handler);

    requestAsk(REQUEST);
    unsubscribe();
    requestAsk(REQUEST);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores an event whose detail is not a request", () => {
    const handler = vi.fn();
    const unsubscribe = onAskRequest(handler);

    window.dispatchEvent(new CustomEvent(ASK_HANDOFF_EVENT, { detail: { question: 42 } }));
    window.dispatchEvent(new CustomEvent(ASK_HANDOFF_EVENT));

    expect(handler).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("uses one event name, so nothing else can be listening for something different", () => {
    expect(ASK_HANDOFF_EVENT).toBe("migration-compass:ask");
  });
});
