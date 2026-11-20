/**
 * The Shape gate node, `shapeGate` (config wire `doorStep -> shapeGate`, uses; off in main's config). The Door calls
 * it as soon as it has read the text and goes on gathering, so the gate's one Clef call runs beside the Door
 * (`doorStep.js`); the Front door's step waits for it only as long as its time limit (`../../shapeGate.js`).
 *
 * Input: the text and whether it is a group's. Output: `{ to: "read", ending, endingSure, order, records }`, or
 * `{ to: "none" }` when there is no model here, the call failed or ran out of time, or it named no ending.
 */
import { decisionEngine } from "../../decide.js";
import { readShape, shapeRequest } from "../../shapeGate.js";
import { texTimeoutMs } from "../../texConfig.js";

/** The longest the gate may take when its config names no limit: Clef answers in about half a second. */
const DEFAULT_MS = 2_500;

export async function shapeGateNode(input, io) {
  const t = io?.ctx?.turn ?? {};
  const engine = io?.engine ?? decisionEngine(t.env?.AI);
  if (typeof engine !== "function" || typeof input?.question !== "string" || input.question.trim() === "") return { to: "none" };
  const asked = shapeRequest(input.question, { group: input.group === true });
  let limit = DEFAULT_MS;
  try {
    limit = texTimeoutMs("shapeGate");
  } catch {
    // a config with no limit for it: the default
  }
  let timer;
  const answers = await Promise.race([
    Promise.resolve().then(() => engine(asked.state, asked.questions)).catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), limit);
    }),
  ]).finally(() => clearTimeout(timer));
  const shape = readShape(answers);
  return shape === null ? { to: "none" } : { to: "read", ...shape };
}
