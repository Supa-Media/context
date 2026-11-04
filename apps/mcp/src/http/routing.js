/**
 * Routing helpers the entry's `route` uses: matching well-known discovery
 * paths, and attaching the link-call hooks to a request's
 * context. Moved verbatim out of `src/index.js`; `route` itself stays there,
 * where its order of checks can be read top to bottom.
 */

import { objectFirstChildren, objectFirstManifest } from "../store/objectManifest.js";
import { attachHomeRoutineReports } from "../agent/chatHomeSeal.js";
import { deliverMail } from "../mail/deliver.js";

/**
 * The three link calls, attached to the store for each request.
 *
 * They need the session's access token and the workspace it resolved to, and a
 * tool handler is given a store rather than a session: what a handler may do
 * is decided where the session is, not by a handler reaching for one.
 *
 * Every session has a control plane (`src/index.js` refuses a deployment without
 * one), so these are always attached.
 */
export function attachLinkCalls(store, session, controlPlane, env) {
  Object.defineProperty(store, "links", {
    value: {
      create: (request) =>
        controlPlane.createLink(session.accessToken, session.workspaceId, request),
      list: () => controlPlane.listLinks(session.accessToken, session.workspaceId),
      revoke: (shareId) =>
        controlPlane.revokeLink(session.accessToken, session.workspaceId, shareId),
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // A vault link (`tools/vault.js`): a page where the person saves or shares
  // a login themselves, signed in. The control plane builds the URL.
  Object.defineProperty(store, "vaultLinks", {
    value: {
      request: (request) => controlPlane.vaultRequest(session.accessToken, session.workspaceId, request),
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // Tex's saved Browserbase profile (`agent/browserProfile.js`), filed under
  // this session's workspace; the control plane makes and releases it.
  Object.defineProperty(store, "browserProfiles", {
    value: {
      get: (owner, chat) => controlPlane.browserProfile(session.accessToken, session.workspaceId, { owner, chat }),
      forget: (owner) => controlPlane.browserProfile(session.accessToken, session.workspaceId, { owner, forget: true }),
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // Note mail mailboxes (`tools/notes/mail.js`): joined against this context,
  // read back only by the grant that joined.
  // A mailbox joined from a background job's turn carries the job's id, and a
  // line sent on the note is handed to those jobs at once (`mail/deliver.js`).
  const jobMailboxes = (path) => controlPlane.jobMailboxes(session.accessToken, session.workspaceId, path);
  Object.defineProperty(store, "mail", {
    value: {
      workspaceId: session.workspaceId,
      join: (path, name, jobId, machineId) => controlPlane.joinMailbox(session.accessToken, session.workspaceId, path, name, jobId, machineId),
      get: (mailboxId) => controlPlane.getMailbox(session.accessToken, mailboxId),
      read: (mailboxId, readThrough) => controlPlane.markMailRead(session.accessToken, mailboxId, readThrough),
      deliver: (line) => deliverMail(env, { jobMailboxes, workspaceId: session.workspaceId }, line),
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // An email the person said yes to (`tools/email.js`), sent through their
  // own Gmail. The control plane picks the sender off this token and holds the limits.
  Object.defineProperty(store, "email", {
    value: {
      check: (email) => controlPlane.sendPersonEmail(session.accessToken, session.workspaceId, email, { check: true }),
      send: (email) => controlPlane.sendPersonEmail(session.accessToken, session.workspaceId, email),
      // A draft saved in their Gmail for them to send; it reaches nobody.
      draft: (email) => controlPlane.savePersonEmailDraft(session.accessToken, session.workspaceId, email),
      // Their mail read live from Gmail (`tools/emailRead.js`), for what the notes do not hold.
      search: (search) => controlPlane.personMailSearch(session.accessToken, session.workspaceId, search),
      read: (address, id, options) => controlPlane.personMailRead(session.accessToken, session.workspaceId, address, id, options),
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // A calendar change the person said yes to (`tools/calendarWrite.js`), and reading it live.
  Object.defineProperty(store, "calendar", {
    value: {
      check: (change) => controlPlane.changePersonCalendar(session.accessToken, session.workspaceId, change, { check: true }),
      change: (change) => controlPlane.changePersonCalendar(session.accessToken, session.workspaceId, change),
      // Days of their calendars read live from Google (`tools/calendarRead.js`).
      days: (request) => controlPlane.personCalendarDays(session.accessToken, session.workspaceId, request),
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // A Google Chat message the person said yes to (`tools/googleChat.js`), and their spaces, by name.
  Object.defineProperty(store, "googleChat", {
    value: {
      check: (message) => controlPlane.sendGoogleChat(session.accessToken, session.workspaceId, message, { check: true }),
      send: (message) => controlPlane.sendGoogleChat(session.accessToken, session.workspaceId, message),
      spaces: () => controlPlane.googleChatSpaces(session.accessToken, session.workspaceId),
      // What was written to them lately, for a check-in (`agent/checkInSources.js`).
      recent: (request) => controlPlane.googleChatRecent(session.accessToken, session.workspaceId, request),
      // One conversation the person named, read live (`tools/googleChatRead.js`).
      conversation: (request) => controlPlane.googleChatConversation(session.accessToken, session.workspaceId, request),
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // Setting a workspace up (`tools/workspaces.js`): created as this person,
  // laid out, connected or invited into in this context. The control plane clears each.
  Object.defineProperty(store, "workspaceSetup", {
    value: {
      create: (request) => controlPlane.createWorkspace(session.accessToken, session.workspaceId, request),
      layout: (request) => controlPlane.layoutWorkspace(session.accessToken, session.workspaceId, request),
      connectGoogle: (kind) => controlPlane.connectGoogle(session.accessToken, session.workspaceId, kind),
      invite: (invitations) => controlPlane.inviteToWorkspace(session.accessToken, session.workspaceId, invitations),
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // Connected apps (`tools/connectors.js`): a link to connect one, and one call
  // through it. The control plane clears each and holds the app's token.
  Object.defineProperty(store, "connectors", {
    value: {
      request: (provider) => controlPlane.connectRequest(session.accessToken, session.workspaceId, provider),
      call: (request) => controlPlane.connectCall(session.accessToken, session.workspaceId, request),
      apps: () => controlPlane.connectApps(session.accessToken, session.workspaceId),
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // A website's status, check or publish (`write_note` `site`), for this context.
  Object.defineProperty(store, "site", {
    value: (request) => controlPlane.site(session.accessToken, session.workspaceId, request),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // The browser that photographs a published page (`infra/site-shots`), when
  // this deployment binds one. It is only ever handed the address the control
  // plane built for this context, after it cleared the caller.
  if (typeof env?.SITE_SHOTS?.fetch === "function") {
    Object.defineProperty(store, "shootSite", {
      value: async (request) => {
        const response = await env.SITE_SHOTS.fetch("https://site-shots/shoot", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body || !Array.isArray(body.shots)) {
          return { error: typeof body?.error === "string" ? body.error : `the browser answered ${response.status}` };
        }
        return body;
      },
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }
  // `report_problem`: filed as this connection's person, resolved from its own
  // token by the control plane. Not tied to a workspace, so the same call on
  // every store a request touches. `texts` only from `tools/reportGate.js`.
  Object.defineProperty(store, "reportProblem", {
    value: (message, texts) => controlPlane.reportProblem(session.accessToken, message, texts),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // `pair_device`: this connection's session approves the code its own computer's runner shows. The control plane
  // approves it as this token's person, into this workspace, and always as a mail-only device tied to this grant.
  Object.defineProperty(store, "pairDevice", {
    value: (code) => controlPlane.texMachinePairApproveFromGrant(session.accessToken, session.workspaceId, code),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // `dream_now`: Tex's dream for this context, now. The control plane clears
  // the owner of their personal workspace off this token and decides.
  Object.defineProperty(store, "dreamNow", {
    value: () => controlPlane.dreamNow(session.accessToken, session.workspaceId),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // `notify_me`: a ping for this connection's person. The control plane
  // clears the owner of their personal workspace off this token and decides.
  Object.defineProperty(store, "requestAttention", {
    value: (urgency, deliver) => controlPlane.requestAttention(session.accessToken, session.workspaceId, urgency, deliver),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // Whether this person's own mailboxes are working (`agent/mailHealth.js`):
  // the owner of their personal workspace only, decided by the control plane.
  Object.defineProperty(store, "mailHealth", {
    value: {
      read: () => controlPlane.readMailHealth(session.accessToken, session.workspaceId),
      raise: (mailboxes) => controlPlane.raiseMailNotices(session.accessToken, session.workspaceId, mailboxes),
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // The tree, for the agent tools that list (`tree/served.js`): the workspace's
  // object where its notes live there (`store/objectManifest.js`), else the
  // control plane, which picks the workspace and clearance off this token's grant.
  const readControlManifest = (page, options) => controlPlane.readTreeManifest(session.accessToken, session.workspaceId, page, options);
  Object.defineProperty(store, "treeManifest", {
    value: store.objectReading ? objectFirstManifest(readControlManifest, store.objectReading) : readControlManifest,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // The name guards' one-level question (`tree/twins.js`), where the notes live in the workspace's object.
  const treeChildren = store.objectReading ? objectFirstChildren(store.objectReading) : null;
  if (treeChildren !== null) {
    Object.defineProperty(store, "treeChildren", { value: treeChildren, enumerable: false, writable: false, configurable: true });
  }
  // Its facts: a move's link candidates and the chaos score's extras (`tree/facts.js`). Where the notes live in the
  // workspace's object, their links and props are asked there first (`store/objectLookup.js` `objectFirstFacts`).
  Object.defineProperty(store, "treeFacts", {
    value: async (request) => {
      // A writer's names ask goes to the object first too (`objectFirstNames`); the note cap's count stays the control plane's.
      const fromObject =
        request?.ask === "names"
          ? typeof store.objectNames === "function"
            ? await store.objectNames(request)
            : null
          : typeof store.objectFacts === "function"
            ? await store.objectFacts(request)
            : null;
      return fromObject ?? (await controlPlane.readTreeFacts(session.accessToken, session.workspaceId, request));
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // A chat home's door: a routine written there is reported, and only one inside the home (`agent/chatHomeSeal.js`).
  attachHomeRoutineReports(store, session, controlPlane);
}

/* ----------------------------- auth & scoping ----------------------------- */

/**
 * Match the two discovery documents, with or without a resource path suffix.
 *
 * RFC 9728 §3 inserts the well-known segment between the host and the resource
 * path, so a resource at `/@seyi/mcp` publishes metadata at
 * `/.well-known/oauth-protected-resource/@seyi/mcp`. Clients probe the
 * path-suffixed form first and the bare form second, so both are served — and
 * the suffix is read for a slug rather than ignored.
 */
export function matchWellKnown(path) {
  const protectedResource = path.match(/^\/\.well-known\/oauth-protected-resource(\/.*)?$/);
  if (protectedResource) {
    // The suffix is the resource *path*, so it ends in "/mcp" — which is itself
    // a valid-looking slug. Trimming that first is what stops
    // `/.well-known/oauth-protected-resource/mcp` — the exact URL this worker's
    // own 401 challenge points at — from being read as a workspace called "mcp"
    // and answering with metadata for a resource nobody asked about.
    const suffix = (protectedResource[1] || "").replace(/\/mcp\/?$/, "");
    const named = suffix.match(/^\/@?([a-z0-9-]{2,32})$/);
    return { kind: "protected-resource", slug: named ? named[1] : null };
  }
  if (/^\/\.well-known\/oauth-authorization-server(\/.*)?$/.test(path)) {
    return { kind: "authorization-server", slug: null };
  }
  return null;
}
