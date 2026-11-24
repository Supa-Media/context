/**
 * Each note link Tex texts goes out signed for its preview card, once
 * (`withPreviewLinks`, `packages/shared/src/notePreview.cjs`).
 *
 * 2026-11-24: a job's report passed the finish step twice and a link went out
 * as `…?t=Product&k=…?t=Product&k=…`, which unfurls as the frozen card.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { withPreviewLinks } from "../../../packages/shared/src/notePreview.cjs";

const PLAIN = "https://context.lc/p/@supa/teams/product/overview.page.md";
const SIGNED = `${PLAIN}?t=Product&k=GyQvXxSIXjnWT6fBW8bKOg`;
const signed = new Map([[PLAIN, SIGNED]]);

test("a plain link is signed where it stands whole, before punctuation", () => {
  assert.equal(withPreviewLinks(`See ${PLAIN}.`, signed), `See ${SIGNED}.`);
  assert.equal(withPreviewLinks(`Is it ${PLAIN}?`, signed), `Is it ${SIGNED}?`);
});

test("a link already signed is never signed again", () => {
  assert.equal(withPreviewLinks(`See ${SIGNED}`, signed), `See ${SIGNED}`);
  assert.equal(withPreviewLinks(withPreviewLinks(`${PLAIN}\n${PLAIN}`, signed), signed), `${SIGNED}\n${SIGNED}`);
});

test("the start of a longer address is left alone", () => {
  assert.equal(withPreviewLinks(`${PLAIN}x`, signed), `${PLAIN}x`);
});
