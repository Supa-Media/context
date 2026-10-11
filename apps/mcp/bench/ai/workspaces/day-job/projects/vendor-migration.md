---
status: in progress
---

# Vendor migration

Moving the carrier booking feed from the old file transfer to the new API.

- Old feed: runs at 2 am, two retries.
- New API: tested in staging, rate limit is 100 requests a minute.
- Cutover planned for the second week of November.
- Rollback: keep the old feed on for two weeks after cutover.
