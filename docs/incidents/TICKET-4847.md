# TICKET-4847 · Duplicate offline alerts

**Verdict:** bug. On 2026-07-22 the worker pool was scaled from one replica
to two. The scheduler was built as a single process, so every job now runs
once per replica, and `alert-scan` raised the same alert twice.

## Evidence

### 1. The design says one scheduler

`docs/ARCHITECTURE.md`, "Workers": "A single scheduler process
(`apps/api/src/workers/index.js`) runs all jobs." The `jobs` table shows two
hosts, `worker-7c2a1e` and `worker-6b9f4d`, running every job.

### 2. Ops scaled the pool on 22 July

```sql
SELECT created_at, actor_id, action, entity_id, before, after, note
FROM audit_logs
WHERE entity_type = 'infrastructure';
```

2026-07-22 15:40 UTC, `ops@metris.energy`, `worker.replicas.updated`,
`{"replicas": 1}` → `{"replicas": 2}`: "Scale out worker pool ahead of Q3
onboarding batch."

### 3. Duplicates start right after the change

```sql
SELECT name, scheduled_for, COUNT(*) AS runs
FROM jobs
GROUP BY name, scheduled_for
HAVING COUNT(*) > 1
ORDER BY scheduled_for
LIMIT 5;
```

The first duplicated run is `refresh-kpi-views` at 2026-07-23 02:00 UTC, the
first scheduled run after the scale-out. No job was duplicated before it.

### 4. Why the check in the code did not stop it

`apps/api/src/workers/jobs/alertScan.js` checks for an open alert and then
inserts. These are two separate steps (check-then-act). The two runs on
28 July overlapped:

```sql
SELECT hostname, started_at, finished_at
FROM jobs
WHERE name = 'alert-scan' AND scheduled_for = '2026-07-28 12:15:00+00';
```

| Time (UTC)   | worker-6b9f4d                 | worker-7c2a1e                 |
| ------------ | ----------------------------- | ----------------------------- |
| 12:15:06.812 | starts                        |                               |
| 12:15:07.104 |                               | starts                        |
| …            | checks: no open alert         | checks: no open alert         |
| 12:15:09.612 | inserts alert #6 (Inverter 2) |                               |
| 12:15:10.204 |                               | inserts alert #7 (Inverter 2) |

Both checked before either had inserted, so both inserted.

### 5. Wider impact

- `refresh-kpi-views` rebuilds the rollup twice a night.
- `connector-status-poll` calls vendor APIs twice as often, which risks vendor
  rate limits.

## Fix

Two layers:

1. **One run per job:** `apps/api/src/workers/lib/jobRunner.js` takes a
   Postgres session advisory lock named after the job. A replica that cannot
   take it logs `skipped — already running on another worker` and does not run.
2. **The database refuses duplicates:**
   `packages/db/migrations/20260730090100_dedupe_open_alerts.js` adds a partial
   unique index, at most one open alert per `(asset_id, type)`, and
   `alertScan.js` inserts with `ON CONFLICT DO NOTHING`.

The same migration resolves the existing duplicate. It keeps alert #6 open,
because Inverter 2 is still offline (TICKET-4830), and resolves #7 with an
`audit_logs` entry: "Duplicate of alert 6 raised by concurrent alert-scan runs."

Tested locally by starting two workers at the same time:

|                   | Before        | After                        |
| ----------------- | ------------- | ---------------------------- |
| alert-scan runs   | 2             | 1 (the other logs `skipped`) |
| refresh-kpi-views | 2             | 1                            |
| Alerts per asset  | 2 (#6 and #7) | 1                            |

## Limits

- The lock stops overlapping runs, not back-to-back ones. If one replica
  finishes before the other starts, both run. For alerts the unique index
  covers that case; for the other jobs it only wastes work.
- Long term: claim each run by `(name, scheduled slot)`, or move to a job queue.

## Next steps

1. Today, before the code ships: scale the worker pool back to one replica.
   It is quick and reversible.
2. Deploy the fix, then scale back out for the Q3 onboarding.
3. Tell Northgate the duplicate email was our fault (included in the
   TICKET-4830 reply).

## Reply to ops

> Hi Daniel, found it. The worker pool was scaled from one to two replicas on
> 22 July, and the scheduler wasn't built to run twice, so every job has been
> running on both workers since the 23rd. The two alert-scan runs on the 28th
> overlapped and both raised the School Bristol alert. Keep alert #6 open,
> since Inverter 2 is genuinely still offline (TICKET-4830), and close #7 as a
> duplicate. The fix makes sure only one worker runs each job and stops the
> database from accepting a second open alert. Until it ships, it's safest to
> scale the workers back to one.
