/**
 * `fetch` in OpenAI's shape (`{id, title, text, url, metadata}`), for ChatGPT's connector: `read_note` itself, answered
 * as JSON. Its own module because `read_note` sits below `search.js` in the import graph.
 */

import { isPlumbing } from "../../privacy/engine.js";
import { normalizePath, noteUrl } from "../../notes/paths.js";
import { noteTitle } from "../../search/visible.js";
import { splitMessageAnchor } from "../../search/commsIndex.js";
import { isDrawingPath } from "../../../../../packages/drawings/src/excalidraw.js";
import { toolError, toolText } from "../results.js";
import { toolReadNote } from "./read.js";

export async function toolOpenAiFetch(store, scope, rules, overrides, idArg) {
  // `search` answers a message inside a channel-day note with the id
  // `<notePath>#<anchor>`, and `fetch(id)` is the only thing ChatGPT does
  // with an id it was given. Split before the `.md` test, which that id
  // would otherwise fail one line before the read ever happened.
  const path = splitMessageAnchor(normalizePath(idArg) ?? "").path;
  if (!path || !path.endsWith(".md")) return toolError("invalid id");
  if (isPlumbing(path)) return toolError("not found");
  /*
    `read_note` itself, in OpenAI's answer shape: one place decides who may
    see the note, forwards a stale address, decrypts, and serves the editing
    history's current text, and reads a note in its workspace object in one
    call (`workspaceStore/collabRead.js`). This door used to repeat the
    resolution with its own probe, get and Markdown-only answer: two more
    trips to the object, and stale words for a note people were editing
    together. Every refusal is `read_note`'s, word for word.
  */
  const read = await toolReadNote(store, scope, rules, overrides, path);
  if (read.isError) return read;
  const opened = read.opened;
  const etag = read.content[0].text.match(/^etag: (.+)$/m)?.[1];
  // A drawing is described, not dumped: its text is the description `read_note` gives.
  const text = opened.text === "" && isDrawingPath(opened.path) ? read.content[0].text : opened.text;
  return toolText(
    JSON.stringify({
      id: path,
      title: noteTitle(opened.path, text),
      text,
      url: noteUrl(opened.path),
      metadata: { etag, encrypted: opened.encrypted || undefined },
    })
  );
}
