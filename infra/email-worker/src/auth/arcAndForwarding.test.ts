// Split out of `auth.test.ts`: ARC-Authentication-Results parsing, a
// forwarded message accepted through our own sealed ARC set, chain
// ambiguity, and folded continuations that cannot forge either verdict.
// `identityAndAlignment.test.ts` covers the suite's overall rationale and
// the earlier checks; `labelsAndFolding.test.ts` covers the later ones.
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

describe("parsing an ARC-Authentication-Results header", () => {
  it("reads the instance tag, then the ordinary RFC 8601 payload", () => {
    const parsed = parseArcAuthenticationResults(
      `i=3; ${MX}; dkim=pass header.d=example.com; dmarc=pass header.from=example.com`,
    )!;
    expect(parsed.instance).toBe(3);
    expect(parsed.authservId).toBe(MX);
    expect(parsed.results.map((entry) => `${entry.method}=${entry.result}`)).toEqual([
      "dkim=pass",
      "dmarc=pass",
    ]);
  });

  it("refuses a value with no instance tag — that is an Authentication-Results", () => {
    // Sabotage: make the tag optional and every plain `Authentication-Results`
    // a sender writes becomes a candidate ARC set at an instance of our
    // choosing, which is a second forgery surface for free.
    expect(parseArcAuthenticationResults(`${MX}; dmarc=pass header.from=example.com`)).toBeNull();
  });

  it("refuses an instance outside RFC 8617's 1–50", () => {
    // The upper bound matters: instance numbers are how "ours is the newest"
    // is decided, so an unbounded one is an attacker-chosen maximum.
    expect(parseArcAuthenticationResults(`i=0; ${MX}; dmarc=pass`)).toBeNull();
    expect(parseArcAuthenticationResults(`i=51; ${MX}; dmarc=pass`)).toBeNull();
    expect(parseArcAuthenticationResults(`i=999; ${MX}; dmarc=pass`)).toBeNull();
    expect(parseArcAuthenticationResults(`i=x; ${MX}; dmarc=pass`)).toBeNull();
  });

  it("refuses a tag with nothing after it", () => {
    expect(parseArcAuthenticationResults("i=1")).toBeNull();
    expect(parseArcAuthenticationResults("i=1; !!!")).toBeNull();
  });
});

/**
 * The feature: a forwarded message is accepted through the chain, and only
 * through the one part of it our MTA wrote.
 *
 * SABOTAGE, both directions, and each is a named test below:
 *
 *   - delete the ARC path (or the `arc=pass` gate, or `abovePrimary`, or the
 *     authserv-id comparison) → "accepts a forwarded message …" goes RED;
 *   - delete the `abovePrimary` filter → "refuses a sender-supplied ARC set …"
 *     goes GREEN, i.e. anyone may claim to be anyone;
 *   - delete the authserv-id comparison → "refuses an ARC set from a foreign
 *     authority …" goes GREEN.
 */
describe("a forwarded message is accepted through the ARC set our MTA sealed", () => {
  it("accepts a forwarded message whose chain our MTA validated and re-sealed", () => {
    // The shape this depends on is INFERRED: that Cloudflare stamps its own ARC
    // set above `Authentication-Results` before Worker delivery. If it does
    // not, this fixture is still the correct behaviour for an MTA that does,
    // and the ARC path is simply inert. See `LOG_ARC_SHAPE`.
    const { verdict } = deliver(
      `${OUR_ARC}\n${FORWARDED_PRIMARY}\n${RELAYED_ARC}\n${FROM_AND_BODY}`,
    );
    expect(verdict).toEqual({
      ok: true,
      address: "seyi@supa.media",
      domain: "supa.media",
      // `arc-` and not `dmarc`: the capture note says out loud that the
      // alignment came from a chain rather than from our own MTA's check.
      method: "arc-dmarc",
    });
  });

  it("refuses the identical message when our MTA did not say the chain validated", () => {
    // Sabotage target: the `arc=pass` gate. Without it, a message carrying ARC
    // headers our MTA never validated is believed on the strength of the
    // headers alone.
    const { verdict } = deliver(
      `${OUR_ARC}\n${FORWARDED_PRIMARY.replace("; arc=pass", "; arc=fail")}\n` +
        `${RELAYED_ARC}\n${FROM_AND_BODY}`,
    );
    expect(verdict).toEqual({ ok: false, reason: "unaligned" });
  });

  it("refuses when our MTA reported no ARC result at all", () => {
    const { verdict } = deliver(
      `${OUR_ARC}\n${FORWARDED_PRIMARY.replace("; arc=pass", "")}\n` +
        `${RELAYED_ARC}\n${FROM_AND_BODY}`,
    );
    expect(verdict).toEqual({ ok: false, reason: "unaligned" });
  });

  it("refuses a sender-supplied ARC set, however perfect, because it is below our verdict", () => {
    // THE FORGERY. An attacker adds the header the feature reads, with our own
    // authserv-id and a passing DMARC for a domain they do not own. It arrives
    // below our MTA's `Authentication-Results`, because that is the only place
    // a sender's headers can be — and that is the whole defence.
    const { parsed, verdict } = deliver(
      `${FORWARDED_PRIMARY}\n` +
        `ARC-Authentication-Results: i=1; ${MX}; dmarc=pass header.from=someone-else.com\n` +
        `From: attacker@someone-else.com\nSubject: fwd\n\nhi\n`,
    );
    expect(parsed.arcAuthenticationResults).toHaveLength(1);
    expect(parsed.arcAuthenticationResults[0]!.abovePrimary).toBe(false);
    expect(verdict.ok).toBe(false);
  });

  it("refuses the same forgery aimed at the From: domain it claims to authenticate", () => {
    // The variant that would actually be worth an attacker's time: forge a pass
    // for a domain that IS on somebody's allow-list.
    const { verdict } = deliver(
      `${FORWARDED_PRIMARY}\n` +
        `ARC-Authentication-Results: i=1; ${MX}; dmarc=pass header.from=supa.media\n` +
        `From: attacker@supa.media\nSubject: fwd\n\nhi\n`,
    );
    expect(verdict).toEqual({ ok: false, reason: "unaligned" });
  });

  it("refuses an ARC set from a foreign authority even inside our MTA's own block", () => {
    // The authserv-id check on its own, with position held constant. Not a
    // shape a real delivery produces — which is exactly why it is asserted
    // here: it is the only way to see that check fail on its own.
    expect(
      verifySender({
        authenticationResults: [`${MX}; dkim=pass header.d=gmail.com; dmarc=none; arc=pass`],
        arcAuthenticationResults: [
          {
            value: "i=2; mx.attacker.test; dmarc=pass header.from=supa.media",
            folded: false,
            abovePrimary: true,
          },
        ],
        fromAddress: "seyi@supa.media",
        authServiceId: MX,
      }),
    ).toEqual({ ok: false, reason: "unaligned" });
  });

  it("ignores the chain entirely when our MTA's own verdict already passes", () => {
    // Ordering, asserted: a non-forwarded message resolves on the direct path
    // and never reaches the ARC code, so nothing in a forged ARC header can
    // change its outcome in either direction.
    const { verdict } = deliver(
      `Authentication-Results: ${MX}; dmarc=pass header.from=supa.media; arc=pass\n` +
        `ARC-Authentication-Results: i=1; ${MX}; dmarc=pass header.from=evil.test\n` +
        `From: seyi@supa.media\n\nhi\n`,
    );
    expect(verdict).toEqual({
      ok: true,
      address: "seyi@supa.media",
      domain: "supa.media",
      method: "dmarc",
    });
  });

  it("never lets the chain rescue a structural refusal about our own header", () => {
    // A foreign authserv-id on the topmost verdict is final. The ARC path sits
    // below that check and cannot be reached, however good the chain looks.
    const { verdict } = deliver(
      `${OUR_ARC}\n` +
        `Authentication-Results: mx.attacker.test; dmarc=pass header.from=supa.media; arc=pass\n` +
        `${RELAYED_ARC}\n${FROM_AND_BODY}`,
    );
    expect(verdict).toEqual({ ok: false, reason: "foreign_authserv_id" });
  });
});

describe("ambiguity in the chain refuses rather than picks", () => {
  it("refuses two ARC sets at the same instance bearing our authserv-id", () => {
    const { verdict } = deliver(
      `ARC-Authentication-Results: i=2; ${MX}; dmarc=pass header.from=supa.media\n` +
        `ARC-Authentication-Results: i=2; ${MX}; dmarc=pass header.from=evil.test\n` +
        `${FORWARDED_PRIMARY}\n${FROM_AND_BODY}`,
    );
    expect(verdict).toEqual({ ok: false, reason: "ambiguous_arc_authentication_results" });
  });

  it("refuses when something below claims an instance at or above ours", () => {
    // "Ours is the newest" is the reason a lower instance is not read. A
    // message that contradicts the numbering is one where that reasoning does
    // not hold, so there is nothing to fall back on.
    const { verdict } = deliver(
      `${OUR_ARC}\n${FORWARDED_PRIMARY}\n` +
        `ARC-Authentication-Results: i=7; mx.attacker.test; dmarc=pass header.from=evil.test\n` +
        `${FROM_AND_BODY}`,
    );
    expect(verdict).toEqual({ ok: false, reason: "ambiguous_arc_authentication_results" });
  });

  it("refuses an unreadable ARC header anywhere in the message", () => {
    // Not "skip it". The instance rule is a claim about the whole set, and a
    // set with a member we cannot read has no maximum we can compute.
    const { verdict } = deliver(
      `${OUR_ARC}\n${FORWARDED_PRIMARY}\n` +
        `ARC-Authentication-Results: garbage\n${RELAYED_ARC}\n${FROM_AND_BODY}`,
    );
    expect(verdict).toEqual({ ok: false, reason: "unparseable_arc_authentication_results" });
  });
});

/**
 * The folding attack, applied to both headers, because it works on both.
 *
 * A sender whose *first* header line begins with SP or HTAB has that line
 * appended — by correct RFC 5322 unfolding — to the last header the MTA wrote.
 * The result is one header, so the "a second header bearing our authserv-id is
 * fatal" rule never fires: nothing was added, ours was extended. These go
 * through the real `parseEmail` because the splice happens during unfolding.
 */
describe("a folded continuation cannot forge either verdict", () => {
  it("refuses when the sender folds a passing method into Authentication-Results", () => {
    const { parsed, verdict } = deliver(
      `Authentication-Results: ${MX}; dkim=none; spf=pass smtp.mailfrom=bounce@evil.test\n` +
        `\t; dmarc=pass header.from=supa.media\n` +
        `From: attacker@supa.media\n\nhi\n`,
    );
    expect(parsed.authenticationResults).toHaveLength(1);
    expect(parsed.authenticationResultsFolded).toEqual([true]);
    expect(verdict).toEqual({ ok: false, reason: "folded_authentication_results" });
  });

  it("refuses when the sender folds into our ARC-Authentication-Results", () => {
    // The same splice one header higher. Everything else about this message is
    // the genuine accepted fixture, so the fold is the only variable.
    const folded =
      `ARC-Seal: i=2; a=rsa-sha256; d=cloudflare.net; s=2024; cv=pass; b=QUE=\n` +
      `ARC-Message-Signature: i=2; a=rsa-sha256; d=cloudflare.net; s=2024; b=QkI=\n` +
      `ARC-Authentication-Results: i=2; ${MX}; dkim=none\n` +
      `\t; dmarc=pass header.from=supa.media\n`;
    const { parsed, verdict } = deliver(
      `${folded}${FORWARDED_PRIMARY}\n${RELAYED_ARC}\n${FROM_AND_BODY}`,
    );
    expect(parsed.arcAuthenticationResults).toHaveLength(2);
    expect(parsed.arcAuthenticationResults[0]!.folded).toBe(true);
    expect(verdict).toEqual({ ok: false, reason: "folded_arc_authentication_results" });
  });

  it("still accepts an ordinary unfolded delivery", () => {
    const { parsed, verdict } = deliver(
      `Authentication-Results: ${MX}; dmarc=pass header.from=supa.media\n` +
        `From: seyi@supa.media\n\nhi\n`,
    );
    expect(parsed.authenticationResultsFolded).toEqual([false]);
    expect(verdict).toMatchObject({ ok: true, method: "dmarc" });
  });

  it("marks only the header that was actually folded", () => {
    const { parsed } = deliver(
      `Authentication-Results: ${MX}; dmarc=pass header.from=supa.media\n` +
        `Subject: a long one\n\tcontinued here\n` +
        `From: seyi@supa.media\n\nhi\n`,
    );
    expect(parsed.authenticationResultsFolded).toEqual([false]);
    expect(parsed.subject).toBe("a long one continued here");
  });

  it("is not fooled by a Received: the sender wrote under their own splice", () => {
    // The discriminator NOT taken, pinned as a test so nobody takes it later.
    //
    // The tempting rule is "a folded AR with an MTA-ish header below it is
    // interior to the MTA's block, so the MTA folded it". The sender writes
    // every byte below the AR, so they supply that evidence themselves: this is
    // the #35 forgery with one extra line. Under the interior rule it is
    // verified as `attacker@supa.media`; under the rule that actually shipped —
    // read only what the MTA emitted before its own CRLF — the spliced clause
    // is not in the parsed string at all and the extra header changes nothing.
    const { parsed, verdict } = deliver(
      `Authentication-Results: ${MX}; dkim=none; spf=pass smtp.mailfrom=bounce@evil.test\n` +
        `\t; dmarc=pass header.from=supa.media\n` +
        `Received: from mx.cloudflare.net by mx.cloudflare.net; Mon, 25 Aug 2026 09:14:02 +0000\n` +
        `ARC-Seal: i=1; a=rsa-sha256; d=cloudflare.net; s=2024; cv=pass; b=QUE=\n` +
        `From: attacker@supa.media\n\nhi\n`,
    );
    expect(parsed.authenticationResultsFolded).toEqual([true]);
    expect(verdict).toEqual({ ok: false, reason: "folded_authentication_results" });
  });
});
