import { StopNewEmailScreen } from "../features/account/AccountLinkScreen";

/** `/stop-new-email?token=…`: stop a new email's seven-day wait. Works signed out. */
export default function StopNewEmailRoute() {
  return <StopNewEmailScreen />;
}
