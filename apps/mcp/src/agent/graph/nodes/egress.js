/**
 * The egress judge step (`texConfig.json`, node `egress`): does the person's own words ask for a step that lets more
 * people see something, or acts in their name (`privacy/judge.js`). Its model and effort are the config's, not the
 * judge's defaults, so a Lab edit to the step reaches the live judge.
 */
import { aiGatewayConfig } from "../../aiGateway.js";
import { judgeWords } from "../../../privacy/judge.js";
import { texEffort, texModel } from "../../texConfig.js";

/** @param {{ words: string, action: string, workspace?: string, subject?: object }} input */
export default async function egress(input, io) {
  const config = aiGatewayConfig(io.ctx.env);
  if (!config) throw new Error("egress: no AI gateway to ask");
  return judgeWords(input, config, { model: texModel("egress"), effort: texEffort("egress").effort });
}
