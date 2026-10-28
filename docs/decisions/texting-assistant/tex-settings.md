# How Tex talks: settings per person and per group

Decided by Dev2, 2026-10-28.

Tex had one setting about how it behaves, the group's engagement style. Tone,
length and emoji were fixed text in the prompt, the same for everyone. People
now choose how Tex talks, modelled on ChatGPT's personality settings and
adapted to texting.

## The settings

Absent means default, and only changed settings are stored.

- Tone: default, professional, friendly, candid, quirky, efficient, nerdy,
  cynical.
- Warmth, enthusiasm and emoji: more, default or less.
- Length: short, default or detailed.
- Bubbles: several per answer (default) or one.
- Humor: 0 to 100 in tens, default 75, an homage to TARS in Interstellar.

## Whose settings apply

- A person's own (`texStylePreferences`) hold in their 1:1 chat.
- A group has its own (`textGroups.texStyle`), changed by any member, and Tex
  says who changed what ("Humor set to 60% (set by jhon).").
- A group never uses anyone's personal settings. A shared chat should not
  take one member's taste, and it should not reveal it either.

## How they take effect

- The gateway says them as a short block after the production prompt and the
  texting style (`apps/mcp/src/agent/texStyle.js`). It adjusts how Tex
  writes and never what it may do. This follows how ChatGPT applies its
  presets: as instructions in the prompt, not a different model.
- Bubbles: one makes the Worker send the answer as one text, links still on
  their own (`apps/agent/src/format.ts`).
- Emoji: less also leaves off the quick acknowledgement tapback.
- Emoji: more is not yet passed to decide; reactions are chosen as before.

## How they are changed

- "Tex, settings" lists them by number (1 When I speak up, in groups only, then
  Tone, Warmth, Enthusiasm, Emoji, Length, Bubbles, Humor). A number opens one;
  a number or a name sets it. Plain words do the common ones: "Tex, less
  emoji", "Tex, humor 60%", "Tex, tone efficient", "Tex, one bubble".
- The app gets a Settings > Tex screen for a person's own settings.
- Every value is checked against its closed set at each trust boundary: the
  control plane's routes and mutation, and the gateway's `/agent` body. A value
  off its set is refused whole, never trimmed.

## What a simplification would cost

Letting a member's personal style apply in a group would let one person set
the tone for everyone and tell the chat what they chose for themselves. The
test "a group uses only its own, with who set it"
(`apps/convex/__tests__/texStyle.test.ts`) fails if the control plane hands a
group anything but its own row.
