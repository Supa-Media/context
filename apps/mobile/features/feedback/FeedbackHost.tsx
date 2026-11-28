import { useEffect } from "react";
import { useReachability } from "../offline/reachability";
import { BetaNotice } from "./BetaNotice";
import { FeedbackDialog } from "./FeedbackDialog";
import { drainQueue } from "./queue";
import { useCanSendFeedback, useFeedbackTransport } from "./transport";
import { closeFeedback, useOpenFeedback } from "./request";
import { useAccountTelemetrySync } from "./useAccountTelemetrySync";
import { useAppVitals } from "../observability/useAppVitals";
import { useSignupChannel } from "../auth/useSignupChannel";

/**
 * The one place the report dialog is drawn, mounted by the signed-in app
 * layout — so visitors to the homepage and shared links never get it.
 *
 * It also sends what is waiting on this device: once when the app opens, and
 * again whenever the device comes back online — and keeps the Privacy &
 * feedback switches following the account, and the app's own vitals
 * (start time, load time, clean sessions) reaching the control plane, and
 * a new account's first touch for its sign-up channel.
 */
export function FeedbackHost() {
  useAccountTelemetrySync();
  useAppVitals();
  useSignupChannel();
  useFeedbackTransport();
  const canReport = useCanSendFeedback();
  const report = useOpenFeedback();
  const reachability = useReachability();

  useEffect(() => {
    if (reachability !== "offline" && canReport) void drainQueue();
  }, [reachability, canReport]);

  return (
    <>
      {report === null ? null : (
        <FeedbackDialog key={report.openedAt} report={report} onClose={closeFeedback} />
      )}
      <BetaNotice />
    </>
  );
}
