/**
 * Tex's turn as one text, for the tests that read its source: `texTurn.js`,
 * then each step file in the order the turn runs them (`texTurn/steps.js`),
 * so a check that one line comes before another still means "earlier in the
 * turn".
 */
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../src/agent/${path}`, import.meta.url), "utf8");

export function texTurnSource() {
  const order = [...read("texTurn/steps.js").matchAll(/from "\.\/(\w+\.js)"/g)].map((match) => match[1]);
  return [read("texTurn.js"), ...order.map((file) => read(`texTurn/${file}`))].join("\n");
}
