import { describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import {
  auditActionLabel,
  auditActorLabel,
  buildKeyExportDocument,
  canReadAuditTrail,
  describeKeyExportFailure,
  type ConsoleAuditEvent,
} from "../features/console/advanced/advanced";

describe("who may read the audit trail through the console", () => {
  // `listEvents` itself is member-readable on the backend, and `paths` is now
  // gated server-side to the reader's own clearance or their own rows. This
  // gate is deliberately stricter still: a member reading the trail keeps
  // every row's incidence and whatever `details` the allow-list publishes,
  // and this console gate holds that narrower residual signal at `owner`
  // until a product decision opens it. See `canReadAuditTrail`'s own doc
  // comment for the current reasoning.
  test("only the owner, never a member or an editor", () => {
    expect(canReadAuditTrail("owner")).toBe(true);
    expect(canReadAuditTrail("editor")).toBe(false);
    expect(canReadAuditTrail("member")).toBe(false);
    expect(canReadAuditTrail(undefined)).toBe(false);
  });
});

describe("naming an action for the audit trail", () => {
  test("a known action reads in words", () => {
    expect(auditActionLabel("file.write")).toBe("Edited a note");
    expect(auditActionLabel("share.created")).toBe("Shared a note with somebody");
  });

  test("an action this build has never heard of still reads as activity", () => {
    // A control plane newer than this bundle can record an action this build
    // does not know — the same closed-set-read-openly rule `fastSearchStateOf`
    // follows — so the fallback must never drop the row or throw.
    expect(auditActionLabel("workspace.something_new")).toBe("workspace something new");
  });
});

describe("naming who acted", () => {
  function event(partial: Partial<ConsoleAuditEvent>): ConsoleAuditEvent {
    return { eventId: "e1", action: "file.write", paths: [], at: 0, ...partial };
  }

  test("an email wins over everything else", () => {
    expect(
      auditActorLabel(event({ actorEmail: "seyi@example.com", actorClientId: "claude" })),
    ).toBe("seyi@example.com");
  });

  test("an OAuth client names an AI app when there is no person", () => {
    expect(auditActorLabel(event({ actorClientId: "Claude Desktop" }))).toBe("Claude Desktop");
  });

  test("a user id with no email is somebody who has since left", () => {
    expect(auditActorLabel(event({ actorUserId: "u1" }))).toBe(
      "Someone no longer on this context",
    );
  });

  test("no actor at all is the context itself", () => {
    expect(auditActorLabel(event({}))).toBe("Context itself");
  });

  test("blank strings are treated as absent, not printed as a name", () => {
    expect(auditActorLabel(event({ actorEmail: "  ", actorClientId: "claude" }))).toBe("claude");
  });
});

describe("building the key export document", () => {
  test("matches the shape docs/decisions/encryption.md specifies", () => {
    const doc = buildKeyExportDocument(
      "kg2cabc",
      { current: "k2", keys: [{ generation: "k1", material: "aaa" }, { generation: "k2", material: "bbb" }] },
      Date.parse("2026-09-07T20:00:00.000Z"),
    );
    expect(doc).toEqual({
      v: 1,
      workspace_id: "kg2cabc",
      exported_at: "2026-09-07T20:00:00.000Z",
      current: "k2",
      keys: [
        { generation: "k1", alg: "A256GCM", key: "aaa" },
        { generation: "k2", alg: "A256GCM", key: "bbb" },
      ],
      envelope: { version: 1, alg: "A256GCM", spec: "docs/decisions/encryption.md" },
    });
  });

  test("never carries the workspace's internal id under a different name", () => {
    // `workspace_id` is the only place the id appears — a second copy under a
    // different key is a second thing to keep in sync with the spec.
    const doc = buildKeyExportDocument("ws1", { current: "k1", keys: [{ generation: "k1", material: "x" }] }, 0);
    expect(JSON.stringify(doc).match(/ws1/g)).toHaveLength(1);
  });
});

describe("turning a failed export into something a person can act on", () => {
  function refusal(code: string) {
    return new ConvexError({ code, message: "irrelevant" });
  }

  test("the rate limit names the actual limit, not a generic retry", () => {
    expect(describeKeyExportFailure(refusal("RATE_LIMITED")).next).toContain("five");
  });

  test("a non-owner is told who can act", () => {
    expect(describeKeyExportFailure(refusal("INSUFFICIENT_ROLE")).headline).toContain("owner");
  });

  test("an unrecognised refusal never repeats the raw error", () => {
    const failure = describeKeyExportFailure(new Error("ECONNRESET at socket.js:42"));
    expect(failure.headline).not.toContain("ECONNRESET");
  });
});
