/** Door node "settleAYesOrNo" (texConfig.json, group "door"): settles a texted yes or no against a waiting approval before any model runs, or keeps the Worker's fixed texts. Its code is the door step `../../texEntryPoint/settleAYesOrNo.js`. */
import { settleAYesOrNo } from "../../texEntryPoint/settleAYesOrNo.js";
import { doorNode } from "../doorNode.js";

export const settleAYesOrNoNode = doorNode(settleAYesOrNo, (t) => ({ front: t.front === true, thumbsUp: t.thumbsUp === true, setAside: Array.isArray(t.setAside) ? t.setAside.length : 0, dropped: Array.isArray(t.dropped) ? t.dropped.length : 0, paid: Array.isArray(t.paid) ? t.paid.length : 0 }));
