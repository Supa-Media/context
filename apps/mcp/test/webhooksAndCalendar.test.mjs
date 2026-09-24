import { check, objects, storedText, env, accessTokenFor, worker } from "./harness.mjs";

export async function runWebhooksAndCalendarChecks() {
  // -- path token + inbox
  const pt = await worker.fetch(
    new Request(`https://x/t/${encodeURIComponent(accessTokenFor("pub-token"))}/mcp`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "ping" }),
    }),
    env,
    { waitUntil() {} }
  );
  check("token-in-path auth works", (await pt.json()).id === 999);
  const inbox = await worker.fetch(
    new Request("https://x/inbox", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessTokenFor("inbox-token")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Idea!", text: "capture me" }),
    }),
    env,
    { waitUntil() {} }
  );
  const inboxBody = await inbox.json();
  check("inbox capture lands in 0-inbox", inboxBody.ok && inboxBody.path.startsWith("0-inbox/") && objects.has(inboxBody.path));
  const granolaPayload = {
    title: "Weekly Leadership Sync",
    text: "## Summary\nWe made a decision.",
    source: "granola",
    external_id: "granola-note-123",
    source_url: "https://app.granola.ai/notes/granola-note-123",
    source_created_at: "2026-08-21T15:00:00Z",
    attendees: ["Seyi", "Alex"],
    metadata: { calendar_event: "Weekly Leadership Sync" },
  };
  const granolaRequest = () =>
    new Request("https://x/inbox", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessTokenFor("inbox-token")}`, "Content-Type": "application/json" },
      body: JSON.stringify(granolaPayload),
    });
  const granolaInbox = await worker.fetch(granolaRequest(), env, { waitUntil() {} });
  const granolaBody = await granolaInbox.json();
  const granolaNote = storedText(granolaBody.path) || "";
  check(
    "structured Granola capture preserves context",
    granolaBody.ok &&
      granolaBody.path.startsWith("0-inbox/granola/") &&
      granolaNote.includes('source: "granola"') &&
      granolaNote.includes('external-id: "granola-note-123"') &&
      granolaNote.includes("Seyi") &&
      granolaNote.includes("https://app.granola.ai/notes/granola-note-123") &&
      granolaNote.includes('"calendar_event": "Weekly Leadership Sync"')
  );
  const granolaRetry = await worker.fetch(granolaRequest(), env, { waitUntil() {} });
  const granolaRetryBody = await granolaRetry.json();
  check(
    "structured inbox capture deduplicates provider retries",
    granolaRetryBody.ok && granolaRetryBody.duplicate === true && granolaRetryBody.path === granolaBody.path
  );
  const invalidInboxJson = await worker.fetch(
    new Request("https://x/inbox", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessTokenFor("inbox-token")}`, "Content-Type": "application/json" },
      body: "{nope",
    }),
    env,
    { waitUntil() {} }
  );
  check("inbox rejects malformed JSON", invalidInboxJson.status === 400);
  const oversizedInbox = await worker.fetch(
    new Request("https://x/inbox", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessTokenFor("inbox-token")}`,
        "Content-Type": "text/plain",
        "Content-Length": "2000001",
      },
      body: "too large",
    }),
    env,
    { waitUntil() {} }
  );
  check("inbox rejects oversized captures", oversizedInbox.status === 413);
  const inboxBad = await worker.fetch(
    new Request("https://x/inbox", { method: "POST", headers: { Authorization: "Bearer pub-token" }, body: "hi" }),
    env,
    { waitUntil() {} }
  );
  check("inbox rejects team token", inboxBad.status === 401);

  // -- native Granola webhook: signed event → API fetch → private inbox
  async function signedGranolaRequest(event, { timestamp = Math.floor(Date.now() / 1000), signature = null } = {}) {
    const raw = JSON.stringify(event);
    const webhookId = event.event_id;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("granola-webhook-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const bytes = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${webhookId}.${timestamp}.${raw}`)
      )
    );
    const encoded = btoa(String.fromCharCode(...bytes));
    return new Request("https://x/granola-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signature || `v1,${encoded}`,
      },
      body: raw,
    });
  }

  const granolaEvent = {
    event_id: "8f1c2a4e-6b3d-4e8f-9a2b-1c5d7e9f0a3b",
    event_type: "note.generated",
    note_id: "not_1d3tmYTlCICgjy",
    occurred_at: "2026-08-21T15:30:00Z",
  };
  let granolaAuthorization = null;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("public-api.granola.ai/v1/notes/not_1d3tmYTlCICgjy")) {
      granolaAuthorization = options?.headers?.Authorization ?? null;
      return Response.json({
        id: "not_1d3tmYTlCICgjy",
        title: "Quarterly yoghurt budget review",
        created_at: "2026-08-21T15:30:00Z",
        updated_at: "2026-08-21T16:45:00Z",
        web_url: "https://notes.granola.ai/d/example",
        owner: { name: "Seyi", email: "seyi@example.com" },
        attendees: [{ name: "Raisin Patel", email: "raisin@example.com" }],
        calendar_event: { event_title: "Yoghurt review" },
        folder_membership: [{ id: "fol_123", name: "AI Workspace Inbox" }],
        summary_markdown: "## Decision\n\nBuy more yoghurt.",
      });
    }
    return new Response("not found", { status: 404 });
  };
  const granolaWork = [];
  const granolaWebhook = await worker.fetch(await signedGranolaRequest(granolaEvent), env, {
    waitUntil: (promise) => granolaWork.push(promise),
  });
  await Promise.all(granolaWork);
  const nativeGranolaNotes = [...objects.entries()].filter(([key]) => key.startsWith("0-inbox/granola/"));
  const nativeGranolaText = nativeGranolaNotes.map(([key]) => storedText(key)).join("\n");
  check(
    "signed Granola webhook fetches and files the full note",
    granolaWebhook.status === 202 &&
      nativeGranolaText.includes("Buy more yoghurt") &&
      nativeGranolaText.includes("Raisin Patel <raisin@example.com>") &&
      nativeGranolaText.includes("AI Workspace Inbox")
  );
  check(
    "Granola note fetch still carries its API credential",
    granolaAuthorization === "Bearer granola-api-key"
  );
  check(
    "completed Granola webhook leaves no pending event",
    ![...objects.keys()].some((key) => key.startsWith(".context/integrations/granola/events/pending/")) &&
      [...objects.keys()].some((key) => key.startsWith(".context/integrations/granola/events/completed/"))
  );
  const granolaDuplicate = await worker.fetch(await signedGranolaRequest(granolaEvent), env, {
    waitUntil() {},
  });
  check("Granola webhook deduplicates event retries", (await granolaDuplicate.json()).duplicate === true);
  const badGranolaSignature = await worker.fetch(
    await signedGranolaRequest({ ...granolaEvent, event_id: "another-event-id" }, { signature: "v1,bad" }),
    env,
    { waitUntil() {} }
  );
  check("Granola webhook rejects invalid signatures", badGranolaSignature.status === 401);
  const staleGranolaSignature = await worker.fetch(
    await signedGranolaRequest(
      { ...granolaEvent, event_id: "stale-event-id" },
      { timestamp: Math.floor(Date.now() / 1000) - 601 }
    ),
    env,
    { waitUntil() {} }
  );
  check("Granola webhook rejects replayed old deliveries", staleGranolaSignature.status === 401);

  // -- calendar cron
  env.CALENDAR_ICS_URL = "https://fake/cal.ics";
  const soon = new Date(Date.now() + 3 * 24 * 3600 * 1000);
  const y = soon.getUTCFullYear(), mo = String(soon.getUTCMonth() + 1).padStart(2, "0"), d = String(soon.getUTCDate()).padStart(2, "0");
  globalThis.fetch = async () =>
    new Response(
      `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:${y}${mo}${d}T140000Z\r\nSUMMARY:Team\r\n  sync\r\nLOCATION:HQ\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
    );
  await worker.scheduled({}, env, { waitUntil: (p) => p });
  await new Promise((r) => setTimeout(r, 50));
  const cal = storedText("2-areas/calendar/next-14-days.md") || "";
  check("cron writes calendar note", cal.includes("Team sync") && cal.includes("@ HQ") && cal.includes("14:00"));

  function icsStamp(date) {
    return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  }
  function utcAt(date, hour) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour));
  }
  function shifted(date, { days = 0, months = 0, years = 0 } = {}) {
    const copy = new Date(date);
    if (years) copy.setUTCFullYear(copy.getUTCFullYear() + years);
    if (months) copy.setUTCMonth(copy.getUTCMonth() + months);
    if (days) copy.setUTCDate(copy.getUTCDate() + days);
    return copy;
  }

  const targetDay = new Date(Date.now() + 3 * 24 * 3600 * 1000);
  const weeklyTarget = utcAt(targetDay, 10);
  const weeklyStart = shifted(weeklyTarget, { days: -21 });
  const weeklyExcluded = shifted(weeklyTarget, { days: 7 });
  const movedMasterStart = utcAt(shifted(targetDay, { days: -21 }), 16);
  const movedOriginal = utcAt(targetDay, 16);
  const movedActual = utcAt(targetDay, 17);
  const cancelledMasterStart = utcAt(shifted(targetDay, { days: -21 }), 18);
  const cancelledOriginal = utcAt(targetDay, 18);
  const dailyStart = utcAt(targetDay, 9);

  const monthlyTargetDay = new Date(targetDay);
  if (monthlyTargetDay.getUTCDate() > 28) {
    monthlyTargetDay.setUTCDate(monthlyTargetDay.getUTCDate() + (32 - monthlyTargetDay.getUTCDate()));
  }
  const monthlyTarget = utcAt(monthlyTargetDay, 11);
  const monthlyStart = shifted(monthlyTarget, { months: -3 });
  const bySetPos = Math.ceil(monthlyTarget.getUTCDate() / 7);
  const bySetPosWeekday = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][monthlyTarget.getUTCDay()];
  const bySetPosStartMonth = shifted(monthlyTarget, { months: -3 });
  const firstOfStartMonth = new Date(Date.UTC(
    bySetPosStartMonth.getUTCFullYear(),
    bySetPosStartMonth.getUTCMonth(),
    1,
    13
  ));
  const bySetPosStart = new Date(firstOfStartMonth);
  bySetPosStart.setUTCDate(
    1 + ((monthlyTarget.getUTCDay() - firstOfStartMonth.getUTCDay() + 7) % 7) + (bySetPos - 1) * 7
  );
  const endedStart = shifted(weeklyTarget, { days: -21 });
  const endedUntil = shifted(weeklyTarget, { days: -7 });

  const yearlyTargetDay = new Date(targetDay);
  if (yearlyTargetDay.getUTCMonth() === 1 && yearlyTargetDay.getUTCDate() === 29) {
    yearlyTargetDay.setUTCDate(28);
  }
  const yearlyTarget = utcAt(yearlyTargetDay, 12);
  const yearlyStart = shifted(yearlyTarget, { years: -3 });

  globalThis.fetch = async () =>
    new Response(
      `BEGIN:VCALENDAR\r\n` +
      `BEGIN:VEVENT\r\nUID:weekly\r\nDTSTART:${icsStamp(weeklyStart)}\r\nRRULE:FREQ=WEEKLY;COUNT=8\r\nEXDATE:${icsStamp(weeklyExcluded)}\r\nSUMMARY:Weekly review\r\nEND:VEVENT\r\n` +
      `BEGIN:VEVENT\r\nUID:moved\r\nDTSTART:${icsStamp(movedMasterStart)}\r\nRRULE:FREQ=WEEKLY;COUNT=8\r\nSUMMARY:Regular slot\r\nEND:VEVENT\r\n` +
      `BEGIN:VEVENT\r\nUID:moved\r\nRECURRENCE-ID:${icsStamp(movedOriginal)}\r\nDTSTART:${icsStamp(movedActual)}\r\nSUMMARY:Rescheduled slot\r\nEND:VEVENT\r\n` +
      `BEGIN:VEVENT\r\nUID:cancelled\r\nDTSTART:${icsStamp(cancelledMasterStart)}\r\nRRULE:FREQ=WEEKLY;COUNT=8\r\nSUMMARY:Cancelled occurrence\r\nEND:VEVENT\r\n` +
      `BEGIN:VEVENT\r\nUID:cancelled\r\nRECURRENCE-ID:${icsStamp(cancelledOriginal)}\r\nDTSTART:${icsStamp(cancelledOriginal)}\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n` +
      `BEGIN:VEVENT\r\nUID:daily\r\nDTSTART:${icsStamp(dailyStart)}\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Daily focus\r\nEND:VEVENT\r\n` +
      `BEGIN:VEVENT\r\nUID:monthly\r\nDTSTART:${icsStamp(monthlyStart)}\r\nRRULE:FREQ=MONTHLY;COUNT=6;BYMONTHDAY=${monthlyTarget.getUTCDate()}\r\nSUMMARY:Monthly review\r\nEND:VEVENT\r\n` +
      `BEGIN:VEVENT\r\nUID:bysetpos\r\nDTSTART:${icsStamp(bySetPosStart)}\r\nRRULE:FREQ=MONTHLY;COUNT=6;BYDAY=${bySetPosWeekday};BYSETPOS=${bySetPos}\r\nSUMMARY:Positioned monthly review\r\nEND:VEVENT\r\n` +
      `BEGIN:VEVENT\r\nUID:ended\r\nDTSTART:${icsStamp(endedStart)}\r\nRRULE:FREQ=WEEKLY;UNTIL=${icsStamp(endedUntil)}\r\nSUMMARY:Expired recurrence\r\nEND:VEVENT\r\n` +
      `BEGIN:VEVENT\r\nUID:yearly\r\nDTSTART:${icsStamp(yearlyStart)}\r\nRRULE:FREQ=YEARLY;COUNT=6;BYMONTH=${yearlyTarget.getUTCMonth() + 1};BYMONTHDAY=${yearlyTarget.getUTCDate()}\r\nSUMMARY:Yearly reminder\r\nEND:VEVENT\r\n` +
      `END:VCALENDAR\r\n`
    );
  await worker.scheduled({}, env, { waitUntil: (p) => p });
  await new Promise((r) => setTimeout(r, 50));
  const recurringCal = storedText("2-areas/calendar/next-14-days.md") || "";
  const targetSection = recurringCal
    .split(`## ${weeklyTarget.toISOString().slice(0, 10)}\n`)[1]
    ?.split("\n## ")[0] || "";
  check("cron expands past-anchored weekly recurrence", recurringCal.includes("10:00 — Weekly review"));
  check("cron honors recurrence EXDATE", (recurringCal.match(/Weekly review/g) || []).length === 1);
  check("cron applies moved recurrence exception", targetSection.includes("17:00 — Rescheduled slot") && !targetSection.includes("16:00 — Regular slot"));
  check("cron applies cancelled recurrence exception", !targetSection.includes("18:00 — Cancelled occurrence"));
  check("cron honors recurrence COUNT", (recurringCal.match(/Daily focus/g) || []).length === 3);
  check("cron expands monthly recurrence", recurringCal.includes("11:00 — Monthly review"));
  check("cron honors recurrence BYSETPOS", recurringCal.includes("13:00 — Positioned monthly review"));
  check("cron honors recurrence UNTIL", !recurringCal.includes("Expired recurrence"));
  check("cron expands yearly recurrence", recurringCal.includes("12:00 — Yearly reminder"));
  check("calendar note reports recurring support", recurringCal.includes("Common recurring-event rules are expanded"));

}
