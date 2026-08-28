/**
 * What a `verified` label is allowed to mean.
 *
 * The property under test, stated once: **a `From:` header is a claim anyone
 * can type**, and the claim an attacker most wants to make is exactly the one
 * an allow-list invites. So alignment is exact, position decides which verdict
 * is ours, and nothing a sender wrote can produce a pass.
 *
 * What changed, and it is worth being exact about: a failing verdict no longer
 * refuses the message — ./ingest.ts captures it and the note says it is
 * unverified. Every test below is therefore about the *label*: a `false`
 * verdict costs a sender a badge rather than a delivery. That makes the forgery
 * cases matter as much as they ever did — a forged pass would put
 * `verified: true` on a stranger's note — and the refusal-shaped wording in
 * these test names is about `verifySender`'s own answer, not about what the
 * Worker does with it.
 *
 * Each `describe` below is a sabotage target: the comment on it names the edit
 * that would defeat the check and which test catches it.
 */
import { describe, expect, it } from "vitest";
import {
  describeArcShape,
  describeSender,
  domainOf,
  parseArcAuthenticationResults,
  parseAuthenticationResults,
  verifySender,
} from "./auth";
import { DEFAULT_MIME_LIMITS, parseEmail } from "./mime";
import { htmlToText } from "./html";

const AUTHSERV = "mx.example-mta.test";

function verify(headers: string[], from: string, authServiceId = AUTHSERV) {
  return verifySender({ authenticationResults: headers, fromAddress: from, authServiceId });
}

const PASSING = (domain: string, mailbox = `alice@${domain}`) =>
  `${AUTHSERV}; dkim=pass header.d=${domain}; spf=pass smtp.mailfrom=${mailbox}; dmarc=pass header.from=${domain}`;

describe("parsing an Authentication-Results header", () => {
  it("reads the authserv-id, the methods, and their properties", () => {
    const parsed = parseAuthenticationResults(PASSING("example.com"))!;
    expect(parsed.authservId).toBe(AUTHSERV);
    expect(parsed.results.map((r) => `${r.method}=${r.result}`)).toEqual([
      "dkim=pass",
      "spf=pass",
      "dmarc=pass",
    ]);
    expect(parsed.results[2]!.properties["header.from"]).toBe("example.com");
  });

  it("survives comments containing a semicolon", () => {
    // Sabotage: split on ";" before stripping comments and this verdict is
    // truncated to nothing, which silently downgrades a pass to "not
    // authenticated" — a fail-closed bug, but one that breaks every real
    // Gmail-shaped header.
    const parsed = parseAuthenticationResults(
      `${AUTHSERV}; spf=pass (example.com: domain of alice designates 1.2.3.4; permitted) smtp.mailfrom=alice@example.com`,
    )!;
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]!.properties["smtp.mailfrom"]).toBe("alice@example.com");
  });

  it("treats a bare `none` as no result at all", () => {
    const parsed = parseAuthenticationResults(`${AUTHSERV}; none`)!;
    expect(parsed.results).toEqual([]);
  });

  it("refuses a value with no authserv-id", () => {
    expect(parseAuthenticationResults("dkim=pass header.d=example.com")).toBeNull();
    expect(parseAuthenticationResults("")).toBeNull();
  });

  it("is bounded: a pathological header does not become a pathological parse", () => {
    const monstrous = `${AUTHSERV}${"; dkim=pass header.d=example.com".repeat(5_000)}`;
    const started = Date.now();
    const parsed = parseAuthenticationResults(monstrous)!;
    expect(Date.now() - started).toBeLessThan(200);
    expect(parsed.results.length).toBeLessThanOrEqual(24);
  });
});

describe("a message must prove the identity it claims", () => {
  it("accepts an aligned DMARC pass", () => {
    const verdict = verify([PASSING("example.com")], "alice@example.com");
    expect(verdict).toEqual({
      ok: true,
      address: "alice@example.com",
      domain: "example.com",
      method: "dmarc",
    });
  });

  it("refuses a message with no Authentication-Results at all", () => {
    // The naive implementation — read `From:`, call the allow-list — passes
    // this message. That is the whole bug this file exists to prevent.
    expect(verify([], "alice@example.com")).toEqual({
      ok: false,
      reason: "no_authentication_results",
    });
  });

  it("refuses a failing DMARC even when everything else looks right", () => {
    const verdict = verify(
      [`${AUTHSERV}; dkim=fail header.d=example.com; spf=fail; dmarc=fail header.from=example.com`],
      "alice@example.com",
    );
    expect(verdict).toEqual({ ok: false, reason: "not_authenticated" });
  });

  it("falls back to an aligned DKIM pass when there is no DMARC verdict", () => {
    const verdict = verify(
      [`${AUTHSERV}; dkim=pass header.d=example.com`],
      "alice@example.com",
    );
    expect(verdict).toMatchObject({ ok: true, method: "dkim" });
  });

  it("falls back to an aligned SPF pass when there is neither", () => {
    const verdict = verify(
      [`${AUTHSERV}; spf=pass smtp.mailfrom=alice@example.com`],
      "alice@example.com",
    );
    expect(verdict).toMatchObject({ ok: true, method: "spf" });
  });
});

describe("alignment: a pass for someone else's domain is not a pass", () => {
  it("refuses a spoofed From: authenticated as another domain", () => {
    // The attack in one line. `evil.test` publishes a perfect SPF record and
    // signs everything it sends, then claims to be alice.
    //
    // Sabotage: drop the `sameDomain` call from the DKIM branch and this
    // message is accepted with `method: "dkim"`.
    const verdict = verify([PASSING("evil.test", "mallory@evil.test")], "alice@example.com");
    expect(verdict).toEqual({ ok: false, reason: "unaligned" });
  });

  it("refuses a DMARC pass whose header.from names a different domain", () => {
    const verdict = verify(
      [`${AUTHSERV}; dmarc=pass header.from=evil.test`],
      "alice@example.com",
    );
    expect(verdict).toEqual({ ok: false, reason: "unaligned" });
  });

  it("does not accept a subdomain as its parent", () => {
    // Sabotage: relax `sameDomain` to organisational-domain matching and this
    // passes. Anyone who can send from any subdomain then aligns to the parent.
    expect(verify([PASSING("mail.example.com")], "alice@example.com")).toEqual({
      ok: false,
      reason: "unaligned",
    });
    expect(verify([PASSING("example.com")], "alice@mail.example.com")).toEqual({
      ok: false,
      reason: "unaligned",
    });
  });

  it("does not accept a domain that merely ends with the right suffix", () => {
    // Sabotage: `endsWith` instead of `===`. Both of these then pass.
    for (const impostor of ["evil-example.com", "notexample.com", "xexample.com"]) {
      expect(verify([PASSING(impostor, `m@${impostor}`)], "alice@example.com")).toEqual({
        ok: false,
        reason: "unaligned",
      });
    }
  });

  it("does not accept the right domain as a prefix of a longer one", () => {
    expect(
      verify([PASSING("example.com.evil.test", "m@example.com.evil.test")], "alice@example.com"),
    ).toEqual({ ok: false, reason: "unaligned" });
  });
});

describe("the sender does not get to write their own verdict", () => {
  it("refuses when the topmost verdict is from a different authority", () => {
    // A forged header naming somebody else's MTA. Sabotage: search the list
    // for *any* header with our authserv-id instead of insisting the topmost
    // one is ours, and a sender who prepends a forgery wins whenever their
    // header sorts first.
    expect(
      verify([`attacker.test; dmarc=pass header.from=example.com`], "alice@example.com"),
    ).toEqual({ ok: false, reason: "foreign_authserv_id" });
  });

  it("ignores a forged verdict placed below ours", () => {
    const verdict = verify(
      [
        `${AUTHSERV}; dmarc=fail header.from=example.com`,
        `${AUTHSERV}; dmarc=pass header.from=example.com`,
      ],
      "alice@example.com",
    );
    // Not "the second one won" — two verdicts claiming our authority is itself
    // fatal, because we cannot tell which is ours.
    expect(verdict).toEqual({ ok: false, reason: "ambiguous_authentication_results" });
  });

  it("refuses when a second header claims our authserv-id, even if ours passes", () => {
    const verdict = verify(
      [PASSING("example.com"), `${AUTHSERV}; dmarc=pass header.from=example.com`],
      "alice@example.com",
    );
    expect(verdict).toEqual({ ok: false, reason: "ambiguous_authentication_results" });
  });

  it("refuses a forged verdict when our own MX did not write one", () => {
    // The case that separates "read the topmost header" from "hunt for a
    // header we like". Our authserv-id is misconfigured, so the genuine verdict
    // is from an authority we do not recognise — and the sender has helpfully
    // supplied one bearing the id we *do* recognise.
    //
    // Sabotage: search the list for the first header whose authserv-id matches,
    // instead of insisting the topmost one does, and the forgery wins.
    const verdict = verify(
      [
        "mx.some-other-mta.test; dmarc=fail header.from=example.com",
        `${AUTHSERV}; dmarc=pass header.from=example.com`,
      ],
      "alice@example.com",
    );
    expect(verdict).toEqual({ ok: false, reason: "foreign_authserv_id" });
  });

  it("does not care about a forged header from another authority below ours", () => {
    const verdict = verify(
      [PASSING("example.com"), "attacker.test; dmarc=pass header.from=whatever.test"],
      "alice@example.com",
    );
    expect(verdict).toMatchObject({ ok: true });
  });
});

describe("fail-closed configuration", () => {
  it("refuses everything when AUTH_SERVICE_ID is unset", () => {
    // An unconfigured deployment ingests nothing rather than trusting whatever
    // header arrives. Sabotage: default `authServiceId` to the value in
    // wrangler.jsonc and an operator who cleared it gets silent acceptance.
    expect(verify([PASSING("example.com")], "alice@example.com", "")).toEqual({
      ok: false,
      reason: "not_configured",
    });
  });

  it("refuses a message with no usable From: address", () => {
    expect(verify([PASSING("example.com")], "")).toEqual({ ok: false, reason: "no_from_address" });
  });

  it("refuses an unparseable Authentication-Results", () => {
    expect(verify(["!!!"], "alice@example.com")).toEqual({
      ok: false,
      reason: "unparseable_authentication_results",
    });
  });
});

/**
 * ============================================================================
 * WHAT CLOUDFLARE EMAIL ROUTING ACTUALLY SENDS, AND WHAT IS STILL INFERRED
 * ============================================================================
 *
 * This block used to pin the opposite of what is below: that Cloudflare stamps
 * only `ARC-Authentication-Results`, that its leading `i=1;` tag makes it
 * unparseable as RFC 8601, and that ingestion therefore refused everything
 * whatever `AUTH_SERVICE_ID` was set to. A real delivery has since settled part
 * of that, and it settled it the other way.
 *
 * ── OBSERVED, in production, from the Worker's own log ──────────────────────
 *
 *   {"worker":"context-email","event":"refused","reason":"auth_unaligned",…}
 *
 * `auth_unaligned` is reachable only after `verifySender` has parsed the
 * topmost `Authentication-Results`, matched its authserv-id against the
 * configured one, and found a passing method for the wrong domain. So all three
 * of these are facts, not guesses:
 *
 *   - Cloudflare Email Routing DOES stamp `Authentication-Results` on a message
 *     delivered to a Worker (contradicting cloudflare/workerd#6740, which
 *     reported none arriving);
 *   - it is topmost, and it parses as RFC 8601 with no ARC instance tag;
 *   - its authserv-id is `mx.cloudflare.net`, the value wrangler.jsonc guesses.
 *
 * The same message's Email Routing activity log read: SPF none, DKIM pass,
 * DMARC none, ARC pass. Which is an ordinary forward — `From:` unchanged, the
 * delivering hop's DKIM belonging to the forwarder — and it is refused for
 * looking exactly like one.
 *
 * ── INFERRED, and labelled as such wherever a fixture depends on it ─────────
 *
 *   - that `arc=pass` is reported inside `Authentication-Results` rather than
 *     anywhere else (RFC 8617 §5.2 says the chain validation status SHOULD go
 *     there, and the activity log proves Cloudflare computes it);
 *   - that Cloudflare stamps an ARC set of its own before Worker delivery, and
 *     places it above `Authentication-Results` (Gmail's own output has the ARC
 *     set above the AR, which is where the shape below comes from).
 *
 * The second inference is the one the ARC path lives or dies on, and nobody has
 * captured the literal headers. `LOG_ARC_SHAPE` exists to settle it: see
 * `describeArcShape`.
 */
describe("Authentication-Results, as a real Cloudflare delivery produces it", () => {
  const CLOUDFLARE_AUTHSERV = "mx.cloudflare.net";

  it("parses, with no instance tag, and names the authserv-id to configure", () => {
    const observed =
      "mx.cloudflare.net; dkim=pass header.d=example.com;" +
      " spf=pass smtp.mailfrom=alice@example.com; dmarc=pass header.from=example.com";
    const parsed = parseAuthenticationResults(observed)!;
    expect(parsed.authservId).toBe(CLOUDFLARE_AUTHSERV);
    expect(verify([observed], "alice@example.com", CLOUDFLARE_AUTHSERV)).toMatchObject({
      ok: true,
      method: "dmarc",
      domain: "example.com",
    });
  });

  it("still refuses an ARC value fed to the wrong parser, because `i=1` is not an authserv-id", () => {
    // The ARC instance tag occupies the first clause, which RFC 8601 reserves
    // for the authserv-id, and `=` is outside that charset. This is why
    // `parseArcAuthenticationResults` exists rather than a `.replace()`.
    expect(
      parseAuthenticationResults("i=1; mx.cloudflare.net; dmarc=pass header.from=example.com"),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                                    ARC                                     */
/* -------------------------------------------------------------------------- */

const MX = "mx.cloudflare.net";

const LIMITS = DEFAULT_MIME_LIMITS;

/**
 * Drive the real `parseEmail`, then the real `verifySender`, from raw bytes.
 *
 * Message-level rather than hand-built inputs, because the two properties that
 * matter most — *where* a header sits, and whether a sender folded into one —
 * exist only in a message. A test that constructed `arcAuthenticationResults`
 * itself would be asserting about its own fixture, not about the defence.
 */
function deliver(raw: string) {
  const parsed = parseEmail(new TextEncoder().encode(raw), LIMITS, htmlToText);
  return {
    parsed,
    verdict: verifySender({
      authenticationResults: parsed.authenticationResults,
      authenticationResultsFolded: parsed.authenticationResultsFolded,
      authenticationResultsFirstLine: parsed.authenticationResultsFirstLine,
      arcAuthenticationResults: parsed.arcAuthenticationResults,
      fromAddress: parsed.fromAddress,
      authServiceId: MX,
    }),
  };
}

/** Our MTA's own verdict on a forward: a pass for the forwarder, not the author. */
const FORWARDED_PRIMARY =
  `Authentication-Results: ${MX}; spf=none; dkim=pass header.d=gmail.com;` +
  ` dmarc=none header.from=supa.media; arc=pass`;

/** The relayed set the forwarder sealed. Below our block; never trusted here. */
const RELAYED_ARC =
  `ARC-Seal: i=1; a=rsa-sha256; d=google.com; s=arc-20240605; cv=none; b=Q0M=\n` +
  `ARC-Message-Signature: i=1; a=rsa-sha256; d=google.com; s=arc-20240605; b=RE Q=\n` +
  `ARC-Authentication-Results: i=1; mx.google.com; spf=pass smtp.mailfrom=seyi@supa.media;` +
  ` dkim=pass header.d=supa.media; dmarc=pass header.from=supa.media`;

/** What our MTA is inferred to add when it validates and re-seals the chain. */
const OUR_ARC =
  `ARC-Seal: i=2; a=rsa-sha256; d=cloudflare.net; s=2024; cv=pass; b=QUE=\n` +
  `ARC-Message-Signature: i=2; a=rsa-sha256; d=cloudflare.net; s=2024; b=QkI=\n` +
  `ARC-Authentication-Results: i=2; ${MX}; spf=pass smtp.mailfrom=seyi@supa.media;` +
  ` dkim=pass header.d=supa.media; dmarc=pass header.from=supa.media`;

const FROM_AND_BODY = `From: seyi@supa.media\nSubject: fwd\n\nhi\n`;

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
