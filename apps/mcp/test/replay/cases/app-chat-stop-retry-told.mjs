import assert from "node:assert/strict";
import { capabilitiesFor } from "../../../../../packages/tex/gateway/agent/capabilities.js";

export default {
  id: "app-chat-stop-retry-told",
  incident: "2026-11-20: a text in the app chat got no answer and nothing said so; the app now shows Delivered, Read or Answered, a stop button and Try again (#3891, #3899), but Tex was never told, so asked how to stop or retry it could only guess.",
  cause: "The capability list described the app chat without its delivery line, stop and retry.",
  path: "capability list (1:1, advisor, reviewer)",
  async run() {
    for (const role of ["texts", "advisor", "reviewer"]) {
      const told = capabilitiesFor(role);
      const app = told.split("\n").find((line) => line.startsWith("- Chatting in the Context app."));
      assert.ok(app, `${role} is told about the app chat`);
      assert.match(app, /the app says Delivered, Read or Answered/, `${role} is told what the app shows under each text`);
      assert.match(app, /stop you mid-answer there \(the stop button or Esc; what you already did stays\)/, `${role} is told how to stop a reply`);
      assert.match(app, /a text you couldn't answer says so with Try again/, `${role} is told a failed text offers Try again`);
    }
  },
};
