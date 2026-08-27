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
import { senderIsAllowed, type IngestionPolicy, type SenderMatcher } from "./policy";
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

/**
 * The real matcher, for the one assertion that is about *its* behaviour rather
 * than about ordering: an unparseable address is refused before
 * `allowAnySender` is even consulted. `stubMatcher` above cannot stand in for
 * that, because the property being pinned is precisely the branch the stub does
 * not have.
 */
const realMatcher: SenderMatcher = senderIsAllowed;

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

/* ------------------- authentication labels; it does not gate ---------------- */

/**
 * The block that changed, and why every assertion in it inverted.
 *
 * It used to be called "authentication gates the allow-list" and it proved that
 * a message which failed `verifySender` was refused however good its `From:`
 * looked. That gate refused two real deliveries — an ordinary Gmail forward,
 * and then a message whose verdict *Cloudflare itself* had folded — and it was
 * removed deliberately. See the block at the top of ./auth.ts.
 *
 * So what these tests pin now is the replacement guarantee: the message is
 * captured, and the capture tells the truth about what was established. A note
 * that claimed a method nobody observed would be strictly worse than the
 * refusal this replaced, so the "does not claim a method" assertions here are
 * the ones to keep green.
 */
describe("authentication labels a capture; it does not gate one", () => {
  it("captures an allowed sender whose message authenticates, and names the method", async () => {
    const decision = await decide(rawMessage({ from: "alice@example.com" }));
    expect(decision.kind).toBe("capture");
    if (decision.kind !== "capture") return;
    expect(decision.log.authMethod).toBe("dmarc");
    expect(decision.log.authFailure).toBeUndefined();
    expect(decision.note).toContain("verified: true");
    expect(decision.note).toContain('sender-authenticated-by: "dmarc"');
  });

  it("captures an allowed sender whose message carries no authentication at all", async () => {
    // The headline case, inverted. Everything about this message is on the
    // allow-list; the only thing missing is proof, and proof is no longer the
    // price of admission.
    const decision = await decide(rawMessage({ from: "alice@example.com", authResults: null }));
    expect(decision.kind).toBe("capture");
    if (decision.kind !== "capture") return;
    expect(decision.log.authMethod).toBe("none");
    expect(decision.log.authFailure).toBe("no_authentication_results");
    expect(decision.note).toContain("verified: false");
    expect(decision.note).toContain('sender-authenticated-by: "none"');
    expect(decision.note).toContain("the sender address may be spoofed");
  });

  it("captures an unaligned forward — the delivery that motivated all of this", async () => {
    // `From:` is the original sender's; the delivering hop signed as itself.
    // This is what every forwarded message looks like, and it was refused
    // `auth_unaligned` in production.
    const decision = await decide(
      rawMessage({
        from: "alice@example.com",
        authResults: [
          `${AUTHSERV}; dkim=pass header.d=forwarder.test; spf=pass smtp.mailfrom=bounce@forwarder.test; dmarc=none header.from=example.com`,
        ],
      }),
    );
    expect(decision.kind).toBe("capture");
    if (decision.kind !== "capture") return;
    expect(decision.log.authFailure).toBe("unaligned");
    expect(decision.note).toContain('authentication-result: "unaligned"');
    expect(decision.note).toContain("the sender address may be spoofed");
  });

  it("captures a message whose verdict our own MTA folded", async () => {
    // The second refusal in production: Cloudflare folds its own long
    // `Authentication-Results`, and the anti-forgery rule refuses every folded
    // one. The rule stays — it still withholds the `verified` label — but it no
    // longer costs the owner the message.
    const decision = await decide(
      rawMessage({
        from: "alice@example.com",
        authResults: [
          `${AUTHSERV}; dkim=pass header.d=example.com;\r\n dmarc=pass header.from=example.com`,
        ],
      }),
    );
    expect(decision.kind).toBe("capture");
    if (decision.kind !== "capture") return;
    expect(decision.log.authFailure).toBe("folded_authentication_results");
    expect(decision.note).toContain("verified: false");
    expect(decision.note).toContain("folded across several lines");
  });

  it("captures a spoofed From: naming an allowed sender, and says it is unverified", async () => {
    // `evil.test` sends perfectly authenticated mail claiming to be alice, and
    // alice is on the list. This is the cost of the decision, and it is a real
    // one: the message lands. What stops it being laundered into the owner's
    // own voice is the label, so this asserts the label rather than the
    // refusal it used to assert.
    const decision = await decide(
      rawMessage({
        from: "alice@example.com",
        authResults: [
          `${AUTHSERV}; dkim=pass header.d=evil.test; spf=pass smtp.mailfrom=m@evil.test; dmarc=pass header.from=evil.test`,
        ],
      }),
    );
    expect(decision.kind).toBe("capture");
    if (decision.kind !== "capture") return;
    expect(decision.log.authMethod).toBe("none");
    expect(decision.log.authFailure).toBe("unaligned");
    expect(decision.note).toContain("verified: false");
    // The thing that must never happen: the note borrowing evil.test's pass.
    expect(decision.note).not.toContain('sender-authenticated-by: "dmarc"');
    expect(decision.note).not.toContain("verified: true");
  });

  it("hands the matcher the address on the message, display name discarded", async () => {
    const matcher = vi.fn<SenderMatcher>(() => true);
    await decide(rawMessage({ from: "Alice <alice@example.com>" }), {}, matcher);
    expect(matcher).toHaveBeenCalledTimes(1);
    expect(matcher.mock.calls[0]![0]).toBe("alice@example.com");
  });

  it("hands the matcher the claimed address when nothing authenticated", async () => {
    // The seam where the trade-off actually lands, asserted directly: with no
    // verdict to work from, the allow-list runs against a string the sender
    // typed. Anything that describes this list as a boundary is wrong — see
    // the header of ./policy.ts.
    const matcher = vi.fn<SenderMatcher>(() => true);
    await decide(
      rawMessage({ from: "Alice <alice@example.com>", authResults: null }),
      {},
      matcher,
    );
    expect(matcher.mock.calls[0]![0]).toBe("alice@example.com");
  });

  it("still refuses a sender the owner's list does not admit", async () => {
    // The refusal that remains, and it is not about trust: the owner said they
    // do not want mail from there.
    const decision = await decide(rawMessage({ from: "stranger@example.net" }));
    expect(decision).toEqual({ kind: "refuse", reason: "sender_not_allowed" });
  });

  it("refuses an unauthenticated stranger too — the list still filters", async () => {
    const decision = await decide(
      rawMessage({ from: "mallory@evil.test", authResults: null }),
    );
    expect(decision).toEqual({ kind: "refuse", reason: "sender_not_allowed" });
  });

  it("captures under allowAnySender whether or not anything authenticated", async () => {
    // `allowAnySender` now means literally any sender. It used to mean "any
    // sender who is really who they say they are", which was a sentence only a
    // gate could support.
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
    expect(unauthenticated.kind).toBe("capture");
    if (unauthenticated.kind !== "capture") return;
    expect(unauthenticated.note).toContain("verified: false");
  });

  it("refuses a message with no usable From:, even under allowAnySender", async () => {
    // The one authentication-shaped refusal that survives, and it survives for
    // a different reason: `senderIsAllowed` cannot match an address it cannot
    // parse, and it answers before it consults `allowAnySender`. A capture
    // with no sender at all is a note nobody can attribute or filter.
    const policy: IngestionPolicy = {
      allowedSenders: [],
      allowedDomains: [],
      allowAnySender: true,
    };
    const decision = await decide(rawMessage({ from: "not-an-address" }), { policy }, realMatcher);
    expect(decision).toEqual({ kind: "refuse", reason: "sender_not_allowed" });
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

  it("refuses the on-bucket plumbing folders", () => {
    // `.history/` and `.audit/` are where note history and the audit trail
    // live. A capture landing in `.history/` would forge note history — which
    // is why `lib/ingestion.ts` refuses any dot-prefixed segment on the write
    // path, and why this Worker refuses it again on the read path.
    //
    // `assertSafePrefix` does NOT catch these: it knows about `.` and `..` and
    // nothing about `.history`. So this used to hold only because the control
    // plane happened to have validated first, and a receiver whose defence is
    // "the other side checked" has no defence at all.
    //
    // Sabotage: drop the `controlPlaneFolderRules` call from
    // `normalizeTargetFolder` and every line here goes green again.
    for (const plumbing of [".history", ".history/", ".audit/", "a/.history/b", ".git/"]) {
      expect(normalizeTargetFolder(plumbing), plumbing).toBeNull();
    }
  });

  it("takes the control plane's verdict, not its repairs", () => {
    // `lib/ingestion.ts` collapses `a//b` to `a/b` on the write path, where a
    // person is typing a folder and a tidy-up is a kindness. Here it must not:
    // the stored form is already canonical, so a double slash means the answer
    // did not come from that path, and filing a capture at a repaired key is
    // the same failure as ignoring the folder outright. Sabotage: return the
    // product rule's `folder` instead of the input and this goes red.
    expect(normalizeTargetFolder("a//b")).toBeNull();
  });

  it("refuses to capture at all when the folder is unusable", async () => {
    const decision = await decide(rawMessage(), { targetFolder: "../escape" });
    expect(decision).toEqual({ kind: "refuse", reason: "invalid_target_folder" });
  });

  it("refuses to capture into the plumbing, end to end", async () => {
    const decision = await decide(rawMessage(), { targetFolder: ".history/" });
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

/**
 * The end-to-end shape of the ARC path, and the diagnostic that exists because
 * nobody has yet captured what Cloudflare really sends.
 *
 * The ARC work survived the change from gate to label, and it still earns its
 * keep: a forwarded message whose chain our MTA validated and re-sealed is the
 * one forwarded message that can be captured **verified**. What it no longer
 * decides is whether the message lands at all.
 *
 * The trust rules themselves live in ./auth.test.ts, with the forgery cases and
 * the sabotage targets. What is asserted here is the wiring — that
 * `decideCapture` hands the parser's positional and folding facts to
 * `verifySender` at all, which is the one way this feature could be silently
 * disarmed without a single auth test going red.
 */
describe("a forwarded message is verified only through the chain our MTA sealed", () => {
  const FORWARDED = `${AUTHSERV}; spf=none; dkim=pass header.d=forwarder.test;` +
    ` dmarc=none header.from=example.com; arc=pass`;

  const forwardedMessage = (arc: [string, string][]) =>
    rawMessage({
      from: "alice@example.com",
      authResults: [FORWARDED],
      leadingHeaders: arc,
    });

  it("captures one our MTA sealed, and records that it came via the chain", async () => {
    const decision = await decide(
      forwardedMessage([
        [
          "ARC-Authentication-Results",
          `i=2; ${AUTHSERV}; dkim=pass header.d=example.com; dmarc=pass header.from=example.com`,
        ],
      ]),
    );
    expect(decision.kind).toBe("capture");
    if (decision.kind !== "capture") return;
    // Not "dmarc". The note and the log both say the alignment came from a
    // chain, because that is a weaker claim than our own MTA making it.
    expect(decision.log.authMethod).toBe("arc-dmarc");
    expect(decision.log.authFailure).toBeUndefined();
    expect(decision.log.sender).toBe("alice@example.com");
    expect(decision.note).toContain("arc-dmarc");
    expect(decision.note).toContain("verified: true");
  });

  it("captures the same message unverified when the ARC set is one the sender supplied", async () => {
    // Identical but for position: a sender's headers land below our MTA's
    // verdict, and this is the wiring that carries that fact through. The
    // message still lands — it is an ordinary forward — but the sender does not
    // get to hand themselves the `verified` label by typing an ARC header.
    const decision = await decide(
      rawMessage({
        from: "alice@example.com",
        authResults: [FORWARDED],
        trailingHeaders: [
          [
            "ARC-Authentication-Results",
            `i=2; ${AUTHSERV}; dkim=pass header.d=example.com; dmarc=pass header.from=example.com`,
          ],
        ],
      }),
    );
    expect(decision.kind).toBe("capture");
    if (decision.kind !== "capture") return;
    expect(decision.log.authMethod).toBe("none");
    expect(decision.log.authFailure).toBe("unaligned");
    expect(decision.note).toContain("verified: false");
    expect(decision.note).not.toContain("arc-dmarc");
  });

  it("carries no ARC diagnostic unless the operator asked for one", async () => {
    const decision = await decide(rawMessage({ from: "alice@example.com", authResults: [FORWARDED] }));
    expect(decision.kind).toBe("capture");
    if (decision.kind !== "capture") return;
    expect(decision.log.arc).toBeUndefined();
  });

  it("emits a bounded ARC shape when the operator did", async () => {
    // It rides on the capture log now: there is no authentication refusal left
    // for it to ride on.
    const decision = await decide(
      rawMessage({
        from: "alice@example.com",
        authResults: [FORWARDED],
        trailingHeaders: [["ARC-Authentication-Results", "i=1; mx.google.test; dmarc=pass"]],
      }),
      { arcDiagnostics: true },
    );
    expect(decision.kind).toBe("capture");
    if (decision.kind !== "capture") return;
    expect(decision.log.arc).toBe("chain=pass headers=1 readable=1 above=0 ours=0 top=1");
  });

  it("emits no ARC shape for a capture that verified, even with the flag on", async () => {
    // The flag exists to explain why mail arrives unverified. A verified
    // capture has nothing to explain, and the diagnostic is not free — it is an
    // extension of a deliberately closed set of log fields.
    const decision = await decide(
      forwardedMessage([
        [
          "ARC-Authentication-Results",
          `i=2; ${AUTHSERV}; dkim=pass header.d=example.com; dmarc=pass header.from=example.com`,
        ],
      ]),
      { arcDiagnostics: true },
    );
    expect(decision.kind).toBe("capture");
    if (decision.kind !== "capture") return;
    expect(decision.log.arc).toBeUndefined();
  });
});
