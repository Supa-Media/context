import { useEffect, useMemo, useRef, useState } from "react";
import {
  offerMerge,
  type MergeRefusal,
} from "../../offline/resolution";
import type { Merge3Result } from "../../offline/merge";
import type { Cached } from "../../offline/cache";
import type { EditorState } from "./editor";
import type { OpenNote } from "./types";

/**
 * Everything a person needs in front of them to answer a conflict.
 *
 * ## Why the bucket's version is re-read here
 *
 * A conflict arrives carrying an etag and a sentence, not a body. To offer
 * anything better than "yours or theirs, blind" the console has to hold the
 * text that is actually in the bucket — to show it, and to merge against it.
 * So this reads the note again, at the moment somebody is looking at the
 * decision, and **that read is what every subsequent save is checked against**:
 * the version on screen is the version the write is conditional on. If it moves
 * again between the read and the save, the write comes back as a conflict and
 * this whole surface reappears with fresh content, which is the correct
 * outcome rather than a failure.
 *
 * ## Why that read must not touch the cache
 *
 * `openNote` remembers what it reads. This deliberately does not, and it is not
 * an oversight: the cache is holding the **ancestor** — the note's body at the
 * etag the draft was typed against — and that body is the only reason a
 * three-way merge is possible at all. Caching the bucket's newer version here
 * would overwrite the ancestor with one of the two sides being merged, and the
 * merge would silently stop being offered from the second conflict onwards.
 *
 * ## What it does not do
 *
 * It writes nothing, anywhere. Reading the other side is a read; every write is
 * behind a control somebody presses. That is the property
 * `__tests__/conflictResolution.test.ts` holds — "no write happens while the
 * decision is open" — and it is the one this whole design is for.
 */
export interface ConflictReview {
  path: string;
  /** What was typed on this device and has never reached the bucket. */
  mine: string;
  /** The body in the bucket, once it has been read. */
  theirs: string | null;
  /**
   * The etag `theirs` was read at.
   *
   * What a chosen save is made conditional on — the version the person was
   * shown, never "whatever is there when the button is pressed".
   */
  theirsEtag: string | null;
  /** The bucket's version is still being read. */
  reading: boolean;
  /** Why it could not be read, when it could not. */
  unreadable: string | null;
  /** The proposal, when an honest one could be made. */
  merge: Merge3Result | null;
  /** Why there is no Merge button. `null` exactly when `merge` is present. */
  mergeRefusal: { reason: MergeRefusal; sentence: string } | null;
  /** From the binding's connect-time probe, for what the check is worth. */
  conditionalWrite?: boolean;
  /** Whatever the refusal itself said, if anything. */
  message?: string;
}

interface Fetched {
  theirs: string | null;
  theirsEtag: string | null;
  reading: boolean;
  unreadable: string | null;
  /** The cache's ancestor, and the etag it is held at. */
  cached: { text: string; etag: string } | null;
}

const IDLE: Fetched = {
  theirs: null,
  theirsEtag: null,
  reading: false,
  unreadable: null,
  cached: null,
};

export function useConflictReview(input: {
  editor: EditorState;
  /** Reads the note from the bucket. Must **not** be the caching read. */
  fetchNote: (path: string) => Promise<OpenNote>;
  cachedNote: (path: string) => Promise<Cached<OpenNote> | null>;
  online: boolean;
  conditionalWrite?: boolean;
}): ConflictReview | null {
  const { editor, online } = input;
  const [fetched, setFetched] = useState<Fetched>(IDLE);

  /*
    Through refs, for the reason every callback in `useFileBrowser` reads the
    offline layer through one: `cachedNote` comes off an object that is rebuilt
    on every keystroke, and an effect that depended on it would re-read the
    bucket on every character typed into a conflicted note.
  */
  const fetchRef = useRef(input.fetchNote);
  fetchRef.current = input.fetchNote;
  const cachedRef = useRef(input.cachedNote);
  cachedRef.current = input.cachedNote;
  const draftBaseRef = useRef(editor.draftBase);
  draftBaseRef.current = editor.draftBase;

  const conflicted = editor.status === "conflict" && editor.path !== null;
  const path = conflicted ? editor.path : null;
  /*
    The identity of *this* conflict, not of the note.

    `conflictEtag` is in it because a second conflict on the same note — the
    person chose, the save was refused again because somebody wrote a third
    time — is a different decision about different text, and it has to re-read.
    Without it the surface would keep showing the version from the first round.
  */
  const round = path === null ? null : `${path} ${editor.conflictEtag ?? ""}`;

  useEffect(() => {
    if (round === null || path === null) {
      setFetched(IDLE);
      return;
    }
    let cancelled = false;
    setFetched({ ...IDLE, reading: online });

    void (async () => {
      // The ancestor first, and always — it is read off the device, so it
      // costs nothing and it is the half that works with no connection.
      const cached = await cachedRef.current(path).catch(() => null);
      const ancestor =
        cached === null ? null : { text: cached.value.text, etag: cached.value.etag };
      if (cancelled) return;

      if (!online) {
        setFetched({ ...IDLE, cached: ancestor });
        return;
      }

      try {
        const note = await fetchRef.current(path);
        if (cancelled) return;
        setFetched({
          theirs: note.text,
          theirsEtag: note.etag,
          reading: false,
          unreadable: null,
          cached: ancestor,
        });
      } catch {
        if (cancelled) return;
        /*
          Deliberately not the thrown message. This is one of the two sides of
          a decision somebody is about to make, so the sentence has to say what
          it means for the decision rather than what the storage layer said.

          **And deliberately not gated on `isServerRefusal`**, unlike the three
          read paths in `useFileBrowser`. The rule those follow is that a copy
          on the device may never overrule an answer from the server, and it
          holds here without a check: the cached ancestor is not shown. It only
          reaches `offerMerge`, which refuses with `"offline"` the moment
          `theirs` is absent, so a failed read produces no merge and no bucket
          text at all — just the fixed sentence below. What stays on screen is
          the person's own draft, which was already there.

          Reaching for the discriminator anyway would cost the one thing this
          panel exists for. Somebody whose membership was revoked mid-conflict
          still has unsaved typing in front of them, and blanking the panel
          would be the console taking it away at exactly the moment they need
          to copy it out. `keepMine` is refused by the server like any other
          write, which is where that decision belongs.
        */
        setFetched({
          ...IDLE,
          cached: ancestor,
          unreadable:
            "The version in your bucket could not be read just now, so it cannot be shown or merged. Keeping yours is still checked against it.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [online, path, round]);

  return useMemo(() => {
    if (!conflicted || path === null) return null;
    const offer = offerMerge({
      cached: fetched.cached,
      draftBase: draftBaseRef.current ?? null,
      mine: editor.draft,
      theirs: fetched.theirs,
    });
    return {
      path,
      mine: editor.draft,
      theirs: fetched.theirs,
      theirsEtag: fetched.theirsEtag,
      reading: fetched.reading,
      unreadable: fetched.unreadable,
      merge: offer.merge,
      mergeRefusal: offer.refusal,
      conditionalWrite: input.conditionalWrite,
      message: editor.message,
    };
  }, [conflicted, editor.draft, editor.message, fetched, input.conditionalWrite, path]);
}
