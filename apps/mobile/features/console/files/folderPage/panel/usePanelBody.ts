/**
 * The words of the note the side panel shows, read through the page's own
 * source (`FolderListSource.readBody`): this device's copy at the reader's
 * clearance, else the bucket through the server. Read again whenever the
 * device's notes change, so a save elsewhere shows here too.
 */

import { useEffect, useState } from "react";
import type { FolderListSource } from "../../listBlock/model";
import { cachedBody, readAbout } from "../pageCache";

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
    if (path === null || source === undefined || readBody === undefined) return;
    let current = true;
    // Read again on every open and every change, behind whatever `pageCache` already holds;
    // a first read that is already on its way (the row's preload) is shared.
    const fresh = changes > 0 || cachedBody(source, path) !== undefined;
    void readAbout(source, path, fresh).then((body) => {
      if (current) setRead({ path, body });
    });
    return () => {
      current = false;
    };
  }, [path, source, readBody, changes]);

  if (path === null || readBody === undefined) return NONE;
  // What was read for this note, kept while a change is read again rather than flashing empty;
  // else what was read for it before or ahead of opening (`pageCache`).
  return read?.path === path ? read.body : (cachedBody(source, path) ?? LOADING);
}
