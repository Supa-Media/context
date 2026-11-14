/** Door node "checkTheQuestion" (texConfig.json, group "door"): checks the question and what came with it: the attachments, the message it replies to, the tapbacks and any steer. Its code is the door step `../../texEntryPoint/checkTheQuestion.js`. */
import { checkTheQuestion } from "../../texEntryPoint/checkTheQuestion.js";
import { doorNode } from "../doorNode.js";

export const checkTheQuestionNode = doorNode(checkTheQuestion, (t) => ({ quoted: t.quoted !== null && t.quoted !== undefined, reacted: Array.isArray(t.reacted) ? t.reacted.length : 0, attachments: Array.isArray(t.sent) ? t.sent.length : 0, steering: t.steer !== null && t.steer !== undefined }));
