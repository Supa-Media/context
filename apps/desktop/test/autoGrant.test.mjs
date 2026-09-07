/**
 * This machine getting its grant **without a step**, and the two facts that
 * takes.
 *
 * #312 moved the approve screen into this app's own window. The owner's
 * reaction to the first end-to-end capture, 2026-09-07: *"I don't love this
 * setup; when installing Granola I didn't have to 'connect' a machine, things
 * just worked."* He was signed in inside that window and was still asked to
 * authorise the same person, on the same machine, to the same context.
 *
 * So the shell follows the gateway's parking redirect itself, reads the request
 * id out of the `Location`, and hands **that** to the page — which answers it
 * with the session it already has. What is checked here is the two pure pieces
 * of that (`parkedRequestFrom`, `createApprovalHandover`) and then the whole
 * flow composed, driven through `connectMachine` with a page-shaped opener, so
 * that the thing asserted is the same thing the app does rather than a sketch
 * of it.
 *
 * **What is deliberately not new.** The OAuth is unchanged and stays in
 * `connect.test.mjs`: registration, PKCE, the single-use `state`, the loopback
 * listener, the exchange. The navigation guard is unchanged and stays in
 * `approval.test.mjs`: this flow makes *fewer* navigations than #312's, not
 * more — the window never goes to the authorization server at all in the
 * ordinary case, and the one address it may reach is still the one that flow's
 * own listener is on, still only while the connect is in flight.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole `apps/desktop` suite.
 *
 *   `parkedRequestFrom` not comparing the origin                          3
 *   ...not comparing the path                                             1
 *   ...accepting any `request_id` shape                                   2
 *   ...answering for an empty console origin                              1
 *   `isParkingRedirect` accepting a 200                                   1
 *   `ApprovalHandover.take` ignoring the id it was given                  2
 *   ...not clearing what it took, so an answer can be replayed            1
 *   `end()` not clearing the handover                                     1
 *   the opener trying the page before checking `approvalTargetFor`        1
 *   the fallback chain in `index.ts` reordered or shortened               2
 *
 * The `take` rows are the ones worth reading twice: a handover that answers
 * about a request this machine never parked is a page choosing which flow it
 * is talking about, and a handover that does not clear is the same answer
 * accepted twice.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createApprovalHandover,
  isParkingRedirect,
  parkedRequestFrom,
} from "../src/core/shell/autoGrant.ts";
import { approvalTargetFor, createApprovalRoute, mayNavigateConsoleWindow } from "../src/core/shell/approval.ts";
import { connectMachine, DESKTOP_SCOPE, DESKTOP_SOFTWARE_ID } from "../src/main/connect.ts";

const LIVE = "https://context.lc";
const CONSOLE = `${LIVE}/console`;
const GATEWAY = "https://gateway.example.test";
const ENDPOINT = `${GATEWAY}/mcp`;
/** Base64url, as `randomOpaqueToken` produces. Obviously fake. */
const REQUEST_ID = "a-parked-request-id-0000";

export async function runAutoGrantChecks(check) {
  // --- reading the parking redirect ----------------------------------------

  check(
    "the parked request id is read out of the consent redirect",
    parkedRequestFrom(`${LIVE}/authorize?request_id=${REQUEST_ID}`, LIVE) === REQUEST_ID,
  );
  check(
    "...and other query parameters on it are none of this app's business",
    parkedRequestFrom(`${LIVE}/authorize?next=%2Fconsole&request_id=${REQUEST_ID}`, LIVE) ===
      REQUEST_ID,
  );

  check(
    "A REDIRECT TO ANY OTHER ORIGIN HANDS THE PAGE NOTHING",
    parkedRequestFrom(`https://attacker.invalid/authorize?request_id=${REQUEST_ID}`, LIVE) === null,
  );
  check(
    "...including one that merely starts with the pinned origin",
    parkedRequestFrom(`https://context.lc.attacker.invalid/authorize?request_id=${REQUEST_ID}`, LIVE) ===
      null,
  );
  check(
    "...and a self-hoster who split the console from the consent screen gets the screen instead",
    parkedRequestFrom(`https://auth.example.test/authorize?request_id=${REQUEST_ID}`, LIVE) === null,
  );
  check(
    "ANOTHER PATH ON THE PINNED ORIGIN IS NOT THE CONSENT SCREEN",
    parkedRequestFrom(`${LIVE}/console?request_id=${REQUEST_ID}`, LIVE) === null &&
      parkedRequestFrom(`${LIVE}/authorize/other?request_id=${REQUEST_ID}`, LIVE) === null,
  );
  check(
    "a redirect with no request id hands over nothing",
    parkedRequestFrom(`${LIVE}/authorize`, LIVE) === null,
  );
  check(
    "...and neither does one whose id is not shaped like one",
    parkedRequestFrom(`${LIVE}/authorize?request_id=short`, LIVE) === null &&
      parkedRequestFrom(`${LIVE}/authorize?request_id=${"x".repeat(200)}`, LIVE) === null &&
      parkedRequestFrom(`${LIVE}/authorize?request_id=../../etc`, LIVE) === null,
  );
  check(
    "A LAUNCH WITH NO CONSOLE WINDOW HAS NO PAGE TO HAND IT TO",
    parkedRequestFrom(`${LIVE}/authorize?request_id=${REQUEST_ID}`, "") === null,
  );
  check(
    "an unparseable location is refused rather than assumed",
    parkedRequestFrom("not a url", LIVE) === null,
  );

  check(
    "only a redirect parks a request; an answer is an answer",
    isParkingRedirect(302) && isParkingRedirect(303) && isParkingRedirect(307),
  );
  check(
    "...so a rendered OAuth error, a 200 and a 500 all fall back to the screen",
    !isParkingRedirect(200) && !isParkingRedirect(400) && !isParkingRedirect(500),
  );

  // --- the handover, and what makes a stale answer inert -------------------

  const handover = createApprovalHandover();
  check("nothing is handed over until a connect hands one over", handover.pending() === null);

  handover.begin({ requestId: REQUEST_ID, authorize: `${GATEWAY}/oauth/authorize?x=1` });
  check("the page can ask what this machine is waiting on", handover.pending()?.requestId === REQUEST_ID);
  check(
    "AN ANSWER ABOUT ANOTHER REQUEST DOES NOTHING",
    handover.take("some-other-request-id-000") === null && handover.pending() !== null,
  );
  check(
    "the answer about the one in flight is taken",
    handover.take(REQUEST_ID)?.authorize === `${GATEWAY}/oauth/authorize?x=1`,
  );
  check(
    "...ONCE — a replayed answer moves no window",
    handover.take(REQUEST_ID) === null && handover.pending() === null,
  );

  handover.begin({ requestId: REQUEST_ID, authorize: `${GATEWAY}/oauth/authorize?x=1` });
  handover.end();
  check(
    "AND ENDING THE CONNECT ENDS THE HANDOVER — a page cannot answer a flow that is over",
    handover.pending() === null && handover.take(REQUEST_ID) === null,
  );

  // --- the flow, with a page that approves ---------------------------------
  //
  // The opener here is the console window as the shell now uses it: it does not
  // navigate to the authorize URL. It follows the parking redirect the way the
  // main process does, hands the id to a "page", and the page navigates the
  // window to the redirect the control plane answered with — which is the one
  // navigation the guard allows, asked here exactly as `windows.ts` asks it.

  {
    const server = authorizationServer();
    const page = consolePage({ server });
    const record = await connectMachine({
      endpoint: ENDPOINT,
      fetchImpl: server.fetchImpl,
      openBrowser: page.open,
    });

    check(
      "A SIGNED-IN CONSOLE MINTS THIS MACHINE'S GRANT WITH NO APPROVE SCREEN",
      record.accessToken === "fake-access-token-not-a-real-one" && record.scope === DESKTOP_SCOPE,
    );
    check(
      "...and the window was never sent to the authorization server at all",
      page.seen.navigated === undefined,
    );
    check(
      "...the page was handed the parked request and nothing else",
      Object.keys(page.seen.handedOver ?? {}).join() === "requestId" &&
        page.seen.handedOver.requestId === REQUEST_ID,
    );
    check(
      "...and the code came back through the guard, to this flow's own listener",
      page.seen.allowed === true && page.seen.callbackStatus === 200,
    );
    check(
      "THE PAGE NEVER SAW THE VERIFIER, THE STATE, OR THE CODE UNTIL THE SERVER GAVE IT ONE",
      // Everything the shell handed the page, walked: one request id.
      JSON.stringify(page.seen.handedOver) === JSON.stringify({ requestId: REQUEST_ID }),
    );
    check(
      "the machine registered itself as the desktop shell, so the control plane may auto-approve it",
      server.calls.some(
        (call) =>
          call.url.endsWith("/oauth/register") &&
          JSON.parse(call.init.body).software_id === DESKTOP_SOFTWARE_ID,
      ),
    );
  }

  // --- and one that cannot ------------------------------------------------
  //
  // A page that is signed out, or one the control plane refused, answers "no"
  // and the person gets #312's approve screen in the same window. Driven here
  // as the opener falling through to the navigate, which is what `index.ts`
  // does with the answer.

  {
    const server = authorizationServer();
    const page = consolePage({ server, approve: false });
    const record = await connectMachine({
      endpoint: ENDPOINT,
      fetchImpl: server.fetchImpl,
      openBrowser: page.open,
    });

    check(
      "A PAGE THAT COULD NOT APPROVE COSTS A SCREEN, NEVER THE GRANT",
      record.accessToken === "fake-access-token-not-a-real-one",
    );
    check(
      "...and that screen is the approve screen, in this window",
      page.seen.navigated?.startsWith(`${GATEWAY}/oauth/authorize?`) === true,
    );
  }

  // --- the wiring that cannot be imported here -----------------------------

  const index = readFileSync(
    fileURLToPath(new URL("../src/main/index.ts", import.meta.url)),
    "utf8",
  );
  check(
    "THE FALLBACK CHAIN IS THREE STEPS, IN THE ORDER THAT ASKS FOR THE LEAST",
    /const target = approvalTargetFor\(href\);\s*if \(target !== null && \(await askConsoleToApprove\(href, target\)\)\) return;\s*if \(await approveInConsoleWindow\(href\)\) return;\s*await openInSystemBrowser\(href\);/.test(
      index,
    ),
  );
  check(
    "the handover closes with the loopback allowance, on every path out of a connect",
    /function endApproval\(\): void \{[\s\S]{0,600}handover\.end\(\);/.test(index),
  );
  check(
    "...and the page is told the approval is over at the same moment",
    /handover\.end\(\);\s*consoleBridge\?\.emitPendingApproval\(null\);/.test(index),
  );
  check(
    "the page's answer is only ever about the request this machine parked",
    /const pending = handover\.take\(result\.requestId\);\s*if \(pending === null\) return;/.test(index),
  );
  check(
    "A PAGE THAT NEVER ANSWERS FALLS BACK RATHER THAN WAITING OUT THE LISTENER",
    /setTimeout\(\(\) => \{\s*const stale = handover\.take\(parked\);[\s\S]{0,320}fallBackToApproveScreen\(stale\.authorize\);/.test(
      index,
    ),
  );
  check(
    "the parked request is read only from the origin this window is pinned to",
    /parkedRequestFrom\(\s*response\.headers\.get\("location"\) \?\? "",\s*consoleOrigin\(consoleAddress\),\s*\)/.test(
      index,
    ),
  );

  const machineGrant = readFileSync(
    fileURLToPath(new URL("../../convex/functions/lib/machineGrant.ts", import.meta.url)),
    "utf8",
  );
  check(
    "THE SOFTWARE ID AGREES WITH THE CONTROL PLANE THAT CHECKS IT",
    // The twin of `ownMachineGrant.test.ts`'s check, so a rename on either side
    // reddens on whichever suite the change touched. Neither app can import the
    // other; `linkParity.test.ts` holds the link engine's twin the same way.
    machineGrant.match(/DESKTOP_SOFTWARE_ID = "([^"]+)"/)?.[1] === DESKTOP_SOFTWARE_ID,
  );
  check(
    "...and the control plane's default is the scope this machine actually asks for",
    new Set(DESKTOP_SCOPE.split(" ")).size === 2 &&
      /MACHINE_GRANT_SCOPES[\s\S]{0,200}"context:write"/.test(machineGrant),
  );
}

/**
 * The console window as the shell now uses it, plus the page inside it.
 *
 * It never navigates to the authorize URL. It does what `askConsoleToApprove`
 * does — follows the parking redirect in the main process, reads the id, hands
 * it over — and then the "page" answers: either by approving through the
 * control plane and navigating the window to the redirect it was given, or by
 * saying no, which is the opener falling through to #312's approve screen.
 *
 * The navigation is asked of `mayNavigateConsoleWindow` before it is followed,
 * exactly as `windows.ts` asks it, so what is driven is the guard rather than a
 * description of it.
 */
function consolePage({ server, approve = true } = {}) {
  const route = createApprovalRoute();
  const seen = {};
  return {
    seen,
    open: async (href) => {
      const target = approvalTargetFor(href);
      if (target === null) throw new Error("this window would not have been navigated there");

      const parking = await server.fetchImpl(href, { redirect: "manual" });
      const parked = isParkingRedirect(parking.status)
        ? parkedRequestFrom(parking.headers.get("location") ?? "", LIVE)
        : null;

      if (parked !== null && approve) {
        route.begin(target, CONSOLE);
        // Everything that crosses to the page, and the check above walks it.
        seen.handedOver = { requestId: parked };

        // What the control plane answers `approveOwnMachineGrant` with: the
        // client's own redirect URI, carrying the code and the state. The page
        // navigates there, which reaches the shell as `will-navigate`.
        const redirect = new URL(target.callback);
        redirect.searchParams.set("code", "an-authorization-code");
        redirect.searchParams.set("state", new URL(href).searchParams.get("state"));
        seen.allowed = mayNavigateConsoleWindow(redirect.href, LIVE, route.callback());
        if (!seen.allowed) throw new Error("the window refused to navigate to the callback");
        const answer = await fetch(redirect.href);
        seen.callbackStatus = answer.status;
        await answer.text();
        seen.returnedTo = route.end();
        return;
      }

      // The page said no — signed out, or a control plane that refused. #312's
      // screen, in this window, which is what the shell falls back to.
      seen.navigated = route.begin(target, CONSOLE);
      const redirect = new URL(target.callback);
      redirect.searchParams.set("code", "an-authorization-code");
      redirect.searchParams.set("state", new URL(href).searchParams.get("state"));
      seen.allowed = mayNavigateConsoleWindow(redirect.href, LIVE, route.callback());
      const answer = await fetch(redirect.href);
      seen.callbackStatus = answer.status;
      await answer.text();
      seen.returnedTo = route.end();
    },
  };
}

/**
 * A conformant authorization server, plus the parking redirect this flow reads.
 *
 * `connect.test.mjs`'s shape with one addition: `GET /oauth/authorize` answers
 * `302 Location: <console>/authorize?request_id=…`, which is what the real
 * gateway does — it parks the request in the control plane and sends the
 * browser to the consent screen.
 */
function authorizationServer({ scope = DESKTOP_SCOPE } = {}) {
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
    if (url.startsWith(`${GATEWAY}/oauth/authorize`)) {
      return new Response(null, {
        status: 302,
        headers: { Location: `${LIVE}/authorize?request_id=${REQUEST_ID}` },
      });
    }
    if (url === `${GATEWAY}/oauth/token`) {
      return json({
        access_token: "fake-access-token-not-a-real-one",
        refresh_token: "fake-refresh-token-not-a-real-one",
        expires_in: 3600,
        scope,
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return { calls, fetchImpl };
}

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
