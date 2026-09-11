// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import Loading from "./loading";

/**
 * The streaming state.
 *
 * Two rules, both about honesty: it says what is loading (one live region, not a
 * blank page), and every shape in it is decoration. A skeleton that invented
 * numbers — or a plausible-looking score or project name — would be fake data on
 * screen, which is worse than an empty page.
 */

afterEach(cleanup);

describe("home page loading state", () => {
  it("names the page and says what it is waiting for, in a live region", () => {
    render(<Loading />);

    expect(screen.getByRole("heading", { level: 1, name: "Migration Compass" })).toBeTruthy();

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Loading your projects and their analyses");
  });

  it("contains no invented data", () => {
    const { container } = render(<Loading />);

    const text = container.textContent ?? "";
    // No numbers at all: no fake counts, no fake scores, no fake project names.
    expect(text.replace(/[^0-9]/g, "")).toBe("");
  });

  it("keeps its shapes out of the accessibility tree", () => {
    const { container } = render(<Loading />);

    const decorative = container.querySelectorAll("[aria-hidden]");
    expect(decorative.length).toBeGreaterThan(0);

    // Everything outside the header is decoration.
    for (const block of container.querySelectorAll("main > div")) {
      expect(block.getAttribute("aria-hidden")).toBe("true");
    }
  });
});
