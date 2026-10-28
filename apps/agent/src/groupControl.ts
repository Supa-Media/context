/**
 * Who a group chat is, asked of the control plane (`POST /agent-texts/group`)
 * on every message Tex acts on (moved out of `groupInbox.ts` whole).
 */

import { readTexStyle, type TexStyle } from "./texStyle";
import { post, record, ServiceError } from "./clients";
import { GROUP_STYLES, type GroupStyle } from "./decide";
import type { GroupDeps, Command } from "./groupInbox";
import type { GroupMessage } from "./sendblueGroups";

export type ControlAnswer =
  | { status: "refused" | "muted" | "stopped" | "started" | "no_shared" }
  | { status: "not_shared"; slugs: string[] }
  | { status: "not_allowed"; slug: string }
  | { status: "invited"; slug: string; count: number; role: string }
  | { status: "guests_off" }
  | { status: "mail_shared"; address: string; narrowed: boolean }
  | { status: "mail_unshared"; count: number }
  | { status: "mail_refused" }
  | { status: "unknown_sender"; tell?: boolean }
  | { status: "choose"; slugs: string[] }
  | {
      status: "ready";
      slug: string;
      intro: boolean;
      timeZone?: string;
      handle?: string;
      accessToken?: string;
      names?: { phone: string; handle: string }[];
      guest?: GuestInfo;
      guests?: { phone: string; label: string }[];
      /** Mailboxes shared with this chat (`chat-mail.md`): the turn is told whose and which. */
      mail?: { handle: string; address: string }[];
      /** When Tex speaks up here (`groupStyle.ts`); absent from a control plane that has none. */
      engagement?: GroupStyle;
      engagementChosen?: boolean;
      /** How Tex talks in this chat (`texStyle.ts`): the group's own, never a member's personal one. */
      texStyle?: TexStyle;
    };

/** A guest chat's group, three words and folder (`apps/convex/functions/lib/textGroupGuests.ts`). */
export type GuestInfo = { group: string; words: string; folder: string };

const LABEL = /^guest-[0-9a-f]{4}$/;
const MAIL_ADDRESS = /^[^\s@/]{1,64}@[^\s@/]{1,190}$/;
const WORDS = /^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}$/;

function guestInfoOf(value: unknown): GuestInfo | undefined {
  const info = record(value);
  if (typeof info.group !== "string" || !/^[a-z0-9][a-z0-9-]{1,99}$/.test(info.group)) return undefined;
  if (typeof info.words !== "string" || !WORDS.test(info.words) || typeof info.folder !== "string") return undefined;
  return { group: info.group, words: info.words, folder: info.folder };
}

export async function askControlPlane(deps: GroupDeps, message: GroupMessage, people: string[], command: Command | null): Promise<ControlAnswer> {
  const wire = command === null || command.kind === "status" || command.kind === "settings" || command.kind === "style" ? undefined : command;
  const { status, json } = await post(deps.fetch, "control_plane", `${deps.controlPlaneOrigin}/agent-texts/group`, deps.workerSecret, {
    line: message.line,
    groupId: message.groupId,
    sender: message.from,
    participants: people.includes(message.from) ? people : [...people, message.from],
    ...(wire !== undefined ? { command: wire } : {}),
    ...(command === null ? { mint: true } : {}),
    // A routine's or check-in's own turn is nobody talking: the chat's last word stays when it was (`textGroupLooks.ts`).
    ...(message.routine !== undefined ? { routine: true } : {}),
  });
  if (status !== 200) throw new ServiceError("control_plane", status);
  const body = record(json);
  const slug = (value: unknown) => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,64}$/.test(value);
  switch (body.status) {
    case "refused":
    case "muted":
    case "stopped":
    case "started":
    case "no_shared":
      return { status: body.status };
    case "not_shared":
      return { status: "not_shared", slugs: (Array.isArray(body.slugs) ? body.slugs.filter(slug) : []).slice(0, 8) as string[] };
    case "unknown_sender":
      return { status: "unknown_sender", tell: body.tell === true };
    case "not_allowed":
      if (!slug(body.slug)) throw new ServiceError("control_plane", status);
      return { status: "not_allowed", slug: body.slug as string };
    case "guests_off":
      return { status: "guests_off" };
    case "mail_shared":
      if (typeof body.address !== "string" || !MAIL_ADDRESS.test(body.address)) throw new ServiceError("control_plane", status);
      return { status: "mail_shared", address: body.address, narrowed: body.narrowed === true };
    case "mail_unshared":
      return { status: "mail_unshared", count: typeof body.count === "number" && Number.isInteger(body.count) ? Math.max(0, Math.min(body.count, 10)) : 0 };
    case "mail_refused":
      return { status: "mail_refused" };
    case "invited":
      if (!slug(body.slug) || typeof body.count !== "number" || !Number.isInteger(body.count) || body.count < 0) throw new ServiceError("control_plane", status);
      return { status: "invited", slug: body.slug as string, count: Math.min(body.count, 64), role: body.role === "member" ? "member" : "editor" };
    case "choose": {
      const slugs = Array.isArray(body.slugs) ? body.slugs.filter(slug) : [];
      if (slugs.length === 0) throw new ServiceError("control_plane", status);
      return { status: "choose", slugs: slugs as string[] };
    }
    case "ready":
      if (!slug(body.slug)) throw new ServiceError("control_plane", status);
      return {
        status: "ready",
        slug: body.slug as string,
        intro: body.intro === true,
        ...(typeof body.timeZone === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(body.timeZone) ? { timeZone: body.timeZone } : {}),
        ...(slug(body.handle) ? { handle: body.handle as string } : {}),
        ...(typeof body.accessToken === "string" && body.accessToken !== "" ? { accessToken: body.accessToken } : {}),
        names: (Array.isArray(body.names) ? body.names : []).map(record).flatMap((entry) =>
          typeof entry.phone === "string" && slug(entry.handle) ? [{ phone: entry.phone, handle: entry.handle as string }] : [],
        ),
        ...(guestInfoOf(body.guest) ? { guest: guestInfoOf(body.guest) } : {}),
        guests: (Array.isArray(body.guests) ? body.guests : []).map(record).flatMap((entry) =>
          typeof entry.phone === "string" && typeof entry.label === "string" && LABEL.test(entry.label) ? [{ phone: entry.phone, label: entry.label }] : [],
        ),
        mail: (Array.isArray(body.mail) ? body.mail : []).slice(0, 10).map(record).flatMap((entry) =>
          slug(entry.handle) && typeof entry.address === "string" && MAIL_ADDRESS.test(entry.address) ? [{ handle: entry.handle as string, address: entry.address }] : [],
        ),
        ...(GROUP_STYLES.includes(body.engagement as GroupStyle) ? { engagement: body.engagement as GroupStyle } : {}),
        ...(typeof body.engagementChosen === "boolean" ? { engagementChosen: body.engagementChosen } : {}),
        ...(readTexStyle(body.texStyle) ? { texStyle: readTexStyle(body.texStyle) } : {}),
      };
    default:
      throw new ServiceError("control_plane", status);
  }
}

