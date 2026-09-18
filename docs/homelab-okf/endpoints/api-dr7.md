---
type: API Endpoint
title: GET /api/dr7
description: UniFi network telemetry (WAN throughput, clients by band, gateway health, PoE) for the "DreamRouter7" panel.
resource: https://192.168.1.1
tags: [unifi, network, telemetry, lan, dr7]
timestamp: 2026-06-23
---

# GET /api/dr7

Powers the dashboard's network panel ("DR7"). Served by the
[Haven Broker](../systems/haven-broker.md), which talks to **UniFi OS** on the LAN.
Polled every **3 seconds** by the SPA.

**Reachability: LAN-only.** The upstream (`UNIFI_URL`, default `https://192.168.1.1`)
is a private address. Any host serving this endpoint must sit on — or tunnel into —
the LAN. A public edge runtime cannot reach it. See [Network Topology](../reference/network-topology.md).

## Auth (mirrors the UniFiHUD C# service)

1. Prefer `UNIFI_API_KEY` via `x-api-key` (stateless, no CSRF).
2. Fall back to `UNIFI_USER`/`UNIFI_PASS` session login (`/api/auth/login` → `/api/login`), capturing cookies + CSRF token.
3. Site resolved via `/integration/v1/sites` (API key) or `/api/s/default` (session).
4. On 401/403, auth state is reset and re-established on the next poll.

# Schema

Response is `Envelope<Dr7>`. `Dr7`:

| Field | Type | Notes |
|---|---|---|
| `wan` | `{ status, down_mbps, up_mbps, latency_ms, ip, port, source?, stale?, error? }` | **prefer Starlink dish** (`downlink_throughput_bps` / `uplink_throughput_bps` ÷ 1e6; already bits/sec — do not ×8) when `STARLINK=1`. Else UniFi gateway `uplink['rx_bytes-r' / 'tx_bytes-r']` × 8 / 1e6 |
| `clients` | `{ total, wired, wireless }` | from `stat/sta` |
| `radios` | `[{ band, clients, util_pct }]` | bands 6 / 5 / 2.4 by `radio` (`6e` / `na` / `ng`) |
| `gateway` | `{ cpu_pct, mem_pct, temp_c, uptime_days }` | from `system_stats` + `temperatures` |
| `poe` | `{ used_w, max_w }` | `max_w` hardcoded 15.4 |

WAN rates: Starlink dish gRPC (`192.168.100.1:9200`, same fields as wan-glass
`starlink_status.proto`) when enabled; UniFi uplink counters otherwise.
Clients / radios / gateway / PoE still come from UniFi `stat/device` + `stat/sta`.
Dish unreachable → last-good Starlink sample marked `wan.stale` (broker stays up).

# Citations
- `server/broker.ts` → `fetchDr7`, `fetchDr7FromUnifi`, `mergeStarlinkWan`
- `server/starlink.ts` → dish gRPC client (wan-glass equivalent)
- `src/api.ts` → `Dr7`, `Radio` interfaces
