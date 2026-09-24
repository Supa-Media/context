/**
 * Detecting whether a bucket already holds a context, or holds only what we
 * wrote there ourselves.
 *
 * Split out of `lib/scaffold.ts` — see that file's header for the scaffolder's
 * overall rules.
 */

import { INDEX_KEY, PRIVACY_KEY, type ScaffoldStore } from "./store";

/* -------------------------------------------------------------------------- */
/*                          detecting an existing context                     */
/* -------------------------------------------------------------------------- */

/**
 * A key whose path contains a dot-prefixed segment is gateway plumbing
 * (`.history/`, `.audit/`, `.context-probe/`, `.obsidian/`), not somebody's
 * notes. Same rule the gateway's `isPlumbing` applies.
 */
export function isPlumbingKey(key: string): boolean {
  return key.split("/").some((segment) => segment.startsWith("."));
}

/**
 * Pages of the root listing we are willing to walk before giving up.
 *
 * Exported so `__tests__/scaffold.test.ts` can seed *more* plumbing than this
 * many pages can hold. That is what makes the delimiter test below non-vacuous:
 * with fewer objects than `DETECT_PAGE_CAP * 1000`, a flat listing eventually
 * reaches the real notes anyway and the test passes for the wrong reason.
 */
export const DETECT_PAGE_CAP = 5;
/** Keys per page. Named for the same reason as the cap above. */
export const DETECT_PAGE_SIZE = 1000;

/**
 * Does this bucket already hold a context?
 *
 * Listed **with a delimiter**, which is the part that matters. A flat listing
 * of a real workspace returns `.history/…` objects first — `.` sorts before every
 * digit and letter — and there can be tens of thousands of them, so a
 * first-page flat listing of the founder's live bucket would come back looking
 * completely empty and we would scaffold straight over the top of it. With a
 * delimiter, that whole subtree collapses to the single prefix `.history/`,
 * and the real folders are visible on page one.
 *
 * The well-known files are checked directly as well, because a bucket whose
 * only content is `privacy.md` is still a context whose access rules must not
 * be reset.
 */
export async function hasExistingContext(store: ScaffoldStore): Promise<boolean> {
  for (const key of [PRIVACY_KEY, INDEX_KEY]) {
    if ((await store.get(key)) !== null) return true;
  }

  let cursor: string | undefined = undefined;
  for (let page = 0; page < DETECT_PAGE_CAP; page += 1) {
    const listing: Awaited<ReturnType<ScaffoldStore["list"]>> = await store.list({
      prefix: "",
      delimiter: "/",
      cursor,
      limit: DETECT_PAGE_SIZE,
    });
    for (const object of listing.objects ?? []) {
      if (!isPlumbingKey(object.key)) return true;
    }
    for (const prefix of listing.delimitedPrefixes ?? []) {
      if (!isPlumbingKey(prefix)) return true;
    }
    if (!listing.truncated) return false;
    // A walk that did not finish knows nothing, and `false` here is the
    // fail-open answer: "no context, scaffold away", over a bucket we could not
    // see the end of. Two ways to not finish and both used to fall out of the
    // loop into `return false`: the page cap, and a store that reports another
    // page and then offers no continuation token — `readTag` in
    // `apps/mcp/src/store/s3.js` reads `IsTruncated` and
    // `NextContinuationToken` from independent tags with no cross-check, so
    // `{ truncated: true, cursor: undefined }` really does arrive here.
    if (!listing.cursor) return true;
    cursor = listing.cursor;
  }
  // The page cap, reached. Same reasoning: unfinished means occupied.
  return true;
}

/**
 * Is there anything in this bucket that **we did not put there**?
 *
 * ## The question `hasExistingContext` cannot answer
 *
 * A scaffold that fails partway leaves real objects in the bucket, so from
 * that moment on `hasExistingContext` says "this is somebody's context" — and
 * it is right, in the only sense it can see. It is also the reason the person
 * whose scaffold half-landed could not finish it through the product: the
 * retry's first guard saw the `privacy.md` the *first attempt* wrote and
 * refused, reporting a bucket we had half-written as a bucket we must not
 * touch (issue #22).
 *
 * So a resuming scaffold asks a narrower question, and the narrowing is the
 * whole safety argument: **every non-plumbing object in the bucket must be a
 * key this exact layout would write, holding the exact bytes this exact layout
 * would write there.** Byte-identity is what makes the answer "we wrote this"
 * rather than "something with this name is here": a person's own
 * hand-maintained `privacy.md` or `1-projects/README.md` is not byte-identical
 * to our generated one, and one note of theirs anywhere — `1-projects/ship.md`
 * — is a key no layout of ours contains. Either way this returns `true` and
 * the caller refuses, exactly as it does for a vault that was here before we
 * arrived.
 *
 * That also means a resume completes **the layout it started**. Asking to
 * resume a half-written PARA bucket with a `custom` layout finds `0-inbox/`
 * foreign and refuses, rather than interleaving two layouts in somebody's
 * bucket.
 *
 * Listed with the same delimiter and page cap as `hasExistingContext`, for the
 * same `.history/` reason. A folder prefix that *is* one of ours is then
 * walked flat, because "the prefix `1-projects/` exists" says nothing about
 * whether what is under it is our README or a thousand of their notes.
 */
export async function hasForeignContent(
  store: ScaffoldStore,
  files: readonly { key: string; body: string }[],
): Promise<boolean> {
  const ours = new Map(files.map((file) => [file.key, file.body]));
  const ourPrefixes = new Set(
    files
      .filter((file) => file.key.includes("/"))
      .map((file) => `${file.key.slice(0, file.key.indexOf("/"))}/`),
  );

  const isOurs = async (key: string): Promise<boolean> => {
    const body = ours.get(key);
    if (body === undefined) return false;
    const object = await store.get(key);
    // Listed but unreadable a moment later: treat as not ours, which refuses.
    if (object === null) return false;
    return (await object.text()) === body;
  };

  const walk = async (
    prefix: string,
    delimiter: string | undefined,
  ): Promise<boolean> => {
    let cursor: string | undefined = undefined;
    for (let page = 0; page < DETECT_PAGE_CAP; page += 1) {
      const listing: Awaited<ReturnType<ScaffoldStore["list"]>> = await store.list(
        { prefix, delimiter, cursor, limit: DETECT_PAGE_SIZE },
      );
      for (const object of listing.objects ?? []) {
        if (isPlumbingKey(object.key)) continue;
        if (!(await isOurs(object.key))) return true;
      }
      for (const found of listing.delimitedPrefixes ?? []) {
        if (isPlumbingKey(found)) continue;
        if (!ourPrefixes.has(found)) return true;
        // Ours by name. Now prove what is under it is ours by content.
        if (await walk(found, undefined)) return true;
      }
      if (!listing.truncated) return false;
      // Unfinished means "assume foreign", for the same reason
      // `hasExistingContext` assumes occupied: `false` is the answer that lets
      // a scaffold run over somebody's bucket.
      if (!listing.cursor) return true;
      cursor = listing.cursor;
    }
    return true;
  };

  return await walk("", "/");
}
