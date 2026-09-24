/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { mount, renderedText } from "./fixtures";

describe("mounting", () => {
  test("the note's text is in the editor", () => {
    const m = mount({ value: "# Heading\n\nbody", editable: true });
    expect(renderedText(m.container)).toContain("Heading");
    m.unmount();
  });

  test("the accessibility label reaches the DOM", () => {
    const m = mount({ value: "x", editable: true });
    expect(m.container.querySelector('[aria-label="note markdown"]')).not.toBeNull();
    m.unmount();
  });

  test("unmounting destroys the view rather than leaking it", () => {
    const m = mount({ value: "x", editable: true });
    expect(m.container.querySelector(".cm-editor")).not.toBeNull();
    m.unmount();
    expect(m.container.querySelector(".cm-editor")).toBeNull();
  });
});
