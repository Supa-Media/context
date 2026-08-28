/**
 * The MIME reader, tested for the two things that matter on a hostile feed:
 * it never throws, and it is bounded everywhere.
 *
 * Correctness of the happy path is here too, but the load-bearing block is
 * "malformed and hostile structures fail closed" — every input in it was
 * written to make a parser recurse forever, allocate forever, or explode.
 */
import { describe, expect, it } from "vitest";
import { htmlToText } from "./html";
import {
  addrSpec,
  DEFAULT_MIME_LIMITS,
  decodeEncodedWords,
  parseContentType,
  parseEmail,
  safeFilename,
  singleLine,
  type MimeLimits,
} from "./mime";
import { rawMessage } from "./fixtures.test-helpers";

const bytes = (value: string) => new TextEncoder().encode(value);
const parse = (value: string | Uint8Array, limits: Partial<MimeLimits> = {}) =>
  parseEmail(
    typeof value === "string" ? bytes(value) : value,
    { ...DEFAULT_MIME_LIMITS, ...limits },
    htmlToText,
  );

describe("the ordinary cases", () => {
  it("reads headers and a plain-text body", () => {
    const parsed = parse(rawMessage({ subject: "Lunch?", body: "One o'clock." }));
    expect(parsed.subject).toBe("Lunch?");
    expect(parsed.fromAddress).toBe("alice@example.com");
    expect(parsed.messageId).toBe("msg-1@example.com");
    expect(parsed.text).toBe("One o'clock.");
    expect(parsed.textSource).toBe("plain");
    expect(parsed.problems).toEqual([]);
  });

  it("unfolds a header split across lines", () => {
    const parsed = parse(
      "Subject: one\r\n  two\r\n\ttee\r\nFrom: a@example.com\r\n\r\nbody",
    );
    expect(parsed.subject).toBe("one two tee");
  });

  it("prefers text/plain over text/html anywhere in the tree", () => {
    const raw = [
      "From: alice@example.com",
      'Content-Type: multipart/alternative; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/html",
      "",
      "<p>rich</p>",
      "--b1",
      "Content-Type: text/plain",
      "",
      "plain wins",
      "--b1--",
      "",
    ].join("\r\n");
    const parsed = parse(raw);
    expect(parsed.textSource).toBe("plain");
    expect(parsed.text).toBe("plain wins");
  });

  it("falls back to a conservative HTML conversion", () => {
    const raw = [
      "From: alice@example.com",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p>Hello</p><script>x</script><a href="https://evil.test">link</a>',
    ].join("\r\n");
    const parsed = parse(raw);
    expect(parsed.textSource).toBe("html");
    expect(parsed.text).toBe("Hello\nlink");
    expect(parsed.text).not.toContain("evil.test");
  });

  it("decodes base64 and quoted-printable bodies", () => {
    const b64 = parse(
      ["From: a@example.com", "Content-Transfer-Encoding: base64", "", "aGVsbG8gd29ybGQ="].join(
        "\r\n",
      ),
    );
    expect(b64.text).toBe("hello world");

    const qp = parse(
      [
        "From: a@example.com",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "caf=C3=A9 and a soft=",
        "break",
      ].join("\r\n"),
    );
    expect(qp.text).toBe("café and a softbreak");
  });

  it("decodes a Latin-1 body labelled as such", () => {
    const head = bytes("From: a@example.com\r\nContent-Type: text/plain; charset=iso-8859-1\r\n\r\n");
    const body = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);
    const message = new Uint8Array(head.length + body.length);
    message.set(head);
    message.set(body, head.length);
    expect(parse(message).text).toBe("café");
  });

  it("finds the text inside a forwarded message/rfc822 part", () => {
    const raw = [
      "From: alice@example.com",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: message/rfc822",
      "",
      "From: bob@example.net",
      "Content-Type: text/plain",
      "",
      "the inner text",
      "--b1--",
      "",
    ].join("\r\n");
    expect(parse(raw).text).toBe("the inner text");
  });
});

describe("RFC 2047 encoded words", () => {
  it("decodes B and Q encodings", () => {
    expect(decodeEncodedWords("=?utf-8?B?SGVsbG8sIHdvcmxk?=")).toBe("Hello, world");
    expect(decodeEncodedWords("=?utf-8?Q?caf=C3=A9_time?=")).toBe("café time");
  });

  it("joins adjacent words across a fold", () => {
    expect(decodeEncodedWords("=?utf-8?Q?one?=   =?utf-8?Q?two?=")).toBe("onetwo");
  });

  it("leaves a malformed word alone rather than guessing", () => {
    expect(decodeEncodedWords("=?utf-8?Z?nope?=")).toBe("=?utf-8?Z?nope?=");
    expect(decodeEncodedWords("plain")).toBe("plain");
  });

  it("cannot be made to backtrack", () => {
    // A regex with a nested quantifier over `.` hangs on this. Ours uses
    // negated classes, so it is one pass.
    const started = Date.now();
    decodeEncodedWords(`${"=?".repeat(200_000)}utf-8?B?QQ`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("content-type parameters", () => {
  it("respects quoted strings", () => {
    const parsed = parseContentType('text/plain; charset="utf-8"; name="a;b.txt"');
    expect(parsed.type).toBe("text/plain");
    expect(parsed.params.charset).toBe("utf-8");
    expect(parsed.params.name).toBe("a;b.txt");
  });

  it("resolves RFC 2231 continuations and extended values", () => {
    const parsed = parseContentType(
      "attachment; filename*0=\"long-\"; filename*1=\"name.txt\"",
    );
    expect(parsed.params.filename).toBe("long-name.txt");
    const extended = parseContentType("attachment; filename*=utf-8''caf%C3%A9.txt");
    expect(extended.params.filename).toBe("café.txt");
  });

  it("lets a continuation win over a plain duplicate", () => {
    // A sender that supplies both is trying to make two readers disagree.
    const parsed = parseContentType('attachment; filename="innocent.txt"; filename*0="real.bin"');
    expect(parsed.params.filename).toBe("real.bin");
  });

  it("rejects a nonsense type rather than passing it on", () => {
    expect(parseContentType("not a type at all").type).toBe("");
  });
});

describe("addresses", () => {
  it("takes the addr-spec and discards the display name", () => {
    // `From: Seyi <mallory@example.net>` is legal and is the whole spoofing
    // trick. Only the address survives.
    expect(addrSpec("Seyi <mallory@example.net>")).toBe("mallory@example.net");
    expect(addrSpec("alice@example.com")).toBe("alice@example.com");
    expect(addrSpec('"alice@safe.example" <mallory@evil.test>')).toBe("mallory@evil.test");
  });

  it("returns nothing for something that is not an address", () => {
    expect(addrSpec("undisclosed recipients")).toBe("");
    expect(addrSpec("")).toBe("");
    expect(addrSpec("a@b@c")).toBe("");
  });

  it("decodes an encoded display name without letting it become the address", () => {
    expect(addrSpec("=?utf-8?B?U2V5aQ==?= <m@evil.test>")).toBe("m@evil.test");
  });
});

describe("malformed and hostile structures fail closed", () => {
  const hostile: Record<string, Uint8Array | string> = {
    empty: "",
    "only a newline": "\r\n",
    "headers with no body": "From: a@example.com\r\nSubject: x",
    "a body with no headers": "\r\n\r\njust text",
    "a NUL in every field": "From: a\u0000@b\r\nSubject: \u0000\u0000\u0000\r\n\r\n\u0000body",
    "a multipart declaring no boundary": "Content-Type: multipart/mixed\r\n\r\nnothing",
    "a boundary that never closes":
      'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nx',
    "a boundary that is only dashes":
      'Content-Type: multipart/mixed; boundary="--"\r\n\r\n----\r\n\r\nx\r\n------',
    "a part that declares itself its own parent":
      'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\n\r\nx\r\n--b--',
    "base64 that is not base64":
      "Content-Transfer-Encoding: base64\r\n\r\n!!!!!!!!!!!!!!!!!!!!",
    "quoted-printable with truncated escapes":
      "Content-Transfer-Encoding: quoted-printable\r\n\r\n=A=ZZ=",
    "a charset that does not exist":
      "Content-Type: text/plain; charset=definitely-not-a-charset\r\n\r\nhello",
    "invalid utf-8 bytes": Uint8Array.from([70, 114, 111, 109, 58, 32, 97, 64, 98, 13, 10, 13, 10, 0xff, 0xfe, 0xfd]),
    "a header line with no colon": "this is not a header\r\nFrom: a@b\r\n\r\nbody",
    "a continuation with nothing to continue": "  orphan\r\nFrom: a@b\r\n\r\nbody",
  };

  it.each(Object.entries(hostile))("%s", (_name, input) => {
    const parsed = parse(input);
    // The contract is a value, not an exception. `parse_failed` would also be a
    // value — it just must never be reached by a merely-odd message.
    expect(parsed).toBeTruthy();
    expect(typeof parsed.text).toBe("string");
    expect(Array.isArray(parsed.attachments)).toBe(true);
    expect(parsed.problems).not.toContain("parse_failed");
  });

  it("returns a value rather than throwing when a collaborator throws", () => {
    // The `catch` in `parseEmail` is the fail-closed contract, and no merely
    // malformed message reaches it — so the only honest way to exercise it is
    // to make something inside it fail. The HTML converter is a real
    // collaborator and a plausible one to break.
    //
    // Sabotage: rethrow from that catch and this fails, while every "hostile
    // structure" case above still passes.
    const raw = new TextEncoder().encode(
      "From: a@example.com\r\nContent-Type: text/html\r\n\r\n<p>hi</p>",
    );
    const exploding = () => {
      throw new Error("converter blew up");
    };
    let parsed: ReturnType<typeof parseEmail>;
    expect(() => {
      parsed = parseEmail(raw, DEFAULT_MIME_LIMITS, exploding);
    }).not.toThrow();
    expect(parsed!.problems).toEqual(["parse_failed"]);
    expect(parsed!.text).toBe("");
  });

  it("does not recurse without a bound", () => {
    // 400 levels of nesting against a depth cap of 12.
    let raw = "Content-Type: text/plain\r\n\r\ndeep";
    for (let level = 0; level < 400; level += 1) {
      raw = `Content-Type: multipart/mixed; boundary="b${level}"\r\n\r\n--b${level}\r\n${raw}\r\n--b${level}--`;
    }
    const started = Date.now();
    const parsed = parse(raw);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(parsed.problems.some((p) => p === "depth_capped" || p === "part_count_capped")).toBe(true);
  });

  it("does not walk an unbounded number of parts", () => {
    const parts = Array.from(
      { length: 5_000 },
      (_, index) => `--b\r\nContent-Type: text/plain\r\n\r\npart ${index}`,
    ).join("\r\n");
    const parsed = parse(`Content-Type: multipart/mixed; boundary="b"\r\n\r\n${parts}\r\n--b--`);
    expect(parsed.problems).toContain("part_count_capped");
  });

  it("does not keep an unbounded number of headers", () => {
    const headers = Array.from({ length: 5_000 }, (_, i) => `X-Pad-${i}: v`).join("\r\n");
    const parsed = parse(`${headers}\r\nFrom: a@example.com\r\n\r\nbody`);
    expect(
      parsed.problems.includes("header_count_capped") ||
        parsed.problems.includes("header_block_truncated"),
    ).toBe(true);
  });

  it("caps the raw message, the body text and the attachment count", () => {
    const long = parse(`From: a@example.com\r\n\r\n${"x".repeat(50_000)}`, { maxTextChars: 100 });
    expect(long.text).toHaveLength(100);
    expect(long.problems).toContain("text_truncated");

    const truncated = parse(`From: a@example.com\r\n\r\n${"x".repeat(50_000)}`, {
      maxRawBytes: 1_000,
    });
    expect(truncated.problems).toContain("raw_truncated");
  });

  it("keeps control characters out of the extracted text", () => {
    const parsed = parse("From: a@example.com\r\n\r\nbefore\u0007\u0000\u001bafter\ttab\nnew");
    expect(parsed.text).toBe("beforeafter\ttab\nnew");
  });
});

describe("attachments", () => {
  const withAttachment = (filename: string, payload = "aGk=") =>
    [
      "From: alice@example.com",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "see attached",
      "--b",
      "Content-Type: application/octet-stream",
      `Content-Disposition: attachment; filename="${filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      payload,
      "--b--",
      "",
    ].join("\r\n");

  it("describes an attachment without letting it become the body", () => {
    const parsed = parse(withAttachment("report.pdf"));
    expect(parsed.text).toBe("see attached");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]!.filename).toBe("report.pdf");
    expect(parsed.attachments[0]!.size).toBe(2);
  });

  it("drops the bytes of an attachment over the per-attachment cap", () => {
    const parsed = parse(withAttachment("big.bin", btoa("x".repeat(3_000))), {
      maxAttachmentBytes: 100,
    });
    expect(parsed.attachments[0]!.bytes).toBeNull();
    expect(parsed.attachments[0]!.size).toBe(3_000);
    expect(parsed.problems).toContain("attachment_size_capped");
  });

  it("reduces a hostile filename to something that cannot mean a path", () => {
    // Sabotage: use the filename as given and the first of these writes
    // outside the target folder.
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("..")).toBe("");
    expect(safeFilename("....//....//x.md")).toBe("x.md");
    expect(safeFilename("C:\\windows\\system32\\a.dll")).toBe("a.dll");
    expect(safeFilename("a/b/c/../../d.txt")).toBe("d.txt");
    expect(safeFilename(".hidden")).toBe("hidden");
    expect(safeFilename("\u0000\u0000")).toBe("");
    // A NUL becomes a space (never nothing), so the name cannot be re-joined
    // into a different one.
    expect(safeFilename("nul\u0000.txt")).toBe("nul-.txt");
  });

  it("keeps a traversal attempt out of the parsed filename too", () => {
    const parsed = parse(withAttachment("../../../../escape.md"));
    expect(parsed.attachments[0]!.filename).toBe("escape.md");
  });
});

describe("singleLine", () => {
  it("removes every way of starting a new line", () => {
    for (const injected of ["\n", "\r", "\r\n", "\u2028", "\u2029", "\u0085", "\u000b", "\u001b"]) {
      const collapsed = singleLine(`before${injected}after`);
      expect(collapsed).toBe("before after");
      expect(collapsed).not.toContain("\n");
    }
  });

  it("removes bidi overrides, which can reverse a rendered line", () => {
    expect(singleLine("safe\u202ecoc.txt")).toBe("safe coc.txt");
  });

  it("does not join two words into one", () => {
    // Replaced with a space rather than deleted: `a<LS>b` must not become `ab`.
    expect(singleLine("a\u2028b")).toBe("a b");
  });
});

describe("Authentication-Results are exposed in order", () => {
  it("keeps every header, in the order the message carried them", () => {
    const parsed = parse(
      rawMessage({
        authResults: ["first; dmarc=fail", "second; dmarc=pass"],
      }),
    );
    expect(parsed.authenticationResults).toEqual(["first; dmarc=fail", "second; dmarc=pass"]);
  });

  it("keeps a sender-supplied header below the one our MX prepended", () => {
    const parsed = parse(
      rawMessage({
        leadingHeaders: [["Authentication-Results", "mx.example-mta.test; dmarc=fail"]],
        authResults: [],
        trailingHeaders: [["Authentication-Results", "mx.example-mta.test; dmarc=pass"]],
      }),
    );
    expect(parsed.authenticationResults[0]).toContain("dmarc=fail");
  });

  it("records the first physical line separately from the unfolded value", () => {
    // The one fact about a folded header that its unfolded text cannot carry:
    // where our MTA's own CRLF was. Everything to the right of it may have been
    // spliced on by the sender, so ./auth.ts reads only the left. Sabotage:
    // snapshot after the extension instead of before, and this returns the
    // whole value — the fold defence silently becomes a no-op.
    const parsed = parse(
      `Authentication-Results: mx.example-mta.test; dkim=pass header.d=example.com\n` +
        `\theader.b="Zz"; dmarc=pass header.from=example.com\n` +
        `From: alice@example.com\nSubject: s\n\nbody\n`,
    );
    expect(parsed.authenticationResultsFolded).toEqual([true]);
    expect(parsed.authenticationResultsFirstLine).toEqual([
      "mx.example-mta.test; dkim=pass header.d=example.com",
    ]);
    expect(parsed.authenticationResults[0]).toContain("dmarc=pass");
  });

  it("reports the whole value as the first line when nothing was folded", () => {
    const parsed = parse(
      rawMessage({ authResults: ["mx.example-mta.test; dmarc=pass header.from=example.com"] }),
    );
    expect(parsed.authenticationResultsFolded).toEqual([false]);
    expect(parsed.authenticationResultsFirstLine).toEqual(parsed.authenticationResults);
  });
});

describe("ARC headers carry their position and their foldedness", () => {
  it("records whether each ARC header sits above the topmost Authentication-Results", () => {
    // Position is the whole of ./auth.ts's forgery defence and it exists only
    // in the message: an ARC header's own text cannot say where it sat. So the
    // parser is the only layer that can record it, and this is the assertion
    // that it does.
    const parsed = parse(
      rawMessage({
        leadingHeaders: [["ARC-Authentication-Results", "i=2; mx.example-mta.test; dmarc=pass"]],
        trailingHeaders: [["ARC-Authentication-Results", "i=1; mx.google.test; dmarc=pass"]],
      }),
    );
    expect(parsed.arcAuthenticationResults.map((header) => header.abovePrimary)).toEqual([
      true,
      false,
    ]);
    expect(parsed.arcAuthenticationResults[0]!.value).toContain("i=2");
  });

  it("calls nothing 'above' when there is no Authentication-Results to be above", () => {
    // No anchor, no block boundary. The conservative reading is the only safe
    // one — and `verifySender` refuses such a message anyway, one check earlier.
    const parsed = parse(
      rawMessage({
        authResults: null,
        leadingHeaders: [["ARC-Authentication-Results", "i=1; mx.example-mta.test; dmarc=pass"]],
      }),
    );
    expect(parsed.arcAuthenticationResults).toHaveLength(1);
    expect(parsed.arcAuthenticationResults[0]!.abovePrimary).toBe(false);
  });

  it("collects every ARC header, with no cap of its own", () => {
    // A cap here would be a truncation blind spot: a forged duplicate pushed
    // past it would vanish from the list `verifySender` checks for ambiguity,
    // and a check that cannot see the forgery is not a check. The only bound
    // is `maxHeaderCount`, which applies to every header alike.
    const many: [string, string][] = Array.from({ length: 30 }, (_, index) => [
      "ARC-Authentication-Results",
      `i=${index + 1}; mx.example-mta.test; dmarc=pass`,
    ]);
    const parsed = parse(rawMessage({ leadingHeaders: many }));
    expect(parsed.arcAuthenticationResults).toHaveLength(30);
  });

  it("flags a folded ARC header, and only that one", () => {
    const raw =
      `ARC-Authentication-Results: i=2; mx.example-mta.test; dkim=none\r\n` +
      `\t; dmarc=pass header.from=example.com\r\n` +
      `ARC-Authentication-Results: i=1; mx.google.test; dmarc=pass\r\n` +
      `Authentication-Results: mx.example-mta.test; dmarc=fail\r\n` +
      `From: alice@example.com\r\n\r\nhi\r\n`;
    const parsed = parse(new TextEncoder().encode(raw));
    expect(parsed.arcAuthenticationResults.map((header) => header.folded)).toEqual([true, false]);
    expect(parsed.arcAuthenticationResults[0]!.value).toContain("dmarc=pass");
  });
});

describe("a Content-Disposition token is parsed as a token, not a media type", () => {
  it("reads `attachment` even with no filename, so the guards that test it work", () => {
    // The regression: `Content-Disposition` went through `parseContentType`,
    // whose `type/subtype` validation no disposition can satisfy — a
    // disposition is a bare token with no slash. So `disposition` was always
    // "" and both `leaf.disposition !== "attachment"` guards were constant
    // `true`, leaving only their `!leaf.filename` half doing any work.
    //
    // Nothing caught it because every attachment fixture supplies a filename.
    // Without one, this attached part won inline selection and BECAME the note
    // body, while also being dropped from the attachment list — so the real
    // body never appeared and nothing recorded that a second part had existed.
    const raw =
      `From: alice@example.com\n` +
      `Content-Type: multipart/mixed; boundary="bnd"\n\n` +
      `--bnd\n` +
      `Content-Type: text/plain\n` +
      `Content-Disposition: attachment\n\n` +
      `SECRET-ATTACHED-TEXT\n` +
      `--bnd\n` +
      `Content-Type: text/plain\n\n` +
      `the real body\n` +
      `--bnd--\n`;
    const parsed = parse(raw);
    expect(parsed.text).toBe("the real body");
    expect(parsed.text).not.toContain("SECRET-ATTACHED-TEXT");
  });

  it("keeps the parameters, so a filename on an attachment still reaches the list", () => {
    const raw =
      `From: alice@example.com\n` +
      `Content-Type: multipart/mixed; boundary="bnd"\n\n` +
      `--bnd\n` +
      `Content-Type: text/plain\n\n` +
      `the real body\n` +
      `--bnd\n` +
      `Content-Type: application/pdf\n` +
      `Content-Disposition: attachment; filename="report.pdf"\n\n` +
      `%PDF-1.4\n` +
      `--bnd--\n`;
    const parsed = parse(raw);
    expect(parsed.text).toBe("the real body");
    expect(parsed.attachments.map((a) => a.filename)).toContain("report.pdf");
  });

  it("strips the parameters before comparing, even when none of them is a filename", () => {
    // The two tests above both pass if `dispositionToken` keeps only its
    // `.trim().toLowerCase()` and drops `splitParams`: the first supplies no
    // parameters at all, and the second has a filename, so the `!leaf.filename`
    // half of each guard carries it. This is the case that needs the split —
    // a parameter that is not a filename, which is what puts the whole value
    // (`"attachment; size=42"`) up against the bare token `"attachment"`.
    const raw =
      `From: alice@example.com\n` +
      `Content-Type: multipart/mixed; boundary="bnd"\n\n` +
      `--bnd\n` +
      `Content-Type: text/plain\n` +
      `Content-Disposition: attachment; size=42\n\n` +
      `SECRET-ATTACHED-TEXT\n` +
      `--bnd\n` +
      `Content-Type: text/plain\n\n` +
      `the real body\n` +
      `--bnd--\n`;
    const parsed = parse(raw);
    expect(parsed.text).toBe("the real body");
    expect(parsed.text).not.toContain("SECRET-ATTACHED-TEXT");
  });

  it("survives a bare trailing semicolon, which is the same shape with no parameter", () => {
    const raw =
      `From: alice@example.com\n` +
      `Content-Type: multipart/mixed; boundary="bnd"\n\n` +
      `--bnd\n` +
      `Content-Type: text/plain\n` +
      `Content-Disposition: attachment;\n\n` +
      `SECRET-ATTACHED-TEXT\n` +
      `--bnd\n` +
      `Content-Type: text/plain\n\n` +
      `the real body\n` +
      `--bnd--\n`;
    const parsed = parse(raw);
    expect(parsed.text).toBe("the real body");
    expect(parsed.text).not.toContain("SECRET-ATTACHED-TEXT");
  });
});
