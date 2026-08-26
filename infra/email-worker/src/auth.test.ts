/**
 * The check that makes the allow-list a control rather than theatre.
 *
 * The property under test, stated once: **an allow-list applied to an
 * unverified `From:` header protects nothing**, because the header is a claim
 * anyone can type, and the claim an attacker most wants to make is exactly the
 * one the list invites. So authentication comes first, alignment is exact, and
 * a passing allow-list never rescues a failing verdict.
 *
 * Each `describe` below is a sabotage target: the comment on it names the edit
 * that would defeat the check and which test catches it.
 */
import { describe, expect, it } from "vitest";
import { domainOf, parseAuthenticationResults, verifySender } from "./auth";

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
 * What Cloudflare Email Routing *actually* puts on a message, as opposed to
 * what this file was written against.
 *
 * `verifySender` reads `Authentication-Results` (RFC 8601). Cloudflare's own
 * documentation of Email Routing says it stamps **`ARC-Authentication-Results`**
 * (RFC 8617) instead, and that header's value begins with an ARC instance tag —
 * `i=1;` — *before* the authserv-id:
 *
 *   ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=pass header.d=…
 *   — https://blog.cloudflare.com/email-routing-subdomains/
 *
 * Two independent consequences, both of which make ingestion refuse everything
 * no matter what `AUTH_SERVICE_ID` is set to. They are pinned here because the
 * deployment note in wrangler.jsonc asks for exactly this — a fixture rather
 * than a claim — and because each one has to be fixed deliberately, by someone
 * who has decided the trust question below.
 *
 * THE TRUST QUESTION, WHICH IS NOT SETTLED AND MUST NOT BE GUESSED:
 * `ARC-Authentication-Results` is forgeable by a sender exactly as
 * `Authentication-Results` is, so trusting it rests on the same assumption —
 * that ours is prepended above anything the sender wrote. cloudflare/workerd
 * issue #6740 reports that on Email Routing → Worker delivery **no**
 * authentication header with real verdicts arrives at all. If that is true
 * here, then trusting the topmost ARC header would hand an attacker the pass
 * they typed. Only a real delivery settles it; until then this refuses, which
 * is the correct direction to be wrong in.
 */
describe("the header Cloudflare Email Routing actually sends", () => {
  const CLOUDFLARE_AUTHSERV = "mx.cloudflare.net";
  // The documented shape, verbatim in structure: ARC instance tag, then the
  // authserv-id, then the verdicts.
  const CLOUDFLARE_ARC_VALUE =
    "i=1; mx.cloudflare.net; dkim=pass header.d=example.com;" +
    " spf=pass smtp.mailfrom=alice@example.com; dmarc=pass header.from=example.com";

  it("cannot parse the value, because `i=1` is read as the authserv-id", () => {
    // The leading ARC instance tag occupies the first clause, which RFC 8601
    // reserves for the authserv-id. `i=1` contains `=`, which the authserv-id
    // charset excludes, so the whole header is rejected as malformed.
    expect(parseAuthenticationResults(CLOUDFLARE_ARC_VALUE)).toBeNull();
  });

  it("therefore refuses a genuine, fully-passing Cloudflare verdict", () => {
    // Every method says pass and the domain aligns. It is still refused — so
    // no value of AUTH_SERVICE_ID makes this deployment ingest anything.
    expect(
      verify([CLOUDFLARE_ARC_VALUE], "alice@example.com", CLOUDFLARE_AUTHSERV),
    ).toEqual({ ok: false, reason: "unparseable_authentication_results" });
  });

  it("would still refuse even if the instance tag were stripped, because the header name differs", () => {
    // Second, independent breakage: ./mime.ts collects only headers named
    // `authentication-results`, so an `ARC-Authentication-Results` header never
    // reaches `verifySender` at all — it arrives as an empty list.
    expect(verify([], "alice@example.com", CLOUDFLARE_AUTHSERV)).toEqual({
      ok: false,
      reason: "no_authentication_results",
    });
  });

  it("names the authserv-id to configure once the header is read correctly", () => {
    // With the instance tag removed, the authserv-id Cloudflare writes parses
    // cleanly and is `mx.cloudflare.net` — which is what wrangler.jsonc already
    // guesses. The guess is right; the header it is compared against is wrong.
    const withoutInstanceTag = CLOUDFLARE_ARC_VALUE.replace(/^i=\d+;\s*/, "");
    const parsed = parseAuthenticationResults(withoutInstanceTag)!;
    expect(parsed.authservId).toBe(CLOUDFLARE_AUTHSERV);
    expect(verify([withoutInstanceTag], "alice@example.com", CLOUDFLARE_AUTHSERV)).toMatchObject({
      ok: true,
      method: "dmarc",
      domain: "example.com",
    });
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
