---
type: API Endpoint
title: GET /api/adguard
description: AdGuard Home DNS query + block statistics and protection status.
resource: http://192.168.1.20
tags: [adguard, dns, telemetry, lan]
timestamp: 2026-06-23
---

# GET /api/adguard

Powers the AdGuard panel. Served by the [Haven Broker](../systems/haven-broker.md),
which calls **AdGuard Home** on the LAN. Polled every **30 seconds**.

**Reachability: LAN-only.** Upstream `ADGUARD_URL` (documented example
`http://192.168.1.20`; broker code default `http://127.0.0.1`) is a private
address — not reachable from a public edge runtime. See
[Network Topology](../reference/network-topology.md).

## Auth

HTTP Basic, `ADGUARD_USER` : `ADGUARD_PASS`. Calls:

- `GET /control/stats` — query / block counts
- `GET /control/status` — `ServerStatus` protection fields (`protection_enabled`,
  `protection_disabled_duration`, `running`)

When `/control/status` fails but stats succeed, stats are still returned and
protection fields are `null` (unknown). The UI must not treat unknown as enabled.

# Schema

Response is `Envelope<Adguard>`:

| Field | Type | Source |
|---|---|---|
| `queries` | number | `num_dns_queries` |
| `blocked` | number | `num_blocked_filtering` |
| `blocked_pct` | number | `blocked / queries` × 100, 1 decimal |
| `protection_enabled` | boolean \| null | `/control/status` `protection_enabled`; null if status unavailable |
| `protection_disabled_duration_ms` | number \| null | `/control/status` `protection_disabled_duration` (ms remaining while paused; 0 when not paused) |
| `running` | boolean \| null | `/control/status` `running` |

# Citations
- `server/broker.ts` → `fetchAdguard`
- `src/api.ts` → `Adguard` interface
- AdGuard Home OpenAPI `ServerStatus`
