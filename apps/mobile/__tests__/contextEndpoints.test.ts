/**
 * @jest-environment jsdom
 */

/**
 * The URL that says where a client starts.
 *
 * A connection reaches every context its person belongs to, so the bare
 * endpoint is the headline and these named URLs are the narrower thing: the
 * context an unaddressed call lands in. The question that produced the file was
 * "are my agents supposed to see your brain automatically" — the answer is now
 * yes, and this is what remains of the first answer to it.
 *
 * Two properties, and they fail in opposite directions:
 *
 *  1. **A named URL is built only when the gateway would read it back.** A slug
 *     it refuses falls back to "no slug", which is the grant's *default*
 *     context — so a wrong named URL does not error, it quietly starts the
 *     client somewhere else.
 *  2. **The single-context account is untouched.** One bare field, no choice to
 *     make. A list of one URL under a heading about picking between contexts is
 *     a decision manufactured for somebody who has none.
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { contextEndpoints, endpointForContext } from "../features/console/endpoints";
import { ConnectionsPane } from "../features/console/panes/ConnectionsPane";
import type { ConsoleData } from "../features/console/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENDPOINT = "https://mcp.context.test/mcp";

describe("the endpoint for one context", () => {
  test("names the context in the path, the way the gateway reads it", () => {
    expect(endpointForContext(ENDPOINT, "seyi")).toBe("https://mcp.context.test/@seyi/mcp");
    // A shared context is addressed by its slug like any other.
    expect(endpointForContext(ENDPOINT, "public-worship")).toBe(
      "https://mcp.context.test/@public-worship/mcp",
    );
    // Already-decorated slugs are tolerated rather than doubled.
    expect(endpointForContext(ENDPOINT, "@seyi")).toBe("https://mcp.context.test/@seyi/mcp");
  });

  /**
   * Every refusal `splitWorkspacePath` makes, made here too.
   *
   * The gateway answers a segment it will not read by ignoring it — the request
   * lands on the grant's default context and succeeds. So a URL this builder
   * got wrong would not surface as an error anywhere; it would surface as
   * somebody's notes being the wrong somebody's.
   */
  test("refuses anything the gateway would not read as a context", () => {
    for (const slug of ["a", "SEYI", "has space", "under_score", "x".repeat(33), ""]) {
      expect(endpointForContext(ENDPOINT, slug)).toBeNull();
    }
    // Routes, not contexts. `t` and `.well-known` are already refused by shape.
    for (const reserved of ["mcp", "inbox", "oauth", "granola-webhook", "meetings"]) {
      expect(endpointForContext(ENDPOINT, reserved)).toBeNull();
    }
  });

  test("refuses a base URL whose first segment is not the gateway's own", () => {
    // The gateway reads the *first* path segment as the slug, so a deployment
    // behind a prefix cannot take a named URL at all. Guessing one for it is
    // this screen inventing somebody else's routing.
    expect(endpointForContext("https://example.test/gateway/mcp", "seyi")).toBeNull();
    expect(endpointForContext("not a url", "seyi")).toBeNull();
  });

  test("a context it cannot name is left out, never padded with the bare URL", () => {
    const rows = contextEndpoints(ENDPOINT, [
      { id: "a", slug: "seyi" },
      { id: "b", slug: "x" },
      { id: "c", slug: "lk" },
    ]);
    expect(rows.map((row) => [row.label, row.url])).toEqual([
      ["@seyi", "https://mcp.context.test/@seyi/mcp"],
      ["@lk", "https://mcp.context.test/@lk/mcp"],
    ]);
  });
});

const CONTEXTS = [
  { id: "seyi", slug: "seyi", displayName: "seyi", role: "owner", kind: "personal", status: "ok" },
  { id: "lk", slug: "lk", displayName: "lk", role: "member", kind: "personal", status: "ok" },
] as unknown as ConsoleData["contexts"];

function paneWith(
  contexts: ConsoleData["contexts"],
  selectedContextId: string | null,
  expand?: string,
): string {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const data = {
    demo: true,
    loading: false,
    contexts,
    selectedContextId,
    selectContext: () => {},
    clients: [],
    endpoint: ENDPOINT,
    members: { members: [], invitations: [], loading: false, failure: null },
  } as unknown as ConsoleData;

  const root = createRoot(host, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(createElement(ConnectionsPane, { data }));
  });
  if (expand !== undefined) {
    // A provider's endpoint is inside its own panel: the row renders a name and
    // two buttons, and the URL it would hand the client only appears once
    // somebody opens Details. Pressing it is the only way to read what this
    // pane passed down.
    const toggle = host.querySelector(`[data-testid="provider-${expand}-toggle"]`)!;
    act(() => {
      toggle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      toggle.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }
  // The panel's own subtree, so an assertion about what the connect rows were
  // handed cannot be satisfied by the endpoint card higher up the page.
  const html =
    expand === undefined
      ? host.innerHTML
      : (host.querySelector(`[data-testid="provider-${expand}"]`)?.innerHTML ?? "");
  act(() => root.unmount());
  host.remove();
  return html;
}

describe("the Connections pane offers the URL that reaches each context", () => {
  test("two contexts get the bare endpoint first and a named one each", () => {
    const html = paneWith(CONTEXTS, "seyi");
    // The bare URL leads, because it is the one that reaches everything.
    expect(html).toContain(ENDPOINT);
    expect(html).toContain("https://mcp.context.test/@seyi/mcp");
    expect(html).toContain("https://mcp.context.test/@lk/mcp");
    expect(html).toContain("One connection reaches every context you belong to");
    // And the named ones are offered as a starting point, never as the way in.
    expect(html).toContain("start it in a particular context");
  });

  test("one context is left exactly as it was", () => {
    const html = paneWith(CONTEXTS.slice(0, 1), "seyi");
    expect(html).toContain(ENDPOINT);
    expect(html).not.toContain("@seyi/mcp");
    expect(html).not.toContain("start it in a particular context");
  });

  /**
   * The connect rows build a deep link from the endpoint they are handed, so on
   * an account with a choice they must follow the context the console is
   * showing. A one-click install that lands somewhere other than the context in
   * front of the person is the reported surprise moved to a different screen.
   */
  test("the connect rows carry the selected context, and only it", () => {
    const panel = paneWith(CONTEXTS, "lk", "claude");
    expect(panel).toContain("https://mcp.context.test/@lk/mcp");
    expect(panel).not.toContain("https://mcp.context.test/@seyi/mcp");
  });
});
