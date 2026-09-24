# TICKET-4830 · Generation dropped ~40% at School Bristol

**Verdict:** not a platform bug. Inverter 2 stopped communicating at
2026-07-28 06:12 UTC. The platform received nothing from it, so nothing was
dropped.

## Evidence

### 1. Production by inverter

```sql
SELECT p.reading_date, a.name, p.production_kwh
FROM productions p
JOIN assets a ON a.id = p.asset_id
JOIN sites s ON s.id = a.site_id
WHERE s.slug = 'school-bristol' AND p.reading_date >= '2026-07-24'
ORDER BY p.reading_date, a.name;
```

| Day        | Inverter 1 (60 kW) | Inverter 2 (40 kW) |  Total |
| ---------- | -----------------: | -----------------: | -----: |
| 2026-07-27 |             328.00 |             218.50 | 546.50 |
| 2026-07-28 |             327.75 |                  — | 327.75 |
| 2026-07-29 |             331.50 |                  — | 331.50 |

546.50 → 327.75 kWh is a 40.0% drop, which is Inverter 2's share of site
capacity (40 of 100 kW). Inverter 1 is flat, so the weather was not the cause.

### 2. Connector state

```sql
SELECT a.name, ca.connector_vendor, ca.last_seen_at, ca.sync_state
FROM connector_assets ca
JOIN assets a ON a.id = ca.asset_id
JOIN sites s ON s.id = a.site_id
WHERE s.slug = 'school-bristol';
```

| Asset      | Last seen (UTC)  | Sync state |
| ---------- | ---------------- | ---------- |
| Inverter 1 | 2026-07-29 20:14 | ok         |
| Inverter 2 | 2026-07-28 06:12 | error      |

### 3. Vendor status poll

`connector-status-poll` (every 6 hours) asks FusionSolar for each device's status:

```sql
SELECT logged_at, level, message
FROM worker_logs
WHERE message ILIKE '%77412%'
ORDER BY logged_at;
```

Every poll since 2026-07-28 06:05 UTC ends with
`Status poll timed out for connector FU-SUN40-77412 (fusionsolar): ETIMEDOUT after 30000ms`,
so the device is unreachable for the vendor too. `alert-scan` raised an
`asset_offline` alert at 12:15 UTC on the 28th. It was raised twice; see TICKET-4847.

## Next steps

1. Support: check the FusionSolar portal for a fault code on FU-SUN40-77412.
2. Customer: ask someone on site to check the inverter display or status lights and its breaker.
3. If it was only a connection problem, the missing readings arrive through the
   normal push once the device is back online. If the inverter was off, that
   generation is lost, and the site loses about 40% of its output on every
   sunny day until it is fixed.

## Reply to the customer

> Hi Tom, thanks for getting in touch. The platform isn't dropping your data.
> One of your two inverters at School Bristol, Inverter 2, stopped
> communicating on the morning of 28 July, and that inverter accounts for 40%
> of the site's capacity, which matches the drop you saw. Inverter 1 is
> working normally.
>
> What we don't know yet is whether Inverter 2 has stopped generating or has
> only lost its connection. Could someone on site check whether the inverter's
> display or status lights are on, and whether its breaker has tripped? If it
> has stopped generating, the site is losing around 40% of its output every
> sunny day, so it's worth checking soon.
>
> We're also checking with the manufacturer on our side. You may have
> received our offline alert twice on the 28th. That was a fault on our side,
> and we're fixing it.
