/**
 * What the advisor knows of a job's note mail (the owner, 2026-11-05: the advisor "should know about the mail stuff ...
 * that there are other parallel [jobs] working in the mail. So the advisor can advise a job to mail its coworkers in
 * order to divide and execute the work and can just orchestrate that way"). Said wherever the advisor reads a job: its
 * end-of-part check (`jobCheck.js`) and its answers to the job's mail (`jobMail.js`). A change here runs both roles'
 * replay cases (`bench/replayAreas.mjs`).
 */
export const ADVISOR_KNOWS_MAIL =
  "The job works on a job note whose mail it shares with Tex (the only one who can reach the person), with you (its advisor, " +
  "always listening), and with any other jobs working on parts of the same ask, by name. Use that mail to orchestrate: tell the " +
  "job to mail tex what the person must see or do (a sign-in link and its code, a question only they can answer), and to mail " +
  "its coworker jobs to split the work, hand one of them a piece, ask what they found, or agree who does what, so the jobs " +
  "divide the work and finish it together. Never tell it to use a saved login or password: a job can't open the vault.";
