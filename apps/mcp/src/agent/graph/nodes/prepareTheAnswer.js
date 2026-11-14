/** Door node "prepareTheAnswer" (texConfig.json, group "door"): starts the side read of Tex's notes and sets up the answer checks and pictures. Its code is the door step `../../texEntryPoint/prepareTheAnswer.js`. */
import { prepareTheAnswer } from "../../texEntryPoint/prepareTheAnswer.js";
import { doorNode } from "../doorNode.js";

export const prepareTheAnswerNode = doorNode(prepareTheAnswer, (t) => ({ texted: t.texted === true, claims: t.claims !== null && t.claims !== undefined, tries: t.tries != null, forwarding: Array.isArray(t.forwarding) ? t.forwarding.length : 0, pictures: t.maker != null, knowsStarted: t.knowsRead != null }));
