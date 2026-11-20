/** Every door step of Tex's turn, one file each, and the turn's failure path (`../texEntryPoint.js`). The config's nodes run them (`../graph/gatewayNodes.js`). */

export { readTheText } from "./readTheText.js";
export { runARoutine } from "./runARoutine.js";
export { checkTheQuestion } from "./checkTheQuestion.js";
export { settleAYesOrNo } from "./settleAYesOrNo.js";
export { watchWhatLeaves } from "./watchWhatLeaves.js";
export { checkItMayRun } from "./checkItMayRun.js";
export { readTheHistory } from "./readTheHistory.js";
export { openTheWeb } from "./openTheWeb.js";
export { readTheSetup } from "./readTheSetup.js";
export { prepareBookkeeping } from "./prepareBookkeeping.js";
export { prepareTheAnswer } from "./prepareTheAnswer.js";
export { runTheModel } from "./runTheModel.js";
export { finishARoutine } from "./finishARoutine.js";
export { sendTheReply } from "./sendTheReply.js";
export { recoverFromFailure } from "./recoverFromFailure.js";
