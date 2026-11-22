import { test } from "node:test";
import assert from "node:assert/strict";
import { emulatedUrl, emulatedHosts } from "../src/hosts.mjs";
import { SERVICES } from "../src/services.mjs";

const ORIGIN = "https://context-emulators-pr42.fake-sub.workers.dev";

test("Google's real endpoints land on the google emulator's own paths", () => {
  const cases = {
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=s": "/google/o/oauth2/v2/auth?client_id=x&state=s",
    "https://oauth2.googleapis.com/token": "/google/oauth2/token",
    "https://oauth2.googleapis.com/revoke?token=t": "/google/oauth2/revoke?token=t",
    "https://openidconnect.googleapis.com/v1/userinfo": "/google/oauth2/v2/userinfo",
    "https://www.googleapis.com/oauth2/v3/userinfo": "/google/oauth2/v2/userinfo",
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?syncToken=a": "/google/calendar/v3/calendars/primary/events?syncToken=a",
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is%3Aunread": "/google/gmail/v1/users/me/messages?q=is%3Aunread",
    "https://api.resend.com/emails": "/resend/emails",
  };
  for (const [real, path] of Object.entries(cases)) assert.equal(emulatedUrl(real, ORIGIN), ORIGIN + path, real);
});

test("a host, path or scheme no emulator covers maps to nothing, so the caller refuses it", () => {
  for (const real of [
    "https://oauth2.googleapis.com/tokens",
    "https://oauth2.googleapis.com/tokeninfo",
    "http://www.googleapis.com/calendar/v3/x",
    "https://www.googleapis.com:8443/calendar/v3/x",
    "https://api.anthropic.com/v1/messages",
    "https://googleapis.com.evil.example/calendar/v3",
    "https://evil.example/https://www.googleapis.com/calendar",
  ]) {
    assert.equal(emulatedUrl(real, ORIGIN), null, real);
  }
});

test("every emulator has a source, a loader and https hosts it alone answers for", () => {
  const seen = new Map();
  for (const svc of SERVICES) {
    assert.match(svc.name, /^[a-z][a-z0-9-]*$/);
    assert.ok(svc.source && typeof svc.load === "function" && svc.covers, svc.name);
    for (const rule of svc.hosts) {
      assert.ok(rule.from.startsWith("/") && rule.to.startsWith("/"), `${svc.name} ${rule.host}`);
      const owner = seen.get(rule.host);
      assert.ok(!owner || owner === svc.name, `${rule.host} is claimed by ${owner} and ${svc.name}`);
      seen.set(rule.host, svc.name);
    }
  }
  assert.ok(emulatedHosts().includes("www.googleapis.com"));
});
