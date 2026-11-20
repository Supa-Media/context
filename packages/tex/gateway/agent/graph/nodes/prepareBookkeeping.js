/** Door node "prepareBookkeeping" (texConfig.json, group "door"): prepares what the turn records: usage, the turn log, the ledger turn id, and the pictures to keep. Its code is the door step `../../texEntryPoint/prepareBookkeeping.js`. */
import { prepareBookkeeping } from "../../texEntryPoint/prepareBookkeeping.js";
import { doorNode } from "../doorNode.js";

export const prepareBookkeepingNode = doorNode(prepareBookkeeping, (t) => ({ ledgerTurn: typeof t.ledgerTurn === "string" ? t.ledgerTurn : "", chatLog: t.chatLog != null, keepPictures: typeof t.keepPictures === "function" }));
