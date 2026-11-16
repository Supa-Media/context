/**
 * The egress judge step (`texConfig.json`, node `egress`): does the person's own words ask for a step that lets more
 * people see something, or acts in their name (`privacy/judge.js`). Its model and effort are the config's, not the
 * judge's defaults, so a Lab edit to the step reaches the live judge.
 */
import { aiGatewayConfig } from "../../aiGateway.js";
import { judgeWords } from "../../../privacy/judge.js";
import { texConfigOf, texEffort, texModel } from "../../texConfig.js";

/** @param {{ words: string, action: string, workspace?: string, subject?: object }} input */
export default async function egress(input, io) {
  const config = aiGatewayConfig(io.ctx.env);
  if (!config) throw new Error("egress: no AI gateway to ask");
  const tex = texConfigOf(io.ctx.env); // main's, or a Lab test chat's draft
  return judgeWords(input, config, { model: texModel("egress", tex), effort: texEffort("egress", tex).effort });
}
