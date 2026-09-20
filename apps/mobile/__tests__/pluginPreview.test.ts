/**
 * @jest-environment jsdom
 */

/**
 * Who may be asked to preview a note's links, which frame is asked, and which
 * answer is still worth drawing.
 *
 * ## The gate, and why it is the stricter one
 *
 * A preview query carries the note's **links** into a plugin's sandbox: the
 * addresses somebody wrote down and the words they wrote around them. That is
 * note content, not metadata about a note, so it passes `maySeeContent` —
 * `vault:read` alone — exactly as a suggestion query does, and not the looser
 * `maySeePaths` that also accepts `metadata:read`.
 *
 * It is worth stating because the argument could plausibly go the other way: a
 * link is *in* the metadata cache in Obsidian, and `metadata:read` is named for
 * links and tags. What the cache holds is the graph between notes in this
 * bucket; what this carries is the URL of a third-party page and the label
 * beside it, which is prose. A plugin approved to see the shape of somebody's
 * vault was not approved to read the URLs in it.
 */

import { describe, expect, test } from "@jest/globals";
import { freshPreviews, maySeeContent, maySeePaths, previewFor } from "../features/console/plugins/runtime";
import {
  externalLinkAt,
  externalLinksIn,
} from "../features/console/files/pluginPreview";
import type { PluginGrant } from "../features/console/plugins/grants";

const BUNDLE = { pluginId: "youversion-linker", bundleFingerprint: "fp-1" };
const JOHN = "https://www.bible.com/bible/1/JHN.3.16";

function grant(capabilities: PluginGrant["capabilities"], over: Partial<PluginGrant> = {}): PluginGrant {
  return {
    pluginId: "youversion-linker",
    bundleFingerprint: "fp-1",
    capabilities,
    networkHosts: [],
    status: "active",
    grantedAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe("a note's links only reach a plugin allowed to read notes", () => {
  test("vault:read is the grant that opens it", () => {
    expect(maySeeContent(BUNDLE, [grant(["vault:read"])])).toBe(true);
  });

  test("metadata:read is enough for a path and not for the note's own links", () => {
    const grants = [grant(["metadata:read"])];
    expect(maySeePaths(BUNDLE, grants)).toBe(true);
    expect(maySeeContent(BUNDLE, grants)).toBe(false);
  });

  test("a revoked grant previews nothing", () => {
    expect(maySeeContent(BUNDLE, [grant(["vault:read"], { status: "revoked" })])).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("a query reaches one frame, and a stale answer reaches nobody", () => {
  const sandbox = { bundle: { pluginId: "youversion-linker" }, nonce: "frame-1" };
  const links = [{ href: JOHN, text: "John 3:16" }];

  test("the frame it was addressed to gets it", () => {
    expect(previewFor(sandbox, { seq: 3, pluginId: "youversion-linker", nonce: "frame-1", links }))
      .toEqual({ seq: 3, links });
  });

  /*
    #533's rule, applied to the third instruction in this protocol. A restart
    mounts a frame with its own settings and its own cache; a query aimed at its
    predecessor is not owed to it.
  */
  test("a replacement frame does not inherit its predecessor's query", () => {
    expect(previewFor(sandbox, { seq: 3, pluginId: "youversion-linker", nonce: "frame-0", links }))
      .toBeUndefined();
  });

  test("another plugin's frame never sees it", () => {
    expect(previewFor({ bundle: { pluginId: "other" }, nonce: "frame-1" }, {
      seq: 3, pluginId: "youversion-linker", nonce: "frame-1", links,
    })).toBeUndefined();
  });

  /*
    A verse crosses the broker and a third-party site, which is long enough for
    the reader to close the note or rewrite the paragraph. An answer about links
    that are no longer there would be drawn over whatever is at that href now.
  */
  test("an answer for an older query is dropped", () => {
    const previews = [{ href: JOHN, text: "For God so loved the world" }];
    expect(freshPreviews({ seq: 9, previews }, 9)).toEqual(previews);
    expect(freshPreviews({ seq: 8, previews }, 9)).toBeNull();
  });

  test("an answer with no query outstanding is dropped", () => {
    expect(freshPreviews({ seq: 9, previews: [] }, null)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

/*
  WHICH LINKS ARE EVEN ASKED ABOUT.

  Built on `@context/shared`'s `parseLinks` rather than a pattern of its own,
  which is what buys the code-fence rule below for nothing: a URL inside a
  fence is a URL being written about, not a link, and sending it would have a
  plugin fetch a page nobody linked to.
*/
describe("the external links in a note", () => {
  test("an inline link gives its href, its label and its whole span", () => {
    expect(externalLinksIn(`see [John 3:16](${JOHN}) now`)).toEqual([
      { from: 4, to: 4 + `[John 3:16](${JOHN})`.length, href: JOHN, text: "John 3:16" },
    ]);
  });

  test("a wiki link is not one — it addresses a note, and carries no scheme", () => {
    expect(externalLinksIn("see [[1-projects/john-3]] now")).toEqual([]);
  });

  test("a link to another note in this bucket is not external", () => {
    expect(externalLinksIn("see [John](1-projects/john-3.md)")).toEqual([]);
  });

  test("a URL inside a code fence is text about a link, not a link", () => {
    expect(externalLinksIn("```\nsee [John 3:16](" + JOHN + ")\n```")).toEqual([]);
  });

  test("several on one line each keep their own label", () => {
    const text = `[a](https://example.test/a) and [b](https://example.test/b)`;
    expect(externalLinksIn(text).map((one) => [one.href, one.text])).toEqual([
      ["https://example.test/a", "a"],
      ["https://example.test/b", "b"],
    ]);
  });

  test("a hover inside the link finds it, and one outside does not", () => {
    const spans = externalLinksIn(`see [John 3:16](${JOHN}) now`);
    expect(externalLinkAt(spans, 8)?.href).toBe(JOHN);
    expect(externalLinkAt(spans, 2)).toBeNull();
    expect(externalLinkAt(spans, 200)).toBeNull();
  });
});
