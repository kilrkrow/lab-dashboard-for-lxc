---
type: API Endpoint
title: GET /api/lab
description: One health rollup for Proxmox VE, Proxmox Backup Server and Portainer, feeding the Lab health light and its host panel.
resource: https://github.com/kilrkrow/lab-dashboard-for-lxc/blob/main/server/broker.ts
tags: [proxmox, pbs, portainer, health, lan]
timestamp: 2026-10-16
---

# GET /api/lab

Feeds the **Lab health** card in the vitals row and the slide-over panel it
opens (`/#health`). Served by the [Haven Broker](../systems/haven-broker.md).
Cached 30 s; concurrent requests share one refresh; `?refresh=1` forces one.

**Reachability: LAN.** All three upstreams are LAN services.

## Sources (each optional, read-only)

| Group | Env | Role | Calls |
|---|---|---|---|
| `proxmox` | `PROXMOX_HOST`, `PROXMOX_TOKENID` + `PROXMOX_SECRET` (or `PROXMOX_TOKEN`) | PVEAuditor on `/` | `GET /api2/json/cluster/resources` |
| `backups` | `PBS_HOST` (port 8007 default), `PBS_TOKENID` + `PBS_SECRET` | Audit on `/` | `GET /api2/json/status/datastore-usage`, `GET /api2/json/nodes/localhost/tasks?since=<15 d>` |
| `docker` | `PORTAINER_HOST` (port 9443 default), `PORTAINER_TOKEN` (`X-API-Key`) | non-admin user with access to each environment | `GET /api/endpoints`; `GET /api/endpoints/{id}/docker/containers/json?all=1` only when a snapshot shows stopped or unhealthy containers |

A source with no token is `off` and its light is grey. A configured source that
fails (401, refused, timeout) is amber with a "Can't reach …" finding.

## Rules (findings)

- Guest not running, unless its name or vmid is in `LAB_EXPECTED_STOPPED` → red
- Node not online → red
- Storage or datastore ≥ `LAB_STORAGE_WARN` (80) → amber, ≥ `LAB_STORAGE_BAD` (92) → red
- Any failed backup in the latest run (tasks within 3 h of the newest) → red
- Newest backup older than `LAB_BACKUP_MAX_AGE_H` (26) → amber
- No verify job within `LAB_VERIFY_MAX_AGE_D` (14) days → amber
- Last garbage collection failed → amber
- Container exited with a non-zero code or restarting → red; `(unhealthy)` → amber.
  `Exited (0)` one-shot jobs are ignored.

## Response

`Envelope<LabHealth>`: `{ state, groups: {proxmox, backups, docker}, findings[], hosts[], sources }`.
States are `ok | warn | bad | unknown`. `findings` are sorted worst first.
`hosts` holds one entry per PVE node (`kind: 'pve'`), the PBS (`'pbs'`) and
each Portainer environment (`'portainer'`). See `LabHealth` in `src/api.ts`.
