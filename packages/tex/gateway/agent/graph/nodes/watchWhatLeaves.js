/** Door node "watchWhatLeaves" (texConfig.json, group "door"): starts this turn's egress ledger and sets what the turn may send out. Its code is the door step `../../texEntryPoint/watchWhatLeaves.js`. */
import { watchWhatLeaves } from "../../texEntryPoint/watchWhatLeaves.js";
import { doorNode } from "../doorNode.js";

export const watchWhatLeavesNode = doorNode(watchWhatLeaves, (t) => ({ ledger: t.ledger !== null && t.ledger !== undefined, seenWhole: t.session?.egress?.complete === true, texting: t.session?.egress?.texting === true }));
