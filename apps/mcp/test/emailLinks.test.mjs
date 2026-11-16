/**
 * AN EMAIL'S LINKS KEEP THEIR ADDRESSES (the owner, 2026-11-16).
 *
 * A vendor's email said only "Click here to view the report in (pdf) format",
 * and the address behind "Click here" never reached Tex: the HTML became its
 * words and nothing else, so the job could not open the report. Now each
 * link's address follows its words in brackets, on every path that turns an
 * email's HTML into text (Gmail synced or read live with `read_email`, which
 * the control plane runs through `extractBody`; mail sent to a workspace's
 * address, through the same shared converter, tested in
 * `infra/email-worker/src/html.test.ts`).
 *
 * ## Sabotage record
 *
 *   `htmlText` without `{ links: true }`
 *     → "a link's address follows its words" fails
 *   `preferredBody` always taking the plain part
 *     → "the HTML is read when only it has the address" fails
 *   the unsubscribe rule removed
 *     → "mailto, unsubscribe and already-shown addresses are left out" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { extractBody } from "../src/communications/gmailSync.js";
import { htmlText } from "../src/communications/gmail/parsing.js";
import htmlTextModule from "../../../packages/shared/src/htmlText.cjs";
import { fixtureMessage } from "./gmailSync/fixtures.mjs";

const { MAX_LINKS, htmlToText } = htmlTextModule;

const REPORT = "https://reports.example.com/view?id=42&format=pdf";
const VENDOR_HTML =
  `<html><head><title>Report</title></head><body>` +
  `<p>Your weekly report is ready.</p>` +
  `<p><a href="${REPORT.replace("&", "&amp;")}">Click here</a> to view the report in (pdf) format</p>` +
  `<img src="https://track.example.com/open.gif" width="1" height="1">` +
  `<p><a href="https://vendor.example.com/unsubscribe?u=1">Unsubscribe</a></p></body></html>`;

test("a link's address follows its words", () => {
  const text = htmlText(VENDOR_HTML);
  assert.match(text, /Click here \[https:\/\/reports\.example\.com\/view\?id=42&format=pdf\] to view the report in \(pdf\) format/);
  assert.doesNotMatch(text, /track\.example\.com/, "a tracking picture is never a link");
  assert.doesNotMatch(text, /unsubscribe\?/i);
});

test("mailto, unsubscribe and already-shown addresses are left out, and each address is kept once", () => {
  const text = htmlText(
    `<a href="mailto:help@example.com">Email us</a> ` +
      `<a href="https://example.com/a">Open</a> <a href="https://example.com/a">Open again</a> ` +
      `<a href="https://example.com/b">https://example.com/b</a> <a href="https://example.com/b/">example.com/b</a> ` +
      `<a href="https://example.com/prefs">Manage preferences</a> <a href="javascript:alert(1)">x</a> <a href="#top">Top</a> ` +
      `<a href="https://example.com/x]y">Bracket</a>`,
  );
  assert.equal(
    text,
    "Email us Open [https://example.com/a] Open again https://example.com/b example.com/b Manage preferences x Top Bracket [https://example.com/x%5Dy]",
  );
});

test("the addresses are capped, and the text still is", () => {
  const many = Array.from({ length: MAX_LINKS + 10 }, (_, i) => `<a href="https://example.com/${i}">go</a>`).join(" ");
  const kept = htmlText(many).match(/\[https:/g) ?? [];
  assert.equal(kept.length, MAX_LINKS);
  assert.ok(htmlToText(many, 100, undefined, { links: true }).length <= 100);
  // Without the option a link is its words alone, as before.
  assert.equal(htmlToText('<a href="https://example.com/a">Open</a>', 1_000), "Open");
});

test("the HTML is read when only it has the address, the plain part otherwise", () => {
  const both = fixtureMessage({
    id: "m-links",
    text: "Your weekly report is ready.\nClick here to view the report in (pdf) format",
    html: VENDOR_HTML,
  });
  assert.match(extractBody(both.payload).text, /\[https:\/\/reports\.example\.com\/view\?id=42&format=pdf\]/);
  const plainHasIt = fixtureMessage({ id: "m-plain", text: `Click here: ${REPORT}`, html: VENDOR_HTML });
  assert.equal(extractBody(plainHasIt.payload).text, `Click here: ${REPORT}`);
  const htmlOnly = fixtureMessage({ id: "m-html", html: VENDOR_HTML });
  assert.match(extractBody(htmlOnly.payload).text, /Click here \[https:\/\/reports\.example\.com/);
});
