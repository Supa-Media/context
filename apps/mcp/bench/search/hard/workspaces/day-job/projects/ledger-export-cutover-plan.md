# Ledger export cutover plan

Plan for cutting over the finance ledger export to the new warehouse table. The cutover date is set by the platform team.

- Flat ledger cutover date: not relevant to this work.
- The export runs nightly until the cutover; after it, the export reads the new table.
- Rollback: keep the old export for seven days after the cutover date.
