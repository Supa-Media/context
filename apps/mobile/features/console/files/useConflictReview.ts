import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  offerMerge,
  type MergeRefusal,
} from "../../offline/resolution";
import type { Merge3Result } from "../../offline/merge";
import { raceTimeout } from "../storage/timeout";
import { isServerRefusal } from "./browser";
import type { EditorState } from "./editor";
import type { OpenNote } from "./types";

/** A conflict read should recover before somebody reaches for refresh. */
export const CONFLICT_READ_RETRY_MS = 1_500;
/** Convex actions do not reject when the device only looks online. */
export const CONFLICT_READ_TIMEOUT_MS = 8_000;

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
  /** Retry a transient read immediately instead of refreshing the whole app. */
  retry?: () => void;
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
  /** The conflict round these bytes belong to. */
  round: string | null;
  theirs: string | null;
  theirsEtag: string | null;
  reading: boolean;
  unreadable: string | null;
  retryable: boolean;
  /** The cache's ancestor, and the etag it is held at. */
  cached: { text: string; etag: string } | null;
}

const IDLE: Fetched = {
  round: null,
  theirs: null,
  theirsEtag: null,
  reading: false,
  unreadable: null,
  retryable: false,
  cached: null,
};

export function useConflictReview(input: {
  editor: EditorState;
  /** Reads the note from the bucket. Must **not** be the caching read. */
  fetchNote: (path: string) => Promise<OpenNote>;
  /**
   * The device's copy to merge against, given the version the draft was typed
   * on. Asked with the base rather than for "the cached note" because a mirror
   * that has synced since holds the bucket's newer body as its current copy and
   * keeps the ancestor beside it (`mirroredAncestor`) — the newest copy is
   * exactly what an ancestor is not.
   */
  ancestor: (path: string, draftBase: string | null) => Promise<{ text: string; etag: string } | null>;
  online: boolean;
  conditionalWrite?: boolean;
}): ConflictReview | null {
  const { editor, online } = input;
  const [fetched, setFetched] = useState<Fetched>(IDLE);
  const [retryGeneration, setRetryGeneration] = useState(0);

  /*
    Through refs, for the reason every callback in `useFileBrowser` reads the
    offline layer through one: `ancestor` comes off an object that is rebuilt
    on every keystroke, and an effect that depended on it would re-read the
    bucket on every character typed into a conflicted note.
  */
  const fetchRef = useRef(input.fetchNote);
  fetchRef.current = input.fetchNote;
  const cachedRef = useRef(input.ancestor);
  cachedRef.current = input.ancestor;
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
  const retryRoundRef = useRef<string | null>(null);
  const retryFailuresRef = useRef(0);
  if (retryRoundRef.current !== round) {
    retryRoundRef.current = round;
    retryFailuresRef.current = 0;
  }

  const retry = useCallback(() => {
    retryFailuresRef.current = 0;
    setRetryGeneration((generation) => generation + 1);
  }, []);

  useEffect(() => {
    if (round === null || path === null) {
      setFetched(IDLE);
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    setFetched((current) =>
      current.round === round && current.theirs !== null
        ? { ...current, reading: online, retryable: false }
        : { ...IDLE, round, reading: online },
    );

    void (async () => {
      // The ancestor first, and always — it is read off the device, so it
      // costs nothing and it is the half that works with no connection.
      const ancestor = await cachedRef
        .current(path, draftBaseRef.current ?? null)
        .catch(() => null);
      if (cancelled) return;

      if (!online) {
        // Keep a version already shown for this conflict. Losing signal after
        // the review loaded must not erase the safe decision in front of the
        // person or make them wait for the same bytes twice.
        setFetched((current) =>
          current.round !== round || current.theirs === null
            ? { ...IDLE, round, cached: ancestor }
            : { ...current, reading: false, retryable: false, cached: ancestor },
        );
        return;
      }

      const settled = await raceTimeout(fetchRef.current(path), {
        ms: CONFLICT_READ_TIMEOUT_MS,
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (handle) => clearTimeout(handle),
      });

      if (settled.kind === "value") {
        if (cancelled) return;
        retryFailuresRef.current = 0;
        setFetched({
          round,
          theirs: settled.value.text,
          theirsEtag: settled.value.etag,
          reading: false,
          unreadable: null,
          retryable: false,
          cached: ancestor,
        });
        return;
      }

      if (cancelled) return;
      const retryable = settled.kind === "timeout" || !isServerRefusal(settled.error);
      setFetched({
        ...IDLE,
        round,
        cached: ancestor,
        retryable,
        unreadable: retryable
          ? "The version in your bucket could not be read just now, so it cannot be shown or merged. Your draft is safe, and this screen will retry automatically."
          : "The version in your bucket could not be read, so it cannot be shown or merged. Your draft is still safe on this device.",
      });

      if (retryable) {
        const delay = Math.min(
          CONFLICT_READ_RETRY_MS * 2 ** retryFailuresRef.current,
          30_000,
        );
        retryFailuresRef.current += 1;
        retryTimer = setTimeout(() => {
          if (!cancelled) setRetryGeneration((generation) => generation + 1);
        }, delay);
      }

      /*
        A read failure is recoverable in place. The old one-shot effect left
        this surface frozen until a hard refresh because neither the conflict
        identity nor coarse reachability changed after a transient gateway or
        provider error. Retrying reads is safe: it writes nothing, and every
        eventual choice is still conditional on the exact etag returned here.

        Server refusals are not retried. A new connection cannot repair lost
        membership or a hidden path, and repeatedly probing one would turn an
        authorization answer into traffic without helping the person.
      */
      if (settled.kind === "failed" && isServerRefusal(settled.error)) {
        /*
          Deliberately not the thrown message. This is one of the two sides of
          a decision somebody is about to make, so the sentence has to say what
          it means for the decision rather than what the storage layer said.

          A server refusal is classified only to prevent a pointless retry. It
          never opens a cache fallback: the cached ancestor is not shown and it
          only reaches `offerMerge`, which refuses with `"offline"` the moment
          `theirs` is absent. A failed read therefore produces no merge and no
          bucket text at all. What stays on screen is the person's own draft,
          which was already there.

          Reaching for the discriminator anyway would cost the one thing this
          panel exists for. Somebody whose membership was revoked mid-conflict
          still has unsaved typing in front of them, and blanking the panel
          would be the console taking it away at exactly the moment they need
          to copy it out. The decision controls remain unavailable because no
          bucket version was shown; the draft remains available to copy out.
        */
        retryFailuresRef.current = 0;
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [online, path, retryGeneration, round]);

  return useMemo(() => {
    if (!conflicted || path === null) return null;
    // Effects clear the old round after paint; never expose its body or etag
    // during that render, because either could enable a decision for the wrong
    // version of this note.
    const current = fetched.round === round ? fetched : IDLE;
    const offer = offerMerge({
      cached: current.cached,
      draftBase: draftBaseRef.current ?? null,
      mine: editor.draft,
      theirs: current.theirs,
    });
    return {
      path,
      mine: editor.draft,
      theirs: current.theirs,
      theirsEtag: current.theirsEtag,
      reading: current.reading,
      unreadable: current.unreadable,
      retry: current.retryable && online ? retry : undefined,
      merge: offer.merge,
      mergeRefusal: offer.refusal,
      conditionalWrite: input.conditionalWrite,
      message: editor.message,
    };
  }, [conflicted, editor.draft, editor.message, fetched, input.conditionalWrite, online, path, retry, round]);
}
