---
type: System
title: Haven Lab Dashboard
description: A static React SPA homelab dashboard backed by a local Node broker, hosted on a LAN host (Proxmox LXC).
resource: https://github.com/kilrkrow/lab-dashboard-for-lxc
tags: [homelab, react, vite, spa, dashboard]
timestamp: 2026-06-23
---

# Haven Lab Dashboard

A premium, lightweight homelab dashboard (glassmorphism UI). The frontend is a
Vite + React 19 SPA that compiles to pure static assets. All live data and the
dashboard config are fetched **at runtime** from same-origin paths served by the
[Haven Broker](haven-broker.md).

The "lab-dashboard-for-lxc" name reflects its design goal: run on an ultra-low-
resource LAN host (the README cites "an LXC with 30MB of RAM") with no Docker.

## Architecture

- **Frontend:** `src/App.tsx` (single-page app), built with `npm run build` → `dist/`.
- **Backend:** [Haven Broker](haven-broker.md) (`server/broker.ts`) serves
  the API, `/config.json`, and the static `dist/` with SPA fallback.
- **Data envelope:** every data call returns `Envelope<T>` =
  `{ ok, stale, mock?, ts, data, error? }` (see `src/api.ts`). The UI uses
  `stale` to show cached-vs-live state, so a brief upstream outage degrades a
  panel gracefully rather than blanking it.

## Runtime polling cadence

Defined in `src/App.tsx`. This is the heart of the dashboard — most of it is live, not static:

| Panel | Path | Interval |
|---|---|---|
| Network (DR7) | [`/api/dr7`](../endpoints/api-dr7.md) | 3s |
| Proxmox | [`/api/proxmox`](../endpoints/api-proxmox.md) | 5s |
| AdGuard | [`/api/adguard`](../endpoints/api-adguard.md) | 30s |
| GitHub repos | [`/api/repos`](../endpoints/api-repos.md) | 5 min |
| Config | [`/config.json`](../endpoints/config-json.md) | once on load |
| Config save | [`PUT /api/config`](../endpoints/api-config.md) | on "Sync to GitHub" |

## Trust boundary

There is **no application-level authentication anywhere in the code.** Today the
dashboard is protected only by being reachable on the LAN. Any migration that
exposes it to the public internet must add an access layer (see
[Network Topology](../reference/network-topology.md)).

# Citations
- `src/App.tsx` (polling intervals, envelope use, config editor)
- `src/api.ts` (`Envelope<T>`, typed data shapes)
- `README.md` ("zero overhead" design goal)
