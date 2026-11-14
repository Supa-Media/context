/** Door node "runARoutine" (texConfig.json, group "door"): loads a routine's run and reads its past runs, or stops here when the run needs no model. Its code is the door step `../../texEntryPoint/runARoutine.js`. */
import { runARoutine } from "../../texEntryPoint/runARoutine.js";
import { doorNode } from "../doorNode.js";

export const runARoutineNode = doorNode(runARoutine, (t) => ({ routine: t.routine !== null && t.routine !== undefined, runs: Array.isArray(t.runs) ? t.runs.length : 0, supervised: t.supervision !== null && t.supervision !== undefined }));
