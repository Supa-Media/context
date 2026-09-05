/**
 * A settings file never widens what this app may do.
 *
 * Every check below is one shape of broken record, asserted to land on the
 * *safe* value rather than on a plausible one. The interesting direction is
 * always the same: a file that fails to say "ask me first" must still ask.
 *
 * ## Sabotage record
 *
 * Run as a temporary local edit and reverted:
 *
 *   `askBeforeEveryMeeting` read with `Boolean(...)` instead of `bool(..., true)`   4
 *
 * Which is the whole reason `bool` takes a fallback: `Boolean(undefined)` is
 * `false`, and `false` here means an app that records without asking.
 */

import {
  DEFAULT_SETTINGS,
  acceptableGatewayUrl,
  normalizeSettings,
} from "../src/core/settings.ts";

export function runSettingsChecks(check) {
  const defaults = normalizeSettings(undefined);
  check("a missing settings file asks before every meeting", defaults.askBeforeEveryMeeting === true);
  check("a missing settings file captures nothing", defaults.captureEnabled === false);
  check("a missing settings file detects nothing", defaults.detectionEnabled === false);
  check("the default transcriber keeps audio on the machine", defaults.transcription === "on-device");

  check("rubbish parses to the defaults", normalizeSettings("not an object").askBeforeEveryMeeting === true);
  check("null parses to the defaults", normalizeSettings(null).captureEnabled === false);

  // The one that matters: a truthy non-boolean must not read as "false".
  const lying = normalizeSettings({ ...DEFAULT_SETTINGS, askBeforeEveryMeeting: "no" });
  check("askBeforeEveryMeeting: \"no\" still asks", lying.askBeforeEveryMeeting === true);
  const missing = normalizeSettings({ version: 1, captureEnabled: true });
  check("an absent askBeforeEveryMeeting still asks", missing.askBeforeEveryMeeting === true);

  // A blocklist outlives the schema it was written in.
  const future = normalizeSettings({ version: 99, blocklist: ["Therapy App", "zoom"], captureEnabled: true });
  check("a record from another version keeps the blocklist", future.blocklist.length === 2);
  check("a record from another version does not keep captureEnabled", future.captureEnabled === false);
  const dirty = normalizeSettings({ version: 1, blocklist: ["zoom", "zoom", 7, "", "  "] });
  check("blocklist entries are deduped and cleaned", dirty.blocklist.length === 1 && dirty.blocklist[0] === "zoom");

  // The gateway URL is a place secrets could hide.
  check("https is accepted", acceptableGatewayUrl("https://gateway.example.test") === "https://gateway.example.test");
  check("a trailing slash is normalised away", acceptableGatewayUrl("https://gateway.example.test/") === "https://gateway.example.test");
  check("a fixed path is kept", acceptableGatewayUrl("https://gateway.example.test/mcp/") === "https://gateway.example.test/mcp");
  check("plain http is refused", acceptableGatewayUrl("http://gateway.example.test") === null);
  check("http on localhost is allowed for self-hosting", acceptableGatewayUrl("http://localhost:8787") === "http://localhost:8787");
  check("credentials in the URL are refused", acceptableGatewayUrl("https://user:secret@gateway.example.test") === null);
  check("a non-URL is refused", acceptableGatewayUrl("gateway.example.test") === null);
  check("a file URL is refused", acceptableGatewayUrl("file:///etc/passwd") === null);
  check("no token field survives normalisation", !("token" in normalizeSettings({ version: 1, token: "shhh" })));
}
