/** Door node "readTheHistory" (texConfig.json, group "door"): hears voice messages, keeps sent files, and reads the chat's history and the tools offered. Its code is the door step `../../texEntryPoint/readTheHistory.js`. */
import { readTheHistory } from "../../texEntryPoint/readTheHistory.js";
import { doorNode } from "../doorNode.js";

export const readTheHistoryNode = doorNode(readTheHistory, (t) => ({ history: Array.isArray(t.history) ? t.history.length : 0, attachments: Array.isArray(t.attachments) ? t.attachments.length : 0, tools: Array.isArray(t.offered) ? t.offered.length : 0, logged: t.logged !== null && t.logged !== undefined, background: t.background != null }));
