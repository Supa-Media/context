import assert from "node:assert/strict";
import { architectureFor } from "../../../../../packages/tex/gateway/agent/texArchitecture.js";
import { ACTIONS } from "../../../src/tools/v2/actions.js";

export default {
  id: "area-setup-by-text",
  incident:
    "2026-11-25: the owner asked that someone be able to update areas, their settings, their metrics and their bots' setup through Tex or the MCP; until then an area's owner, metric or Grok bot could be set only in the app's area panel.",
  cause:
    "No tool wrote an area's settings, so Tex was told nothing about areas and could only point at the app. `manage` action `area` (set_area) now does, and Tex's capability list names it in a 1:1 text and in a group chat.",
  path: "1:1 text",
  async run() {
    assert.equal(ACTIONS.manage.area?.tool, "set_area", "manage area reaches set_area");
    for (const role of ["texts", "group"]) {
      const told = architectureFor(role);
      const line = told.split("\n").find((entry) => entry.startsWith("- Areas and their bots"));
      assert.ok(line, `the ${role} turn is told it can set up an area`);
      assert.match(line, /manage action area/, `${role}: by manage action area`);
      assert.match(line, /metric/, `${role}: including its metric`);
    }
  },
};
