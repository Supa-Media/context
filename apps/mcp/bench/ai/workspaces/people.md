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

## Things tests rely on

- Maya and John both work on fashion-brand. John's woodshop is his alone.
- Priya is in six workspaces and shares two with Maya (fashion-brand, band).
- `fashion-brand/people/john.md` is held back from members, so Priya must never see it.
