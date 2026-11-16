/**
 * Job advisor node "jobadv" (`texConfig.json`; Dev2, 2026-11-16: Job check and the Advisor on job mail, merged): the
 * one advisor a background job reaches through its `uses` wire, in one of two roles. `role: "check"` gives the
 * advisor's verdict on one part of the job (`jobCheck.js` `checkJob`, through `../jobAdvisor/check.js`); `role: "mail"` answers
 * a question the job asked on its note's mail (`jobNote.js`, through `../jobAdvisor/mail.js`). The live things each role needs
 * come in `io.ctx` (`jobCheck`, `mailadv`), never in the input or the output, which stay plain and loggable.
 */
import { jobcheck } from "../jobAdvisor/check.js";
import { mailadv } from "../jobAdvisor/mail.js";

export async function jobadv(input, io) {
  const { role, ...rest } = input;
  if (role === "check") return jobcheck(rest, io);
  if (role === "mail") return mailadv(rest, io);
  throw new Error(`jobadv: no role "${role}"`);
}
