// The whole path a preview uses, in process: Google sign-in through the
// emulator, then Calendar with an RSVP and Gmail, all at the URLs our code
// already calls, rewritten by emulatedUrl.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmulators, emulatedUrl, personaEmail } from "../src/index.mjs";

const ORIGIN = "https://emulators.test";

async function start() {
  const emulators = await createEmulators({ publicUrl: ORIGIN });
  const call = (realUrl, init = {}) => {
    const to = emulatedUrl(realUrl, ORIGIN);
    assert.ok(to, `no emulator for ${realUrl}`);
    return emulators.fetch(new Request(to, { redirect: "manual", ...init }));
  };
  return { emulators, call };
}

async function signIn(call, email, scope) {
  const redirect = "https://app.test/google/callback";
  const page = await call(`https://accounts.google.com/o/oauth2/v2/auth?client_id=preview&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&access_type=offline&state=s1&scope=${encodeURIComponent(scope)}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), new RegExp(email.replace(".", "\\.")), "the sign-in page offers the persona's account");
  const form = new URLSearchParams({ email, redirect_uri: redirect, scope, state: "s1", client_id: "preview", nonce: "", code_challenge: "", code_challenge_method: "" });
  const back = await call("https://accounts.google.com/o/oauth2/v2/auth/callback", { method: "POST", body: form });
  assert.equal(back.status, 302);
  const location = new URL(back.headers.get("location"));
  assert.equal(location.origin + location.pathname, redirect);
  assert.equal(location.searchParams.get("state"), "s1");
  const token = await call("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code: location.searchParams.get("code"), client_id: "preview", client_secret: "fake", redirect_uri: redirect }),
  });
  assert.equal(token.status, 200);
  return token.json();
}

test("a persona signs in to Google, gets an RSVP'd event on their calendar and new mail", async () => {
  const { emulators, call } = await start();
  try {
    const email = personaEmail("alpha");
    const tokens = await signIn(call, email, "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.modify");
    assert.ok(tokens.access_token && tokens.refresh_token && tokens.id_token);
    const auth = { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" };

    const me = await (await call("https://openidconnect.googleapis.com/v1/userinfo", { headers: auth })).json();
    assert.equal(me.email, email);

    const created = await call("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        summary: "Golf at the club",
        start: { dateTime: "2026-11-23T15:00:00Z" },
        end: { dateTime: "2026-11-23T17:00:00Z" },
        attendees: [{ email, self: true, responseStatus: "accepted" }, { email: "friend@example.com", responseStatus: "needsAction" }],
      }),
    });
    assert.equal(created.status, 200);
    const list = await (await call("https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=2026-11-23T00:00:00Z&timeMax=2026-11-24T00:00:00Z&singleEvents=true", { headers: auth })).json();
    const golf = list.items.find((e) => e.summary === "Golf at the club");
    assert.ok(golf, "the event is on the calendar");
    assert.equal(golf.attendees.find((a) => a.email === email).responseStatus, "accepted");

    const inbox = await (await call("https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread", { headers: auth })).json();
    assert.ok(inbox.messages.some((m) => m.id === "msg_welcome_alpha"), "alpha's own seeded mail");
    assert.ok(!inbox.messages.some((m) => m.id === "msg_welcome_beta"), "never another persona's mail");

    const refreshed = await call("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: "preview", client_secret: "fake" }) });
    assert.equal(refreshed.status, 200);
  } finally {
    await emulators.close();
  }
});

test("a calendar call with no token is refused the way Google refuses it", async () => {
  const { emulators, call } = await start();
  try {
    const res = await call("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.status, "UNAUTHENTICATED");
  } finally {
    await emulators.close();
  }
});

test("Resend sends land in the emulator, and an unknown emulator name is a 404", async () => {
  const { emulators, call } = await start();
  try {
    const sent = await call("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: "Bearer re_fake", "content-type": "application/json" },
      body: JSON.stringify({ from: "tex@emulators.invalid", to: ["alpha@supa.media"], subject: "Hi", text: "Hello" }),
    });
    assert.equal(sent.status, 200);
    assert.ok((await sent.json()).id);
    const missing = await emulators.fetch(new Request(`${ORIGIN}/stripe/v1/charges`));
    assert.equal(missing.status, 404);
  } finally {
    await emulators.close();
  }
});
