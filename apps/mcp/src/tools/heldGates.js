/**
 * The calls that always wait for the person's yes to their exact copy,
 * whatever the deployment's egress switch says (`session.js`): an email
 * (`emailGate.js`) and a calendar change (`calendarGate.js`).
 */

import { EMAIL_TOOL, emailGate } from "./emailGate.js";
import { CALENDAR_TOOL, calendarGate } from "./calendarGate.js";

export const HELD_GATES = Object.freeze({ [EMAIL_TOOL]: emailGate, [CALENDAR_TOOL]: calendarGate });
