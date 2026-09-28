import { describe, expect, test } from "@jest/globals";
import {
  CAST_PREVIEW_PARAM,
  castPreviewHref,
  castPreviewSnapshot,
  hasCast,
  stashCastPreview,
  takeCastPreview,
} from "../features/home/castPreview";
import { castSite } from "../features/home/cast/castSite";
import { liveHomeTree } from "../features/home/homeSite";

/** A `Storage` in memory, with what was written visible to the test. */
function memory() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const DRAFT = [
  "---",
  "title: pricing",
  "---",
  "# pricing",
  "",
  "- unlimited members",
  "",
  "```cast",
  "@jon adds a line below: - clearer skin",
  "```",
  "",
].join("\n");

const NOW = 1_800_000_000_000;
const NONCE = "abcdef0123456789";

function search(href: string) {
  return href.slice(href.indexOf("?"));
}

describe("Preview demo: the owner's draft, played by the homepage", () => {
  test("offered only for a note whose draft holds a cast step", () => {
    expect(hasCast(DRAFT)).toBe(true);
    expect(hasCast("# pricing\n\n- unlimited members\n")).toBe(false);
    // An ordinary code block that merely mentions cast is not a script.
    expect(hasCast("```js\ncast()\n```\n")).toBe(false);
    // An empty script plays nothing, so there is nothing to preview.
    expect(hasCast("```cast\n```\n")).toBe(false);
  });

  test("the draft becomes the homepage's only page, without its frontmatter, with its cast playing", () => {
    const snapshot = castPreviewSnapshot(DRAFT, "pricing", "Preview");
    expect(snapshot.revision).toBeNull();
    expect(snapshot.pages).toHaveLength(1);
    expect(snapshot.pages[0]!.routePath).toBe("/");
    expect(snapshot.pages[0]!.markdown.startsWith("# pricing")).toBe(true);

    // What the homepage does with it: the same `castSite` as the real site.
    const cast = castSite(snapshot.pages);
    expect(cast.scripts.get("/")?.map((step) => step.kind)).toEqual(["append"]);
    expect(cast.pages[0]!.markdown).not.toContain("```cast");
    expect(liveHomeTree(cast.pages).paths.get("/")).toBeDefined();
  });

  test("the new tab takes the handoff once, and a reload is the real site again", () => {
    const store = memory();
    const nonce = stashCastPreview(store, castPreviewSnapshot(DRAFT, "pricing", "Preview"), NOW, NONCE);
    expect(nonce).toBe(NONCE);
    const href = castPreviewHref(NONCE);
    expect(href).toBe(`/?${CAST_PREVIEW_PARAM}=${NONCE}`);

    const taken = takeCastPreview(store, search(href), NOW + 1_000);
    expect(taken?.pages[0]!.title).toBe("pricing");
    expect(store.items.size).toBe(0);
    expect(takeCastPreview(store, search(href), NOW + 2_000)).toBeNull();
  });

  test("a second press clears a draft whose tab never opened", () => {
    const store = memory();
    stashCastPreview(store, castPreviewSnapshot(DRAFT, "pricing", "Preview"), NOW, NONCE);
    stashCastPreview(store, castPreviewSnapshot(DRAFT, "pricing", "Preview"), NOW, "fedcba9876543210");
    expect([...store.items.keys()]).toEqual(["context-cast-preview:fedcba9876543210"]);
  });

  test("an ordinary visit, an unknown key, a stale handoff or junk is the real site", () => {
    const store = memory();
    expect(takeCastPreview(store, "", NOW)).toBeNull();
    expect(takeCastPreview(store, "?page=pricing", NOW)).toBeNull();
    expect(takeCastPreview(store, `?${CAST_PREVIEW_PARAM}=${NONCE}`, NOW)).toBeNull();

    stashCastPreview(store, castPreviewSnapshot(DRAFT, "pricing", "Preview"), NOW, NONCE);
    expect(takeCastPreview(store, `?${CAST_PREVIEW_PARAM}=${NONCE}`, NOW + 11 * 60 * 1000)).toBeNull();
    expect(store.items.size).toBe(0);

    store.setItem(`context-cast-preview:${NONCE}`, "{not json");
    expect(takeCastPreview(store, `?${CAST_PREVIEW_PARAM}=${NONCE}`, NOW)).toBeNull();
    store.setItem(`context-cast-preview:${NONCE}`, JSON.stringify({ at: NOW, snapshot: { pages: [] } }));
    expect(takeCastPreview(store, `?${CAST_PREVIEW_PARAM}=${NONCE}`, NOW)).toBeNull();
    // A key that is not one of ours is never read.
    expect(takeCastPreview(store, `?${CAST_PREVIEW_PARAM}=../x`, NOW)).toBeNull();
  });

  test("storage that throws means no preview, never an error", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(stashCastPreview(broken, castPreviewSnapshot(DRAFT, "p", "Preview"), NOW, NONCE)).toBeNull();
    expect(takeCastPreview(broken, `?${CAST_PREVIEW_PARAM}=${NONCE}`, NOW)).toBeNull();
    expect(stashCastPreview(undefined, castPreviewSnapshot(DRAFT, "p", "Preview"))).toBeNull();
  });
});
