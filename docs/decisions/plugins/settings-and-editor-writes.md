# Plugins — settings and editor writes

## A settings pane is described, never forwarded

`display()` is the most hostile thing a plugin runs on Context's behalf, and
that is not a hypothetical: the real Bible Reference pane opens with a **sponsor
iframe** and a **tracking image**, both set through `innerHTML`, before it
reaches a single control. Forwarding what a plugin builds would mean Context
serving somebody else's ads and somebody else's analytics from inside a
customer's console.

So the same inversion as the suggestion dialog and `Modal`, applied where it
matters most. `display()` runs in the sandbox against a real `containerEl`; the
guest walks that element and sends a **description** — a kind, a name, a
sentence, a value, a list of options; the console draws its own controls; a
change crosses back as an index and the plugin's own `onChange` runs in the
sandbox.

Order is document order from the plugin's own container, so a heading it wrote
between two settings lands between them. Nothing is re-sorted: this is somebody
else's pane, and rearranging it makes their documentation wrong.

**A hidden control is not offered.** Obsidian augments `HTMLElement` with
`hide()`/`show()`, and this pane builds every control up front then hides the
ones that do not apply. Two things followed from adding them: the shim stopped
throwing (see below), and `describePane` skips a hidden row — drawing it would
offer a setting the plugin's own author refuses to show.

**A `display()` that throws part-way is reported, not swallowed.** The shim was
missing `hide()`, so `display()` threw on the fourth of twenty-one rows and the
error was caught and dropped. The reader got a pane silently missing seventeen
settings, which looks exactly like a plugin that has four — the quieter failure
and the worse one. The pane now carries what it threw and says so above the rows
it did manage to draw.

**Links do not survive, and the pane says so once.** An anchor is markup; only
text crosses. A plugin's settings routinely link to its documentation, its
repository and its author, and all of them arrive as plain words. Silence there
reads as a broken pane, so `LINKS_NOTE` states the rule at the foot — a refusal
carrying its route out, like every other refusal in this feature.

**The index is checked on the trusted side.** It is what a reader's press is
addressed by, so a guest that renumbered its rows could point a toggle at a
different setting than the one on screen. The parser accepts a control only when
its claimed index equals its position in the accepted list, and drops it
otherwise. The real guest emits dense indices and can never exercise that
branch, which is exactly why it has its own check in
`packages/obsidian-runtime/test/test.mjs`.

**What a simplification costs.** Forwarding the plugin's DOM puts an iframe and
a tracking pixel in the trusted realm. Drawing hidden rows offers settings the
plugin refuses to show. Swallowing the `display()` error restores a pane that
lies about how many settings a plugin has. Trusting the index lets a guest
redirect a press. `pluginSandboxGuest.test.ts`, `pluginSettingsPane.test.ts`,
`packages/obsidian-runtime/test/test.mjs` and
`e2e/webkit/pluginSettings.spec.ts` hold these, the last against the real
release — which is the only check that caught the missing `hide()`.

`addSettingTab` moved from `INERT_MEMBERS` to `SUPPORTED_MEMBERS` with this.
That is the direction an entry on that list is supposed to travel, and it had
been "accepted and not drawn yet" for months.

## The open note is an editor a plugin can write into, while its work is running

`app.workspace.getActiveViewOfType(MarkdownView)` is the ending of nearly every
"insert this here" an Obsidian plugin has. It sat in `INERT_MEMBERS` answering
`null`, and because plugins reach for it through an optional chain —

```js
this.app.workspace.getActiveViewOfType(MarkdownView)?.editor
  .replaceRange(verse, editor.getCursor())
```

— that `null` was never an error anybody could see. It was a row pressed, a
dialog closed, and a note that did not change. Reported from the shipped console
as *"I click on the verse and nothing happens"*, twice, about the feature the
plugin exists for.

**A view exists while Context is running one piece of that plugin's work**, and
not otherwise: a command, a ribbon press, or a choice made in a dialog it
opened. `withActiveEditor` reads the open note before the work, hands the plugin
an editor over those bytes, waits for the work to settle, and writes the result
back through the same audited, etag-checked RPC the `editorCallback` path
already used. Outside that window there is nothing to write back into, so a
plugin that kept a view would be holding an editor whose edits go nowhere.

**The caret starts at the end of the note.** The console's real caret lives in a
CodeMirror view in the trusted realm, and both places a plugin writes from — a
command pressed on the plugins pane, a dialog over the console — are places
where nobody is typing in the note. Appending is the one answer that is always
visible and never overwrites something somebody was looking at. An in-editor
suggestion is the case where the host *does* know, and it passes the offset in.

**Every command gets the same reach, not just an `editorCallback` one.** That is
Obsidian's shape rather than a widening: the grant is unchanged, the write is
the same RPC, and a plugin that does not ask for the view costs one read it
never uses. `editorCallback` keeps its stricter rule — no note open is an error
— because a command that takes an editor has nothing to do without one.

**What a simplification costs.** Answering `null` again makes the dialog picks
and command inserts of a whole class of plugin silent no-ops. Keeping the view
alive between pieces of work gives a plugin an editor whose writes are never
saved, or are saved against a note the reader has since left. Handing back a
`MarkdownView` for any type asked for hands a plugin an object whose methods are
not the ones it is about to call. `apps/mobile/__tests__/pluginActiveView.test.ts`
holds the mechanism and `e2e/webkit/pluginModalPickReal.spec.ts` holds it against
the released Bible Reference bundle — the real `onChooseSuggestion`, the real
`MarkdownView` check, the real write.

`getActiveViewOfType` moved from `INERT_MEMBERS` to `SUPPORTED_MEMBERS` **and**
`PARTIAL_MEMBERS` with this: it is answered, and the bound — only during the
plugin's own work, only `MarkdownView`, caret at the end — is worth printing
beside a plugin that uses it.

## A press that does nothing is a bug, even when nothing is broken

Three different things produced the identical experience — a row pressed, and a
note that did not change: no view to write into, no `vault:write` grant, and a
write that failed. The first is fixed above; the other two are not bugs at all,
and the **silence** was the whole defect. The console's default grant makes the
second the ordinary first experience of Bible Reference: `enableCapabilities`
gives read and settings, never write, on purpose.

So the guest reports **which of three** it was — `no-note`, `not-allowed`,
`failed` — and the console writes the sentence. A word rather than a sentence,
because a message carried up from a sandbox would be a plugin composing
Context's error text, often about that plugin's own missing grant; the set is
closed in `@context/obsidian-runtime`, so the worst a lying guest achieves is
the wrong one of three. `pluginWorkNote` holds the words in one place, for the
dialog and the plugins card alike, so one refusal does not read as two problems.

**A plugin that never wanted the note is never reported as having failed to get
it.** A dialog that only switches a translation touches nothing, and an error
over it would be Context inventing a problem. The guest records whether the
plugin actually reached for a view during that piece of work, and says nothing
when it did not.

**What a simplification costs.** Swallowing the reason restores the original
report. Carrying the plugin's own string instead of a word lets a plugin write
Context's error message. Reporting a reason for a plugin that never asked puts
an error over a dialog that did exactly what the reader wanted.
`pluginActiveView.test.ts`, `pluginSuggestDialog.test.ts`,
`pluginSuggestDialogHost.test.ts` and the second case in
`e2e/webkit/pluginModalPickReal.spec.ts` hold it.

## A check that reads React state from inside `onEvent` is not a check

`useRuntime.onEvent` is a `useCallback` handed to every sandbox frame, and every
ownership check it makes — *did I ask this frame for this?* — has to be true at
the moment a message arrives. Its dependency list names the Convex actions, the
mutations and the workspace id, and **every one of those is stable**, so the
callback is built on the first render and keeps whatever state it closed over
then.

The settings pane checked ownership against `settingsPane` and `settingsRequest`
state from inside that callback. `settingsRequest` was `undefined` on the first
render and stayed `undefined` for the life of the console, so every pane any
plugin ever drew was dropped as one nobody had asked for: pressing **Settings…**
did nothing at all, for every plugin, from the day the feature shipped.

This was written down *in the file*, beside `textModalOwner`, and accepted on
the grounds that it "fails closed: the pane stops opening, somebody notices
within a day". It fails closed and nobody noticed for weeks, because a control
that does nothing reads as a slow console rather than as a broken feature. **A
fail-closed bug is not a cheap bug; it is a quiet one.**

Ownership now lives in a ref — `settingsOwner`, like `textModalOwner` and every
pending map beside it — written before the request goes out and released when
the pane closes or its frame goes. The rule for that callback is: **refs for
anything it reads, state only for what it sets.**

**What a simplification costs.** Reading state there again reintroduces a
feature that is dead on arrival and green in every test that does not drive the
hook — which is why the guard is a host-level test, `pluginSettingsHost.test.ts`,
that presses Settings… through the real `useRuntime` rather than handing a
component a pane it did not ask for.
