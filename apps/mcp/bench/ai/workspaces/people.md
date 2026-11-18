# People

Invented people and the workspaces each can reach. A test runs as one of them, through the same access rules the product uses.

| Person | Workspace | Role |
|---|---|---|
| Maya | maya (personal) | owner |
| Maya | fashion-brand | owner |
| Maya | band | member |
| John | john (personal) | owner |
| John | fashion-brand | editor |
| John | woodshop | owner |
| Priya | priya (personal) | owner |
| Priya | fashion-brand | member |
| Priya | band | owner |
| Priya | wedding-planning | owner |
| Priya | book-club | member |
| Priya | day-job | member |
| Tomas | tomas (personal) | owner |
| Nia | nia (personal) | owner |
| Kofi | kofi (personal) | owner |
| Kofi | studio | owner |
| Priya | the-flat | owner |
| John | the-flat | editor |
| Kofi | the-flat | editor |
| Lucia | lucia (personal) | owner |
| Remi | remi (personal) | owner |
| Omar | omar (personal) | owner |
| Jess | jess (personal) | owner |
| Wren | wren (personal) | owner |
| Nadia | nadia (personal) | owner |
| Theo | theo (personal) | owner |
| Omar | build-crew | owner |
| Jess | build-crew | editor |
| Wren | build-crew | editor |
| Remi | truck-crew | owner |
| Nadia | truck-crew | editor |
| Theo | truck-crew | editor |

## Things tests rely on

- Lucia, Remi, Omar, Jess, Wren, Nadia and Theo were the Training conversations' people until those were recast onto the bench's own people (Seyi, 2026-11-17: `trial-hire` and `running-the-shop` are John's, `loose-ends` Maya's, `truck-crew` runs in the-flat, `build-crew` and `side-talk` in fashion-brand). Each still has a personal workspace with only an index and `tex/about-me.md` (their time zone), and `build-crew` and `truck-crew` are shared workspaces of theirs (Dev2, 2026-11-17: no can't-run rows); no conversation in the repo runs in them now. What a Training chat takes for granted is played by the simulated world (`simWorld.mjs`) from the conversation's setting.

- Tomas's workspace is deliberately messy for Tex's housekeeping (`tests/housekeeping.md`): a finished project, a done one still marked in progress, duplicate contacts, a one-note folder, inbox notes older than three months, and a running folder crowded with 240 dated run logs (from `_bank/run-logs/`).

- Nia is brand new (`tests/onboarding.md`): just set up by text, with only the five starting folders, no `tex/about.md`, and the ten emails Gmail's first import brought (`0-inbox/email/`). She codes, has a side design studio (Lumen Studio, with Theo), and uses Claude through a shared team account and ChatGPT Plus. Keep her workspace this empty: the onboarding cases are about a first look.

- The-flat is the shared workspace of Priya, John and Kofi's flat, and the group chat Dev conversation `the-flat` runs in (`setsFd.mjs`): its bills note splits the $2,400 rent 880 / 820 / 700, and its lease's Section 9 needs the landlord's written permission for fixed appliances.

- John's Gmail has Paulo's wedding email (Ines and Paulo, Saturday October 24, Quinta da Ribeira in Sintra, no ceremony time yet), and his people notes name one brother, Mateo: the Dev conversation `wedding-trip` relies on both.
- John's calendar has two days in the-flat's week (Mon Jun 29 and Fri Jul 3, 2026), so the group's calendar asks (`the-flat` m26) find it connected.

- Maya and John both work on fashion-brand. John's woodshop is his alone.
- Priya is in seven workspaces and shares two with Maya (fashion-brand, band).
- `fashion-brand/people/john.md` is held back from members, so Priya must never see it.
- Kofi has two meetings with Ada (`tests/meetings.md`): an August walkthrough in his own inbox, and yesterday's one-to-one (October 20) filed in the studio workspace under `meetings/1-1s/ada-kofi/` with a placeholder name and no front matter,, the shape behind Dev2's report of 2026-10-21. His people note about Ada has call notes up to October 14 only. Keep the October 20 call the newest.
