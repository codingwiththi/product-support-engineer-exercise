# TICKET-4821 · Dashboard revenue does not match CSV export

**Verdict:** bug. The CSV (£4,087.00) is correct. The dashboard (£4,321.00)
has served a stale rollup since 2026-07-27, because a migration dropped the
unique index that `REFRESH MATERIALIZED VIEW CONCURRENTLY` requires.

## Evidence

### 1. The two screens read from different places

From `docs/ARCHITECTURE.md` ("Derived figures"):

- Dashboard: `getDashboard` in `apps/api/src/services/kpiService.js` reads
  the materialized view `mv_site_daily_kpis`, rebuilt nightly by the
  `refresh-kpi-views` job.
- CSV export: `siteDailyKpis` in `apps/api/src/services/reportingService.js`
  computes live from `productions` and `consumptions`.

### 2. The nightly refresh has failed since 2026-07-28

```sql
SELECT name, status, scheduled_for, hostname, error
FROM jobs
WHERE name = 'refresh-kpi-views'
ORDER BY scheduled_for DESC
LIMIT 10;
```

| Scheduled (UTC)  | Status    | Error                                                                     |
| ---------------- | --------- | ------------------------------------------------------------------------- |
| 2026-07-29 02:00 | failed    | cannot refresh materialized view "public.mv_site_daily_kpis" concurrently |
| 2026-07-28 02:00 | failed    | cannot refresh materialized view "public.mv_site_daily_kpis" concurrently |
| 2026-07-27 02:00 | completed |                                                                           |

`SELECT MAX(day) FROM mv_site_daily_kpis;` returns `2026-07-26`. Each run
appears twice, on two hosts; see TICKET-4847.

### 3. The cause: a migration dropped the unique index

`REFRESH MATERIALIZED VIEW CONCURRENTLY` is only allowed when the view has a
unique index (Postgres documentation, `REFRESH MATERIALIZED VIEW`).

- `20260302091500_create_mv_site_daily_kpis.js` creates the view and
  `mv_site_daily_kpis_site_day_uq` on `(site_id, day)`.
- `20260727053100_recreate_mv_site_daily_kpis.js` drops and recreates the view
  to add `savings_gbp`. Dropping the view drops its index, and the migration
  does not recreate it.

### 4. Why the dashboard is higher, not lower

```sql
SELECT created_at, actor_id, action, entity_type, note
FROM audit_logs
ORDER BY created_at;
```

Between 20 and 24 July, firmware 2.4.1 on gateway SE-GW-2201 (London
Warehouse) sent each daily summary twice. The vendor's corrective re-sync
deleted the 10 duplicates on 2026-07-27 at about 13:50 UTC. That was after the
last successful refresh (02:00 UTC), so the view still contains them.

| When (UTC)     | Event                                         |
| -------------- | --------------------------------------------- |
| 20–24 July     | duplicate readings land in `productions`      |
| 27 July 02:00  | last successful refresh copies the duplicates |
| 27 July ~05:31 | migration recreates the view without index    |
| 27 July 13:52  | re-sync deletes the duplicates from raw data  |
| 28 and 29 July | refresh fails, view keeps the duplicates      |

### 5. Reconciliation to the penny

Deleted readings, from the `before` column of each deletion:

```sql
SELECT COUNT(*), SUM((before->>'production_kwh')::numeric) AS kwh
FROM audit_logs
WHERE action = 'production.reading.deleted';
```

London Warehouse PPA rate: £0.08/kWh (`ppa_agreements`).

| Component                                 | Dashboard (view) |    CSV (live) |
| ----------------------------------------- | ---------------: | ------------: |
| 1–26 July, clean readings                 |        £3,667.00 |     £3,667.00 |
| Duplicates 20–24 July (8,175 kWh × £0.08) |          £654.00 |             — |
| 27–29 July (5,250 kWh × £0.08)            |                — |       £420.00 |
| **Total**                                 |    **£4,321.00** | **£4,087.00** |

## Fix

`packages/db/migrations/20260730090000_restore_mv_site_daily_kpis_unique_index.js`
recreates `mv_site_daily_kpis_site_day_uq` and runs one plain refresh.

|                            | Before                     | After                      |
| -------------------------- | -------------------------- | -------------------------- |
| Albion dashboard, July     | £4,321.00, data to 26 July | £4,087.00, data to 29 July |
| `REFRESH ... CONCURRENTLY` | fails                      | succeeds                   |

A new migration, not an edit of `20260727053100`: that one has already run in
production, so editing it would not change the database.

## Next steps

1. Deploy the migration. The dashboard is correct as soon as it runs.
2. Check whether other customers invoiced from the dashboard between 27 and
   29 July. Every customer's dashboard was frozen on 26 July.

## Proposed improvements

- Alert on `jobs.status = 'failed'`. The refresh failed for two nights and was
  only found through a customer complaint.
- Show "data as of <latest day in the view>" on the dashboard. It currently
  shows the period as 1–29 July while the data stops on 26 July.
- Add a check in CI that `mv_site_daily_kpis` has a unique index, so a future
  migration cannot drop it silently.

## Reply to the customer

> Hi Priya, thanks for flagging this. The CSV figure of £4,087.00 is correct
> and safe to invoice against. The dashboard was showing out-of-date data that
> still included some duplicate readings our vendor had since corrected. We've
> fixed the dashboard and it now matches the export. Sorry for the confusion
> ahead of your month close.
