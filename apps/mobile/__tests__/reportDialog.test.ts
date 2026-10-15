/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * "Report or block" as a person meets it: a reason is required, the words are
 * optional and bounded, "Also block" is offered only where somebody sent the
 * thing, and the receipt names a code and the 24-hour promise. The server's
 * half — no oracle, ids only — is `apps/convex/__tests__/reportAndBlock.test.ts`.
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ReportDialogView } =
  require("../features/report/ReportDialog") as typeof import("../features/report/ReportDialog");
const model = require("../features/report/model") as typeof import("../features/report/model");

const live: Array<() => void> = [];
afterEach(() => {
  while (live.length > 0) live.pop()!();
});

type Sent = Record<string, unknown>;

async function mount(options: { person: { handle: string | null; name: string | null } | null; fail?: unknown }) {
  const sent: Sent[] = [];
  const closed: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  const submit = async (args: Sent) => {
    sent.push(args);
    if (options.fail !== undefined) throw options.fail;
    return { eventId: "7f2c9a0000000000000000000000abcd" };
  };
  await act(async () => {
    root.render(
      createElement(ReportDialogView, {
        target: { kind: "share", token: "tok" },
        person: options.person,
        onClose: () => closed.push("closed"),
        submit: submit as never,
      }),
    );
  });
  live.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const find = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const press = async (id: string) => {
    const node = find(id);
    if (node === null) throw new Error(`nothing to press: ${id}`);
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  return { find, press, sent, closed };
}

function disabled(node: HTMLElement | null): boolean {
  return node?.getAttribute("aria-disabled") === "true" || node?.hasAttribute("disabled") === true;
}

describe("the report dialog", () => {
  test("Send waits for a reason, then sends it with the block the person ticked", async () => {
    const ui = await mount({ person: { handle: "ana", name: "Ana Ruiz" } });
    expect(document.body.textContent).toContain("Also block @ana");
    expect(disabled(ui.find("report-send"))).toBe(true);

    await ui.press("report-reason-harassment");
    await ui.press("report-also-block");
    expect(disabled(ui.find("report-send"))).toBe(false);
    await ui.press("report-send");

    expect(ui.sent).toHaveLength(1);
    expect(ui.sent[0]).toMatchObject({
      target: { kind: "share", token: "tok" },
      reason: "harassment",
      alsoBlock: true,
    });
    // Words left blank are not sent at all.
    expect(ui.sent[0]).not.toHaveProperty("details");
    const receipt = ui.find("report-sent")?.textContent ?? "";
    expect(receipt).toContain("FB-7F2C9A");
    expect(receipt).toContain("within 24 hours");
    expect(receipt).toContain("@ana is blocked");
  });

  test("with nobody behind it, there is no block to offer", async () => {
    const ui = await mount({ person: null });
    expect(ui.find("report-also-block")).toBeNull();
    await ui.press("report-reason-spam");
    await ui.press("report-send");
    expect(ui.sent[0]).toMatchObject({ alsoBlock: false });
  });

  test("a refusal says what to do, and keeps the report on screen", async () => {
    const ui = await mount({ person: null, fail: { data: { code: "FEEDBACK_RATE_LIMITED" } } });
    await ui.press("report-reason-other");
    await ui.press("report-send");
    expect(ui.find("report-failed")?.textContent).toContain("context@supa.media");
    expect(ui.find("report-send")).not.toBeNull();
  });
});

describe("the report's rules", () => {
  test("a signed-out reader's email names the page in its subject", () => {
    expect(model.reportMailto("https://example.invalid/@ana/about")).toBe(
      "mailto:context@supa.media?subject=Report%3A%20https%3A%2F%2Fexample.invalid%2F%40ana%2Fabout",
    );
  });

  test("the person is named by handle, then name, then neither", () => {
    expect(model.personLabel({ handle: "ana", name: "Ana" })).toBe("@ana");
    expect(model.personLabel({ handle: null, name: "Ana" })).toBe("Ana");
    expect(model.personLabel({ handle: null, name: null })).toBe("this person");
  });

  test("the reasons are the server's closed list", () => {
    expect([...model.REPORT_REASONS]).toEqual(["spam", "harassment", "sexual", "violence", "illegal", "other"]);
    expect(model.canSend(null, "")).toBe(false);
    expect(model.canSend("spam", "x".repeat(model.DETAILS_MAX + 1))).toBe(false);
  });
});
