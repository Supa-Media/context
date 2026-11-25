/**
 * A group turn given up on after its retries (moved out of `groupInbox.ts` whole, so the queue stays under its size
 * limit). Never silent where someone is waiting: a job's report and a `did` turn say so in their own way.
 */
import { didUnsaid } from "./didFacts";
import { routineDone, type GroupDeps } from "./groupInbox";
import { failedLine, GROUP_LINES } from "./groupLines";
import { log, say } from "./groupSay";
import type { InboxStorage } from "./inbox";
import { watchFailed } from "./reviewWatch";
import type { GroupMessage } from "./sendblueGroups";

/** A turn given up on (`reason` as logged): a routine nobody asked for just now fails quietly; anyone else is told what broke, and the chat is scored (`watchFailed`). */
export async function turnFailed(storage: InboxStorage, deps: GroupDeps, message: GroupMessage, reason: string | undefined): Promise<void> {
  if (message.jobReport !== undefined) {
    // Never lost in silence: the chat hears that news is waiting, and the job list holds it for the next tag (`chatJobs`).
    log("job_report_failed");
    await say(storage, deps, message, GROUP_LINES.jobReportRefused, { system: true, reason: "failed" }).catch(() => {});
  } else if (await didUnsaid(storage, deps, message, "failed")) {
    // said in its old line (`didFacts.ts`)
  } else if (message.crossChat !== undefined) log("cross_chat_failed"); // the asking chat hears it timed out (`crossChat.ts`)
  else if (message.routine !== undefined) await routineDone(deps, message, "failed");
  else await say(storage, deps, message, failedLine(reason), { system: true, reason: reason === "gateway:504" ? "timed_out" : "failed" }).catch(() => {}).then(() => watchFailed(storage, deps, message));
}
