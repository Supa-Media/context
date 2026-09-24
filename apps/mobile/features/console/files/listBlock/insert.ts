import type { EditorView } from "@codemirror/view";
import { LIST_FENCE_LANG, listHost } from "./model";

/**
 * Put a folder list at the caret, listing the open note's own folder — a blog
 * index in `writing/` lists `writing/` — newest first.
 *
 * A note at the top of the workspace has no folder of its own, so the block is
 * left open at `from: ` with the caret there, which shows its source; somebody
 * names the folder and moves on, and the list draws.
 */
export function insertFolderList(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const selfPath = view.state.facet(listHost)?.current?.selfPath ?? null;
  const slash = selfPath === null ? -1 : selfPath.lastIndexOf("/");
  const folder = slash > 0 ? selfPath!.slice(0, slash) : "";

  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const lead = line.text.trim() === "" ? "" : "\n\n";
  const at = lead === "" ? line.from : line.to;
  const opening = `${lead}\`\`\`${LIST_FENCE_LANG}\nfrom: `;
  const block = `${opening}${folder}\n\`\`\`\n`;
  view.dispatch({
    changes: { from: at, to: lead === "" ? line.to : at, insert: block },
    // With a folder, past the block so it draws; without, on `from: `.
    selection: { anchor: folder === "" ? at + opening.length : at + block.length },
    userEvent: "input",
    scrollIntoView: true,
  });
  view.focus();
  return true;
}
