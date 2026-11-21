# Export job runbook

This runbook covers the nightly export job that copies the finance ledger into the reporting warehouse. It is owned by the data platform rota, and the rota owner keeps it current after each incident. Read the whole page before you change anything, because the steps depend on each other.

## Purpose

The export reads the ledger tables after the close of business, writes one file per entity, and loads the files into the reporting warehouse. Finance reads the warehouse at nine in the morning, so the job must finish before seven. Most of the time it does. When it does not, the reporting team sees yesterday's figures and asks in the group chat, which is the signal that this runbook is needed.

The job has three stages. The extract stage pulls rows from the ledger, using the watermark stored with the last successful run. The transform stage normalises currency codes, drops test entities and writes the files. The load stage uploads the files and then moves a marker that tells the warehouse the day is ready. Each stage can fail on its own, and each leaves a log line with the run identifier.

## Schedule

The job starts at 22:30 UTC on weekdays and at 23:30 UTC on Saturdays, when the weekly close adds a second pass. There is no weekend run on Sunday. A manual run can be started from the scheduler page by anyone on the rota, with the run identifier of the failed run pasted into the reason field so the log can be joined later.

Do not start a second run while the first is still in the extract stage. The watermark is only written at the end of a successful load, so two runs at once read the same rows and write the same files twice. The warehouse de-duplicates by file name, but the marker file does not, and a duplicate marker makes the dashboards show double totals for an hour.

## Inputs

The job needs three inputs. The first is the ledger connection, which is held in the secrets store and never written in this page or in the logs. The second is the watermark, a timestamp in the job's own state table. The third is the list of entities, kept in the configuration folder, which says which entities are reported and which are internal.

If the entity list changes, the job must be restarted from a clean watermark, not from the last one. A new entity with no rows before the watermark is silently missing from history otherwise. The change is made in the configuration folder first, then the job is restarted with the flag that resets the watermark to the start of the financial year.

## Steps for a normal night

1. Check the scheduler page at 22:45 UTC. The run should be in the extract stage with a row count rising.
2. At about 23:10 UTC the transform stage starts. Its log should show one file per entity in the configured list.
3. The load stage uploads the files. A marker named with today's date appears in the warehouse bucket when the load is complete.
4. Post a one-line status in the team channel: the run identifier, the row count and the marker time.

If the marker is not there by 06:30 UTC, the on-call engineer starts the escalation in the next section. Do not wait for the reporting team to ask.

## Checks

The job runs three checks before it writes the marker. The row count check compares the extract with the average of the last four weeks, and fails if the count is below half or above double. The balance check sums the debits and the credits per entity and fails on any difference. The entity check confirms that every reported entity has at least one file.

A failed check stops the run before the marker. The run is left in its failed state so the log can be read. Do not clear the failed state until the check's cause is written in the incident note, because clearing it lets a retry overwrite the evidence.

## Alerts

Alerts go to the on-call channel. A row-count alert means the ledger changed shape or a large batch was posted late; ask finance before you rerun. A balance alert is always treated as serious, even when the difference is small, because it usually means a half-written batch. The alerts are muted between 22:00 and 23:00 UTC on the close day only.

The job also sends a daily digest to the reporting team at 07:00 UTC, which lists the run identifier, the time the marker was written and any check that was overridden. An override is recorded in the digest and needs a name against it.

## Rollback

Rollback is the last resort, and it is a two-step action. First, stop the scheduler entry so no new run starts. Second, restore the warehouse tables from the nightly snapshot named by the run identifier of the last good run. The snapshot is kept for seven days.

Do not rerun the migration script to undo a bad load. The migration script changes the table layout as well as the rows, and rerunning it on a table that already has the new layout drops the columns that the reports read. Restore from the snapshot instead, then rerun the export with the watermark set to the snapshot's time.

After a rollback, post in the team channel what was restored, from which snapshot, and whether the reporting team needs to re-open any figure they already shared. Record the rollback in the incident note the same day.

## Known issues

The transform stage is slow on the first working day of a quarter, when the chart of accounts changes. The job is allowed to run until 08:00 UTC on those days and the alert threshold is raised by an hour. The raise is not automatic; the rota owner sets it.

The load stage occasionally times out on the warehouse upload when the bucket is busy. The retry is automatic, once, after five minutes. If the second attempt fails, the file set is left in the staging prefix and the marker is not written.

## Contacts

The rota owner is named in the rota page for the current quarter. The finance contact for ledger questions is in the finance team's folder, not here. The platform team's second line takes over after two hours without an answer from the primary.

## Change history

The job was first written for the monthly close and was moved to nightly runs when the reporting team asked for the figures every morning. The move added the watermark, which was the largest single change. Before the watermark, every run read the whole ledger, and the job took most of a night. After it, the extract reads only the rows posted since the last good load.

The second change added the balance check after a half-written batch reached the dashboards for a whole day. The third change split the transform stage out, so a transform failure no longer leaves the extract's files in the bucket with no marker. Each change has an entry in the incident log with its run identifier, and the entries are the place to look when the job behaves differently from this page.
