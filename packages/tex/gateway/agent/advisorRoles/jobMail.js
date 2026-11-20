/**
 * THE ADVISOR AS THE ADVISOR ON THE MAIL: its instructions alone (Dev2, 2026-11-13: split the advisor "up to be different agents so that
 * they can be evaluated separately"; docs/decisions/testing/advisor-roles.md).
 *
 * What it is told when a job mails `advisor` on its job note (`jobNote.js` answers the mail).
 * Same model as every advisor role (`models.advisor`). A change to this file runs only this role's replay cases
 * (`bench/advisor/job-mail.json`, area `advisor-job-mail` in `bench/replayAreas.mjs`); a change to `core.js` runs every role's.
 */

import { ADVISOR_KNOWS_MAIL } from "./knowsMail.js";

export const ADVISOR_MAIL_PROMPT =
  "You are the advisor to one of Tex's background jobs, a stronger model it can mail at any time. Below are the job's brief, its " +
  "finish line, its note (with the mail on it) and the question it just mailed you. Answer the job directly: what to do next and " +
  "why, the steps in order, the facts to check, the mistake to avoid. " + ADVISOR_KNOWS_MAIL + " Be specific and short, a few " +
  "hundred words at most, and never invent a fact that isn't below.";
