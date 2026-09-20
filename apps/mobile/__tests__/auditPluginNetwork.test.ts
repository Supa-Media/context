/**
 * @jest-environment jsdom
 */

/**
 * The one audit row whose subject is not already on it.
 *
 * ## The gap this closes, and how it was found
 *
 * The plugin card promises a network grant is *"brokered, audited and
 * revocable"*, and the smoke test written against it asked a reader to confirm
 * "exactly one `plugin.network` row naming the plugin, the host, the method and
 * the status". **That was not a thing the shipped console could do.**
 * `recordRuntimeAudit` has stored all four since the egress service landed and
 * `listEvents` hands them to an owner, but `AdvancedPanel` drew action, actor,
 * time and paths — and `plugin.network` carries no path by construction,
 * because no note is involved. The row read *"plugin network · you · 2 minutes
 * ago"* and answered none of the three questions somebody opens a trail to ask.
 *
 * ## Why the tests below are mostly about what is *not* drawn
 *
 * The fix is one line of text, and the whole risk is in its blast radius.
 * `details` is a free-form map the control plane fills in per action, and
 * `apps/convex/functions/audit.ts`'s own header spends pages on why its
 * contents are subtle — a count can be a subtraction, a scope can be a
 * permission, a visibility can be an existence oracle. A console that rendered
 * `details` generally would publish every one of those the day the server added
 * it, with nobody re-reading the client.
 *
 * So the guard is a map of action to the exact keys, and most of what follows
 * proves the map is the boundary rather than a suggestion.
 */

import { describe, expect, test } from "@jest/globals";
import { auditActionLabel, auditDetailLine } from "../features/console/advanced/advanced";
import type { ConsoleAuditEvent } from "../features/console/advanced/advanced";

function event(over: Partial<ConsoleAuditEvent> = {}): ConsoleAuditEvent {
  return {
    eventId: "e1",
    action: "plugin.network",
    paths: [],
    at: 1,
    details: {
      pluginId: "youversion-linker",
      host: "www.bible.com",
      method: "GET",
      status: 200,
    },
    ...over,
  };
}

describe("what a plugin's network row says", () => {
  test("the plugin, the host, the method and what came back", () => {
    expect(auditDetailLine(event())).toBe("youversion-linker · www.bible.com · GET · 200");
  });

  /*
    The row's own label, which read "plugin network" — the server's raw action
    name, printed by the fallback `auditActionLabel` exists for. Correct
    behaviour for an action this build has never heard of, and this one it has.
  */
  test("and the action reads as a sentence rather than a dotted name", () => {
    expect(auditActionLabel("plugin.network")).toBe("A plugin reached the internet");
  });

  test("a failed request still names what failed and how", () => {
    expect(auditDetailLine(event({ details: { ...event().details, status: 403 } })))
      .toBe("youversion-linker · www.bible.com · GET · 403");
  });

  /*
    A field the server did not record is absent, not "null". `recordRuntimeAudit`
    writes nulls into `host`, `method` and `status` for the vault operations that
    share its shape, and a row that printed them would read
    "youversion-linker · null · null · null".
  */
  test("nulls are dropped rather than printed", () => {
    expect(auditDetailLine(event({ details: { pluginId: "x", host: null, method: null, status: null } })))
      .toBe("x");
  });

  test("a row with no details at all draws no line", () => {
    expect(auditDetailLine(event({ details: undefined }))).toBeNull();
  });

  test("a row whose details are all unusable draws no line, not an empty one", () => {
    expect(auditDetailLine(event({ details: { pluginId: "   ", host: "" } }))).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

/*
  THE BOUNDARY, WHICH IS THE POINT OF THE CHANGE.

  Everything here would pass just as well if `auditDetailLine` returned `null`
  always — and that is deliberate. These are the assertions that must survive
  somebody widening the feature later, so each one names a thing the console
  must keep refusing to draw.
*/
describe("nothing else renders its details, whatever they contain", () => {
  /*
    `file.write` carries `{ conflictCheck }` and is on the *server's*
    member-visible allow-list, so it is the most tempting thing to render next.
    The server deciding a member may receive a field is not this console
    deciding to draw it.
  */
  test("a file write's details are not drawn, though the server sends them", () => {
    /*
      A *string* detail rather than `file.write`'s real `{ conflictCheck: true }`,
      and that is the whole value of this test. Written with the boolean it
      passed under a sabotage that deleted the action allow-list entirely —
      because a boolean is dropped by the value filter one step later, so
      nothing here was exercising the guard it is named for. A test that cannot
      fail for its own reason is not a test.
    */
    expect(
      auditDetailLine(event({ action: "file.write", details: { conflictCheck: "skipped" } })),
    ).toBeNull();
  });

  test("a visibility change's details are not drawn", () => {
    expect(
      auditDetailLine(
        event({ action: "visibility.note", details: { visibility: "private", exception: true } }),
      ),
    ).toBeNull();
  });

  test("a grant's details are not drawn", () => {
    expect(auditDetailLine(event({ action: "grant.revoked", details: { reason: "client_revocation" } })))
      .toBeNull();
  });

  /*
    The case that matters most: an action this build has never heard of, from a
    control plane newer than this bundle. It renders its *name* — that is the
    closed-set-read-openly rule this file already follows — and never its
    payload.
  */
  test("an action this build does not know renders its name and never its payload", () => {
    const unknown = event({ action: "billing.card_updated", details: { last4: "4242" } });
    expect(auditActionLabel(unknown.action)).toBe("billing card updated");
    expect(auditDetailLine(unknown)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe("even on the row it does draw, only the four named keys cross", () => {
  /*
    A `details` that one day carries a body, a token, a full URL or a header
    renders exactly as much as it does today. The keys are named in
    `RENDERED_DETAILS`; a key that is not named is not drawn, so this stays true
    without anybody re-reading the client when the server grows a field.
  */
  test("a body, a token, a URL and a header are all absent from the line", () => {
    const line = auditDetailLine(
      event({
        details: {
          pluginId: "youversion-linker",
          host: "www.bible.com",
          method: "GET",
          status: 200,
          body: "For God so loved the world",
          authorization: "Bearer sk-live-do-not-print-me",
          url: "https://www.bible.com/bible/1/JHN.3.16?token=secret",
          setCookie: "session=abc",
        },
      }),
    );
    expect(line).toBe("youversion-linker · www.bible.com · GET · 200");
    for (const secret of ["Bearer", "sk-live", "token=secret", "session=abc", "so loved"]) {
      expect(line).not.toContain(secret);
    }
  });

  /*
    The URL's path is deliberately not among the keys, and this says so out
    loud: the host is the unit a grant is written in, and the path is what the
    plugin was reading — which verse somebody looked up is their business.
  */
  test("the host is drawn and the path it was reaching is not", () => {
    const line = auditDetailLine(
      event({ details: { ...event().details, path: "/bible/1/JHN.3.16" } }),
    );
    expect(line).toContain("www.bible.com");
    expect(line).not.toContain("JHN.3.16");
  });
});

/* -------------------------------------------------------------------------- */

describe("the values are bounded and flattened, because a plugin picks some of them", () => {
  /*
    `method` is the one field of the four a *plugin* supplies — `host` is
    re-derived from the parsed URL by the server, `pluginId` comes from the
    session, `status` from the broker's own response. It is bounded hardest,
    and all four are bounded, because a cap the producer applies to itself is
    not a cap.
  */
  test("a plugin cannot push an essay through the method field", () => {
    const line = auditDetailLine(event({ details: { method: "G".repeat(500) } }));
    expect(line).toBe("G".repeat(12));
  });

  test("nor a paragraph through its own id", () => {
    const line = auditDetailLine(event({ details: { pluginId: "p".repeat(500) } }));
    expect(line).toBe("p".repeat(60));
  });

  /*
    A newline inside one value would draw as an extra line of audit trail that
    nothing recorded — a row claiming an event that never happened, in the one
    screen whose whole job is to be believed.
  */
  test("a newline cannot forge a second line of trail", () => {
    const line = auditDetailLine(
      event({ details: { pluginId: "ok\nDeleted a note\nsomebody@example.test", host: "h" } }),
    );
    expect(line).not.toContain("\n");
    expect(line).toBe("ok Deleted a note somebody@example.test · h");
  });

  test("a boolean, an object and a NaN are dropped rather than stringified", () => {
    const line = auditDetailLine(
      event({
        details: {
          pluginId: "keep-me",
          host: true as unknown as string,
          method: { toString: () => "nope" } as unknown as string,
          status: Number.NaN,
        },
      }),
    );
    expect(line).toBe("keep-me");
  });

  test("an inherited key is not a key this row has", () => {
    const details = Object.create({ host: "evil.test" }) as Record<string, string>;
    details.pluginId = "youversion-linker";
    expect(auditDetailLine(event({ details }))).toBe("youversion-linker");
  });
});
