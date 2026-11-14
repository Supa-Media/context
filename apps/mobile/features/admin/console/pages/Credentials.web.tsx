/**
 * Credentials: the artifact's `P.credentials`, `P.credentials.props` (the side panel that sets, replaces or adds one) and
 * the sign-in texts panel (`cr-sms`). A secret is written here and never read back: the value is read from the password
 * input only inside `savesecret`, passed to `admin.setSecret`, and the input is cleared. It is never rendered, logged or
 * toasted; a failure toasts the server's message, never the arguments.
 */
import { useMemo } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@context/convex/_generated/api";
import { KNOWN_SECRETS, relativeTime, unsetKnownSecrets } from "../../report";
import { confirmBox, esc, ic, panel } from "../kit";
import { S, go, render, toast } from "../state";
import type { ConsolePage } from "../types";

type Secrets = FunctionReturnType<typeof api.functions.admin.listSecrets>;
type SignIn = FunctionReturnType<typeof api.functions.admin.signInTexts>;

/** The server's message for a failed call, or a flat sentence. Never `String(error)`: that can carry the arguments. */
function errText(error: unknown, fallback = "That did not work. Check the name and try again.") {
  const data = (error as { data?: unknown })?.data;
  if (data !== null && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}

/** A field inside the page (`#pgin`) or the side panel (`#props`), by its id. */
const field = (scope: string, id: string) => document.querySelector<HTMLInputElement>(`${scope} #${id}`);

function useCredentialsData() {
  const secrets = useQuery(api.functions.admin.listSecrets, {});
  const signIn = useQuery(api.functions.admin.signInTexts, {});
  const setSecret = useAction(api.functions.admin.setSecret);
  const deleteSecret = useMutation(api.functions.admin.deleteSecret);
  const setSenderId = useMutation(api.functions.admin.setSignInTextsSender);
  // Stable between renders: the shell calls `onData` whenever this object changes, so a fresh one each time would loop.
  return useMemo(() => ({ secrets, signIn, setSecret, deleteSecret, setSenderId }), [secrets, signIn, setSecret, deleteSecret, setSenderId]);
}
type CredentialsData = ReturnType<typeof useCredentialsData>;

const LOADING = '<div class="empty">Loading…</div>';

/** The Replace/Delete confirm's sentence: what stops working without the secret (the known name's words). */
const unsetMeans = (name: string) => KNOWN_SECRETS.find((known) => known.name === name)?.unsetMeans ?? "What uses it stops.";

function notSetPanel(secrets: Secrets | undefined) {
  if (!secrets) return panel("cr-unset", "Not set", "", LOADING);
  const missing = unsetKnownSecrets(secrets);
  return panel(
    "cr-unset",
    "Not set",
    `${missing.length} the code expects`,
    missing.length
      ? missing
          .map(
            (s) =>
              `<div class="row" style="padding:8px 0"><div style="flex:1;min-width:0"><div class="mono">${esc(s.name)}</div><div class="sub">${esc(s.description)}</div><div style="color:var(--warn);font-size:12.5px">${esc(s.unsetMeans)}</div></div><button class="primary" data-act="sel" data-id="${esc(`set-${s.name}`)}">Set</button></div>`,
          )
          .join("")
      : '<div class="sub">Everything the code expects is set.</div>',
  );
}

function setPanel(secrets: Secrets | undefined) {
  if (!secrets) return panel("cr-set", "Set", "", LOADING);
  const rows = secrets
    .map((s) => {
      const name = esc(s.name);
      const confirming = S.confirm === "del" + s.name;
      return `<tr><td class="wrap"><div class="mono">${name}</div><div class="sub">${esc(s.description ?? "")}</div></td><td class="mono hp">${esc(s.fingerprint)}</td><td class="hp">${esc(relativeTime(s.updatedAt))}${s.updatedByEmail ? ` <span class="sub">by ${esc(s.updatedByEmail)}</span>` : ""}</td><td class="r acts">${
        confirming
          ? confirmBox(esc(unsetMeans(s.name)), "Delete", "delsecret", s.name, true)
          : `<button class="ghost" data-act="sel" data-id="${esc(`set-${s.name}`)}">Replace</button> <button class="ghost danger" data-act="askdel" data-id="${name}">Delete</button>`
      }</td></tr>`;
    })
    .join("");
  return panel(
    "cr-set",
    "Set",
    `${secrets.length}`,
    `<div class="tbl"><table><tr><th>Name</th><th class="hp">Fingerprint</th><th class="hp">Set</th><th></th></tr>${rows}</table></div>`,
    `<button class="ghost" data-act="sel" data-id="set-new">Add</button>`,
  );
}

function signInPanel(signIn: SignIn | undefined) {
  if (!signIn) return panel("cr-sms", "Sign-in texts", "", LOADING);
  if (signIn.fromDeployment)
    return panel(
      "cr-sms",
      "Sign-in texts",
      "",
      `<div class="sub">The deployment sets the Messaging Service itself, so that one is used.</div>`,
    );
  const stored = signIn.messagingServiceSid ?? "";
  const lead = signIn.saysContext
    ? "Codes read “123456 is your Context code.” and go out from this Twilio service."
    : "Codes come through Twilio Verify, which signs them with Togather’s name.";
  return panel(
    "cr-sms",
    "Sign-in texts",
    "",
    `<div class="sub" style="margin-bottom:8px">${lead}</div><div class="row"><input class="search mono" id="mg" value="${esc(stored)}" placeholder="MG…" style="max-width:280px" aria-label="Twilio Messaging Service ID"><button class="ghost" data-act="smssave">Save</button>${
      stored ? (S.confirm === "sms" ? confirmBox("Codes fall back to Twilio Verify.", "Clear", "smsclear", "", true) : '<button class="ghost" data-act="asksms">Clear</button>') : ""
    }</div>`,
  );
}

export const credentialsPage: ConsolePage<CredentialsData> = {
  key: "credentials",
  filters: {},
  windowed: false,
  useData: useCredentialsData,
  render: (d) => notSetPanel(d?.secrets) + setPanel(d?.secrets) + signInPanel(d?.signIn),

  props: (d, x) => {
    if (!x.startsWith("set-")) return null;
    const name = x.slice(4);
    const isNew = name === "new";
    const row = d?.secrets?.find((s) => s.name === name);
    const known = KNOWN_SECRETS.find((s) => s.name === name);
    const title = isNew ? "Add a credential" : (row ? "Replace " : "Set ") + `<span class="mono" style="font-size:14px">${esc(name)}</span>`;
    // The value field is never filled from anywhere: it starts empty and is only read by `savesecret`.
    return `<div class="pph"><h3 tabindex="-1">${title}</h3><button class="ib sm" data-act="close" aria-label="Close">${ic("x")}</button></div>
 ${isNew ? `<label class="field">Name<input id="sn" class="mono" placeholder="SEARCH_D1_API_TOKEN"></label>` : ""}
 <label class="field">Value<input id="sv" type="password" autocomplete="off" placeholder="Pasted once, never shown again"></label>
 <label class="field">What it's for<input id="sd" value="${esc(row?.description ?? known?.description ?? "")}"></label>
 <div class="row"><button class="primary" data-act="savesecret" data-id="${esc(name)}">Save</button><span class="sub">Encrypted at rest; only its fingerprint is shown.</span></div>`;
  },

  acts: {
    askdel(el) {
      S.confirm = "del" + el.dataset.id;
      render();
    },

    async delsecret(el, d) {
      if (!d) return;
      const name = el.dataset.id!;
      try {
        await d.deleteSecret({ name });
        S.confirm = null;
        toast(`${name} deleted`);
      } catch (error) {
        S.confirm = null;
        toast(errText(error));
      }
      render();
    },

    async savesecret(el, d) {
      if (!d) return;
      let name = el.dataset.id!;
      if (name === "new") {
        name = (field("#props", "sn")?.value ?? "").trim().toUpperCase();
        if (!/^[A-Z][A-Z0-9_]+$/.test(name)) return toast("Name it in capitals, like SEARCH_D1_API_TOKEN");
      }
      const input = field("#props", "sv");
      const value = input?.value ?? "";
      if (!value) return toast("Paste the value first");
      const description = field("#props", "sd")?.value ?? "";
      // Cleared as soon as it is read: the value is held only for the one call below, never in the page.
      if (input) input.value = "";
      try {
        const saved = await d.setSecret({ name, value, description: description.length > 0 ? description : undefined });
        toast(`${saved.name} set, fingerprint ${saved.fingerprint}`);
        go("credentials", [], null, { replace: true });
      } catch (error) {
        toast(errText(error));
        render();
      }
    },

    async smssave(_el, d) {
      if (!d) return;
      const v = (field("#pgin", "mg")?.value ?? "").trim();
      if (v && !/^MG/.test(v)) return toast("A Messaging Service ID starts with MG");
      try {
        await d.setSenderId({ messagingServiceSid: v });
        toast("Saved");
      } catch (error) {
        toast(errText(error, "That did not save. Try again."));
      }
      render();
    },

    asksms() {
      S.confirm = "sms";
      render();
    },

    async smsclear(_el, d) {
      if (!d) return;
      try {
        await d.setSenderId({ messagingServiceSid: "" });
        S.confirm = null;
        toast("Cleared; codes go through Twilio Verify");
      } catch (error) {
        S.confirm = null;
        toast(errText(error, "That did not save. Try again."));
      }
      render();
    },
  },
};
