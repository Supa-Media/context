/**
 * Approving this machine inside the app's own window, and the one navigation
 * that buys.
 *
 * The flow itself is `test/connect.test.mjs`'s and stays there: dynamic client
 * registration, PKCE, the single-use `state`, the loopback listener, the
 * exchange. What is checked here is the part that is new, and it is a
 * *navigation guard* rather than an OAuth step — so it is checked the way every
 * other guard in this app is, as a pure function with no Electron in the room:
 *
 *  - the console window may reach `http://127.0.0.1:<port>/…` **only** while a
 *    connect is in flight, and only the port and path the flow's own listener
 *    registered;
 *  - a foreign origin is refused exactly as it was before this existed;
 *  - the window comes back to the console when the approval ends, however it
 *    ended.
 *
 * The last block runs the **whole** `connectMachine` flow with an opener that
 * behaves like the console window: it applies `mayNavigateConsoleWindow` before
 * following the redirect the approve screen would follow, so what is asserted
 * is the two guards composed — the navigation rule and the state check — rather
 * than either one on its own.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole `apps/desktop` suite, measured rather than remembered.
 *
 *   `isApprovalCallback` comparing origin only, not the path              1
 *   ...comparing host only, so any port on this machine is a target       2
 *   `createApprovalRoute().end()` not clearing the callback               1
 *   the allowance open from construction rather than from `begin()`       1
 *   `approvalTargetFor` accepting a non-loopback `redirect_uri`           1
 *   `approvalTargetFor` accepting an `http` authorize URL off loopback    1
 *   `mayNavigateConsoleWindow` dropping `isAllowedConsoleNavigation`      1
 *   `returnAfterApproval` trusting the URL the window was on              2
 *   `windows.ts` back to the two-argument origin guard                    1
 *   `stateMatches` swapped for `true`                                     5
 *
 * The small numbers are the point rather than a weakness: each row is a
 * different arm of the same guard, and several assertions are written as one
 * `&&` line because a person reading a failure wants the sentence, not five of
 * them. The row that would be alarming is a zero, and there is not one — the
 * last row is five because the whole flow, including the window opener here,
 * runs through the state check that `connect.test.mjs` already guards.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  approvalTargetFor,
  createApprovalRoute,
  isApprovalCallback,
  mayNavigateConsoleWindow,
  returnAfterApproval,
} from "../src/core/shell/approval.ts";
import { MIRROR_ORIGIN } from "../src/core/shell/mirror.ts";
import { connectMachine, DESKTOP_SCOPE } from "../src/main/connect.ts";

const LIVE = "https://context.lc";
const CONSOLE = `${LIVE}/console`;
const GATEWAY = "https://gateway.example.test";
const ENDPOINT = `${GATEWAY}/mcp`;

const authorizeHref = ({
  redirect = "http://127.0.0.1:53411/context-hook/callback",
  base = `${GATEWAY}/oauth/authorize`,
} = {}) => `${base}?response_type=code&client_id=c1&redirect_uri=${encodeURIComponent(redirect)}`;

export async function runApprovalChecks(check) {
  // --- what the window may be sent to --------------------------------------

  const target = approvalTargetFor(authorizeHref());
  check(
    "the authorize URL is read for the loopback address the flow itself registered",
    target !== null && target.callback === "http://127.0.0.1:53411/context-hook/callback",
  );
  check(
    "...and the authorize URL is carried through whole, query and all — this shell edits nothing",
    target?.authorize.startsWith(`${GATEWAY}/oauth/authorize?`) === true &&
      new URL(target.authorize).searchParams.get("redirect_uri") === target.callback &&
      new URL(target.authorize).searchParams.get("response_type") === "code",
  );

  check(
    "AN AUTHORIZE URL OVER PLAIN HTTP IS NOT SOMEWHERE THIS WINDOW GOES",
    approvalTargetFor(authorizeHref({ base: "http://gateway.example.test/oauth/authorize" })) === null,
  );
  check(
    "...but a loopback gateway is, because that is how a self-hoster runs one",
    approvalTargetFor(authorizeHref({ base: "http://127.0.0.1:8787/oauth/authorize" })) !== null,
  );
  check(
    "A REDIRECT THAT IS NOT LOOPBACK IS REFUSED — the code must come back to this process",
    approvalTargetFor(authorizeHref({ redirect: "https://attacker.invalid/callback" })) === null,
  );
  check(
    "...and neither is `localhost`, which is a name somebody else's DNS can answer",
    approvalTargetFor(authorizeHref({ redirect: "http://localhost:53411/context-hook/callback" })) ===
      null,
  );
  check(
    "...nor a loopback redirect with no port, which would mean port 80",
    approvalTargetFor(authorizeHref({ redirect: "http://127.0.0.1/context-hook/callback" })) === null,
  );
  check(
    "...nor one carrying its own query or fragment, which the later match does not compare",
    approvalTargetFor(authorizeHref({ redirect: "http://127.0.0.1:53411/cb?x=1" })) === null &&
      approvalTargetFor(authorizeHref({ redirect: "http://127.0.0.1:53411/cb#f" })) === null,
  );
  check(
    "an authorize URL with no redirect_uri at all is not one of ours",
    approvalTargetFor(`${GATEWAY}/oauth/authorize?response_type=code`) === null,
  );
  check("an unparseable authorize URL is refused rather than assumed", approvalTargetFor("not a url") === null);

  // --- the allowance is open only while a connect is in flight -------------

  const route = createApprovalRoute();
  const callback = "http://127.0.0.1:53411/context-hook/callback";

  check(
    "THERE IS NO LOOPBACK ALLOWANCE UNTIL A CONNECT OPENS ONE",
    route.callback() === null && mayNavigateConsoleWindow(callback, LIVE, route.callback()) === false,
  );

  const opened = route.begin({ authorize: `${GATEWAY}/oauth/authorize?x=1`, callback }, CONSOLE);
  check("beginning one answers the URL the window should load", opened === `${GATEWAY}/oauth/authorize?x=1`);
  check(
    "the approve screen may hand the window back to this machine's own listener",
    mayNavigateConsoleWindow(`${callback}?code=abc&state=xyz`, LIVE, route.callback()) === true,
  );
  check(
    "ANOTHER PORT ON THIS MACHINE IS NOT THIS FLOW'S LISTENER",
    mayNavigateConsoleWindow("http://127.0.0.1:9999/context-hook/callback", LIVE, route.callback()) ===
      false,
  );
  check(
    "...nor is another path on the right port",
    mayNavigateConsoleWindow("http://127.0.0.1:53411/admin", LIVE, route.callback()) === false,
  );
  check(
    "...nor a host that merely reads like loopback",
    mayNavigateConsoleWindow(
      "http://127.0.0.1.attacker.invalid:53411/context-hook/callback",
      LIVE,
      route.callback(),
    ) === false,
  );
  check(
    "...nor the same path over https somewhere else",
    mayNavigateConsoleWindow("https://127.0.0.1:53411/context-hook/callback", LIVE, route.callback()) ===
      false,
  );
  check(
    "A FOREIGN ORIGIN IS STILL REFUSED WITH A CONNECT IN FLIGHT",
    mayNavigateConsoleWindow("https://attacker.invalid/console", LIVE, route.callback()) === false &&
      mayNavigateConsoleWindow("file:///etc/passwd", LIVE, route.callback()) === false &&
      mayNavigateConsoleWindow("not a url", LIVE, route.callback()) === false,
  );
  check(
    "...and the console and its offline mirror are allowed exactly as before",
    mayNavigateConsoleWindow(`${LIVE}/console/settings`, LIVE, route.callback()) === true &&
      mayNavigateConsoleWindow(`${MIRROR_ORIGIN}/console`, LIVE, route.callback()) === true,
  );

  const back = route.end();
  check("ending the approval says where the window belongs", back === CONSOLE);
  check(
    "THE ALLOWANCE CLOSES WITH THE CONNECT — a page cannot walk to a socket afterwards",
    route.callback() === null &&
      mayNavigateConsoleWindow(`${callback}?code=abc`, LIVE, route.callback()) === false,
  );
  check(
    "...and ending twice moves no window, so a stray call cannot navigate one",
    route.end() === null,
  );

  check(
    "the callback is refused outright when nothing is in flight, whatever it looks like",
    isApprovalCallback(`${callback}?code=abc`, null) === false,
  );

  // --- where the window goes afterwards ------------------------------------

  check(
    "the window returns to the console page the person pressed Connect on",
    returnAfterApproval(`${LIVE}/console/settings`, CONSOLE, LIVE) === `${LIVE}/console/settings`,
  );
  check(
    "THE WINDOW IS NEVER LEFT ON THE LOOPBACK LISTENER'S PAGE — its server has closed",
    returnAfterApproval(`${callback}?code=abc`, CONSOLE, LIVE) === CONSOLE,
  );
  check(
    "...nor returned to an origin it should not have been on in the first place",
    returnAfterApproval("https://attacker.invalid/", CONSOLE, LIVE) === CONSOLE &&
      returnAfterApproval("about:blank", CONSOLE, LIVE) === CONSOLE &&
      returnAfterApproval("", CONSOLE, LIVE) === CONSOLE,
  );
  check(
    "...and an offline window goes back to the mirrored console it was reading",
    returnAfterApproval(`${MIRROR_ORIGIN}/console`, CONSOLE, LIVE) === `${MIRROR_ORIGIN}/console`,
  );

  // --- the wiring that cannot be imported here ------------------------------

  const windows = readFileSync(
    fileURLToPath(new URL("../src/main/windows.ts", import.meta.url)),
    "utf8",
  );
  check(
    "`will-navigate` asks the composed rule, so the loopback allowance cannot become a second guard",
    /will-navigate[\s\S]{0,1600}mayNavigateConsoleWindow\(target, origin, callback\)/.test(windows),
  );
  check(
    "...and the callback reaches it as a getter read per navigation, never a captured value",
    /approvalCallback\?: \(\) => string \| null/.test(windows) &&
      /options\.approvalCallback\?\.\(\)/.test(windows),
  );

  const index = readFileSync(
    fileURLToPath(new URL("../src/main/index.ts", import.meta.url)),
    "utf8",
  );
  check(
    "the console window is created with the allowance wired to it",
    /createConsoleWindow\(url, RENDERER_DIR, \{\s*approvalCallback: \(\) => approval\.callback\(\),/.test(
      index,
    ),
  );
  check(
    "THE WINDOW IS BACK ON THE CONSOLE BEFORE ANYTHING ELSE IS ASKED OF THE PERSON",
    /endApproval\(\);\s*await askAboutTranscription\(\);/.test(index),
  );
  check(
    "THE APPROVAL IS ENDED IN `finally`, so a refused or failed connect closes it too",
    /finally \{[\s\S]{0,240}endApproval\(\);[\s\S]{0,120}connecting = false;/.test(index),
  );
  check(
    "...and the connect hands the authorize URL to the window before the system browser",
    /openBrowser: async \(href\) => \{\s*if \(await approveInConsoleWindow\(href\)\) return;\s*await openInSystemBrowser\(href\);/.test(
      index,
    ),
  );

  // --- the flow, with the window's guard in the middle of it ----------------

  const server = authorizationServer();
  const window = consoleWindowOpener();
  const record = await connectMachine({
    endpoint: ENDPOINT,
    fetchImpl: server.fetchImpl,
    openBrowser: window.open,
  });
  check(
    "APPROVING IN THE WINDOW YIELDS THE SAME GRANT THE BROWSER DID",
    record.accessToken === "fake-access-token-not-a-real-one" && record.scope === DESKTOP_SCOPE,
  );
  check(
    "...having navigated the window to the authorization server's own approve page",
    window.seen.navigated?.startsWith(`${GATEWAY}/oauth/authorize?`) === true,
  );
  check(
    "...and the window followed the callback only because the guard allowed that one address",
    window.seen.allowed === true && window.seen.callbackStatus === 200,
  );

  const attacked = authorizationServer();
  const foreign = consoleWindowOpener({ state: "a-state-this-machine-never-minted" });
  const refusedState = await connectMachine({
    endpoint: ENDPOINT,
    fetchImpl: attacked.fetchImpl,
    openBrowser: foreign.open,
  }).then(
    () => null,
    (error) => error,
  );
  check(
    "A CALLBACK WITH A STATE THIS MACHINE NEVER MINTED IS STILL REFUSED IN THE WINDOW",
    refusedState !== null && /nothing was saved/.test(refusedState.message),
  );
  check(
    "...and no code was exchanged for it",
    attacked.calls.filter((call) => call.url.endsWith("/oauth/token")).length === 0,
  );

  const replayed = await fetch(`${window.seen.callback}?code=replayed&state=replayed`).then(
    () => "answered",
    () => "refused",
  );
  check(
    "THE LOOPBACK LISTENER IS GONE ONCE THE GRANT IS IN, so a replayed callback lands nowhere",
    replayed === "refused",
  );
}

/**
 * The console window, as this app now uses it: something that navigates, and
 * refuses to navigate anywhere the guard has not allowed.
 *
 * The whole point of driving the flow through it is that the redirect the
 * approve screen performs is a *navigation of this window*, so a test that
 * fetched the callback directly would prove the OAuth and none of the shell.
 */
function consoleWindowOpener({ state: override, code = "an-authorization-code" } = {}) {
  const route = createApprovalRoute();
  const seen = {};
  return {
    seen,
    open: async (href) => {
      const target = approvalTargetFor(href);
      if (target === null) throw new Error("this window would not have been navigated there");
      seen.navigated = route.begin(target, CONSOLE);
      seen.callback = target.callback;

      // What the approve screen does at the end: `window.location.assign(...)`,
      // which reaches the shell as a `will-navigate` and is decided by the
      // guard before anything is fetched.
      const redirect = new URL(target.callback);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", override ?? new URL(href).searchParams.get("state"));
      seen.allowed = mayNavigateConsoleWindow(redirect.href, LIVE, route.callback());
      if (!seen.allowed) throw new Error("the window refused to navigate to the callback");

      const answer = await fetch(redirect.href);
      seen.callbackStatus = answer.status;
      await answer.text();
      // And back to the console, which is what `endApproval` does for real.
      seen.returnedTo = route.end();
    },
  };
}

/** A conformant authorization server. The same shape `connect.test.mjs` uses. */
function authorizationServer() {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init });
    if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
      return json({ resource: ENDPOINT, authorization_servers: [GATEWAY] });
    }
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return json({
        issuer: GATEWAY,
        authorization_endpoint: `${GATEWAY}/oauth/authorize`,
        token_endpoint: `${GATEWAY}/oauth/token`,
        registration_endpoint: `${GATEWAY}/oauth/register`,
      });
    }
    if (url === `${GATEWAY}/oauth/register`) return json({ client_id: "client-for-this-machine" });
    if (url === `${GATEWAY}/oauth/token`) {
      return json({
        access_token: "fake-access-token-not-a-real-one",
        refresh_token: "fake-refresh-token-not-a-real-one",
        expires_in: 3600,
        scope: DESKTOP_SCOPE,
      });
    }
    return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
  };
  return { fetchImpl, calls };
}

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
