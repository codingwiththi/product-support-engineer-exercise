# TICKET-4835 · Revenue showing £0 for Factory Manchester

**Verdict:** not a code bug. The Factory Manchester PPA ended on 2026-06-30
and no agreement covers July, so revenue is priced at £0. The same gap
inflates savings. Whether the contract was renewed is a question for the
account team.

## Evidence

### 1. How revenue and savings are calculated

From `docs/ARCHITECTURE.md` ("Derived figures"):

- revenue = production × PPA rate for the reading date
- savings = self-consumed × (grid import tariff − PPA rate)

The revenue page uses `siteDailyKpis` in
`apps/api/src/services/reportingService.js`. It joins the agreement whose
window covers each day and falls back to 0 when there is none:

```sql
LEFT JOIN ppa_agreements pa
  ON pa.site_id = s.id AND pa.status = 'active' AND d.day BETWEEN pa.start_date AND pa.end_date
...
COALESCE(dp.production_kwh, 0) * COALESCE(pa.rate_per_kwh, 0)                       -- revenue
(COALESCE(pr.price_per_kwh, 0) - COALESCE(pa.rate_per_kwh, 0))                      -- savings
```

### 2. The Manchester agreement ended on 30 June

```sql
SELECT s.slug, pa.rate_per_kwh, pa.start_date, pa.end_date, pa.status
FROM ppa_agreements pa
JOIN sites s ON s.id = pa.site_id
WHERE s.slug = 'factory-manchester';
```

| Rate  | Start      | End        | Status |
| ----- | ---------- | ---------- | ------ |
| £0.12 | 2025-07-01 | 2026-06-30 | active |

No row covers July, so from 2026-07-01 the rate is `NULL` and becomes 0.

### 3. Leeds had the same end date and was renewed

```sql
SELECT created_at, actor_id, action, entity_id, after, note
FROM audit_logs
WHERE entity_type = 'ppa_agreement'
ORDER BY created_at;
```

On 2026-06-28 ops entered the Leeds Depot renewal (2026-07-01 → 2031-06-30,
"countersigned copy filed") and marked the old agreement `superseded`. There is
no equivalent entry for Manchester.

### 4. Impact, 1–29 July (38,989 kWh produced)

With the grid tariff at £0.28:

|         |  Shown now | If the £0.12 rate had continued |
| ------- | ---------: | ------------------------------: |
| Revenue |      £0.00 |                       £4,678.71 |
| Savings | £10,916.99 |                       £6,238.28 |

Savings per kWh went from £0.16 (0.28 − 0.12) to £0.28 (0.28 − 0), which is
why the customer saw savings go up.

## Next steps

1. Ask the Pennine Group account manager whether the Manchester renewal was
   signed (for Leeds, a countersigned copy was filed).
2. If it was renewed: ops enters it the same way as Leeds, through the audited
   flow, not a direct database update. The revenue page and CSV correct
   immediately; the dashboard corrects on the next nightly refresh (which
   depends on the TICKET-4821 fix).
3. If it was not renewed: £0 revenue is correct and the customer needs a
   commercial conversation. Savings are still overstated, because they assume
   the solar energy is free. That needs a product decision.

## Proposed improvements

- Show "No active agreement" instead of £0.00 when a site has production but no
  agreement covers the day. Keep showing production, because it is real.
- Alert ops 60 days before any `ppa_agreements.end_date`, so renewals are
  entered before customers see the gap.

## Reply to the customer

> Hi Rachel, thanks for flagging this. Factory Manchester is generating
> normally. The £0 revenue is because our records show the site's power
> purchase agreement ending on 30 June 2026, and we don't have a renewal on
> file yet, so July's generation isn't being priced. The same gap is why
> savings look higher: they're being calculated as if the energy were free.
>
> We're checking with your account manager whether the renewal was signed. If
> it was, we'll add it and the figures will update straight away. We'll come
> back to you once we've confirmed.
