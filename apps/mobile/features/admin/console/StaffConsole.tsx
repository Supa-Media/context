import { AdminPane } from "../AdminPane";

/** The staff console is a web page; on a phone app `/admin` keeps the old console. */
export const STAFF_CONSOLE_TITLE = "Staff console";
export function StaffConsole() {
  return <AdminPane />;
}
