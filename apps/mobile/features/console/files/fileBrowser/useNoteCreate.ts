/**
 * Creating notes and drawings: by name, and untitled.
 *
 * Part of `useFileBrowser`, called straight after `useCreateAndMove`, which
 * it was moved out of when the online create stopped being three round trips
 * long (`__tests__/quickNoteCreate.test.ts`). What a part reads from an
 * earlier one arrives in `deps`, and is the same value the code closed over
 * before.
 */
/* eslint-disable react-hooks/exhaustive-deps -- Moved from `useCreateAndMove`,
   where the same lists were accepted. What the rule reports here is refs and
   state setters that arrive through `deps`, so it cannot see they are stable. */
import { isDrawingPath, newDrawing } from "@context/drawings";
import { ConvexError } from "convex/values";
import { useCallback, useRef } from "react";
import { toFileError } from "../browser";
import {
  baseName,
  describeNameProblem,
  displayName,
  drawingFileName,
  ensureMarkdown,
  folderLabel,
  joinPath,
} from "../paths";
import { applyNoteCreate, undoNoteCreate } from "../optimistic";
import { announceDid } from "../../map/live/announce";
import { untitledName, type UntitledKind } from "../untitled";
import type { OpenNote } from "../types";
import { DRAWING_NEEDS_CONNECTION, claimedMessage, collision } from "./copy";
import type { Listings, FileBrowserOptions } from "./types";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { ListingsValues } from "./useListings";
import type { OfflineQueueValues } from "./useOfflineQueue";
import type { RunOperationValues } from "./useRunOperation";

type NoteCreateDeps =
  & { options: FileBrowserOptions }
  & Pick<FileActionsValues, "workspaceId" | "writeNote">
  & Pick<BrowserStateValues, "drawLocally" | "setExpanded" | "setNotice">
  & Pick<OfflineQueueValues, "listings" | "listingsRef" | "offlineRef">
  & Pick<ListingsValues, "refresh" | "reportRefreshFailure">
  & Pick<RunOperationValues, "run">
  & { select: (path: string, written?: OpenNote) => boolean };

/**
 * How many taken names an untitled create steps past before it gives up and
 * shows the refusal. Each one is a name the listing said was free and the
 * bucket said was not — more than a handful in a row is not a stale listing.
 */
const UNTITLED_RETRIES = 5;

/** The refusal a create into somebody else's private folder shows. */
function cannotAddTo(folder: string): ConvexError<{ code: string; message: string }> {
  const place = folder === "" ? "the top of this workspace" : folderLabel(baseName(folder));
  return new ConvexError({
    code: "FILE_NOT_FOUND",
    message: `You can't add notes to ${place}. Pick a folder that is shared with you.`,
  });
}

/** What a new note or drawing starts as. */
function seedFor(name: string): string {
  return isDrawingPath(name) ? newDrawing() : `# ${name.replace(/\.md$/i, "")}\n\n`;
}

export function useNoteCreate(deps: NoteCreateDeps) {
  const {
    options, drawLocally, listings, listingsRef, offlineRef, refresh, reportRefreshFailure, run, select,
    setExpanded, setNotice, workspaceId, writeNote,
  } = deps;

  /**
   * The notes made without a name that have not taken one yet.
   *
   * Session-scoped and deliberately not derived from the *name* alone. A path
   * matching `untitled-<date>` is not enough to earn an automatic rename: a
   * note made yesterday, opened today, whose heading somebody had already
   * changed by hand would rename itself the moment it loaded — a file moving in
   * somebody's bucket because they looked at it. Only a note this session
   * created without asking for a name is a note this session may name.
   *
   * An entry leaves when the rename fires, so the adoption happens **once**.
   * After that the heading and the filename are two things the person owns
   * separately, which is how every other note in the bucket already works.
   */
  const awaitingTitle = useRef<Set<string>>(new Set());

  /** The newest create; only it may move the selection when its write lands. */
  const latestCreate = useRef(0);

  const createNote = useCallback(
    (folder: string, rawName: string, untitled?: UntitledKind) => {
      const name = ensureMarkdown(rawName);
      const problem = describeNameProblem(name) ?? collision(listings, folder, name);
      if (problem !== null) return setNotice(problem);
      const path = joinPath(folder, name);
      /*
        Offline, the note is made on the device and opened at once — the core
        of taking notes offline. It is a queued create (`baseEtag: null`), so
        what is eventually sent is the same `writeNote` with no `expectedEtag`
        this function makes online, and the server's create refuses if a note
        appeared at that name meanwhile: parked as a conflict, with nothing
        overwritten. The name checks above are the same ones, against the
        listings as drawn — the queue's own new notes included.
      */
      if (offlineRef.current.reachability === "offline") {
        if (!options.canEdit || workspaceId === null) return;
        if (isDrawingPath(name)) return setNotice(DRAWING_NEEDS_CONNECTION);
        if (offlineRef.current.claims(path)) return setNotice(claimedMessage(displayName(name)));
        const text = `# ${name.replace(/\.md$/i, "")}\n\n`;
        offlineRef.current.queueSave({ path, text, baseEtag: null });
        setExpanded((current) => (folder === "" ? current : new Set([...current, folder])));
        select(path);
        return;
      }
      /*
        ONE ROUND TRIP, AND THE ROW IS THERE FROM THE PRESS.

        This used to wait for the write, then for `run`'s reload of the folder,
        then for `select`'s read of the note it had just written — three calls
        to somebody's bucket in a row before anything moved, which is the lag
        the owner reported on the phone's quick note (2026-10-01). And because
        nothing was drawn until the end, the folder still read as not having
        the note: a second press in that window, the natural response to a
        first press that seems not to have worked, chose the same untitled name
        and was refused with "A file already exists at that path".

        So: the row is drawn now (`applyNoteCreate`), which also takes the name
        for any create after this one; the note opens from the write's own
        answer, with no read; and the folder's reload carries on behind it.

        A drawing is seeded as a drawing, whichever control got here. `# name`
        is right for a note and is a file the gateway *refuses* on a
        `.excalidraw.md` path, so a person who typed `plan.excalidraw` into New
        note used to get an error rather than a drawing.
      */
      latestCreate.current += 1;
      const mine = latestCreate.current;
      let at = path;
      let current = name;
      const refused: string[] = [];
      drawLocally((listed) => applyNoteCreate(listed, at));
      void run(
        async () => {
          for (;;) {
            const text = seedFor(current);
            try {
              const result = await writeNote({ workspaceId: workspaceId!, path: at, text });
              announceDid(workspaceId ?? null, { kind: "create", path: at });
              const visibility = listingsRef.current[folder]?.folderDefault ?? "private";
              if (latestCreate.current === mine) {
                select(at, {
                  path: at,
                  text,
                  etag: result.etag,
                  visibility,
                  inherited: visibility,
                  exception: false,
                  readOnly: false,
                });
              }
              return { touched: [at] };
            } catch (error) {
              const gone = at;
              drawLocally((listed) => undoNoteCreate(listed, gone));
              /*
                Taken: the listing said this untitled name was free and the
                bucket says it is not — a note made on another device today, or
                a listing that had not caught up. Nobody chose this name, so a
                refusal about it is noise; the next one is chosen instead. A
                name somebody *typed* is theirs, and its refusal is shown.
              */
              /*
                Refused as missing: a create can only be that where the folder
                is not this person's to write in — the server answers a private
                path exactly as an absent one, rightly. "That file does not
                exist." said nothing a person could act on, about a file they
                had not named yet (the owner's team, 2026-10-02).
              */
              if (toFileError(error).code === "FILE_NOT_FOUND") throw cannotAddTo(folder);
              const taken = untitled !== undefined && toFileError(error).code === "CONFLICT";
              if (!taken || refused.length >= UNTITLED_RETRIES) throw error;
              refused.push(current);
              awaitingTitle.current.delete(gone);
              current = untitledName(listingsRef.current, folder, untitled, new Date(), refused);
              at = joinPath(folder, current);
              awaitingTitle.current.add(at);
              const next = at;
              drawLocally((listed) => applyNoteCreate(listed, next));
            }
          }
        },
        () => drawLocally((listed) => undoNoteCreate(listed, at)),
      );
    },
    [listings, options.canEdit, run, select, workspaceId, writeNote],
  );

  /**
   * New drawing: the same creation as above, with the suffix supplied.
   *
   * A person names a diagram, not a file format, and `<name>.excalidraw.md` is
   * two extensions they should not have to know about. Delegating rather than
   * writing means the collision and name checks are the note's, once.
   */
  const createDrawing = useCallback(
    (folder: string, rawName: string) => {
      createNote(folder, drawingFileName(rawName));
    },
    [createNote],
  );

  /**
   * New note, new drawing: made now, called `untitled-<date>`, opened.
   *
   * Delegates rather than writing, so the name checks, the collision check, the
   * offline queue and the drawing seed are all `createNote`'s — one create in
   * this file, whatever asked for it. What is added here is the name and the
   * promise that the name is temporary. See `untitled.ts`.
   */
  const createUntitled = useCallback(
    (folder: string, kind: "note" | "drawing") => {
      if (!options.canEdit) return;
      const make = (known: Listings) => {
        const name = untitledName(known, folder, kind, new Date());
        awaitingTitle.current.add(joinPath(folder, name));
        createNote(folder, name, kind);
      };
      /*
        THE DESTINATION IS LOADED FIRST, AND THAT IS NOT A TIDINESS POINT.

        The name is chosen against the folder's listing, and listings are fetched
        per folder — so a destination nobody has opened reads as *empty*, and
        every untitled note made into it is called `untitled-<date>` with no
        suffix. The second one is then a name the bucket already has, and the
        server's create refuses it.

        That is not hypothetical: the quick-note link (`?quickAction=note`) files
        into `0-inbox` from a widget, on a console that has loaded the root and
        nothing else. Two captures on one day, in two launches, is the ordinary
        use of a capture widget — and before this the second was an error
        message.

        Loaded, this is one `listFiles` the console was going to make anyway when
        the create's own `refresh` ran. Unloaded and unreachable, the refusal
        surfaces through `reportRefreshFailure` rather than as a note that
        silently did not appear.
      */
      if (listings[folder] !== undefined) return make(listings);
      void refresh([folder])
        .then(({ pages }) => make({ ...listingsRef.current, ...pages }))
        .catch(reportRefreshFailure);
    },
    [createNote, listings, options.canEdit, refresh, reportRefreshFailure],
  );

  return { createNote, createDrawing, awaitingTitle, createUntitled };
}

export type NoteCreateValues = ReturnType<typeof useNoteCreate>;
