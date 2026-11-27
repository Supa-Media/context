# Tex's Connect notes step is off (2026-11-27)

Turns off the Connect notes step (`connect`, `noteConnect.js`) that went live
on 2026-11-20.

**Decided by the owner on 2026-11-27**, from a decision card after the nightly
core eval was traced: "Turn Connect off". After a turn that saved a note,
Connect added a `## Connections` line to the other notes it judged related. The
plumber visit (core q6) also changed the tiler's quote, an inbox chat and an
unsorted note, and the dentist correction (q8) changed the office's reminder.
Those notes changed although the person asked about none of them, and both
cases failed every run. The owner chose to stop the automatic links rather than
loosen the tests or keep the links one-way.

The node stays in `texConfig.json` with `on: false`, and its wire stays in
place, so a Lab draft can turn it back on and bench it. `texGraph.cjs` skips a
node that is off.

**What a simplification would cost:** turning it back on without a Lab draft
puts edits to notes the person never named back into every turn that saves a
note, and core q6 and q8 fail again.
