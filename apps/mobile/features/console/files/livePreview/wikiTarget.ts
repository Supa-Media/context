/*
  How a wiki link target is drawn, apart from the editor so a card that is not
  CodeMirror (the map's note card) draws a link the same way without loading it.
*/

/**
 * Where a wiki link target's name is: the last path segment, without a `.md`.
 *
 * `from`–`to` is the part drawn and `to`–`extensionTo` a `.md` hidden after
 * it, both offsets into `target`. A heading or block anchor (`#…`) stays with
 * the name, and a slash inside the anchor is not a folder.
 */
export function wikiTargetName(target: string): { from: number; to: number; extensionTo: number } {
  const hash = target.indexOf("#");
  const path = hash === -1 ? target : target.slice(0, hash);
  // `[[folder/]]` has no name after its last slash; drawing nothing would make
  // the link invisible, so it keeps its whole path.
  const slash = path.lastIndexOf("/") + 1;
  const from = slash === path.length ? 0 : slash;
  const md = path.length - from > 3 && path.toLowerCase().endsWith(".md");
  return { from, to: md ? path.length - 3 : path.length, extensionTo: path.length };
}

/** A wiki link target as it is drawn: its name, and its anchor if it has one. */
export function wikiTargetText(target: string): string {
  const name = wikiTargetName(target);
  return target.slice(name.from, name.to) + target.slice(name.extensionTo);
}
