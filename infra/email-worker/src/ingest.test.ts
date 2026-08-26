/**
 * The decision core.
 *
 * The block that matters most is "authentication gates the allow-list": it
 * proves the *order* of the two checks, which is the difference between a
 * control and a control-shaped hole. The rest covers recipient classification
 * (which is a mail-interception control, per CLAUDE.md), idempotency, path
 * safety, and the caps.
 */
import { describe, expect, it, vi } from "vitest";
import {
  captureFingerprint,
  classifyRecipient,
  decideCapture,
  DEFAULT_TARGET_FOLDER,
  normalizeTargetFolder,
  type IngestConfig,
} from "./ingest";
import { DEFAULT_MIME_LIMITS } from "./mime";
import type { IngestionPolicy, SenderMatcher } from "./policy";
import { AUTHSERV, rawMessage } from "./fixtures.test-helpers";
import { RESERVED_NAMES, RFC2142_MANDATORY_NAMES } from "../../../apps/convex/functions/lib/names";

/**
 * Stands in for `apps/convex/functions/lib`'s `senderIsAllowed` while the seam
 * in ./policy.ts is unwired.
 *
 * Deliberately minimal. It exists to drive the *ordering* tests below — does
 * authentication run first, is its verdict respected — and not to be a second
 * implementation of the matching rules. The real rules (exact domain equality,
 * the asymmetric sub-address handling) are tested where they live; restating
 * them here would create exactly the second opinion ./policy.ts warns about.
 */
const stubMatcher: SenderMatcher = (from, policy) => {
  if (policy.allowAnySender) return true;
  if (policy.allowedSenders.includes(from)) return true;
  const at = from.lastIndexOf("@");
  return at > 0 && policy.allowedDomains.includes(from.slice(at + 1));
};

const ALLOW_ALICE: IngestionPolicy = {
  allowedSenders: ["alice@example.com"],
  allowedDomains: [],
  allowAnySender: false,
};

function config(overrides: Partial<IngestConfig> = {}): IngestConfig {
  return {
    targetFolder: DEFAULT_TARGET_FOLDER,
    policy: ALLOW_ALICE,
    attachmentPolicy: "list",
    maxMessageBytes: 5_000_000,
    limits: DEFAULT_MIME_LIMITS,
    authServiceId: AUTHSERV,
    ...overrides,
  };
}

const NOW = new Date("2026-08-26T09:00:00.000Z");

function decide(
  raw: Uint8Array,
  overrides: Partial<IngestConfig> = {},
  matcher: SenderMatcher = stubMatcher,
) {
  return decideCapture(
    {
      recipient: "seyi@context.lc",
      owner: "seyi",
      raw,
      now: NOW,
      fenceNonce: "0123456789abcdef",
    },
    config(overrides),
    matcher,
  );
}

/* ------------------------------- recipients ------------------------------- */

describe("classifying a recipient", () => {
  it("accepts a claimable name on our domain", () => {
    expect(classifyRecipient("seyi@context.lc", "context.lc")).toEqual({
      kind: "personal",
      username: "seyi",
    });
  });

  it("is case-insensitive", () => {
    expect(classifyRecipient("SEYI@CONTEXT.LC", "context.lc")).toEqual({
      kind: "personal",
      username: "seyi",
    });
  });

  it("strips a sub-address tag and does not use it for anything", () => {
    // Notably it does NOT become a folder. Letting a stranger name part of the
    // destination path would be a write primitive.
    expect(classifyRecipient("seyi+receipts@context.lc", "context.lc")).toEqual({
      kind: "personal",
      username: "seyi",
    });
  });

  it("refuses another domain", () => {
    for (const address of [
      "seyi@example.com",
      "seyi@context.lc.evil.test",
      "seyi@notcontext.lc",
      "seyi@sub.context.lc",
    ]) {
      expect(classifyRecipient(address, "context.lc")).toEqual({
        kind: "refuse",
        reason: "foreign_recipient_domain",
      });
    }
  });

  it("refuses everything when no ingest domain is configured", () => {
    expect(classifyRecipient("seyi@context.lc", "")).toEqual({
      kind: "refuse",
      reason: "foreign_recipient_domain",
    });
  });

  it("forwards the RFC 2142 mandatory mailboxes instead of ingesting them", () => {
    // CLAUDE.md: "RFC 2142 requires postmaster and abuse stay deliverable to
    // us". If either of these ever classified as `personal`, someone could
    // claim the name and receive our mail.
    expect(RFC2142_MANDATORY_NAMES).toEqual(["postmaster", "abuse"]);
    for (const name of RFC2142_MANDATORY_NAMES) {
      expect(classifyRecipient(`${name}@context.lc`, "context.lc")).toEqual({
        kind: "operations",
        localPart: name,
      });
    }
  });

  it("refuses every reserved name, so a mailbox cannot be intercepted", () => {
    // The reserved list is a mail-interception control, not cosmetic. Sabotage:
    // drop the `RESERVED_NAMES` check and `support@context.lc` starts
    // resolving to whoever claimed the name.
    for (const name of RESERVED_NAMES) {
      if (RFC2142_MANDATORY_NAMES.includes(name)) continue;
      const decision = classifyRecipient(`${name}@context.lc`, "context.lc");
      expect(decision.kind).toBe("refuse");
    }
  });

  it("refuses a malformed local part rather than normalising it into a valid one", () => {
    for (const local of ["", "a", "-nope", "nope-", "has space", "a".repeat(40), "under_score"]) {
      const decision = classifyRecipient(`${local}@context.lc`, "context.lc");
      expect(decision.kind).toBe("refuse");
    }
  });

  it("refuses something that is not an address at all", () => {
    expect(classifyRecipient("not-an-address", "context.lc").kind).toBe("refuse");
    expect(classifyRecipient("@context.lc", "context.lc").kind).toBe("refuse");
  });

  it("only ever produces a personal destination, never any other kind", () => {
    // The model, asserted at the one function that turns an address into a
    // destination: a local part is a *username*, and a username is a personal
    // context. `classifyRecipient` has no variant that could carry a shared
    // context, so there is nothing here to refuse — it is not expressible.
    // Sabotage: add a `{ kind: "shared" }` arm to `RecipientDecision` for some
    // future "team inbox" feature and this fails on the first name that hits it.
    const names = ["seyi", "alice", "acme-board", "the-team", "shared-thing", "ops-team"];
    for (const name of names) {
      const decision = classifyRecipient(`${name}@context.lc`, "context.lc");
      expect(["personal", "operations", "refuse"], name).toContain(decision.kind);
      if (decision.kind === "personal") expect(decision.username, name).toBe(name);
    }
  });

  it("gives a tagged address exactly the destination the untagged one gets", () => {
    // With one personal context per person there is nothing left for a tag to
    // select, so it must not be able to change anything at all.
    expect(classifyRecipient("seyi+anything@context.lc", "context.lc")).toEqual(
      classifyRecipient("seyi@context.lc", "context.lc"),
    );
    expect(classifyRecipient("seyi+../escape@context.lc", "context.lc")).toEqual(
      classifyRecipient("seyi@context.lc", "context.lc"),
    );
  });
});

/* -------------------- authentication gates the allow-list ------------------- */

describe("authentication gates the allow-list", () => {
  it("accepts an allowed sender whose message authenticates", async () => {
    const decision = await decide(rawMessage({ from: "alice@example.com" }));
    expect(decision.kind).toBe("capture");
  });

  it("refuses an allowed sender whose message fails authentication", async () => {
    // The headline case. Everything about this message is on the allow-list;
    // the only thing missing is proof.
    const decision = await decide(rawMessage({ from: "alice@example.com", authResults: null }));
    expect(decision).toEqual({ kind: "refuse", reason: "auth_no_authentication_results" });
  });

  it("refuses a spoofed From: naming an allowed sender but authenticated elsewhere", async () => {
    // `evil.test` sends perfectly authenticated mail claiming to be alice.
    const decision = await decide(
      rawMessage({
        from: "alice@example.com",
        authResults: [
          `${AUTHSERV}; dkim=pass header.d=evil.test; spf=pass smtp.mailfrom=m@evil.test; dmarc=pass header.from=evil.test`,
        ],
      }),
    );
    expect(decision).toEqual({ kind: "refuse", reason: "auth_unaligned" });
  });

  it("never consults the matcher for a message that failed authentication", async () => {
    // Sabotage: move the `matcher(...)` call above `verifySender` and this
    // fails — which is the whole point of asserting it separately from the
    // outcome. An implementation that checked the list first and the verdict
    // second would still refuse *this* message, and would still be wrong.
    const matcher = vi.fn<SenderMatcher>(() => true);
    const decision = await decide(
      rawMessage({ from: "mallory@evil.test", authResults: null }),
      {},
      matcher,
    );
    expect(decision.kind).toBe("refuse");
    expect(matcher).not.toHaveBeenCalled();
  });

  it("hands the matcher the proved address, not the raw From: header", async () => {
    const matcher = vi.fn<SenderMatcher>(() => true);
    await decide(rawMessage({ from: "Alice <alice@example.com>" }), {}, matcher);
    expect(matcher).toHaveBeenCalledTimes(1);
    expect(matcher.mock.calls[0]![0]).toBe("alice@example.com");
  });

  it("refuses an authenticated sender who is not on the list", async () => {
    const decision = await decide(rawMessage({ from: "stranger@example.net" }));
    expect(decision).toEqual({ kind: "refuse", reason: "sender_not_allowed" });
  });

  it("still requires authentication under allowAnySender", async () => {
    // `allowAnySender` means "any sender who is really who they say they are",
    // never "skip the check".
    const policy: IngestionPolicy = {
      allowedSenders: [],
      allowedDomains: [],
      allowAnySender: true,
    };
    expect((await decide(rawMessage({ from: "anyone@example.net" }), { policy })).kind).toBe(
      "capture",
    );
    const unauthenticated = await decide(
      rawMessage({ from: "anyone@example.net", authResults: null }),
      { policy },
    );
    expect(unauthenticated.kind).toBe("refuse");
  });

  it("treats a matcher that throws as a matcher that said no", async () => {
    const decision = await decide(rawMessage(), {}, () => {
      throw new Error("boom");
    });
    expect(decision).toEqual({ kind: "refuse", reason: "sender_not_allowed" });
  });

  it("treats a non-boolean matcher answer as a no", async () => {
    const decision = await decide(rawMessage(), {}, (() => "yes") as unknown as SenderMatcher);
    expect(decision).toEqual({ kind: "refuse", reason: "sender_not_allowed" });
  });
});

/* -------------------------------- the write -------------------------------- */

describe("what gets written", () => {
  it("keys the note by the message id, under the target folder", async () => {
    const decision = await decide(rawMessage({ messageId: "<msg-1@example.com>" }));
    expect(decision.kind).toBe("capture");
    if (decision.kind !== "capture") return;
    const fingerprint = await captureFingerprint("msg-1@example.com", new Uint8Array());
    expect(decision.key).toBe(`0-inbox/email/${fingerprint.slice(0, 24)}.md`);
  });

  it("gives a redelivered message the same key", async () => {
    // Idempotency. A retried SMTP delivery repeats the Message-ID, so it
    // computes the same key and index.ts finds the note already there.
    const first = await decide(rawMessage({ body: "one" }));
    const second = await decide(rawMessage({ body: "one" }));
    expect(first.kind === "capture" && second.kind === "capture").toBe(true);
    if (first.kind !== "capture" || second.kind !== "capture") return;
    expect(first.key).toBe(second.key);
  });

  it("gives two different messages different keys", async () => {
    const first = await decide(rawMessage({ messageId: "<a@example.com>" }));
    const second = await decide(rawMessage({ messageId: "<b@example.com>" }));
    if (first.kind !== "capture" || second.kind !== "capture") return;
    expect(first.key).not.toBe(second.key);
  });

  it("falls back to hashing the bytes when there is no Message-ID", async () => {
    const first = await decide(rawMessage({ messageId: null, body: "same" }));
    const second = await decide(rawMessage({ messageId: null, body: "same" }));
    const other = await decide(rawMessage({ messageId: null, body: "different" }));
    if (first.kind !== "capture" || second.kind !== "capture" || other.kind !== "capture") return;
    expect(first.key).toBe(second.key);
    expect(first.key).not.toBe(other.key);
  });

  it("honours a configured target folder", async () => {
    const decision = await decide(rawMessage(), { targetFolder: "3-resources/mail" });
    if (decision.kind !== "capture") return;
    expect(decision.key.startsWith("3-resources/mail/email/")).toBe(true);
  });

  it("never namespaces the key by tenant", async () => {
    // Tenancy is bucket-level. Sabotage: prefix with a context id and this
    // fails — as does an existing brain connecting with zero migration.
    const decision = await decide(rawMessage());
    if (decision.kind !== "capture") return;
    expect(decision.key.startsWith("0-inbox/")).toBe(true);
    expect(decision.key).not.toMatch(/workspace|tenant/);
  });
});

describe("the target folder is configuration, and is still a path", () => {
  it("accepts a plain folder and normalises the slash", () => {
    expect(normalizeTargetFolder("0-inbox")).toBe("0-inbox/");
    expect(normalizeTargetFolder("0-inbox/")).toBe("0-inbox/");
    expect(normalizeTargetFolder("a/b/c")).toBe("a/b/c/");
    expect(normalizeTargetFolder("")).toBe(DEFAULT_TARGET_FOLDER);
  });

  it("refuses anything that could escape the bucket", () => {
    // A `..` here would escape the customer's configured root prefix on every
    // single capture. Sabotage: return the default instead of `null` and a
    // misconfiguration becomes invisible.
    for (const bad of ["..", "../escape", "a/../../b", "a/./b", "a//b", "a\\b", "x".repeat(300)]) {
      expect(normalizeTargetFolder(bad)).toBeNull();
    }
  });

  it("refuses to capture at all when the folder is unusable", async () => {
    const decision = await decide(rawMessage(), { targetFolder: "../escape" });
    expect(decision).toEqual({ kind: "refuse", reason: "invalid_target_folder" });
  });
});

describe("caps and empties", () => {
  it("refuses a message over the configured size", async () => {
    const decision = await decide(rawMessage({ body: "x".repeat(5_000) }), {
      maxMessageBytes: 1_000,
    });
    expect(decision).toEqual({ kind: "refuse", reason: "message_too_large" });
  });

  it("refuses a message with nothing in it", async () => {
    const decision = await decide(rawMessage({ body: "   \r\n  " }));
    expect(decision).toEqual({ kind: "refuse", reason: "empty_message" });
  });

  it("accepts an attachment-only message when attachments are kept", async () => {
    const raw = new TextEncoder().encode(
      [
        `Authentication-Results: ${AUTHSERV}; dmarc=pass header.from=example.com`,
        "From: alice@example.com",
        "Message-ID: <att@example.com>",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="r.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        "aGk=",
        "--b--",
        "",
      ].join("\r\n"),
    );
    expect((await decide(raw)).kind).toBe("capture");
    expect((await decide(raw, { attachmentPolicy: "ignore" }))).toEqual({
      kind: "refuse",
      reason: "empty_message",
    });
  });
});

describe("stored attachments", () => {
  const withAttachment = (filename: string) =>
    new TextEncoder().encode(
      [
        `Authentication-Results: ${AUTHSERV}; dmarc=pass header.from=example.com`,
        "From: alice@example.com",
        "Message-ID: <att@example.com>",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "see attached",
        "--b",
        "Content-Type: application/pdf",
        `Content-Disposition: attachment; filename="${filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        "aGk=",
        "--b--",
        "",
      ].join("\r\n"),
    );

  it("writes nothing extra under the default policy", async () => {
    const decision = await decide(withAttachment("r.pdf"));
    if (decision.kind !== "capture") return;
    expect(decision.attachments).toEqual([]);
    expect(decision.note).toContain("not stored");
  });

  it("content-addresses a stored attachment under the target folder", async () => {
    const decision = await decide(withAttachment("r.pdf"), { attachmentPolicy: "store" });
    if (decision.kind !== "capture") return;
    expect(decision.attachments).toHaveLength(1);
    expect(decision.attachments[0]!.key).toMatch(
      /^0-inbox\/email\/attachments\/[0-9a-f]{12}-r\.pdf$/,
    );
  });

  it("cannot be made to write outside the target folder", async () => {
    // Sabotage: use the declared filename verbatim and the first of these
    // writes into `.history/` or out of the bucket entirely.
    for (const hostile of [
      "../../../../etc/passwd",
      "..%2f..%2fescape.md",
      "/absolute.md",
      ".history/overwrite.md",
      "..",
    ]) {
      const decision = await decide(withAttachment(hostile), { attachmentPolicy: "store" });
      if (decision.kind !== "capture") throw new Error("expected a capture");
      for (const write of decision.attachments) {
        expect(write.key.startsWith("0-inbox/email/attachments/")).toBe(true);
        expect(write.key).not.toContain("..");
        expect(write.key.split("/")).toHaveLength(4);
      }
    }
  });
});
