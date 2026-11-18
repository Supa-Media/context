# Lab Dev failures on 17 November 2026

The Lab Dev set is 53 starred labels: 30 front door, 23 Decide. This is the
14 newest full runs that finished on 17 November (Tex Lab run workflow,
runs 68, 69, 70, 72–75, 77–79 and 83–86). Each ran both conversations, both
nodes, on the commit's own graph rather than a Lab draft. Those commits
later merged to main. Partial runs (one node) and draft-graph runs are not
in this count.

No Dev item is quoted here. A cause is the mechanism of the failed line,
and, where one row mixed silence with a spoken miss, whether the reply was
silence. Counts are fail instances across the 14 runs, not unique tests.

## The score

| | passes | fails | per run |
| --- | ---: | ---: | ---: |
| Front door | 162 | 258 | 11.6 / 30 |
| Decide | 252 | 70 | 18 / 23 |
| Total | 414 | 328 | 29.6 / 53 |

The total ran from 26 to 32. Decide was 18/23 on every run. The front door
ran from 8 to 14. That is the band in
[dev-front-door-measure](./dev-front-door-measure.md).

## Front door

258 fails. Seven of the 30 front-door tests passed every run. 23 failed at
least once. 18 of those failed in at least 10 of the 14 runs.

| cause | fails | share | tests that failed ≥10/14 |
| --- | ---: | ---: | ---: |
| Grounding: answered about a note, page, mail, picture or stored record without using it | 66 | 25.6% | 5 |
| Agency: offered, promised, or talked instead of doing the act | 65 | 25.2% | 5 |
| Report shape: length, what to lead with, how long a lookup takes | 49 | 19.0% | 3 |
| Quiet vs speak: a tapback was required and words went out, or a check-in or job report stayed silent | 37 | 14.3% | 3 |
| Voice: playful, cheeky, or who was addressed | 36 | 14.0% | 2 |
| The reply was lost (the turn said the answer did not come back) | 5 | 1.9% | 0 |

Agency is the cluster [PR 3574](https://github.com/Supa-Media/context/pull/3574)
names (do the ask, and do not tack an offer on after it). It is not touched
again here. An earlier pass over the same day called agency about 41%. That
pass folded report shape and some voice into it. Split by mechanism, agency
is a quarter of the fails, and grounding is the largest share that 3574 does
not cover.

Grounding is not one phrase. The same five tests fail in at least 10 runs:
a fact that lives in notes or contacts, a stored booking, a picture, a lease
or page that was paraphrased, and a check-in that spoke without the fact the
mail held. The record check merged in
[PR 3550](https://github.com/Supa-Media/context/pull/3550) is a notice when
the ask matches a narrow pattern and any search counts as the read. The four
runs of that commit in this window scored 13, 12, 8 and 14 on the front
door. Mean 11.8, inside the band.

Quiet vs speak is three stable tests: a finished simple act that got a
sentence instead of a reaction, a reminder that got a confirmation sentence,
and a check-in or job report that stayed silent when it should have said
what came in. Voice is the playful and cheeky lines. Those flip between
repeats of one commit, and loosening them would be changing the test
([dev-front-door-measure](./dev-front-door-measure.md)).

## Decide

70 fails, five tests, each one wrong on all 14 runs. No other Decide test
failed.

| cause | fails | share |
| --- | ---: | ---: |
| Stayed quiet when the label is respond | 28 | 40% |
| Right action, wrong reason, and no reaction | 14 | 20% |
| Right action and reason, no reaction | 14 | 20% |
| Right action, wrong reason | 14 | 20% |

Two of the five are the speak-or-not choice. The other three already choose
quiet and miss the reason code, the reaction, or both. Reason wording moved
Decide from 17 to 18 and stopped there
([dev-front-door-measure](./dev-front-door-measure.md)).

## What 43 of 53 would take

43 is 80%. The mean here is 29.6, so the gap is about 13.4 points.

If every grounding fail and every quiet-vs-speak fail became a pass, and
nothing else moved, the mean would be about 37. If agency flipped as well,
about 42. That arithmetic gives each fail to the fix that names its
mechanism, and it assumes no regression. The runs already swing by 6 points
with no change. Voice, report shape and the five lost replies are still
about 6 points a run, and Decide's five stable misses are another 5.

So 43 is not what a wider notice or another sentence in the prompt has done.
The two causes under the agency work are grounding and quiet-vs-speak.
Together they are worth about 7 points if they fully flip, which lands near
37, not 43. Reaching 43 on the current Haiku front door still needs the
agency cluster to actually do the work (3574 is that sentence, not yet a
measured gain) and the report-shape and voice misses, which are several
different judgments rather than one mechanism. A front door that cannot
finish a multi-step job inside its send-back budget does not pick those up
by being told to.
