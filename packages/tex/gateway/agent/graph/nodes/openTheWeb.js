/** Door node "openTheWeb" (texConfig.json, group "door"): picks the write tools for this chat and opens the browser, vouched for by the person's own words. Its code is the door step `../../texEntryPoint/openTheWeb.js`. */
import { openTheWeb } from "../../texEntryPoint/openTheWeb.js";
import { doorNode } from "../doorNode.js";

export const openTheWebNode = doorNode(openTheWeb, (t) => ({ texting: t.texting === true, streamed: t.streamed === true, channel: t.channel != null, writeTools: Array.isArray(t.textingWriting) ? t.textingWriting.length : 0, groupWriteTools: Array.isArray(t.groupWriting) ? t.groupWriting.length : 0 }));
