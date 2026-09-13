import type { AppearanceChoice } from "../../design/theme";
import { receivesMail } from "../ingestion/settings";
import { privacyViewOf } from "../privacy/map";
import { visibilityWord } from "../privacy/words";
import { fastSearchPill } from "../search/fastSearch";
import { storagePillLabel } from "../storage/pill";
import { pluginsPreview } from "../plugins/plugins";
import type { ConsoleData } from "../types";
import type { SettingsSectionKey } from "./sections";

/**
 * What a settings row says about itself, on its right-hand side.
 *
 * The list was nineteen destinations set in one weight, each holding one word.
 * "Storage" did not say R2, "Email" did not say whether mail was landing, and
 * "Appearance" did not say dark — so every question a person brought to this
 * screen cost a navigation and a trip back, for an answer the console had
 * already loaded and was holding in `ConsoleData`.
 *
 * ## The rule
 *
 * **A preview is a claim, so it is never invented out of an absence.** This
 * codebase is written against "absent is not zero" deliberately and in
 * several places — `ConsoleData.storage` is tri-state and spends a paragraph
 * saying why, `invitations` is `undefined` until it lands, `fastSearch.status`
 * is `null` before it answers, `notesIndexed` is typed `number` rather than
 * `number | undefined` specifically so that `?? 0` is a compile error. A
 * right-aligned string is exactly the shape that collapses one of those into
 * "None", quietly, on a screen people consult to find out what is true.
 *
 * So `null` here means **this row has nothing to add**, and it covers three
 * different absences that must never be rendered as a value:
 *
 *  - *not answered yet* — the binding in flight, the member list loading;
 *  - *withheld* — `listGroups` and `listShares` are owner-only on the backend
 *    and the views express that by arriving empty with no `actions`, so an
 *    empty array means "none" for an owner and "not yours to see" for
 *    everybody else, and only the first may be said out loud;
 *  - *not visible from here* — Chats is Google Chat, which `ConsoleData` can
 *    see, **and** this Mac's iMessages, which lives on the desktop bridge and
 *    does not reach the console at all. "Not connected" from half the
 *    mechanism is a flat lie to anybody capturing the other half.
 *
 * A known zero is a different thing from all three, and a section may say it:
 * an owner with no groups gets "None", because that is an answer.
 *
 * ## Three rows that stay quiet for a reason worth writing down
 *
 * `devices` and `premium` have real answers — the machines holding a capture
 * grant, and whether this context is paying — and both live in a Convex
 * subscription inside their own panel rather than on `ConsoleData`. Hoisting
 * either would add a query to every console load to decorate one row, which
 * is a trade worth making on purpose and not as a side effect of this change.
 * `meetings` has nothing persisted to report by design, which
 * `MeetingsPanel`'s own header argues; `account` has no state worth a claim.
 */
export function settingsPreview(
  key: SettingsSectionKey,
  data: ConsoleData,
  /**
   * The viewer's appearance setting, or `null` where the caller has none to
   * offer — `OverviewPanel`, which draws no Appearance row.
   *
   * The whole object rather than the `choice`, and that is the guard rather
   * than a convenience: `choice` is `"system"` before the device has answered
   * on a native cold start, so a caller handing over only that reads "System"
   * to somebody on Dark and then flips. Taking `ready` alongside it makes
   * dropping it a type error instead of a thing to remember.
   */
  appearance: { choice: AppearanceChoice; ready: boolean } | null,
): string | null {
  switch (key) {
    case "apps":
      // `clients` is `[]` while the workspace list is still in flight, which
      // is not "no AI apps connected".
      if (data.loading) return null;
      return data.clients.length === 0 ? "None" : `${data.clients.length} active`;

    case "profile":
      return data.viewer.name;

    case "invitations": {
      // `undefined` is not `[]`, and `[]` is the resting state of this row —
      // "None" on every load is a badge people learn to ignore.
      const pending = data.invitations?.length ?? 0;
      return pending === 0 ? null : `${pending} pending`;
    }

    case "appearance": {
      if (appearance === null || !appearance.ready) return null;
      const { choice } = appearance;
      return choice === "system" ? "System" : choice === "dark" ? "Dark" : "Light";
    }

    case "email": {
      const mailboxes = data.googleConnections.filter(
        (connection) => connection.gmail !== undefined,
      ).length;
      if (mailboxes > 0) return plural(mailboxes, "mailbox", "mailboxes");
      if (receivesMail(data.ingestion)) return "Forwarding on";
      /*
        And no "Not connected" from here, however tempting.

        Mail reaches a workspace by two mechanisms and this row can only see one
        and a half of them. `useLiveConsoleData` builds `googleConnections`
        through `usable()`, which returns `undefined` for a query in flight
        **and** for one that came back an error — so an empty list is three
        different things, and only one of them is "no mailbox". Somebody with
        Gmail connected would read "Not connected" on every load until that
        subscription landed, and permanently if it failed.
      */
      return null;
    }

    case "calendar": {
      const calendars = data.googleConnections.filter(
        (connection) => connection.calendar !== undefined,
      ).length;
      return calendars === 0 ? null : plural(calendars, "calendar", "calendars");
    }

    case "chats": {
      // Half the mechanism — see the header. A count is honest; its absence
      // is not, so zero says nothing rather than "Not connected".
      const chats = data.googleConnections.filter(
        (connection) => connection.chat !== undefined,
      ).length;
      return chats === 0 ? null : "Google Chat";
    }

    case "people": {
      const { members, loading, failure } = data.members;
      if (loading || failure !== null) return null;
      return members.length === 1 ? "Just you" : `${members.length} people`;
    }

    case "groups": {
      const { groups, loading, failure, actions } = data.groups;
      if (actions === undefined || loading || failure !== undefined) return null;
      return groups.length === 0 ? "None" : plural(groups.length, "group", "groups");
    }

    case "shares": {
      const { shares, loading, failure, actions } = data.shares;
      if (actions === undefined || loading || failure !== null) return null;
      return shares.length === 0 ? "None" : plural(shares.length, "link", "links");
    }

    case "privacy": {
      const view = privacyViewOf(data.files.listings, "");
      // `loading` and `broken` are not a visibility, and the second is a
      // banner's job rather than a row's.
      if (view.state !== "ready") return null;
      return `${visibilityWord(view.folderDefault)} by default`;
    }

    case "storage":
      // `null` in, `null` out, for both of the absences it covers.
      return storagePillLabel(data.storage);

    case "search": {
      const status = data.fastSearch.status;
      if (status === null) return null;
      // The same judgement the card's own chip makes, from the same function:
      // `off` and `unavailable` are working states, and a label on a working
      // state is a badge somebody clears by turning on a copy of their notes.
      return fastSearchPill(status.state)?.label ?? null;
    }

    case "plugins":
      /*
        `null` for everything that is not a completed read — the console having
        no way to ask, and a read that failed, are both absences, and "None"
        from either is a sentence about somebody's vault that nobody checked.
        See `pluginsPreview`.
      */
      return pluginsPreview(data.plugins);

    /*
      Silent, each for its own reason — see the header. Written out rather
      than swept into a `default`, so a section added to the catalogue and not
      to this switch is a compile error rather than a blank row nobody
      notices.
    */
    case "overview":
    case "premium":
    case "devices":
    case "account":
    case "meetings":
    case "advanced":
      return null;
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
