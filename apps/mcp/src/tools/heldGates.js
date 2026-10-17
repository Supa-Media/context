/**
 * The calls that always wait for the person's yes to their exact copy
 * (`session.js`): an email (`emailGate.js`), a calendar change
 * (`calendarGate.js`), and a bug report filed by text (`reportGate.js`).
 */

import { EMAIL_TOOL, emailGate } from "./emailGate.js";
import { CALENDAR_TOOL, calendarGate } from "./calendarGate.js";
import { REPORT_TOOL, reportGate } from "./reportGate.js";

export const HELD_GATES = Object.freeze({ [EMAIL_TOOL]: emailGate, [CALENDAR_TOOL]: calendarGate, [REPORT_TOOL]: reportGate });
