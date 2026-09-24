// Split out of `auth.test.ts`: our own MTA folding its own long verdict,
// the production refusal as the real chain shapes it, turning a verdict
// into a label, `domainOf`, and a folded verdict that cannot be read into a
// stronger claim. `identityAndAlignment.test.ts` covers the suite's overall
// rationale; `arcAndForwarding.test.ts` covers the ARC-parsing checks.
// `fixtures.ts` holds the shared imports and ARC message fixtures.

import { describe, expect, it } from "vitest";
import {
  describeArcShape,
  describeSender,
  domainOf,
  parseArcAuthenticationResults,
  parseAuthenticationResults,
  verifySender,
  DEFAULT_MIME_LIMITS,
  parseEmail,
  htmlToText,
  AUTHSERV,
  verify,
  PASSING,
  MX,
  LIMITS,
  deliver,
  FORWARDED_PRIMARY,
  RELAYED_ARC,
  OUR_ARC,
  FROM_AND_BODY,
} from "./fixtures";

/**
 * The other half of the fold rule: our own MTA's long header, which it folds.
 *
 * This is the shape production actually produced — a Resend message that used
 * to log `authMethod: "dkim"` and then, once the fold rule landed, logged
 * `authMethod: "none"` with `authFailure: "folded_authentication_results"`.
 * Every capture carried the spoofing warning after that, which is precisely how
 * a warning stops being read.
 *
 * SABOTAGE, both directions:
 *
 *   - delete `authenticationResultsFirstLine` (or make `verifySender` read
 *     `headers[0]` when folded) → "reads the clauses our MTA fitted on the
 *     first line" goes RED with `folded_authentication_results`, i.e. back to
 *     warning about everybody;
 *   - make the fold trust the *whole* unfolded value → "refuses when the sender
 *     folds a passing method into Authentication-Results" above goes RED with
 *     `ok: true`, i.e. a stranger gets `verified: true` on somebody's note.
 */
describe("our own MTA folding its own long verdict", () => {
  /**
   * Cloudflare's `Authentication-Results` as it wraps it, with the ARC set it
   * seals sitting *below* — which is the placement that makes the interior
   * discriminator useless as well as unsound, since the sender writes that
   * region too.
   */
  const CLOUDFLARE_FOLDED =
    `Received: from a1.resend.dev (a1.resend.dev [149.72.154.232])\n` +
    `\tby ${MX} with ESMTPS id 4bJcRHrMGNRW\n` +
    `\tfor <capture@ctx.test>; Mon, 25 Aug 2026 09:14:02 +0000\n` +
    `Authentication-Results: ${MX}; dkim=pass header.d=resend.dev\n` +
    `\theader.i=@resend.dev header.b="Vv3nQx8K";\n` +
    `\tspf=pass (${MX}: domain of bounces@resend.dev designates 149.72.154.232\n` +
    `\tas permitted sender) smtp.mailfrom=bounces@resend.dev;\n` +
    `\tdmarc=pass (p=NONE sp=NONE dis=NONE) header.from=resend.dev\n` +
    `ARC-Seal: i=1; a=rsa-sha256; d=cloudflare.net; s=2024; cv=none; b=QUE=\n` +
    `ARC-Message-Signature: i=1; a=rsa-sha256; d=cloudflare.net; s=2024; b=QkI=\n` +
    `ARC-Authentication-Results: i=1; ${MX}; dkim=pass header.d=resend.dev;\n` +
    `\tspf=pass smtp.mailfrom=bounces@resend.dev\n` +
    `From: Resend <notifications@resend.dev>\n` +
    `Subject: Your API key\n\nbody\n`;

  it("reads the clauses our MTA fitted on the first line, and names the real method", () => {
    const { parsed, verdict } = deliver(CLOUDFLARE_FOLDED);
    expect(parsed.authenticationResultsFolded).toEqual([true]);
    expect(verdict).toEqual({
      ok: true,
      address: "notifications@resend.dev",
      domain: "resend.dev",
      // `dkim`, not `dmarc`: the `dmarc=pass` is on a continuation line, so it
      // is not read and the label does not claim it. Naming a method the
      // message did not prove on the line we trusted would be the lie this
      // whole file exists to avoid.
      method: "dkim",
    });
  });

  it("keeps the sender out of the value it read", () => {
    // The first line stops where our MTA's CRLF was. Everything after it —
    // including anything a sender spliced on — is absent from the string
    // `verifySender` parses, which is the entire safety argument.
    const { parsed } = deliver(CLOUDFLARE_FOLDED);
    expect(parsed.authenticationResultsFirstLine).toEqual([
      `${MX}; dkim=pass header.d=resend.dev`,
    ]);
    expect(parsed.authenticationResults[0]).toContain("dmarc=pass");
    expect(parsed.authenticationResultsFirstLine[0]).not.toContain("dmarc");
  });

  it("stays unverified when the MTA folded before any clause — a known cost", () => {
    // An MTA that wraps immediately after the authserv-id leaves nothing on the
    // first line to read, and this comes out unverified. That is the
    // fail-closed direction and it is the limitation to watch: if Cloudflare
    // turns out to wrap this way, `authMethod` stays `none` in the log and the
    // fix has not helped, which is the signal to reach for the ARC set our MTA
    // seals *above* the AR instead. See `verifyViaArc`.
    const { verdict } = deliver(
      `Authentication-Results: ${MX};\n` +
        `\tdkim=pass header.d=resend.dev;\n` +
        `\tdmarc=pass header.from=resend.dev\n` +
        `From: notifications@resend.dev\n\nbody\n`,
    );
    expect(verdict).toEqual({ ok: false, reason: "folded_authentication_results" });
  });

  it("still refuses a folded verdict whose first line names somebody else", () => {
    const { verdict } = deliver(
      `Authentication-Results: ${MX}; dkim=pass header.d=evil.test\n` +
        `\theader.b="Zz"; dmarc=pass header.from=resend.dev\n` +
        `From: notifications@resend.dev\n\nbody\n`,
    );
    expect(verdict).toEqual({ ok: false, reason: "folded_authentication_results" });
  });

  it("still refuses a folded verdict bearing a foreign authserv-id", () => {
    // The authserv-id is the first token of the first line, so truncation can
    // never hide it — and this reason is reported as itself rather than
    // rewritten to the fold.
    const { verdict } = deliver(
      `Authentication-Results: attacker.test; dkim=pass header.d=resend.dev\n` +
        `\theader.b="Zz"\n` +
        `From: notifications@resend.dev\n\nbody\n`,
    );
    expect(verdict).toEqual({ ok: false, reason: "foreign_authserv_id" });
  });

  it("labels the folded-but-readable delivery verified, which is the point", () => {
    const parsed = parseEmail(new TextEncoder().encode(CLOUDFLARE_FOLDED), LIMITS, htmlToText);
    const identity = describeSender({
      authenticationResults: parsed.authenticationResults,
      authenticationResultsFolded: parsed.authenticationResultsFolded,
      authenticationResultsFirstLine: parsed.authenticationResultsFirstLine,
      arcAuthenticationResults: parsed.arcAuthenticationResults,
      fromAddress: parsed.fromAddress,
      authServiceId: MX,
    });
    expect(identity).toEqual({
      address: "notifications@resend.dev",
      domain: "resend.dev",
      verified: true,
      method: "dkim",
      failure: null,
    });
  });
});

/**
 * The production message, reproduced as ARC actually produces it — and it is
 * still refused.
 *
 * This is the honest half of the fixture above. In a real Gmail forward the ARC
 * set carrying the original verdict is sealed by **Google**, sits at `i=1`, and
 * names `mx.google.com`. Our MTA validates the chain and says `arc=pass`, but
 * unless it also seals a set of its own there is nothing in the message our MTA
 * wrote about what the *first* receiver saw — and RFC 8617 §7.2 is explicit
 * that a validated chain proves integrity, not honesty: anyone can seal a chain
 * of their own lies.
 *
 * Reading `i=1` therefore is not a loosening of the rules above, it is a
 * different mechanism: trust the *sealing domain*, which is knowable only from
 * `ARC-Seal: i=1; d=…` under `cv=pass`, and only against a list of forwarders
 * an operator has decided to believe. That is a product decision with a new
 * configuration surface, so it is pinned here as a known limitation rather than
 * guessed at in a parser.
 */
describe("the production refusal, as the real chain shapes it", () => {
  it("is still refused, because the only verdict worth reading was sealed by the forwarder", () => {
    const { parsed, verdict } = deliver(`${FORWARDED_PRIMARY}\n${RELAYED_ARC}\n${FROM_AND_BODY}`);
    expect(parsed.fromAddress).toBe("seyi@supa.media");
    expect(parsed.arcAuthenticationResults).toHaveLength(1);
    expect(parsed.arcAuthenticationResults[0]!.abovePrimary).toBe(false);
    expect(verdict).toEqual({ ok: false, reason: "unaligned" });
  });

  it("and the diagnostic says exactly why, in numbers a log may carry", () => {
    const parsed = parseEmail(
      new TextEncoder().encode(`${FORWARDED_PRIMARY}\n${RELAYED_ARC}\n${FROM_AND_BODY}`),
      LIMITS,
      htmlToText,
    );
    const shape = describeArcShape({
      authenticationResults: parsed.authenticationResults,
      arcAuthenticationResults: parsed.arcAuthenticationResults,
      fromAddress: parsed.fromAddress,
      authServiceId: MX,
    });
    // `ours=0` is the finding: the chain validated, one ARC header arrived, and
    // none of it was written by our own MTA.
    expect(shape).toBe("chain=pass headers=1 readable=1 above=0 ours=0 top=1");
    // Nothing a sender wrote is in it. That is what makes it loggable.
    expect(shape).not.toContain("supa.media");
    expect(shape).not.toContain("google");
    expect(shape).toMatch(/^[a-z=0-9 ]+$/);
  });
});

/**
 * The seam that turns a verdict into a label.
 *
 * `describeSender` is the only thing ./ingest.ts calls, so it is the one place
 * a "helpful" default could put a method name on a message that never earned
 * one. Sabotage targets, both of which the tests here catch:
 *
 *   - fill `method` from the verdict unconditionally → "never names a method";
 *   - drop the `verified` flag and let a caller infer it from `address` being
 *     non-empty → "an unverified identity still carries the claimed address".
 */
describe("turning a verdict into a label", () => {
  it("reports the proved address and the method that proved it", () => {
    const identity = describeSender({
      authenticationResults: [PASSING("example.com")],
      fromAddress: "alice@example.com",
      authServiceId: AUTHSERV,
    });
    expect(identity).toEqual({
      address: "alice@example.com",
      domain: "example.com",
      verified: true,
      method: "dmarc",
      failure: null,
    });
  });

  it("never names a method for a message that proved nothing", () => {
    // The single most dangerous thing this function could do: a note reading
    // `sender-authenticated-by: dmarc` about a message no DMARC verdict
    // covered would be a fabricated proof, which is worse than a missing one.
    for (const input of [
      { authenticationResults: [], fromAddress: "alice@example.com" },
      { authenticationResults: [PASSING("evil.test")], fromAddress: "alice@example.com" },
      {
        authenticationResults: [PASSING("example.com")],
        authenticationResultsFolded: [true],
        fromAddress: "alice@example.com",
      },
      { authenticationResults: [PASSING("example.com")], fromAddress: "alice@example.com", authServiceId: "" },
    ]) {
      const identity = describeSender({ authServiceId: AUTHSERV, ...input });
      expect(identity.verified).toBe(false);
      expect(identity.method).toBeNull();
      expect(identity.failure).not.toBeNull();
    }
  });

  it("an unverified identity still carries the claimed address, marked as a claim", () => {
    // This is the address the allow-list is then applied to. It has to be
    // there — a capture with no sender is useless — and `verified: false` is
    // the only thing distinguishing it from a proved one, which is why it is a
    // field rather than something a caller infers.
    const identity = describeSender({
      authenticationResults: [PASSING("evil.test")],
      fromAddress: "  alice@example.com  ",
      authServiceId: AUTHSERV,
    });
    expect(identity.address).toBe("alice@example.com");
    expect(identity.domain).toBe("example.com");
    expect(identity.verified).toBe(false);
    expect(identity.failure).toBe("unaligned");
  });

  it("names each failure distinctly, so the note can say which", () => {
    const failureOf = (input: Parameters<typeof describeSender>[0]) =>
      describeSender(input).failure;
    expect(
      failureOf({ authenticationResults: [], fromAddress: "a@example.com", authServiceId: AUTHSERV }),
    ).toBe("no_authentication_results");
    expect(
      failureOf({
        authenticationResults: [PASSING("example.com")],
        authenticationResultsFolded: [true],
        fromAddress: "a@example.com",
        authServiceId: AUTHSERV,
      }),
    ).toBe("folded_authentication_results");
    expect(
      failureOf({
        authenticationResults: [PASSING("example.com")],
        fromAddress: "a@example.com",
        authServiceId: "other.test",
      }),
    ).toBe("foreign_authserv_id");
    expect(
      failureOf({
        authenticationResults: [PASSING("example.com")],
        fromAddress: "",
        authServiceId: AUTHSERV,
      }),
    ).toBe("no_from_address");
  });

  it("carries an ARC pass through as the weaker claim it is", () => {
    const identity = describeSender({
      authenticationResults: [`${AUTHSERV}; dkim=pass header.d=forwarder.test; arc=pass`],
      arcAuthenticationResults: [
        {
          value: `i=1; ${AUTHSERV}; dmarc=pass header.from=example.com`,
          folded: false,
          abovePrimary: true,
        },
      ],
      fromAddress: "alice@example.com",
      authServiceId: AUTHSERV,
    });
    expect(identity.verified).toBe(true);
    expect(identity.method).toBe("arc-dmarc");
  });
});

describe("domainOf", () => {
  it("takes the last @, so a quoted local part cannot move the domain", () => {
    expect(domainOf('"a@b"@example.com')).toBe("example.com");
    expect(domainOf("alice@EXAMPLE.com")).toBe("example.com");
    expect(domainOf("nope")).toBe("");
    expect(domainOf("nope@")).toBe("");
    expect(domainOf("@nope")).toBe("");
  });
});

/**
 * Reading a folded verdict short assumes truncation can only ever weaken it.
 * `evaluateAlignment` has one branch where that is false.
 *
 * A `dmarc=pass` whose `header.from` names a domain other than the message's
 * From is a hard refusal — it returns `unaligned` and never falls through to
 * the `dkim` and `spf` checks after it. So that clause is a **veto**, and a
 * veto is the one kind of clause whose removal makes the verdict *stronger*.
 *
 * Cut it off with the fold and the same header stops refusing and starts
 * passing. Whether Cloudflare ever wraps its own header between those two
 * clauses is not known — the same unverified assumption about another system's
 * formatting the fold rule has run on since #35 — so this is defence in depth
 * rather than a demonstrated delivery. The guard costs one parse of a string we
 * already hold and can only ever refuse, so the risk runs the safe way.
 */
describe("a folded verdict cannot be read into a stronger claim", () => {
  const AUTHSERV = "mx.cloudflare.net";
  const FIRST_LINE = `${AUTHSERV}; dkim=pass header.d=victim.test`;
  const VETO = "dmarc=pass header.from=other.test";

  const ask = (full: string, firstLine: string, folded: boolean) =>
    verifySender({
      authenticationResults: [full],
      authenticationResultsFolded: [folded],
      authenticationResultsFirstLine: [firstLine],
      arcAuthenticationResults: [],
      fromAddress: "alice@victim.test",
      authServiceId: AUTHSERV,
    });

  it("refuses the intact header, which is the answer being preserved", () => {
    const full = `${FIRST_LINE}; ${VETO}`;
    expect(ask(full, full, false)).toEqual({ ok: false, reason: "unaligned" });
  });

  it("does not turn that refusal into a pass when the veto falls after the fold", () => {
    expect(ask(`${FIRST_LINE}; ${VETO}`, FIRST_LINE, true).ok).toBe(false);
  });

  it("still reads a folded header short when nothing was vetoing", () => {
    // The whole point of #52: an ordinary long header keeps working. Only a
    // clause that would have *refused* stops the short read.
    const full = `${FIRST_LINE}; spf=pass smtp.mailfrom=bounce@victim.test`;
    expect(ask(full, FIRST_LINE, true)).toEqual({
      ok: true,
      address: "alice@victim.test",
      domain: "victim.test",
      method: "dkim",
    });
  });

  it("does not veto a `dmarc=pass` that simply omits `header.from`", () => {
    // `evaluateAlignment` treats an absent `header.from` as "not a mismatch" —
    // some MTAs omit it, and DMARC is defined against the From domain anyway.
    // The veto must agree. Sabotage: drop the `!!claimed` guard, so the
    // comparison runs against `""`, and this refuses every folded header from
    // an MTA with that formatting — i.e. it labels ordinary mail unverified,
    // which is the production symptom #52 exists to remove.
    const full = `${FIRST_LINE}; dmarc=pass`;
    expect(ask(full, FIRST_LINE, true)).toEqual({
      ok: true,
      address: "alice@victim.test",
      domain: "victim.test",
      method: "dkim",
    });
  });

  /**
   * Where the veto runs, which is a different property from what it says.
   *
   * `FOLD_MAY_EXPLAIN` names the three reasons a fold could itself have caused.
   * `foreign_authserv_id` and `ambiguous_authentication_results` are
   * deliberately not among them — the authserv-id is the first token of the
   * first line, so it is never truncated away, and a duplicate header is a
   * finding about a *different* header. A veto checked before those two rules
   * would relabel both, and the sender chooses whether there is a veto.
   */
  describe("and cannot be used to relabel a refusal a fold could not have caused", () => {
    const FOREIGN = "evil.example; dkim=pass header.d=victim.test";

    it("still reports a foreign authserv-id, not the fold", () => {
      // The downgrade an attacker wants: from "a verdict written by an
      // authority we do not recognise, which is what a sender writing their
      // own verdict looks like" to "our own server folded its verdict", which
      // this file's own prose treats as a shrug.
      expect(ask(`${FOREIGN}; ${VETO}`, FOREIGN, true)).toEqual({
        ok: false,
        reason: "foreign_authserv_id",
      });
    });

    it("still reports two verdicts claiming our authority, not the fold", () => {
      const first = `${FIRST_LINE}; ${VETO}`;
      expect(
        verifySender({
          authenticationResults: [first, `${AUTHSERV}; dkim=pass header.d=victim.test`],
          authenticationResultsFolded: [true, false],
          authenticationResultsFirstLine: [FIRST_LINE, ""],
          arcAuthenticationResults: [],
          fromAddress: "alice@victim.test",
          authServiceId: AUTHSERV,
        }),
      ).toEqual({ ok: false, reason: "ambiguous_authentication_results" });
    });
  });
});
