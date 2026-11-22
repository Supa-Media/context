import assert from "node:assert/strict";
import { architectureFor } from "../../../../../packages/tex/gateway/agent/texArchitecture.js";

export default {
  id: "group-share-offer-yes",
  incident: "2026-11-22, Lab copy of Tex Devs: a member asked whether to share their calendar with the group, and Tex told them to type \"Tex, share my calendar here\" instead of offering, though a plain yes to Tex's offer now counts.",
  cause: "Tex's capability lines for sharing a calendar or mail with a group chat named only the set phrase, never that Tex may offer and that a yes to its offer is enough.",
  path: "group tag",
  async run() {
    const told = architectureFor("group");
    for (const name of ["Sharing someone's calendar with a group chat", "Sharing someone's mail with a group chat"]) {
      const line = told.split("\n").find((entry) => entry.startsWith(`- ${name}`));
      assert.ok(line, `the group turn is told about ${name}`);
      assert.match(line, /their plain yes to your offer is enough: never tell them to type a set phrase/, `${name}: offer, and take the yes`);
    }
  },
};
