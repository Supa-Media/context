import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useAction, useConvexAuth } from "convex/react";
import { api } from "@context/convex/_generated/api";
import {
  getDesktopBridge,
  type ConnectionView,
  type DesktopBridge,
  type PendingMachineApproval,
} from "@context/desktop-bridge";
import { Button } from "../../design/components/Button";
import { Card } from "../../design/components/Card";
import { Dot } from "../../design/components/Dot";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { useThemedStyles, type Colors } from "../../design/theme";
import { leaveTo } from "../../consent/leave";
import { describeMachine, machineTitle } from "../thisMachine";
import {
  decideMachineApproval,
  machineApprovalLine,
  type MachineApprovalInputs,
} from "../machineApproval";

/**
 * The machine the console is running on, in this context's settings.
 *
 * Drawn **only inside the desktop shell**, and the check for that is the one
 * the whole feature uses: a frozen `window.desktop` carrying a bridge version
 * this bundle understands. In a browser and on a phone this component returns
 * `null` and costs a render — which is why `SettingsPane` can mount it
 * unconditionally instead of asking the question a second time.
 *
 * ## What it is for
 *
 * The shell records with no window open and queues what it recorded. That
 * needs a credential, and the credential is **this machine's own**: one OAuth
 * client per machine, so revoking the laptop you lost does not sign out the one
 * on your desk. The console's Convex session is not that credential and cannot
 * stand in for it — `features/meetings/gateway.ts` says why at length — so a
 * person who is signed in here can still have a machine that cannot send.
 * Without this card, that state has no surface at all in the one runtime.
 *
 * ## What it does not show
 *
 * Any part of the credential. The bridge exposes `connect()`, `disconnect()`
 * and three words, and `getDesktopBridge` refuses a bridge that grew anything
 * credential-shaped. `connect()` returns nothing; the token is minted, stored
 * and spent in the main process, and never becomes a value this page can hold.
 *
 * **`connect()` used to navigate this window, and mostly no longer does.** The
 * owner's reaction to the first end-to-end capture, 2026-09-07: *"I don't love
 * this setup; when installing Granola I didn't have to 'connect' a machine,
 * things just worked."* So the shell hands this card the authorization request
 * it just parked, over the bridge, and the card answers it with the session
 * this page already holds — no approve screen, no browser, no second sign-in.
 * The approve screen is still what every refusal falls back to, and still what
 * a tray-only launch and every other OAuth client get.
 *
 * What crosses for that is **one request id**, in one direction, and a boolean
 * back. No token, no code, no verifier: the code goes to a loopback listener in
 * the shell's main process, which is where the PKCE verifier that redeems it
 * lives. `features/meetings/machineApproval.ts` is the decision,
 * `apps/desktop/src/core/shell/autoGrant.ts` is the other half, and
 * `docs/decisions/desktop.md` is the argument.
 */
export function ThisMachineCard() {
  const bridge = useDesktopBridge();
  if (bridge === null) return null;
  return <MachineCard bridge={bridge} />;
}

/**
 * The bridge, once.
 *
 * In state rather than read at render time: `getDesktopBridge()` walks an
 * object a page could in principle have changed between renders, and a
 * component whose identity flickers would tear down the subscription below
 * with it.
 */
function useDesktopBridge(): DesktopBridge | null {
  const [bridge] = useState(() => getDesktopBridge());
  return bridge;
}

function MachineCard({ bridge }: { bridge: DesktopBridge }) {
  const styles = useThemedStyles(makeStyles);
  const [connection, setConnection] = useState<ConnectionView | null>(null);
  const approval = useMachineApproval(bridge, connection);

  /*
    Asked once and then subscribed, and the unsubscribe is used.

    This is the reason `docs/decisions/desktop.md` put an unsubscribe on every
    subscription rather than copying the shell's old `onState`: a settings pane
    is mounted and unmounted every time somebody opens and closes it, and a
    handler that could not be detached would be a leak per visit and a stale
    closure setting state on an unmounted component.
  */
  useEffect(() => {
    let live = true;
    void bridge.connection
      .get()
      .then((view) => {
        if (live) setConnection(view);
      })
      .catch(() => {
        // A shell that will not answer is not a machine to draw claims about.
        // The card stays on its loading line rather than inventing a state.
      });
    const off = bridge.connection.onChange((view) => {
      if (live) setConnection(view);
    });
    return () => {
      live = false;
      off();
    };
  }, [bridge]);

  const title = machineTitle(bridge.shell);

  if (connection === null) {
    return (
      <Card>
        <Text variant="rowTitle">{title}</Text>
        <Text variant="rowSub" style={styles.sub} testID="this-machine-loading">
          Checking whether this machine is connected…
        </Text>
      </Card>
    );
  }

  const view = describeMachine(connection);

  return (
    <Card>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text variant="rowTitle" testID="this-machine-title">
            {title}
          </Text>
          <Text variant="rowSub" style={styles.sub} testID="this-machine-sentence">
            {view.sentence}
          </Text>
        </View>
        <Pill tone={view.tone} leading={<Dot tone={view.tone} />}>
          {view.pill}
        </Pill>
      </View>

      {approval === null ? null : (
        <Text variant="rowSub" style={styles.sub} testID="this-machine-approval">
          {approval}
        </Text>
      )}

      {view.notice === null ? null : (
        <Text variant="rowSub" style={styles.notice} testID="this-machine-notice">
          {view.notice}
        </Text>
      )}

      {view.action === null || view.actionLabel === null ? null : (
        <View style={styles.actions}>
          <Button
            label={view.actionLabel}
            variant={view.action === "connect" ? "white" : undefined}
            onPress={() =>
              view.action === "connect"
                ? bridge.connection.connect()
                : bridge.connection.disconnect()
            }
            testID={`this-machine-${view.action}`}
          />
        </View>
      )}
    </Card>
  );
}

/**
 * Answer the machine approval the shell is holding, with this page's session.
 *
 * Returns the one line the card shows about it, or `null` when there is nothing
 * of this hook's own to say — which is every ordinary moment.
 *
 * ## Every decision is `decideMachineApproval`'s
 *
 * What is here is the *plumbing*: subscribe, call, tell the shell. The rule for
 * when a page may mint a credential lives in a pure function, because
 * `features/console/capabilities.ts` records what happens otherwise: *every
 * guard expressed inside a component in this app was held by nothing.*
 *
 * ## The shell is always told what happened
 *
 * Both branches answer `resolveApproval`, and that is what makes a refusal
 * cost a screen rather than a five-minute wait: the shell falls back to the
 * approve screen the moment it hears `approved: false`. A page that failed to
 * answer at all is handled on the shell's side by a timeout, so this is the
 * fast path rather than the only one.
 */
function useMachineApproval(
  bridge: DesktopBridge,
  connection: ConnectionView | null,
): string | null {
  const auth = useConvexAuth();
  const mint = useAction(api.functions.authorizations.approveOwnMachineGrant);
  const [pending, setPending] = useState<PendingMachineApproval | null>(null);
  const [state, setState] = useState<"idle" | "minting" | "granted" | "refused">("idle");
  const [granted, setGranted] = useState<string | null>(null);
  /*
    In a ref rather than in state, and the two facts are different in kind: this
    is "which request has this page already spoken about", which must be true
    the moment it becomes true rather than at the next render. A re-render
    between deciding to mint and recording that we did is a second mint of the
    same request.
  */
  const answered = useRef<string | null>(null);
  const minting = useRef(false);

  useEffect(() => {
    const connection = bridge.connection;
    // A version-2 shell has no such member and never pushes one: it approves in
    // its own window, which is #312's flow and is not a degradation.
    if (connection.pendingApproval === undefined || connection.onPendingApproval === undefined) {
      return;
    }
    let live = true;
    void connection.pendingApproval().then(
      (value) => {
        if (live) setPending(value);
      },
      () => {
        // A shell that will not answer has nothing in flight as far as this
        // page is concerned, and the shell's own timeout owns the rest.
      },
    );
    const off = connection.onPendingApproval((value) => {
      if (live) setPending(value);
    });
    return () => {
      live = false;
      off();
    };
  }, [bridge]);

  const tell = useCallback(
    (requestId: string, approved: boolean) => {
      void bridge.connection.resolveApproval?.({ requestId, approved }).catch(() => {
        // The shell went away, or the channel is gone. Its own timeout is what
        // puts the approve screen up in that case.
      });
    },
    [bridge],
  );

  useEffect(() => {
    const inputs: MachineApprovalInputs = {
      pending,
      connection,
      auth,
      minting: minting.current,
      answered: answered.current,
    };
    const action = decideMachineApproval(inputs);
    if (action.kind === "idle") return;

    answered.current = action.requestId;
    if (action.kind === "declineSignedOut") {
      setState("refused");
      tell(action.requestId, false);
      return;
    }

    minting.current = true;
    setState("minting");
    void mint({ requestId: action.requestId })
      .then((result) => {
        setGranted(result.workspaceSlug);
        setState("granted");
        // Told before the navigation, so the shell knows the page is on its way
        // to the loopback redirect rather than silent.
        tell(action.requestId, true);
        /*
          The last step of the flow, through the one function this app leaves
          itself with. `leaveTo` narrows the target with `isSafeRedirect` — the
          general rule about navigation targets, not a consent detail — and the
          consent screen hands the same kind of URL to the same function.

          It is a navigation this window is allowed exactly one of: the client's
          own loopback redirect, carrying the code. `core/shell/approval.ts`
          bounds it to the address this connect's own listener is on and only
          while the connect is in flight, which is the same allowance the
          approve screen's redirect used. The code lands in the shell's main
          process; this page holds the URL for as long as it takes to leave it,
          exactly as the browser did.
        */
        leaveTo(result.redirectTo);
      })
      .catch(() => {
        /*
          Every refusal, one branch, and deliberately no sentence about which:
          they all end the same way for the person — the approve screen opens in
          this window a moment later and asks them properly. The control plane
          refuses a client that is not the shell, a scope that is not the
          default, a role that cannot grant the tier, a request that is spent,
          and a person who is over the rate limit; not one of those is a thing
          to read on a card.
        */
        setState("refused");
        tell(action.requestId, false);
      })
      .finally(() => {
        minting.current = false;
      });
  }, [pending, connection, auth, mint, tell]);

  if (state === "idle") return null;
  /*
    A grant this page minted names the context it was minted for, because that
    is a fact this page has and the shell has not: the machine's own record
    holds a gateway base URL and never a slug, and the control plane resolves
    which context a request grants. Naming it from anywhere else — the context
    the console happens to be *showing*, say — would be a sentence about the
    wrong thing on the one card whose whole job is saying where meetings go.
  */
  return machineApprovalLine(state, granted);
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  head: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  headText: { flex: 1, minWidth: 0 },
  sub: { marginTop: 4 },
  notice: { marginTop: 8, color: colors.crit },
  actions: { flexDirection: "row", justifyContent: "flex-end", marginTop: 12 },
});
