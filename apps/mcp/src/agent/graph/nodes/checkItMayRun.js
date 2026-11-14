/** Door node "checkItMayRun" (texConfig.json, group "door"): starts reading the tools, the history and the provider check, and refuses here when the model may not run. Its code is the door step `../../texEntryPoint/checkItMayRun.js`. */
import { checkItMayRun } from "../../texEntryPoint/checkItMayRun.js";
import { doorNode } from "../doorNode.js";

export const checkItMayRunNode = doorNode(checkItMayRun, (t) => ({ allowedStarted: t.allowedRead != null, historyStarted: t.historyRead != null, toolsStarted: t.offeredRead != null }));
