// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ErrorNotice } from "./error-notice";

/**
 * The rendered failure.
 *
 * A swallowed read error once made the project list say "No projects yet" while the
 * database was unreachable — a claim about the reader's data, and a false one. These
 * tests pin what replaces it: a named region, a statement of what failed, and what to
 * do next, with no diagnostic detail and no invented cause.
 */

afterEach(cleanup);

describe("ErrorNotice", () => {
  it("is a named region with the failure as a heading", () => {
    render(<ErrorNotice title="Projects could not be loaded" detail="The read failed." />);

    const region = screen.getByRole("region", { name: "Projects could not be loaded" });

    expect(region.querySelector("h2")?.textContent).toBe("Projects could not be loaded");
    expect(region.textContent).toContain("The read failed.");
  });

  it("states what to do about it when there is something useful to say", () => {
    render(
      <ErrorNotice
        title="Assessment unavailable"
        detail="The read failed."
        action="Reload the page to try again."
      />,
    );

    expect(screen.getByRole("region", { name: "Assessment unavailable" }).textContent).toContain(
      "Reload the page to try again.",
    );
  });

  it("renders nothing extra when there is no action to offer", () => {
    const { container } = render(<ErrorNotice title="Failed" detail="The read failed." />);

    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  it("is not an alert: a message present at first paint is not a change", () => {
    render(<ErrorNotice title="Failed" detail="The read failed." />);

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
