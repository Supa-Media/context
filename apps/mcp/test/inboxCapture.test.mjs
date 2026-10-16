import { check, objects, storedText, env, accessTokenFor, worker } from "./harness.mjs";

export async function runInboxCaptureChecks() {
  // -- path token + inbox (the per-person capture route; every write goes through the session)
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

}
