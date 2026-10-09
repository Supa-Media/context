import { describe, expect, test } from "@jest/globals";
import {
  approvalsEndpoint,
  decisionRequest,
  readDecision,
  readListing,
} from "../features/approvals/gateway";

/**
 * THE APPROVALS WIRE, AND WHAT A MALFORMED ANSWER DOES TO IT.
 *
 * `apps/mcp/src/http/approvals.js` is the server half. The gate there holds an
 * AI client's widening call until the person says yes, and this screen is the
 * place they say it. Two things must hold on this side of the wire:
 *
 *  1. **What is shown is what the server sent, field by field.** The listing
 *     carries the arguments that would run, so a field added to a record for
 *     some other purpose must not ride along into the panel. Every field is
 *     named here, and a planted sentinel proves nothing unnamed gets through.
 *  2. **A body that is not the documented shape is a failure, never a crash
 *     and never a half-read list.** A panel with somebody waiting at it cannot
 *     throw, and a list with one unreadable entry is not shown with that entry
 *     quietly missing: the count would lie about what is waiting.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `readListing` spreading each record (`{ ...entry }`) instead of naming
 *     its fields. → **1 fails**: `a field the server did not name stays off the screen`.
 *  2. `readListing` skipping an unreadable entry rather than failing the list.
 *     → **1 fails**: `one unreadable entry fails the whole listing`.
 *  3. `readDecision` reading `ok` as `!== false`, so an approval with no `ok`
 *     claims the call ran. → **1 fails**: `an approval that does not say it ran
 *     does not claim that it ran`.
 *  4. `approvalsEndpoint` keeping the endpoint's path. → **1 fails**: `the
 *     context in the endpoint's path is dropped`.
 */

const SENTINEL = "zarquon-plumbago-9471-not-for-the-approvals-screen";

function entry(over: Record<string, unknown> = {}) {
  return {
    id: "ap_1",
    summary: "share 1-projects/plan.md with anyone who has the link",
    tool: "create_link",
    args: { path: "1-projects/plan.md" },
    audience: "anyone with the link",
    client: "Claude Desktop",
    created_at: 1_700_000_000_000,
    expires_at: 1_700_000_900_000,
    ...over,
  };
}

describe("where the approvals are asked", () => {
  test("the route is derived from the endpoint the console already shows", () => {
    expect(approvalsEndpoint("https://mcp.context.test/mcp")).toBe(
      "https://mcp.context.test/approvals",
    );
  });

  /**
   * As for `/agent`: the console's grant is minted for one workspace, so the
   * token names the context. A slug in the path would be a second answer to
   * the same question.
   */
  test("the context in the endpoint's path is dropped", () => {
    expect(approvalsEndpoint("https://mcp.context.test/@seyi/mcp")).toBe(
      "https://mcp.context.test/approvals",
    );
    expect(approvalsEndpoint("https://mcp.context.test/t/cat_token/mcp")).toBe(
      "https://mcp.context.test/approvals",
    );
  });

  test("a port is kept, because a self-hoster's gateway has one", () => {
    expect(approvalsEndpoint("http://localhost:8787/mcp")).toBe(
      "http://localhost:8787/approvals",
    );
  });

  test("something that is not a web address is nowhere to ask", () => {
    expect(approvalsEndpoint("")).toBeNull();
    expect(approvalsEndpoint("mcp.context.test/mcp")).toBeNull();
    expect(approvalsEndpoint("javascript:alert(1)")).toBeNull();
  });

  test("a decision names the approval and the answer, and nothing else", () => {
    expect(decisionRequest("ap_1", "approve")).toEqual({ id: "ap_1", action: "approve" });
    expect(decisionRequest("ap_1", "deny")).toEqual({ id: "ap_1", action: "deny" });
  });
});

describe("what the listing shows", () => {
  test("a listing is read into the fields the screen uses", () => {
    const read = readListing(200, { approvals: [entry()] });

    expect(read).toEqual({
      kind: "listed",
      approvals: [
        {
          id: "ap_1",
          summary: "share 1-projects/plan.md with anyone who has the link",
          tool: "create_link",
          args: { path: "1-projects/plan.md" },
          audience: "anyone with the link",
          client: "Claude Desktop",
          createdAt: 1_700_000_000_000,
          expiresAt: 1_700_000_900_000,
        },
      ],
    });
  });

  test("an empty listing is a listing, not a failure", () => {
    expect(readListing(200, { approvals: [] })).toEqual({ kind: "listed", approvals: [] });
  });

  test("a field the server did not name stays off the screen", () => {
    const read = readListing(200, {
      approvals: [entry({ account_email: SENTINEL, body: SENTINEL, internal_hint: SENTINEL })],
    });

    expect(read.kind).toBe("listed");
    expect(JSON.stringify(read)).not.toContain(SENTINEL);
  });

  test("the arguments are carried exactly as sent, for the person to read", () => {
    const args = { path: "a.md", images: [{ url: "https://example.test/x.png" }] };
    const read = readListing(200, { approvals: [entry({ args })] });

    expect(read.kind === "listed" && read.approvals[0]?.args).toEqual(args);
  });

  test("a client the gateway could not name is an absence, not a made-up name", () => {
    const read = readListing(200, { approvals: [entry({ client: null, audience: 7 })] });

    expect(read.kind === "listed" && read.approvals[0]?.client).toBeNull();
    expect(read.kind === "listed" && read.approvals[0]?.audience).toBeNull();
  });

  /**
   * The count on the tab is the number of things waiting. An entry this build
   * cannot read is one of them, so dropping it would make the count a lie about
   * what is held. The whole listing says it could not be read instead.
   */
  test("one unreadable entry fails the whole listing", () => {
    for (const bad of [
      entry({ id: "" }),
      entry({ id: 42 }),
      entry({ summary: undefined }),
      entry({ tool: null }),
      entry({ created_at: "yesterday" }),
      entry({ expires_at: Number.NaN }),
      null,
      "ap_2",
    ]) {
      const read = readListing(200, { approvals: [entry(), bad] });
      expect(read.kind).toBe("failed");
    }
  });

  test("a body that is not the documented shape is a failure, never a crash", () => {
    for (const body of [null, undefined, "approvals", [], {}, { approvals: "none" }, { approvals: null }]) {
      expect(() => readListing(200, body)).not.toThrow();
      expect(readListing(200, body).kind).toBe("failed");
    }
  });

  test("a refusal is never read as an empty list", () => {
    expect(readListing(403, { approvals: [] }).kind).toBe("failed");
    expect(readListing(500, { approvals: [entry()] }).kind).toBe("failed");
  });

  test("a refusal names no status code at somebody", () => {
    for (const status of [401, 403, 500, 0]) {
      const read = readListing(status, null);
      if (read.kind !== "failed") throw new Error("expected a failure");
      expect(read.sentence.length).toBeGreaterThan(0);
      expect(read.sentence).not.toContain(String(status));
    }
  });
});

describe("what an approve or a deny comes back as", () => {
  test("an approval that ran says so, with the tool's own answer", () => {
    expect(
      readDecision(200, { status: "approved", summary: "share plan", result: "Shared.", ok: true }),
    ).toEqual({
      kind: "decided",
      decision: { status: "approved", summary: "share plan", ok: true, result: "Shared." },
    });
  });

  /**
   * "Approved" and "ran" are different claims. The gateway sends `ok` for the
   * second, and a missing one is not evidence that the call succeeded.
   */
  test("an approval that does not say it ran does not claim that it ran", () => {
    const read = readDecision(200, { status: "approved", summary: "x", result: "Shared." });
    expect(read.kind === "decided" && read.decision).toEqual({
      status: "approved",
      summary: "x",
      ok: false,
      result: "Shared.",
    });
  });

  test("a denial is a denial, with no result to show", () => {
    expect(readDecision(200, { status: "denied", summary: "share plan" })).toEqual({
      kind: "decided",
      decision: { status: "denied", summary: "share plan" },
    });
  });

  test("an approval whose result is not text is an approval with no text", () => {
    const read = readDecision(200, { status: "approved", result: { nested: SENTINEL }, ok: true });
    expect(read.kind === "decided" && read.decision.status === "approved" && read.decision.result).toBe("");
    expect(JSON.stringify(read)).not.toContain(SENTINEL);
  });

  test("an approval that has gone is gone, not a failure", () => {
    expect(readDecision(404, { error: "not_found" })).toEqual({ kind: "gone" });
  });

  test("a status the server did not name is a failure, not a decision", () => {
    for (const body of [
      null,
      "approved",
      {},
      { status: "maybe" },
      { status: "APPROVED" },
      { status: ["approved"] },
    ]) {
      expect(() => readDecision(200, body)).not.toThrow();
      expect(readDecision(200, body).kind).toBe("failed");
    }
  });

  test("a refusal is a failure whatever the body says", () => {
    expect(readDecision(500, { status: "approved", ok: true }).kind).toBe("failed");
    expect(readDecision(400, null).kind).toBe("failed");
  });

  test("an expired connection says to reload rather than blaming the request", () => {
    const read = readDecision(403, null);
    expect(read.kind === "failed" && read.sentence).toContain("Reload");
  });
});
