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
 * `premium` has a real answer — whether this context is paying — and it lives
 * in a Convex subscription inside its own panel rather than on `ConsoleData`.
 * Hoisting it would add a query to every console load to decorate one row,
 * which is a trade worth making on purpose and not as a side effect of this
 * change. (`devices` was the other one, and its row is gone: the machines are
 * a card at the foot of Profile now.)
 * `meetings` has nothing persisted to report by design, which
 * `MeetingsPanel`'s own header argues.
 */
export function settingsPreview(
  key: SettingsSectionKey,
  data: ConsoleData,
): string | null {
  switch (key) {
    case "profile":
      return data.viewer.name;

    case "invitations": {
      // `undefined` is not `[]`, and `[]` is the resting state of this row —
      // "None" on every load is a badge people learn to ignore.
      const pending = data.invitations?.length ?? 0;
      return pending === 0 ? null : `${pending} pending`;
    }

    case "integrations": {
      /*
        The AI apps, and nothing else on the row.

        Four counts — apps, mailboxes, calendars, chats — do not fit in a
        right-aligned string, and summing them into "6 connected" would be a
        number nobody can act on. The apps count is the one a person glancing
        at the row is actually asking about, and it is the only one of the
        four this module can state without qualification: `clients` is a
        complete list once it has landed, while `googleConnections` comes back
        empty for a query in flight, one that failed, and a genuinely
        unconnected account alike — and Chats can only ever see half its own
        mechanism, because this Mac's iMessages never reach `ConsoleData`.

        So the blocks inside the panel keep their own claims, where each can
        say what it does and does not know, and the row says the one thing
        that is true on its own.
      */
      if (data.loading) return null;
      return data.clients.length === 0 ? "None" : `${data.clients.length} active`;
    }

    case "sharing": {
      /*
        The members count, which is the one claim of the four that is about
        this screen as a whole rather than about a block on it — and the one
        somebody glancing at the row wants. Groups, links and the privacy
        default are each an answer to a narrower question, and three of them
        stacked in a right-aligned string is not a preview.

        The same guards the members row had: `loading` and a failure are both
        absences, and neither may be rendered as a number.
      */
      const { members, loading, failure } = data.members;
      if (loading || failure !== null) return null;
      return members.length === 1 ? "Just you" : `${members.length} people`;
    }

    case "storage":
      /*
        The binding, not the index. `null` in, `null` out, for both of the
        absences it covers — and the index has no claim on this row even
        though it is now a block on the screen: "R2 · notes-bucket" answers
        where the notes are, which is what somebody reading the row wants, and
        a second clause about the index would be the row trying to be the
        panel.
      */
      return storagePillLabel(data.storage);

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
    /*
      `model` joins this group for `premium`'s reason exactly: the answer —
      whether this context has a model account connected — lives in a Convex
      query inside its own panel rather than on `ConsoleData`, and hoisting it
      would add a query to every console load to decorate one row. A trade
      worth making on purpose if the row ever needs it, and not as a side
      effect of adding the section.

      Written above the group rather than between two of its cases, which is
      where it was: a comment there reads as a fallthrough to `no-fallthrough`
      and reddens lint, and CI found that rather than my own run, because I
      linted the files I had added instead of the ones I had changed.
    */
    case "workspace":
    case "premium":
    case "website":
    case "emoji":
    case "model":
    case "meetings":
      return null;
  }
}
