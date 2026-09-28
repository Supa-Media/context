/**
 * Paths this product itself puts into every workspace — guessable without
 * knowing anything about the owner, and therefore the set the unauthenticated
 * preview may name.
 *
 * Split out of `lib/scaffold.ts` — see that file's header for the scaffolder's
 * overall rules.
 */

import { ARCHIVE_FOLDER_PATTERN } from "../privacy";
import { INDEX_KEY, PARA_FOLDERS, PRIVACY_KEY } from "./store";

/**
 * Names this product does not write, kept out anyway because they are generic.
 *
 * A first version called `todo.md` "mandated by the connected-client house
 * rules". That contradicts a decision already recorded in `apps/mcp/src/index.js`
 * — the agent-ledger and `todo.md` conventions were deliberately removed from
 * `SERVER_INSTRUCTIONS` because "they are one customer's house rules... Ours is
 * the product's rules only." By that decision `todo.md` is a name its owner
 * chose, and this list would have no business holding it.
 *
 * It stays on the weaker and honestly weaker argument: `todo.md` at the root of
 * a notes bucket is a guess anybody would make. **That argument is unbounded** —
 * `notes.md`, `journal.md`, `ideas.md` are guesses too — so any list built on it
 * is an arbitrary stopping point, and this one stops at one entry. The residual
 * is real and is not a bug in the rule but a limit of it: a generic filename the
 * owner picked is still previewable.
 *
 * Kept rather than dropped because the two directions fail differently. Refusing
 * a name nobody would have guessed costs one owner one card; previewing one
 * anybody would guess is the thing the whole rule exists to stop.
 */
export const GENERIC_ROOT_KEYS = ["todo.md"] as const;

/**
 * Folders the GATEWAY creates from a capture's `source`, not the owner.
 *
 * `writeInboxCapture` files any capture carrying an `external_id` under
 * `0-inbox/<safeSlug(source)>/`, so the folder name is whatever the sender
 * called itself — and three senders are the product's own. `plugins/context`
 * publishes exactly three client ids and bakes `--client <id>` into the
 * command it installs, so `hook:claude-code` slugs to `hook-claude-code`;
 * `POST /inbox` defaults `source` to `"inbox"`; the Granola webhook hardcodes
 * `"granola"`.
 *
 * The hook one is the sharpest of the whole list. It is the product's most
 * promoted surface — the safety net for a session nobody remembered to save —
 * and the folder appears the first time an installed hook fires, so it needs
 * no action by the owner at all beyond running the installer.
 *
 * A capture whose source the SENDER chose is a different matter and stays
 * previewable: that name is not ours to guess — **except when the slug falls
 * back**, which is why `0-inbox/capture` is on the list. A sender who picks a
 * source with no Latin alphanumerics gets a folder name of ours, so the
 * sender-chose-it exclusion does not reach the fallback.
 */
export const CAPTURE_SOURCE_FOLDERS = [
  "0-inbox/hook-claude-code",
  "0-inbox/hook-codex",
  "0-inbox/hook-gemini-cli",
  "0-inbox/inbox",
  "0-inbox/granola",
  // `safeSlug` ends `|| "capture"`, so a source containing no `[a-z0-9]` at
  // all — "日本語アプリ", "Здравствуй", "###", an emoji — lands in a folder
  // named by US rather than by the sender. Narrower than the others and still
  // a hardcoded literal in our source needing no knowledge of the owner, on
  // exactly the generic-guess ground `todo.md` sits on.
  "0-inbox/capture",
] as const;

/**
 * The one path the single-tenant calendar cron writes, and its folder.
 *
 * `2-areas/calendar/next-14-days.md` is hardcoded in the gateway and gated on
 * `CALENDAR_ICS_URL`, so it exists only where that is configured — which is
 * the original workspace, the one deployment whose owner is publicly known. The
 * name requires no knowledge of them.
 */
export const CALENDAR_PATHS = ["2-areas/calendar", "2-areas/calendar/next-14-days.md"] as const;

/**
 * The root folders every workspace **preset** writes.
 *
 * `apps/mobile/features/workspace/presets.ts` ships fixed layouts (one per kind
 * of workspace) and sends them down the `custom` template path, and
 * `DEFAULT_PRESET` is `business` — so
 * these are what a shared context gets when nobody chooses. That makes them
 * ours, at addresses anybody who knows a handle can type, which is the whole
 * test `isProductMandatedPath` applies.
 *
 * The list below said `custom` was out of scope "because those folder names are
 * the owner's". That is still true of a layout somebody typed and false of one
 * we ship, and #203 is what made the difference matter: a shared context's
 * scaffold starts these `team`, so a folder card on one actually names its
 * contents.
 *
 * Kept in step with the preset file by `teamShare.test.ts`, which reads that
 * file rather than restating it here. Names an earlier version of the presets
 * wrote (`3-handbook`, `4-customers`) stay: workspaces made then still have
 * them, and this list is about what can be guessed, not what is current.
 */
const PRESET_FOLDERS = [
  "1-clients",
  "1-plan",
  "2-pipeline",
  "2-teams",
  "2-work",
  "3-clients",
  "3-handbook",
  "3-meetings",
  "3-practice",
  "3-team",
  "4-customers",
  "4-handbook",
  "4-practice",
  "4-reference",
  "5-archive",
] as const;

/**
 * The archive roots **this product ships**, and the session folders under them.
 *
 * Computed off the two lists above rather than restated, for the reason the
 * whole of `PRODUCT_MANDATED_PATHS` is computed: a preset that adds
 * `6-archive` tomorrow would otherwise ship a guessable session folder that no
 * list names, and the guard below drives `defaultSessionFolder` rather than a
 * copy of it, so the gap would surface as a failing check rather than a quiet
 * card. `0-inbox/sessions` is the no-archive fallback and is ours outright.
 */
function productArchiveRoots(): string[] {
  const roots = new Set<string>();
  for (const folder of [...PARA_FOLDERS, ...PRESET_FOLDERS]) {
    if (ARCHIVE_FOLDER_PATTERN.test(folder)) roots.add(folder);
  }
  return [...roots].sort();
}

function sessionFolders(): string[] {
  return [...productArchiveRoots().map((root) => `${root}/chat-history`), "0-inbox/sessions"];
}

/**
 * Where `save_context` files a session — a folder name WE pick, not the owner.
 *
 * `defaultSessionFolder` in the gateway returns `<archive>/chat-history` when
 * the manifest declares an archive folder and `0-inbox/sessions` otherwise, so
 * every workspace whose owner has run the hook once has one of these. That makes
 * them a guess per handle on names nobody chose — the same shape as the five
 * PARA folders, and they get the same answer.
 *
 * **`<archive>` is resolved, not literal**, which is why this list is computed
 * rather than typed: the gateway recognises any `<n>-archive`, and the archive
 * roots *this product ships* are the PARA one and the presets'. An archive a
 * customer named themselves is theirs and stays off the list, on the same
 * ground the `custom` template does below — the guessability premise does not
 * hold for a folder we did not choose.
 *
 * A blanket `.md` refusal used to cover this without naming it. Replacing that
 * with a list was right (guessability is a property of a name, not of
 * file-versus-folder) and it made the edge the blanket rule had been hiding
 * into a gap: measured, `4-archive/chat-history` unfurled as "Chat history"
 * with a live card token.
 *
 * **The platform folder beneath is NOT bounded by refusing the parent**, and a
 * first version of this comment said it was, twice over.
 * `isProductMandatedPath` is exact-match — the neighbouring test pins that it
 * must not be `startsWith` — so `4-archive/chat-history/claude` previews with
 * its name regardless. And the parent is not the only place it can live:
 * `save_context` takes a `destination`, so the platform folder appears under
 * whatever the caller chose.
 *
 * Stopping at the parent is still right, and for a different reason than the
 * one that was written down: the platform segment is caller-supplied
 * (`/^[a-z0-9][a-z0-9-]{0,31}$/`), so the child set is unbounded and cannot be
 * enumerated, and under an owner-chosen `destination` refusing it would cost a
 * card for nothing. The residual is that `<session folder>/<platform>` is
 * previewable for the three platform names somebody might guess. Named rather
 * than argued away.
 */
export const SESSION_FOLDERS: readonly string[] = sessionFolders();

/**
 * A path this product itself puts into every workspace, and therefore one anybody
 * can guess without knowing a thing about the owner.
 *
 * Used by `previewForNote` to decide what an unauthenticated crawler may be
 * told about a **guessable** address. The card rule turns on guessability: a
 * share link is 32 CSPRNG bytes and may carry a title, while `/@name/<path>` is
 * typed, so it may only answer for a path the owner explicitly linked — and
 * that bound is worth exactly as much as the name space it is defended by.
 *
 * The five PARA folders are in this list, and naming them here is what let the
 * preview stop refusing folders wholesale. A folder the owner named —
 * `1-projects/public-worship-chapter-transition` — is no more guessable than a
 * note filename, and refusing it cost a card for nothing; a folder *this
 * product* wrote is five guesses, which is the whole risk. Notes are a bigger
 * list than "index.md":
 * `scaffoldFiles` also lays a `README.md` into every PARA folder, so a fresh
 * workspace arrives with six guessable note names before its owner writes anything.
 *
 * The test for this drives `scaffoldFiles` rather than restating its output, so
 * an eighth scaffolded file cannot quietly become an eighth guess.
 *
 * **The `custom` template was deliberately out of scope, and half of it no
 * longer is** — see `PRESET_FOLDERS` above. A layout somebody typed is still
 * theirs; one this product ships through the same code path is ours, and the
 * list below spreads those. What follows argues the original half.
 *
 * **The `custom` template is deliberately out of scope.** It also writes a
 * `README.md` per folder, but those folder names are the owner's — `Journal/`,
 * `Clients/` — so the guessability premise that makes this list a security
 * control simply does not hold for them, and refusing them would cost a card
 * for nothing. Only `PARA_FOLDERS` is consulted, and the test's claim that
 * driving `scaffoldFiles` catches a new file is a claim about the `para`
 * branch.
 */

export const PRODUCT_MANDATED_PATHS: readonly string[] = [
  INDEX_KEY,
  PRIVACY_KEY,
  ...GENERIC_ROOT_KEYS,
  // The five PARA folders themselves. `applyStructure` writes exactly these
  // into every `para` workspace, so they are five guesses per handle — the
  // narrowest name space in the product and the reason the preview refused
  // folders wholesale before this list learned to name them.
  ...PARA_FOLDERS,
  ...SESSION_FOLDERS,
  ...CAPTURE_SOURCE_FOLDERS,
  ...CALENDAR_PATHS,
  ...PARA_FOLDERS.map((folder) => `${folder}/README.md`),
  // The preset layouts, for the reason `PRESET_FOLDERS` gives. `0-inbox`,
  // `1-projects` and their READMEs are already above via `PARA_FOLDERS`; a
  // duplicate would be harmless but this list is read by two tests as a set.
  ...PRESET_FOLDERS,
  ...PRESET_FOLDERS.map((folder) => `${folder}/README.md`),
];

/**
 * **The list, not a second statement of it.**
 *
 * This was a chain of `if`s, and `infra/router/src/preview.ts` mirrors it with
 * a literal that a test compares against a THIRD hand-written array — so the
 * comparison held two restatements against each other and never asked the
 * predicate. Adding `SESSION_FOLDERS` to the `if`s left that test green with
 * the router's copy short: routed ⊆ predicate was checked, predicate ⊆ routed
 * was not. The same one-directional hole as the `native-deps.json` `core`
 * list, in the guard written to stop hand-maintained enumerations.
 *
 * Exporting the array is what makes the mirror checkable: the predicate reads
 * it, and the test compares the router's literal against it rather than
 * against a copy somebody kept in step by remembering to.
 */
export function isProductMandatedPath(path: string): boolean {
  return PRODUCT_MANDATED_PATHS.includes(path);
}
