/**
 * The ingestion policy evaluator, adversarially.
 *
 * `senderIsAllowed` is the only thing standing between a semi-public capture
 * address and a note the owner's AI clients will read as trusted context, and
 * every input it sees comes from a `From:` header an attacker writes. So these
 * tests are organized by *attack*, not by function: each block is named after
 * the bypass it exists to prove impossible, and the assertions are the literal
 * strings somebody would send.
 *
 * Two of them look fine and are not — subdomain matching and suffix confusion —
 * and both were sabotage-verified: replacing the exact-equality domain check
 * with `endsWith` makes the named tests fail, which is what makes them worth
 * having. See CLAUDE.md, "A guard nobody has checked is not a guard".
 *
 * Every value here is obviously fake. `.test` is the RFC 2606 reserved TLD;
 * `publicworship.life` appears because it is the example in the brief, always
 * as an allowlist entry rather than as a real correspondent.
 */

import { afterEach, describe, expect, test } from "vitest";
import {
  DEFAULT_TARGET_FOLDER,
  INGESTION_RECEIVER_ENV,
  type IngestionPolicy,
  MAX_ALLOWED_DOMAINS,
  MAX_ALLOWED_SENDERS,
  ingestionAddressFor,
  ingestionIsReceiving,
  normalizeDomainEntry,
  normalizeSenderEntry,
  normalizeTargetFolder,
  parseEmailAddress,
  senderIsAllowed,
} from "../functions/lib/ingestion";

const CLOSED: IngestionPolicy = {
  allowedSenders: [],
  allowedDomains: [],
  allowAnySender: false,
};

function policy(overrides: Partial<IngestionPolicy>): IngestionPolicy {
  return { ...CLOSED, ...overrides };
}

/* -------------------------------------------------------------------------- */

describe("the closed default", () => {
  test("an empty policy accepts nothing at all", () => {
    for (const from of [
      "seyi@example.test",
      "anyone@anywhere.test",
      "postmaster@context.lc",
      "",
    ]) {
      expect(senderIsAllowed(from, CLOSED)).toBe(false);
    }
  });

  test("an empty policy with allowAnySender false is not accidentally open", () => {
    // The failure this guards is a matcher that returns true when it runs out
    // of rules — the "no rules means no restrictions" reading of an allowlist.
    expect(senderIsAllowed("stranger@evil.test", policy({}))).toBe(false);
  });

  test("allowAnySender is the only thing that opens it", () => {
    expect(senderIsAllowed("stranger@evil.test", policy({ allowAnySender: true }))).toBe(
      true,
    );
  });

  test("allowAnySender still means any real sender, not any bytes", () => {
    const open = policy({ allowAnySender: true });
    for (const junk of ["", "   ", "not-an-address", "a@b@c.test", "root@localhost"]) {
      expect(senderIsAllowed(junk, open)).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("subdomains are not the domain", () => {
  const allowed = policy({ allowedDomains: ["publicworship.life"] });

  test("the bare domain matches", () => {
    expect(senderIsAllowed("seyi@publicworship.life", allowed)).toBe(true);
  });

  test("a subdomain of an allowed domain does NOT match", () => {
    // The classic bug: `domain.endsWith(entry)` admits every one of these, and
    // an attacker only needs a DNS record they already control.
    for (const from of [
      "attacker@evil.publicworship.life",
      "attacker@mail.publicworship.life",
      "attacker@a.b.c.publicworship.life",
    ]) {
      expect(senderIsAllowed(from, allowed)).toBe(false);
    }
  });

  test("a subdomain matches once it is listed explicitly", () => {
    const explicit = policy({
      allowedDomains: ["publicworship.life", "mail.publicworship.life"],
    });
    expect(senderIsAllowed("seyi@mail.publicworship.life", explicit)).toBe(true);
    // …and listing one subdomain does not admit its siblings.
    expect(senderIsAllowed("attacker@evil.publicworship.life", explicit)).toBe(false);
  });

  test("a parent of an allowed subdomain does not match either", () => {
    const explicit = policy({ allowedDomains: ["mail.publicworship.life"] });
    expect(senderIsAllowed("seyi@publicworship.life", explicit)).toBe(false);
  });
});

describe("suffix confusion", () => {
  const allowed = policy({ allowedDomains: ["publicworship.life"] });

  test("a domain that merely ends with the allowed one does NOT match", () => {
    for (const from of [
      "attacker@notpublicworship.life",
      "attacker@xpublicworship.life",
      "attacker@my-publicworship.life",
    ]) {
      expect(senderIsAllowed(from, allowed)).toBe(false);
    }
  });

  test("a domain that starts with the allowed one does not match", () => {
    for (const from of [
      "attacker@publicworship.life.evil.test",
      "attacker@publicworship.lifetime.test",
    ]) {
      expect(senderIsAllowed(from, allowed)).toBe(false);
    }
  });

  test("the same confusion on the address list", () => {
    const byAddress = policy({ allowedSenders: ["seyi@publicworship.life"] });
    for (const from of [
      "seyi@notpublicworship.life",
      "seyi@evil.publicworship.life",
      "notseyi@publicworship.life",
      "seyi@publicworship.life.evil.test",
    ]) {
      expect(senderIsAllowed(from, byAddress)).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("case", () => {
  test("the domain matches case-insensitively", () => {
    const allowed = policy({ allowedDomains: ["Publicworship.LIFE"] });
    expect(senderIsAllowed("seyi@PUBLICWORSHIP.life", allowed)).toBe(true);
  });

  test("the address matches case-insensitively, both sides", () => {
    const allowed = policy({ allowedSenders: ["SEYI@Example.TEST"] });
    expect(senderIsAllowed("Seyi@example.test", allowed)).toBe(true);
    expect(senderIsAllowed("seyi@EXAMPLE.TEST", allowed)).toBe(true);
  });

  test("case folding does not make two different mailboxes one", () => {
    const allowed = policy({ allowedSenders: ["seyi@example.test"] });
    expect(senderIsAllowed("seyix@example.test", allowed)).toBe(false);
  });
});

describe("a trailing dot is the same domain", () => {
  test("on the message", () => {
    const allowed = policy({ allowedDomains: ["example.test"] });
    expect(senderIsAllowed("seyi@example.test.", allowed)).toBe(true);
  });

  test("on the allowlist entry", () => {
    const allowed = policy({ allowedDomains: ["example.test."] });
    expect(senderIsAllowed("seyi@example.test", allowed)).toBe(true);
  });

  test("but two trailing dots are malformed and refused", () => {
    const allowed = policy({ allowedDomains: ["example.test"] });
    expect(senderIsAllowed("seyi@example.test..", allowed)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("sub-addressing", () => {
  const allowed = policy({ allowedSenders: ["seyi@example.test"] });

  test("a tag on the message still matches the bare entry", () => {
    // Without this, an allowlist silently fails on exactly the forwarded mail
    // people configure ingestion for.
    expect(senderIsAllowed("seyi+newsletter@example.test", allowed)).toBe(true);
    expect(senderIsAllowed("seyi+a+b@example.test", allowed)).toBe(true);
  });

  test("stripping the tag does not reach a different mailbox", () => {
    expect(senderIsAllowed("seyix+news@example.test", allowed)).toBe(false);
    expect(senderIsAllowed("seyi+news@evil.test", allowed)).toBe(false);
  });

  test("an entry that names a tag is taken literally", () => {
    const tagged = policy({ allowedSenders: ["seyi+news@example.test"] });
    expect(senderIsAllowed("seyi+news@example.test", tagged)).toBe(true);
    // The owner asked for one tag; do not hand them every tag.
    expect(senderIsAllowed("seyi+other@example.test", tagged)).toBe(false);
    expect(senderIsAllowed("seyi@example.test", tagged)).toBe(false);
  });

  test("dots in the local part are NOT provider-folded", () => {
    // Gmail treats `a.b@` and `ab@` as one mailbox. Applying that everywhere
    // would admit a different person on every other domain.
    expect(senderIsAllowed("s.eyi@example.test", allowed)).toBe(false);
  });

  test("a local part that is only a tag is not collapsed to nothing", () => {
    const oddly = policy({ allowedSenders: ["+tag@example.test"] });
    expect(senderIsAllowed("+tag@example.test", oddly)).toBe(true);
    expect(senderIsAllowed("anyone@example.test", oddly)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("display names cannot smuggle an allowed address", () => {
  const allowed = policy({ allowedSenders: ["seyi@example.test"] });

  test("the angle-addr wins, not the text beside it", () => {
    for (const from of [
      '"seyi@example.test" <attacker@evil.test>',
      "seyi@example.test <attacker@evil.test>",
      "<attacker@evil.test>",
      "Seyi (seyi@example.test) <attacker@evil.test>",
    ]) {
      expect(senderIsAllowed(from, allowed)).toBe(false);
    }
  });

  test("a real display-name form still matches", () => {
    expect(senderIsAllowed("Seyi <seyi@example.test>", allowed)).toBe(true);
    expect(senderIsAllowed('"Olujide, Seyi" <seyi@example.test>', allowed)).toBe(true);
    expect(senderIsAllowed("  Seyi   <seyi@example.test>  ", allowed)).toBe(true);
  });

  test("two angle-addrs are ambiguous and refused outright", () => {
    expect(senderIsAllowed("<attacker@evil.test> <seyi@example.test>", allowed)).toBe(
      false,
    );
    expect(senderIsAllowed("<seyi@example.test> <attacker@evil.test>", allowed)).toBe(
      false,
    );
  });

  test("anything after the closing bracket is refused", () => {
    expect(senderIsAllowed("<seyi@example.test> (via evil.test)", allowed)).toBe(false);
  });

  test("an address list or group is refused rather than guessed at", () => {
    for (const from of [
      "seyi@example.test, attacker@evil.test",
      "attacker@evil.test, seyi@example.test",
      "undisclosed-recipients:;",
      "Group: seyi@example.test;",
    ]) {
      expect(senderIsAllowed(from, allowed)).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("malformed input fails closed and never throws", () => {
  const allowed = policy({
    allowedSenders: ["seyi@example.test"],
    allowedDomains: ["example.test"],
  });

  const HOSTILE: string[] = [
    "",
    " ",
    "\t",
    "@",
    "@example.test",
    "seyi@",
    "seyi",
    "seyi@@example.test",
    "seyi@example.test@example.test",
    "a@b@example.test",
    "seyi@.example.test",
    "seyi@example..test",
    "seyi@-example.test",
    "seyi@example-.test",
    "seyi@example.test-",
    ".seyi@example.test",
    "seyi.@example.test",
    "se..yi@example.test",
    "seyi@localhost",
    "seyi@127.0.0.1",
    "seyi@[127.0.0.1]",
    '"se yi"@example.test',
    "se yi@example.test",
    "seyi@exam ple.test",
    "seyi@example.test\nBcc: attacker@evil.test",
    "seyi@example.test\r\nX-Injected: 1",
    // Unicode and homograph forms: refused, not normalized.
    "seyi@exаmple.test", // Cyrillic а
    "seyі@example.test",
    "seyi@例え.テスト",
    "seyi@example.test​",
    // Absurd lengths.
    `${"a".repeat(5000)}@example.test`,
    `seyi@${"a".repeat(300)}.test`,
    `seyi@${`${"a".repeat(60)}.`.repeat(20)}test`,
    `${"seyi+".repeat(200)}@example.test`,
    `${"<".repeat(2000)}seyi@example.test`,
    "a".repeat(100_000),
  ];

  test("every hostile form is refused without throwing", () => {
    for (const value of HOSTILE) {
      expect(() => senderIsAllowed(value, allowed)).not.toThrow();
      expect(senderIsAllowed(value, allowed), JSON.stringify(value)).toBe(false);
    }
  });

  test("whitespace around a real address is trimmed, not treated as hostile", () => {
    expect(senderIsAllowed("  seyi@example.test  ", allowed)).toBe(true);
  });

  test("non-string input is refused without throwing", () => {
    const values: unknown[] = [
      undefined,
      null,
      42,
      {},
      [],
      { toString: () => "seyi@example.test" },
    ];
    for (const value of values) {
      expect(() => senderIsAllowed(value as string, allowed)).not.toThrow();
      expect(senderIsAllowed(value as string, allowed)).toBe(false);
    }
  });

  test("a hostile evaluation finishes promptly", () => {
    // Not a benchmark — a tripwire for a validator that becomes exponential on
    // an input the attacker chooses. A catastrophic pattern blows this by
    // orders of magnitude, not by a few milliseconds.
    const started = Date.now();
    for (let index = 0; index < 200; index += 1) {
      senderIsAllowed(`${"a-".repeat(400)}@${"b-".repeat(120)}.test`, allowed);
    }
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a punycode domain is plain ASCII and matches exactly", () => {
    const puny = policy({ allowedDomains: ["xn--80ak6aa92e.test"] });
    expect(senderIsAllowed("seyi@xn--80ak6aa92e.test", puny)).toBe(true);
    expect(senderIsAllowed("seyi@xn--80ak6aa92e.evil.test", puny)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("a policy that is itself junk cannot widen anything", () => {
  test("unparseable entries match nothing rather than everything", () => {
    const broken = policy({
      allowedSenders: ["", "not an address", "@", "*@example.test", "*"],
      allowedDomains: ["", "*", "*.example.test", ".test"],
    });
    for (const from of ["seyi@example.test", "attacker@evil.test"]) {
      expect(senderIsAllowed(from, broken)).toBe(false);
    }
  });

  test("a wildcard is a literal string, never a pattern", () => {
    const broken = policy({ allowedDomains: ["*.publicworship.life"] });
    expect(senderIsAllowed("attacker@evil.publicworship.life", broken)).toBe(false);
  });

  test("junk entries do not stop a real entry beside them from matching", () => {
    const mixed = policy({ allowedSenders: ["nonsense", "seyi@example.test"] });
    expect(senderIsAllowed("seyi@example.test", mixed)).toBe(true);
  });

  test("a policy with missing fields is treated as closed, not as open", () => {
    const partial = { allowAnySender: false } as unknown as IngestionPolicy;
    expect(senderIsAllowed("seyi@example.test", partial)).toBe(false);
  });

  test("entries beyond the cap are ignored rather than walked", () => {
    const overlong = policy({
      allowedSenders: [
        ...Array.from({ length: MAX_ALLOWED_SENDERS }, (_, i) => `filler${i}@example.test`),
        "seyi@late.test",
      ],
      allowedDomains: [
        ...Array.from({ length: MAX_ALLOWED_DOMAINS }, (_, i) => `filler${i}.test`),
        "late.test",
      ],
    });
    expect(senderIsAllowed("filler0@example.test", overlong)).toBe(true);
    // Beyond the cap: ignored, which fails closed.
    expect(senderIsAllowed("seyi@late.test", overlong)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("parseEmailAddress", () => {
  test("returns the canonical form", () => {
    expect(parseEmailAddress("  Seyi <SEYI+News@Example.TEST.>  ")).toEqual({
      address: "seyi+news@example.test",
      localPart: "seyi+news",
      baseLocalPart: "seyi",
      domain: "example.test",
    });
  });

  test("normalizeSenderEntry is the same parser", () => {
    expect(normalizeSenderEntry("Seyi <SEYI@Example.test>")).toBe("seyi@example.test");
    expect(normalizeSenderEntry("nope")).toBeNull();
    expect(normalizeSenderEntry(undefined)).toBeNull();
  });
});

describe("normalizeDomainEntry", () => {
  test("accepts the forms people actually paste", () => {
    expect(normalizeDomainEntry("Example.TEST")).toBe("example.test");
    expect(normalizeDomainEntry("@example.test")).toBe("example.test");
    expect(normalizeDomainEntry("  example.test.  ")).toBe("example.test");
    expect(normalizeDomainEntry("mail.example.test")).toBe("mail.example.test");
  });

  test("refuses an address in the domain list rather than reinterpreting it", () => {
    // Silently reading `seyi@example.test` as "everyone at example.test" would
    // widen a policy by a typo.
    expect(normalizeDomainEntry("seyi@example.test")).toBeNull();
  });

  test("refuses patterns, paths, and single labels", () => {
    for (const entry of [
      "*.example.test",
      "*",
      ".example.test",
      "example",
      "localhost",
      "example.test/path",
      "https://example.test",
      "example .test",
      "",
      "  ",
      "例え.テスト",
      undefined,
      null,
      42,
    ]) {
      expect(normalizeDomainEntry(entry)).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("target folders", () => {
  test("the default is a folder, with its trailing slash", () => {
    expect(DEFAULT_TARGET_FOLDER).toBe("0-inbox/");
    expect(normalizeTargetFolder(DEFAULT_TARGET_FOLDER)).toEqual({
      ok: true,
      folder: "0-inbox/",
    });
  });

  test("canonicalizes to one trailing slash and no leading one", () => {
    for (const raw of ["0-inbox", "/0-inbox", "0-inbox/", "//0-inbox//", " 0-inbox/ "]) {
      expect(normalizeTargetFolder(raw)).toEqual({ ok: true, folder: "0-inbox/" });
    }
  });

  test("nested folders are fine", () => {
    expect(normalizeTargetFolder("2-areas/mail/inbound")).toEqual({
      ok: true,
      folder: "2-areas/mail/inbound/",
    });
  });

  test("refuses traversal", () => {
    for (const raw of ["../secrets", "0-inbox/../../etc", "0-inbox/..", "./0-inbox", "."]) {
      expect(normalizeTargetFolder(raw).ok).toBe(false);
    }
    expect(normalizeTargetFolder("../secrets")).toEqual({
      ok: false,
      reason: "traversal",
    });
  });

  test("refuses the plumbing folders", () => {
    // Mail landing in `.history/` would forge note history; `.audit/` likewise.
    for (const raw of [".history", ".history/2026", ".audit", "0-inbox/.history"]) {
      expect(normalizeTargetFolder(raw)).toEqual({ ok: false, reason: "reserved" });
    }
  });

  test("refuses empty, absurd, and unprintable paths", () => {
    expect(normalizeTargetFolder("")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeTargetFolder("   ")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeTargetFolder("///")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeTargetFolder("a\\b")).toEqual({
      ok: false,
      reason: "invalid_characters",
    });
    expect(normalizeTargetFolder("a\nb")).toEqual({
      ok: false,
      reason: "invalid_characters",
    });
    expect(normalizeTargetFolder("a".repeat(2000))).toEqual({
      ok: false,
      reason: "too_long",
    });
    expect(normalizeTargetFolder(`${"a/".repeat(300)}b`).ok).toBe(false);
    expect(normalizeTargetFolder(undefined)).toEqual({
      ok: false,
      reason: "invalid_characters",
    });
  });
});

describe("the capture address", () => {
  test("is derived from the slug on the apex", () => {
    expect(ingestionAddressFor("seyi")).toBe("seyi@context.lc");
    expect(ingestionAddressFor("ignite-2026")).toBe("ignite-2026@context.lc");
  });
});

/**
 * Whether anything is on the other end of that address.
 *
 * The address being derivable says nothing about it being deliverable, and the
 * console spent a release conflating the two: it rendered the address with a
 * Copy button under "Forward any email here and it lands in 0-inbox/", and the
 * owner of this product mailed it and got `550 5.1.1 Address does not exist`
 * back. The point of this function is that "is a receiver deployed" is a
 * property of the *deployment*, which only the control plane can see, so the
 * answer travels to clients over the wire instead of being assumed by them.
 */
describe("whether a receiver is deployed", () => {
  const original = process.env[INGESTION_RECEIVER_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[INGESTION_RECEIVER_ENV];
    else process.env[INGESTION_RECEIVER_ENV] = original;
  });

  test("says no when nobody has said yes", () => {
    // The state of every environment today, and of any deployment that has
    // never heard of this variable. Absence is not a yes.
    delete process.env[INGESTION_RECEIVER_ENV];
    expect(ingestionIsReceiving()).toBe(false);
  });

  test("says yes only for the exact opt-in", () => {
    // Not "truthy", not "set". A half-configured deployment left holding
    // `INGESTION_RECEIVER=` or `=false` must not read as live, and neither
    // should a near miss somebody typed from memory.
    for (const value of ["", "false", "0", "true", "yes", "LIVE", "live "]) {
      process.env[INGESTION_RECEIVER_ENV] = value;
      expect(ingestionIsReceiving()).toBe(false);
    }
    process.env[INGESTION_RECEIVER_ENV] = "live";
    expect(ingestionIsReceiving()).toBe(true);
  });
});
