# A Sonnet front door stays inside the Haiku band (2026-11-17)

Three Dev front-door slices, on a Lab draft that sets the front door's model
to `sonnet-5-5` and was not promoted, on main `e21f02ef`:

| Slice | Front door | costUsd | Wall clock |
| --- | --- | --- | --- |
| 1 | 12/30 | $1.413 | 693 s |
| 2 | 14/30 | $0.912 | 688 s |
| 3 | 9/30 | $1.470 | 680 s |

Mean 11.7 of 30, spread 9 to 14. The Haiku front door in the same week sits
at 11 to 13 of 30. The mean does not clear that band. A Dev score of 43 of
53, with Decide staying at 18 of 23, needs a front door near 25 of 30. The
best of these three was 14.

Mean cost $1.27 a slice. A Haiku full Dev run the same week is about $0.11
to $0.18, and nearly all of that is the front door, so the Lab bill is about
8 to 12 times Haiku. The list price is 20 times on every token. The last
measured production front-door bill was about $0.73 a day on Haiku
(2026-11-05; not remeasured on current traffic). Ten times that is about
$200 more a month. Twenty times is about $420 more a month.

The two full Dev runs of the wide record check (`15e20646f`, before "note"
and "page" were limited to a determiner right against them) were 32 of 53
(front door 14, Decide 18, $0.3512) and 26 of 53 (front door 8, Decide 18,
$0.1082). Mean 29, spread 26 to 32, which does not sit above the 29 to 31
band. The code that merged in #3550 is the narrower pattern. These two runs
did not measure it.

Picture turns still failed on Sonnet. The provider's HTTP 400 body is not in
the GitHub log or the Lab row: the gateway records the payer and the status
only.
