---
type: Service
title: Haven Broker
description: Dependency-free Node HTTP service that brokers UniFi, Proxmox, AdGuard, and GitHub, serves config.json, and serves the static SPA.
resource: https://github.com/kilrkrow/lab-dashboard-for-lxc/blob/main/server/broker.ts
tags: [node, broker, backend, homelab, secrets]
timestamp: 2026-06-23
---

# Haven Broker

A single-file Node service (`server/broker.ts`, ~27KB, **no npm dependencies** —
uses only `node:http`/`node:https`). It is the dashboard's only backend. It
exists to (a) inject secrets server-side so the static frontend never holds
them, and (b) reach LAN services the browser can't.

## Responsibilities

1. **Brokers four upstreams**, each behind its own credentials:
   - [`/api/dr7`](../endpoints/api-dr7.md) → UniFi OS (LAN, self-signed TLS)
   - [`/api/proxmox`](../endpoints/api-proxmox.md) → Proxmox VE (LAN)
   - [`/api/adguard`](../endpoints/api-adguard.md) → AdGuard Home (LAN)
   - [`/api/repos`](../endpoints/api-repos.md) → GitHub REST API (public internet)
2. **Read/write config:** [`GET /config.json`](../endpoints/config-json.md) and
   [`PUT /api/config`](../endpoints/api-config.md) (disk write + GitHub commit).
3. **Serves static assets** from `../dist` with SPA fallback to `index.html`.

## Run

- Dev: `npm run broker` (`node --import=tsx/esm server/broker.ts`)
- Prod: `npm run broker:build` then `npm run broker:start` (`node dist-server/broker.js`)
- Listens on `PORT` (default **3000**), binds `0.0.0.0`.

## Configuration

All via env / `.env` (see `.env.example`). Secrets never reach the browser.
Key vars: `UNIFI_URL`/`UNIFI_API_KEY` (or `UNIFI_USER`/`UNIFI_PASS`),
`PROXMOX_URL`/`PROXMOX_TOKEN`/`PROXMOX_NODE`, `ADGUARD_URL`/`ADGUARD_USER`/
`ADGUARD_PASS`, `GITHUB_TOKEN`/`GITHUB_USER`, `CONFIG_PATH`, `PORT`.

## Resilience model

Each upstream fetch keeps a last-good in-memory cache. On upstream failure the
broker returns the cached payload marked `stale: true` (or `fail()` with no data
if nothing was ever cached). This is what lets the UI ride out blips.

## Caveats / gotchas

- `rejectUnauthorized: false` is the default on outbound fetches — required for
  UniFi's self-signed cert, but it means the broker does not verify upstream TLS.
- Sets `access-control-allow-origin: *` on API responses.
- The broker reads `editConfigUrl` out of the on-disk config to know where to
  commit on `PUT /api/config` — config and code are coupled through that field.

# Citations
- `server/broker.ts` (whole file)
- `package.json` (`broker`, `broker:build`, `broker:start` scripts)
- `.env.example` (configuration surface)
