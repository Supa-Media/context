import { useEffect } from "react";
import { useReachability } from "../offline/reachability";
import { canSendFeedback } from "../observability/client";
import { BetaNotice } from "./BetaNotice";
import { FeedbackDialog } from "./FeedbackDialog";
import { drainQueue } from "./queue";
import { closeFeedback, useOpenFeedback } from "./request";
import { useAccountTelemetrySync } from "./useAccountTelemetrySync";

/**
 * The one place the report dialog is drawn, mounted by the signed-in app
 * layout — so visitors to the homepage and shared links never get it.
 *
 * It also sends what is waiting on this device: once when the app opens, and
 * again whenever the device comes back online — and keeps the Privacy &
 * feedback switches following the account.
 */
export function FeedbackHost() {
  useAccountTelemetrySync();
  const report = useOpenFeedback();
  const reachability = useReachability();

  useEffect(() => {
    if (reachability !== "offline" && canSendFeedback()) void drainQueue();
  }, [reachability]);

  return (
    <>
      {report === null ? null : (
        <FeedbackDialog key={report.openedAt} report={report} onClose={closeFeedback} />
      )}
      <BetaNotice />
    </>
  );
}
