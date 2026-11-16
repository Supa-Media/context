/**
 * Mail sent to a workspace's address keeps each link's address after its
 * words (the owner, 2026-11-16: a vendor's "Click here to view the report in
 * (pdf) format" reached Tex without the address behind it). The converter is
 * the shared one (`packages/shared/src/htmlText.cjs`); the gateway's Gmail
 * path is tested in `apps/mcp/test/emailLinks.test.mjs`.
 *
 * Sabotage record:
 *   ingestion passing plain `htmlToText` again → "a captured note carries the address" fails
 *   `linksOnlyIn` always false → "a plain part without the address loses to the HTML" fails
 */
import { describe, expect, it } from "vitest";
import { htmlToText, htmlToTextWithLinks } from "./html";
import { DEFAULT_MIME_LIMITS, parseEmail } from "./mime";
import { DEFAULT_TARGET_FOLDER, decideCapture } from "./ingest";
import { senderIsAllowed } from "./policy";
import { AUTHSERV, rawMessage } from "./fixtures.test-helpers";

const CAP = 100_000;
const REPORT = "https://reports.example.com/view?id=42&format=pdf";
const HTML = `<p><a href="${REPORT.replace("&", "&amp;")}">Click here</a> to view the report in (pdf) format</p><p><a href="mailto:help@example.com">Write to us</a></p>`;

const bytes = (value: string) => new TextEncoder().encode(value);

describe("link addresses", () => {
  it("follow their words, mailto left out", () => {
    expect(htmlToTextWithLinks(HTML, CAP)).toBe(`Click here [${REPORT}] to view the report in (pdf) format\n\nWrite to us`);
  });

  it("are left out by default", () => {
    expect(htmlToText(HTML, CAP)).toBe("Click here to view the report in (pdf) format\n\nWrite to us");
  });

  it("an ingested HTML email keeps its link's address", () => {
    const raw = ["From: reports@example.com", "Content-Type: text/html; charset=utf-8", "", HTML].join("\r\n");
    const parsed = parseEmail(bytes(raw), DEFAULT_MIME_LIMITS, htmlToTextWithLinks);
    expect(parsed.textSource).toBe("html");
    expect(parsed.text).toContain(`Click here [${REPORT}]`);
  });

  it("a captured note carries the address", async () => {
    const decision = await decideCapture(
      { recipient: "seyi@context.lc", owner: "seyi", raw: rawMessage({ contentType: 'text/html; charset="utf-8"', body: HTML }), now: new Date("2026-08-26T09:00:00.000Z"), fenceNonce: "0123456789abcdef" },
      { targetFolder: DEFAULT_TARGET_FOLDER, policy: { allowedSenders: ["alice@example.com"], allowedDomains: [], allowAnySender: false }, attachmentPolicy: "list", maxMessageBytes: 5_000_000, limits: DEFAULT_MIME_LIMITS, authServiceId: AUTHSERV },
      senderIsAllowed,
    );
    expect(decision.kind).toBe("capture");
    if (decision.kind === "capture") expect(decision.note).toContain(`Click here [${REPORT}]`);
  });

  it("a plain part without the address loses to the HTML, and one with it wins", () => {
    const raw = (plain: string) =>
      [
        "From: reports@example.com",
        'Content-Type: multipart/alternative; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain",
        "",
        plain,
        "--b1",
        "Content-Type: text/html",
        "",
        HTML,
        "--b1--",
        "",
      ].join("\r\n");
    const without = parseEmail(bytes(raw("Click here to view the report in (pdf) format")), DEFAULT_MIME_LIMITS, htmlToTextWithLinks);
    expect(without.textSource).toBe("html");
    expect(without.text).toContain(REPORT);
    const withIt = parseEmail(bytes(raw(`The report: ${REPORT}`)), DEFAULT_MIME_LIMITS, htmlToTextWithLinks);
    expect(withIt.textSource).toBe("plain");
    expect(withIt.text).toBe(`The report: ${REPORT}`);
  });

  it("stays linear on hostile links", () => {
    const attacks = [
      `<a href="${"&".repeat(300_000)}">x</a>`,
      `<a ${"h ".repeat(150_000)}>x</a>`,
      `<a href="https://example.com/${"a".repeat(300_000)}">x</a>`,
      '<a href="https://example.com/">'.repeat(20_000),
    ];
    for (const html of attacks) {
      let steps = 0;
      const started = Date.now();
      const text = htmlToText(html, CAP, () => void (steps += 1), { links: true });
      expect(steps).toBeLessThanOrEqual(html.length * 3 + 100);
      expect(text.length).toBeLessThanOrEqual(CAP);
      // A tripwire, not a benchmark: a quadratic scan of these takes far longer.
      expect(Date.now() - started).toBeLessThan(2_000);
    }
  });
});
