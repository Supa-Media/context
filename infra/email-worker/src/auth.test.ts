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

describe("domainOf", () => {
  it("takes the last @, so a quoted local part cannot move the domain", () => {
    expect(domainOf('"a@b"@example.com')).toBe("example.com");
    expect(domainOf("alice@EXAMPLE.com")).toBe("example.com");
    expect(domainOf("nope")).toBe("");
    expect(domainOf("nope@")).toBe("");
    expect(domainOf("@nope")).toBe("");
  });
});
