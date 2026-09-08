/**
 * The console's one connection between the passphrase machinery
 * (`session.ts`, `passphraseOps.ts`) and the bucket.
 *
 * Everything in this file runs on the device. The four operations
 * (`protect`, `unlock`, `save`, `changePassphrase`, `remove`) derive a key
 * here, encrypt or decrypt here, and hand only ciphertext to the two Convex
 * actions this hook calls — `writeNote` for everything that writes an
 * envelope, `removeNoteEncryption` for the one door that writes plaintext over
 * an encrypted note. Neither action, and nothing between here and either of
 * them, ever sees a passphrase or a derived key: see `passphraseOps.ts`'s own
 * header for how that is tested rather than merely true by inspection.
 *
 * ## What this file deliberately does not do
 *
 * **It never touches `features/offline`.** No `rememberDraft`, no
 * `queueSave`, no `AsyncStorage` — not directly, and not through anything this
 * file imports. That is not an oversight to be filled in for parity with the
 * ordinary editor: the offline draft queue is a durable, cross-reload store,
 * and a note that is unlocked *in this session's memory* must never leave a
 * plaintext copy of itself somewhere that outlives the tab, the reload, or the
 * lock. `docs/decisions/encryption.md`'s key model puts the same weight on the
 * workspace data key: never in Markdown, never in the bucket, never on a
 * device, never in a log. A queued draft on disk is exactly that kind of
 * place, and an unlocked note's plaintext is exactly that kind of secret while
 * the session holds it.
 *
 * The cost this pays for that guarantee, stated rather than hidden: **editing
 * an unlocked note has no autosave and no offline queue.** A save is the
 * explicit press this file's `save` answers, and a person who edits a locked
 * note, then closes the app or loses connectivity before pressing it, loses
 * that edit — the same way any other unsent input is lost, and unlike an
 * ordinary note, which the offline queue would otherwise have carried through
 * for them. That is the trade the guard buys, named here so a future change
 * that "just wires the unlocked editor into autosave for consistency" reads
 * this paragraph first.
 *
 * `__tests__/encryptionDraftQueueGuard.test.ts` checks this on the source of
 * this file and its sibling UI components, not only on behaviour: a guard
 * nobody has checked is not a guard.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { toFileError } from "../files/browser";
import { decryptWithPassphrase, NoteCryptoError } from "./envelope";
import type { KdfDescriptor } from "./kdf";
import {
  changePassphrase,
  MINIMUM_PASSPHRASE_LENGTH,
  protectNote,
  removePassphrase,
  saveUnlockedNote,
  unlockNote,
  type NoteWriter,
  type OpsContext,
} from "./passphraseOps";
import {
  DEFAULT_IDLE_MS,
  initialSessionState,
  isUnlocked,
  keyFor,
  msUntilLock,
  sessionReducer,
  type SessionState,
} from "./session";

/** How often the idle sweep checks, independent of `DEFAULT_IDLE_MS` itself. */
const SWEEP_INTERVAL_MS = 15_000;

export interface NoteEncryptionController {
  session: SessionState;
  isUnlocked(path: string): boolean;
  msUntilLock(path: string, now: number): number | null;
  /** Locks every open note in this session — see `session.ts`'s `lock` rule. */
  lock(): void;
  /** Renews a note's idle timer without touching its key or its content. */
  touch(path: string): void;
  /** Lock a plaintext note behind a passphrase for the first time. */
  protect(input: {
    path: string;
    plaintext: string;
    etag: string | null;
    passphrase: string;
  }): Promise<{ etag: string; stored: string }>;
  /** Open a locked note for this session. No request is made — see `unlockNote`. */
  unlock(input: { path: string; stored: string; passphrase: string }): Promise<{ plaintext: string }>;
  /**
   * Read a note this session already unlocked, without asking for the
   * passphrase again.
   *
   * `null` when this session holds no key for `path` — the caller falls back
   * to a passphrase prompt. The session never keeps the *plaintext* (only the
   * key does, in memory), so a note revisited after navigating away needs this
   * to redraw without unlocking twice; unlike `unlock`, this makes no request
   * either, for the same reason: the ciphertext is already in hand.
   */
  peek(path: string, stored: string): Promise<string | null>;
  /** Save an edit to a note unlocked in this session. */
  save(input: { path: string; plaintext: string; etag: string | null; stored: string }): Promise<{
    etag: string;
    stored: string;
  }>;
  /** Change a locked note's passphrase without rewriting its body. */
  changePassphrase(input: {
    path: string;
    stored: string;
    etag: string | null;
    currentPassphrase: string;
    newPassphrase: string;
  }): Promise<{ etag: string; stored: string }>;
  /** Take the passphrase off a note, requiring it. */
  remove(input: {
    path: string;
    stored: string;
    etag: string | null;
    passphrase: string;
  }): Promise<{ etag: string; plaintext: string }>;
}

/**
 * Build a `NoteWriter` over one Convex action.
 *
 * The only place a passphrase-derived key's *output* — never the key or the
 * passphrase themselves, which never reach this function at all — leaves the
 * device: `request.content` is what `encryptForPassphrase` produced, and it is
 * what a stolen bucket credential would see too.
 */
function actionWriter(
  action: (args: {
    workspaceId: Id<"workspaces">;
    path: string;
    text: string;
    expectedEtag?: string;
  }) => Promise<{ etag: string }>,
  workspaceIdRef: { current: string | null },
): NoteWriter {
  return {
    async write(request) {
      const workspaceId = workspaceIdRef.current;
      if (workspaceId === null) {
        throw new NoteCryptoError("no context is open to write this note into");
      }
      try {
        const result = await action({
          workspaceId: workspaceId as Id<"workspaces">,
          path: request.path,
          text: request.content,
          expectedEtag: request.expectedEtag ?? undefined,
        });
        return { etag: result.etag };
      } catch (error) {
        // Re-thrown as a `NoteCryptoError` so every caller in `passphraseOps.ts`
        // sees one error type regardless of whether the failure was
        // cryptographic or a refusal from the bucket — the dialogs that call
        // these operations already render `NoteCryptoError.message` as-is.
        throw new NoteCryptoError(toFileError(error).message);
      }
    },
  };
}

export function useNoteEncryption(
  workspaceId: string | null,
  /**
   * Injected so a test need not pay Argon2id's real cost on every case — the
   * same reason `passphraseOps.ts`'s own `OpsContext.derive` is injectable.
   * Never passed by the console itself, which always wants the real KDF.
   */
  derive?: (passphrase: string, kdf: KdfDescriptor) => Uint8Array,
): NoteEncryptionController {
  const [session, dispatch] = useReducer(sessionReducer, initialSessionState);

  /*
   * Idle auto-lock: time-based and checked, never trusted to a single timer —
   * `session.ts`'s own header explains why `sweep(now)` has to be re-evaluated
   * on a tick rather than armed once per unlock. `DEFAULT_IDLE_MS` names the
   * timeout `docs/decisions/encryption.md` sets; this is only how often the
   * check runs, and is deliberately much shorter than it so a suspended device
   * locks within one tick of waking rather than within one tick of the whole
   * idle window.
   */
  useEffect(() => {
    const id = setInterval(() => dispatch({ type: "sweep", at: Date.now() }), SWEEP_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  const writeNoteAction = useAction(api.functions.files.writeNote);
  const removeEncryptionAction = useAction(api.functions.files.removeNoteEncryption);

  // Two writers, deliberately not one with a flag: `ordinary` is every write
  // that produces another envelope (a lock, an edit, a passphrase change);
  // `removal` is the one door that writes plaintext, and it is a different
  // Convex action precisely because `writeFile` refuses plaintext over an
  // encrypted note unconditionally. See `docs/decisions/encryption.md` and
  // `fileOps.ts`'s own comments on both doors.
  const ordinaryWriter = useMemo(
    () => actionWriter(writeNoteAction, workspaceIdRef),
    [writeNoteAction],
  );
  const removalWriter = useMemo(
    () => actionWriter(removeEncryptionAction, workspaceIdRef),
    [removeEncryptionAction],
  );

  const ordinaryContext = useCallback(
    (): OpsContext => ({ workspaceId: workspaceIdRef.current ?? "", writer: ordinaryWriter, derive }),
    [ordinaryWriter, derive],
  );
  const removalContext = useCallback(
    (): OpsContext => ({ workspaceId: workspaceIdRef.current ?? "", writer: removalWriter, derive }),
    [removalWriter, derive],
  );

  const protect = useCallback(
    async (input: { path: string; plaintext: string; etag: string | null; passphrase: string }) => {
      const result = await protectNote(input, ordinaryContext());
      // Locking a note is the one operation that leaves it open afterwards —
      // the person just typed the passphrase and proved they know it, so
      // asking them to unlock what they just locked would be the console
      // second-guessing its own write.
      dispatch({ type: "unlocked", path: input.path, key: result.key, at: Date.now() });
      return { etag: result.etag, stored: result.stored };
    },
    [ordinaryContext],
  );

  const unlock = useCallback(
    async (input: { path: string; stored: string; passphrase: string }) => {
      const result = await unlockNote(input, ordinaryContext());
      dispatch({ type: "unlocked", path: input.path, key: result.key, at: Date.now() });
      return { plaintext: result.plaintext };
    },
    [ordinaryContext],
  );

  const peek = useCallback(
    async (path: string, stored: string): Promise<string | null> => {
      const key = keyFor(session, path);
      if (key === null) return null;
      dispatch({ type: "touched", path, at: Date.now() });
      return await decryptWithPassphrase(stored, {
        workspaceId: workspaceIdRef.current ?? "",
        kek: key,
      });
    },
    [session],
  );

  const save = useCallback(
    async (input: { path: string; plaintext: string; etag: string | null; stored: string }) => {
      const key = keyFor(session, input.path);
      if (key === null) {
        throw new NoteCryptoError("this note is locked; unlock it before saving");
      }
      const result = await saveUnlockedNote({ ...input, key }, ordinaryContext());
      dispatch({ type: "touched", path: input.path, at: Date.now() });
      return result;
    },
    [ordinaryContext, session],
  );

  const changePassphraseOp = useCallback(
    async (input: {
      path: string;
      stored: string;
      etag: string | null;
      currentPassphrase: string;
      newPassphrase: string;
    }) => {
      const result = await changePassphrase(input, ordinaryContext());
      // A passphrase change carries the new key straight into the session, so
      // a note already open stays open under the passphrase that now opens it
      // — the person just proved they knew the old one and chose the new one.
      dispatch({ type: "unlocked", path: input.path, key: result.key, at: Date.now() });
      return { etag: result.etag, stored: result.stored };
    },
    [ordinaryContext],
  );

  const remove = useCallback(
    async (input: { path: string; stored: string; etag: string | null; passphrase: string }) => {
      const result = await removePassphrase(input, removalContext());
      // The note is plaintext now; there is nothing left for this session to
      // hold a key for, and keeping one around would be a key with no lock.
      dispatch({ type: "closed", path: input.path });
      return result;
    },
    [removalContext],
  );

  return useMemo(
    () => ({
      session,
      isUnlocked: (path) => isUnlocked(session, path),
      msUntilLock: (path, now) => msUntilLock(session, path, now),
      lock: () => dispatch({ type: "lock", reason: "manual" }),
      touch: (path) => dispatch({ type: "touched", path, at: Date.now() }),
      protect,
      unlock,
      peek,
      save,
      changePassphrase: changePassphraseOp,
      remove,
    }),
    [session, protect, unlock, peek, save, changePassphraseOp, remove],
  );
}

export { DEFAULT_IDLE_MS, MINIMUM_PASSPHRASE_LENGTH };
export type { KdfDescriptor };
