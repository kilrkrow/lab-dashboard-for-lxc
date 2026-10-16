---
type: API Endpoint
title: GET /api/status
description: Up/down state and response-time history for each service tile, from Uptime Kuma or a direct probe.
resource: https://github.com/kilrkrow/lab-dashboard-for-lxc/blob/main/server/broker.ts
tags: [status, uptime-kuma, probe, lan]
timestamp: 2026-10-16
---

# GET /api/status

Feeds the tile status dots and the `grafana: true` sparkline. Served by the
[Haven Broker](../systems/haven-broker.md).

**Reachability: LAN.** Probes and Uptime Kuma are LAN services.

## Which tiles

Every `http(s)` tile in a category with `"svc": true`, plus any tile with
`"grafana": true`, read from the **on-disk** `config.json` (never from the
request). Tiles applied only in the editor session show grey until saved.

## How state is decided

1. If `KUMA_URL` is set, GET `${KUMA_URL}/metrics` (Basic auth, empty user,
   `KUMA_API_KEY` as password) and parse `monitor_status` / `monitor_response_time`.
   A tile matches a monitor by name (case-insensitive), then by monitored URL
   host:port, then by a TCP-port monitor on the same host:port. Ping monitors
   are ignored (machine up ≠ service up). Kuma status 1/0/2/3 → up/down/pending/maintenance.
2. Otherwise the broker GETs the tile URL (4 s timeout, TLS not verified,
   body not read). Any HTTP status below 500 → up; 5xx, refused, DNS failure or
   timeout → down.

## Response

`Envelope<Record<url, TileStatus>>`, where `TileStatus` is
`{ state, source: 'kuma'|'probe', ms, history: number[], detail? }`.
`history` holds up to 24 recent response times. Results are cached 30 s and
concurrent requests share one refresh. If Kuma fails, `ok` stays true, `error`
carries the Kuma error, and every tile falls back to probes.

# Citations
- `server/broker.ts` → `fetchStatus`, `refreshStatus`, `parseKumaMetrics`, `matchMonitor`, `probe`
- `src/App.tsx` → `AppTile`
