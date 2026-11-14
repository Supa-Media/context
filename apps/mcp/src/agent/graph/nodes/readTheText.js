/** Door node "readTheText" (texConfig.json, group "door"): reads the request's body, who is asking and from which chat, and the question. Its code is the door step `../../texEntryPoint/readTheText.js`. */
import { readTheText } from "../../texEntryPoint/readTheText.js";
import { doorNode } from "../doorNode.js";

export const readTheTextNode = doorNode(readTheText, (t) => ({ chat: t.group !== null && t.group !== undefined ? "group" : "one", kind: String(t.tex?.kind ?? ""), job: t.job != null, routine: t.runner === true, report: t.report != null, asked: typeof t.question === "string" && t.question.length > 0, covers: Array.isArray(t.body?.covers) ? t.body.covers.filter((id) => typeof id === "string").slice(0, 32) : [] }));
