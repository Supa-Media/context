/**
 * The words of the note the side panel shows, read through the page's own
 * source (`FolderListSource.readBody`): this device's copy at the reader's
 * clearance, else the bucket through the server. Read again whenever the
 * device's notes change, so a save elsewhere shows here too.
 */

import { useEffect, useState } from "react";
import { isEncryptedNote } from "../../../encryption/envelope";
import type { FolderListSource } from "../../listBlock/model";

export type PanelBody =
  | { readonly kind: "loading" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "locked" }
  | { readonly kind: "missing" }
  /** Nothing to read: a folder with no front note, or a surface with no source. */
  | { readonly kind: "none" };

const LOADING: PanelBody = { kind: "loading" };
const NONE: PanelBody = { kind: "none" };

export function usePanelBody(source: FolderListSource | undefined, path: string | null): PanelBody {
  const [read, setRead] = useState<{ path: string; body: PanelBody } | null>(null);
  const [changes, setChanges] = useState(0);
  const readBody = source?.readBody;
  const subscribe = source?.subscribe;

  useEffect(() => {
    if (subscribe === undefined) return;
    return subscribe(() => setChanges((count) => count + 1));
  }, [subscribe]);

  useEffect(() => {
    if (path === null || readBody === undefined) return;
    let current = true;
    void readBody(path)
      .then((found): PanelBody => {
        if (found === null) return { kind: "missing" };
        // Said by the source, or by the text itself: an envelope is never drawn as words.
        if (found.encrypted || isEncryptedNote(found.text)) return { kind: "locked" };
        return { kind: "text", text: found.text };
      })
      .catch((): PanelBody => ({ kind: "missing" }))
      .then((body) => {
        if (current) setRead({ path, body });
      });
    return () => {
      current = false;
    };
  }, [path, readBody, changes]);

  if (path === null || readBody === undefined) return NONE;
  // What was read for this note, kept while a change is read again rather than flashing empty.
  return read?.path === path ? read.body : LOADING;
}
