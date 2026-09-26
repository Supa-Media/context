/**
 * What the open context sends that is not a file operation: a queued write,
 * an image stored or read for the open note, and a submitted form.
 *
 * Part of `useFileBrowser`, moved out of that file verbatim. The facade calls
 * each part in the order the code used to run, so every hook is still called
 * in the same order with the same dependency lists; what a part reads from an
 * earlier one arrives in `deps`, and is the same value the code closed over
 * before.
 */
/* eslint-disable react-hooks/exhaustive-deps -- Every dependency list in this
   file was moved unchanged from `useFileBrowser.ts`, where the rule accepted
   it. What it reports here is refs, state setters and `dispatch` that now
   arrive through `deps` instead of from a `useRef`, `useState` or `useReducer`
   in the same function, so the rule can no longer see they are stable. */
import { useCallback, useMemo } from "react";
import { dataUrlFor, isRemoteImageTarget } from "../imageBytes";
import { toFileError } from "../browser";
import type { FormOutcome, FormSubmission } from "../formBlock";
import type { WriteOutcome } from "../../../offline/sync";
import { queuedWriteSender } from "../queuedWrite";
import { EMOJI_IMAGE_TARGET } from "../emoji/host";
import { loadCustomEmoji } from "../../emoji/emojiCache";
import type { PendingWrite } from "../../../offline/outbox";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";

type WritesAndImagesDeps =
  & Pick<
    FileActionsValues,
    | "imageCache"
    | "readNoteImageAction"
    | "readRemoteImageAction"
    | "readEmojiAction"
    | "storeNoteImageAction"
    | "submitFormAction"
    | "workspaceId"
    | "writeNote"
  >
  & Pick<BrowserStateValues, "editorRef" | "selectedPathRef">;

export function useWritesAndImages(deps: WritesAndImagesDeps) {
  const {
    editorRef, imageCache, readEmojiAction, readNoteImageAction, readRemoteImageAction, selectedPathRef, storeNoteImageAction,
    submitFormAction, workspaceId, writeNote,
  } = deps;

  /* ------------------------------- offline -------------------------------- */

  /**
   * One queued write, sent through the same action the Save button uses.
   *
   * This is the whole reason a drained write is as safe as an online one: it is
   * not a second write path, it is `writeNote` with the etag the draft was
   * typed against, so it gets the server's `onlyIf: { etagMatches }` where the
   * bucket supports one and its read-compare where it does not — and the same
   * `CONFLICT`, with the same `currentEtag`, when somebody got there first.
   *
   * The write itself now lives in `queuedWrite.ts`, because there are two
   * things that empty a queue: this one for the open context, and
   * `useBackgroundDrain` for every other. One definition of what a queued
   * write *is*, bound here to the context on screen and there to the one each
   * queue is filed under — two copies would be two places for a `force` flag
   * or a dropped `expectedEtag` to appear.
   */
  const sendTo = useMemo(() => queuedWriteSender(writeNote), [writeNote]);
  const sendQueued = useCallback(
    async (pending: PendingWrite): Promise<WriteOutcome> => {
      if (workspaceId === null) return { kind: "failed", message: "No context is open." };
      return sendTo(workspaceId, pending);
    },
    [sendTo, workspaceId],
  );

  /**
   * Send one filled-in form block, and phrase what came back.
   *
   * The one write on this hook that does **not** go through
   * `api.functions.files` — see `FileBrowser.submitForm` for why a `member`
   * needs a path of its own. The note it names is the open one, read here
   * rather than taken from the widget: the widget knows which *form* was
   * pressed and this knows which note is on screen, and a widget that carried
   * a path would be a caller naming the file its submission lands beside.
   *
   * Resolves in both directions. A refusal from the server is a sentence
   * somebody wrote for exactly this case — "this form takes responses from
   * editors and above", "that response file cannot be read" — so it is passed
   * through rather than replaced with a generic one.
   */
  /**
   * The bytes behind an image the open note embeds.
   *
   * The note is read from `selectedPathRef` rather than taken from the widget,
   * for the reason `submitForm` gives: the widget knows which *image* is being
   * drawn and this knows which note is on screen. The server needs both, because
   * an image borrows its visibility from the notes that reference it — a widget
   * that carried a note path would be a caller choosing which note vouches for
   * the image it is asking for.
   *
   * Cached on the key, forever, and that is safe because the key is a content
   * hash: the same key is the same bytes, in this session and in every other.
   * The cache is what makes a row survive a keystroke — `toDOM` runs again on
   * every rebuild, and without it every character typed in a note with an image
   * in it would be a round trip to the bucket.
   *
   * `null` for every failure, deliberately: a missing image, an image in a note
   * this viewer cannot see, and a store that is down all draw the same absence,
   * and the row says so in its own words rather than reporting a server error
   * somebody reading a note can do nothing about.
   */
  const loadImage = useCallback(
    async (target: string): Promise<string | null> => {
      if (workspaceId === null) return null;
      /*
        A workspace emoji, asked for by name over the native editor's image
        bridge. Not gated on the open note: every member may see every emoji.
      */
      if (target.startsWith(EMOJI_IMAGE_TARGET)) {
        const name = target.slice(EMOJI_IMAGE_TARGET.length);
        return loadCustomEmoji(workspaceId, name, (args) => readEmojiAction({ workspaceId, ...args }));
      }
      const notePath = selectedPathRef.current;
      if (notePath === null) return null;
      const cacheKey = `${workspaceId}|${target}`;
      const cached = imageCache.current.get(cacheKey);
      if (cached !== undefined) return cached;
      try {
        /*
          A remote image goes through our proxy, never straight into an <img>:
          drawn directly, its host would see every read with the reader's
          address. The server fetches it for a note this viewer can see that
          names it, and hands back bytes like any stored image.
        */
        const read = isRemoteImageTarget(target)
          ? await readRemoteImageAction({ workspaceId, notePath, url: target })
          : await readNoteImageAction({ workspaceId, notePath, leaf: target });
        const src = dataUrlFor(read.bytes, read.contentType);
        imageCache.current.set(cacheKey, src);
        return src;
      } catch {
        return null;
      }
    },
    [workspaceId, readNoteImageAction, readRemoteImageAction, readEmojiAction],
  );

  /**
   * Store a pasted or dropped image, and answer with the key to embed.
   *
   * The refusal is the server's sentence rather than a generic one — "a stored
   * image must be at most 5000000 bytes", "you do not have write access" — for
   * the same reason `submitForm` passes one through: somebody wrote those words
   * for exactly this moment, and the editor has nothing better to say.
   *
   * The returned key is put in the cache as well, so the image somebody just
   * pasted draws from the bytes already in hand instead of being read back out
   * of the bucket a moment after it was written.
   */
  const storeImage = useCallback(
    async (image: {
      bytes: ArrayBuffer;
      contentType: string;
    }): Promise<{ target: string } | { error: string }> => {
      if (workspaceId === null) return { error: "No context is open." };
      /*
        AN ENCRYPTED NOTE TAKES NO IMAGE, AND SAYS SO.

        The note's text is encrypted on this device and the bytes of an image are
        not: storing one beside it would put in the clear exactly what somebody
        turned encryption on to keep out of it, in the same bucket, under a name
        the note itself spells out. Encrypting attachments is real work —
        `encryption.md` scopes it — and until it is done the honest answer is a
        refusal a person can read, not a paste that quietly weakens the thing
        they asked for.
      */
      if (editorRef.current.encrypted) {
        return { error: "An encrypted note can’t hold an image yet." };
      }
      /*
        WHICH NOTE THE EMBED IS ABOUT TO LAND IN.

        An upload is a round trip, and the editor inserts the line when it comes
        back. Open another note in that window — a click in the tree, a link
        followed — and the insert would land in *that* note, which is an image
        appearing in a document nobody pasted into. The editor cannot notice:
        it is one view with notes swapped through it, and by then its state is
        the new note's.

        So the check is here, where the open note is already known, and it is
        made after the write rather than before: the bytes are in the bucket
        either way — content-addressed, so nothing is orphaned that a second
        paste would not reuse — and what is refused is the *insert*.
      */
      const noteAtStart = selectedPathRef.current;
      try {
        const stored = await storeNoteImageAction({
          workspaceId,
          bytes: image.bytes,
          contentType: image.contentType,
        });
        if (selectedPathRef.current !== noteAtStart) {
          imageCache.current.set(
            `${workspaceId}|${stored.leaf}`,
            dataUrlFor(image.bytes, image.contentType),
          );
          return {
            error: "That note closed before the image was stored. It is in your bucket.",
          };
        }
        imageCache.current.set(
          `${workspaceId}|${stored.leaf}`,
          dataUrlFor(image.bytes, image.contentType),
        );
        return { target: stored.leaf };
      } catch (error) {
        return { error: toFileError(error).message };
      }
    },
    [workspaceId, storeNoteImageAction],
  );

  const submitForm = useCallback(
    async (submission: FormSubmission): Promise<FormOutcome> => {
      if (workspaceId === null) return { ok: false, message: "No context is open." };
      const path = selectedPathRef.current;
      if (path === null) return { ok: false, message: "No note is open." };
      try {
        await submitFormAction({
          workspaceId,
          path,
          formId: submission.formId,
          values: submission.values.map((entry) => ({ ...entry })),
        });
        return { ok: true, message: "Sent. Thank you!" };
      } catch (error) {
        return { ok: false, message: toFileError(error).message };
      }
    },
    [workspaceId, submitFormAction],
  );

  return { sendQueued, loadImage, storeImage, submitForm };
}

export type WritesAndImagesValues = ReturnType<typeof useWritesAndImages>;
