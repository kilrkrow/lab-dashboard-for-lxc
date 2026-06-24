---
okf_version: "0.1"
---

# Haven Lab — Knowledge Bundle

An [OKF v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
bundle describing the **Haven Lab Dashboard** homelab as it exists **today**
(pre-migration, 2026-06-23). It captures the architecture, the broker's HTTP
surface, the LAN topology, and the deploy runbook — the context an agent would
otherwise have to reverse-engineer from `server/broker.ts` every time.

This is the durable *knowledge* layer. Time-bound migration *decisions* live as
RFCs in `.hermes/plans/`, not here. (Knowledge = the noun; an RFC = the verb.)

## Systems
- [Haven Lab Dashboard](systems/haven-lab-dashboard.md) — the React SPA + its polling model.
- [Haven Broker](systems/haven-broker.md) — the Node service that fronts every data source.

## API endpoints (served by the broker)
- [`GET /api/dr7`](endpoints/api-dr7.md) — UniFi network telemetry (LAN).
- [`GET /api/proxmox`](endpoints/api-proxmox.md) — Proxmox node/guest stats (LAN).
- [`GET /api/adguard`](endpoints/api-adguard.md) — AdGuard Home DNS stats (LAN).
- [`GET /api/repos`](endpoints/api-repos.md) — GitHub repo list + open-PR counts (public).
- [`PUT /api/config`](endpoints/api-config.md) — save config to disk **and** commit to GitHub.
- [`GET /config.json`](endpoints/config-json.md) — runtime dashboard config (read from disk).

## Reference
- [Network Topology](reference/network-topology.md) — hosts, ports, and trust boundary.

## Runbooks
- [Deploy / Update](runbooks/deploy.md) — how the site ships today (publish.ps1 → git → update.sh).

See [log.md](log.md) for the bundle's change history.
