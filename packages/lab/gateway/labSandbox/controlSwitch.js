/**
 * The control plane a test chat's object asks (`chatRun.js` `chatEnvFor`), answered from what the Lab already read for
 * the chat. Split out of `chatRun.js` to keep it under its size limit.
 */

/** The chat's shared mailboxes as a turn of `asker`'s is told them: `askerSends` on each one they have connected too. */
export function mailFor(mail, asker) {
  return mail.map(({ handle, address, senders }) => ({ handle, address, ...(asker && Array.isArray(senders) && senders.includes(asker) ? { askerSends: true } : {}) }));
}

/**
 * The control plane as the chat object asks it, answered from what the Lab already read for this chat (`chat`, from
 * `texLabSandbox.ts` `session`). Reads answer; a change is refused and listed (`gate.record`).
 */
export function controlPlaneSwitch({ about, chat, phones, gate, token, storage = null, world = null }) {
  // Muted in this test chat (a turn's `chat_mute`, or "Tex, stop"): the chat object's own mark (`groupChat.ts` `gmuted`),
  // so the control plane answers as it would for a muted chat, and "Tex, start" starts it again.
  const muted = async () => storage !== null && (await storage.get("gmuted")) === true;
  const names = (about.people ?? []).flatMap((p) => (typeof p.handle === "string" && /^[a-z0-9][a-z0-9-]{0,64}$/.test(p.handle) && phones.has(p.handle) ? [{ phone: phones.get(p.handle), handle: p.handle, ...(p.name && p.name !== "You" ? { name: p.name } : {}) }] : []));
  const guests = [...phones.entries()].filter(([who]) => !names.some((n) => n.handle === who)).map(([, phone], i) => ({ phone, label: `guest-${(4096 + i).toString(16).slice(-4)}` }));
  const own = async (path, body) => {
    switch (path) {
      case "/agent-texts/session":
        return { status: "linked", accessToken: token, ...(about.timeZone ? { timeZone: about.timeZone } : {}) };
      case "/agent-texts/group": {
        if (body?.command?.kind === "stop" || body?.command?.kind === "start") {
          gate.record({ kind: "Setting", summary: body.command.kind === "stop" ? "muted Tex in this test chat" : "started Tex again in this test chat" });
          return { status: body.command.kind === "stop" ? "stopped" : "started" };
        }
        if (body?.command !== undefined) {
          gate.record({ kind: "Settings", summary: `asked the control plane to ${String(body.command?.kind ?? "change the chat")}` });
          return { status: "refused" };
        }
        if (about.kind === "group" && (await muted())) return { status: "muted" };
        const handle = names.find((n) => n.phone === body?.sender)?.handle;
        return {
          status: "ready",
          slug: chat?.slug ?? "lab",
          intro: false,
          ...(about.timeZone ? { timeZone: about.timeZone } : {}),
          ...(handle ? { handle } : {}),
          accessToken: token,
          names,
          guests,
          // How Tex acts in this chat, as the control plane's row says (`textGroups.ts` `engagementOf`).
          ...(chat?.engagement ? { engagement: chat.engagement } : {}),
          ...(chat?.engagementChosen === true ? { engagementChosen: true } : {}),
          ...(chat?.instructions ? { instructions: chat.instructions } : {}),
          ...(chat?.updates ? { updates: chat.updates } : {}),
          // Whether the chat is shared with the developers, as the control plane reads it (`lib/texLabShared.ts` `devShareOf`).
          ...(chat?.devShare ? { devShare: chat.devShare } : {}),
          // The chat's shared mail, marked for this text's asker as a real turn's is (`lib/textGroupMail.ts`), and calendars.
          ...(Array.isArray(chat?.mail) && chat.mail.length > 0 ? { mail: mailFor(chat.mail, handle) } : {}),
          ...(Array.isArray(chat?.calendar) && chat.calendar.length > 0 ? { calendar: chat.calendar } : {}),
        };
      }
      case "/agent-texts/decide/gate":
        return { ok: true, remaining: 1000 };
      case "/agent-texts/decide/usage":
        return { ok: true };
      case "/agent-texts/old-line":
        return chat?.oldLine ?? { mode: "off" };
      case "/agent-texts/phones":
        return { phones: [] };
      default:
        gate.record({ kind: "Other", summary: `asked the control plane ${path}` });
        return null;
    }
  };
  // A made-up group chat (`world.js`, `worldLocal.js`): its group questions are the world's to answer, which may build on
  // the Lab's own answer (`own`).
  return async (path, body) => {
    const real = world === null ? undefined : await world(path, body, own);
    return real !== undefined ? real : await own(path, body);
  };
}
