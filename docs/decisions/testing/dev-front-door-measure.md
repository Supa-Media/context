# The Dev set's front door moves a few points between repeats (2026-11-17)

The Lab Dev set is 53 starred labels: 23 Decide, 30 front door. A single run
is not a result. On 2026-11-17 the front door, at one commit, scored anywhere
from 7 to 13 of 30. Decide sat on 17, then 18 of 23 after the reason wording
in #3520, and stayed there.

## What actually moved the score

Harness fixes did. Running check-in and routine rows (#3451) and giving
Decide examples the full answer shape (#3455) lifted a full run from about
19 to about 28. Pages that earlier turns say they wrote (#3512) and clearer
Decide reasons (#3520) held that. More Training conversations (#3466), a
larger front-door model, and the humour and extra-offer prompt edits (#3500)
stayed inside the spread.

#3546 (keep a tapback that ended an earlier turn, and show the judge each
job's brief) was measured on its own head, three runs: 31, 30 and 29 of 53.
Decide 18/23 on each. Front door 13, 12 and 11. Mean 30, spread 29 to 31.
That is the same band as the runs on main just before it (about 27 to 30).

## What a repeat is allowed to decide

A change is a gain only when the mean of several full runs sits above the
old band by more than the spread. One run at 31 is not a gain over a run at
29. Front door and Decide are reported apart, because a Decide wording
change does not move the front door and a front-door prompt does not move
Decide.

Subjective front-door lines (a reply that should be a little playful, or
one short line) flip between repeats of the same commit. The judge's reason
tracked the reply each time; the line itself is a judgment call. Loosening
those lines so a plain answer passes would be changing the test, not fixing
a judge that marked a playful reply as plain.

## A picture the front door's model refuses

The front door's fallback is `glm-4-7`, which cannot see a picture
(`pictureFallback` in `attachments.js`). When the seeing model fails and no
other seeing model is configured, the turn goes on with that fallback. One
Dev picture turn did this after HTTP 400; the fallback then described signs
it could not have read. A picture turn in the same runs was read by Haiku
and passed, so the 400 is not every picture. The 400's cause is not pinned.
What is pinned: the words the blind model was given said to admit it could
not see the picture, and did not say not to invent one. Those words now
forbid the guess (`plainAttachmentText`, and a picture inside a tool
result). A guess from a blind model still fails a line that requires the
picture to have been read. Stopping the guess does not, by itself, pass
that line.

## The style prompt contradicted the tapback

The capability list and `send` action `tapback` already allow a thanks, or
a finished ask with nothing new to say, to be answered by a tapback and no
words, and refuse that when the person tagged Tex by name. `how-you-talk`
still said a thanks gets "Anytime." and a finished ask gets "Done." The
only thanks example was words. The prompt now names the tapback in both
places, and one invented example shows it. `sees-own-reply` checks the
modules still say so.

## What would not be a simplification

Treating one Dev run as the score, or editing a prompt or a judge line so
that one starred row flips, puts the set back where an agent can train on
the cases that grade it. `apps/mcp/test/agentAttachments.test.mjs` fails if
a blind model is no longer told not to guess. `sees-own-reply` fails if the
style modules stop teaching the tapback.

Reaching 43 of 53 from a mean near 30 is not a wording pass of the size
that has already been tried. The misses that repeat are multi-step jobs
(a page, a booking, the advisor) inside a front door set to two rounds on
Haiku, answers given without a read, and an offer tacked on after the work.
A Sonnet front door was estimated, from production token counts, at
several hundred dollars a month more than Haiku, and it has not been
measured on this set. That spend is the owner's. The sealed Test set
still has no front-door stars, so the gate cannot see a front-door
regression. Only the owner can add those.
