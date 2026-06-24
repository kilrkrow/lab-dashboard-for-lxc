---
type: API Endpoint
title: GET /api/proxmox
description: Proxmox VE node health plus LXC/VM running counts.
resource: https://192.168.1.10:8006
tags: [proxmox, virtualization, telemetry, lan]
timestamp: 2026-06-23
---

# GET /api/proxmox

Powers the Proxmox panel. Served by the [Haven Broker](../systems/haven-broker.md),
which calls the **Proxmox VE API** on the LAN. Polled every **5 seconds**.

**Reachability: LAN-only.** Upstream `PROXMOX_URL` (documented example
`https://192.168.1.10:8006`; broker code default `https://127.0.0.1:8006`) is a
private address. Not reachable from a public edge runtime — see
[Network Topology](../reference/network-topology.md).

## Auth

`PROXMOX_TOKEN` sent verbatim as the `Authorization` header
(format `PVEAPIToken=user@pam!tokenid=secret`). `PROXMOX_NODE` (default `pve`)
selects the node.

# Schema

Response is `Envelope<Proxmox>`. Built from three parallel calls:
`/api2/json/nodes/{node}/status`, `/lxc`, `/qemu`.

| Field | Type | Source |
|---|---|---|
| `node` | string | `PROXMOX_NODE` |
| `cpu_pct` | number | `status.cpu` × 100, rounded |
| `mem_pct` | number | `status.memory.used / total` |
| `temp_c` | number \| null | `status.thermal_state` (cpu/package/core 0) |
| `lxc_up` / `lxc_total` | number | count of running vs all containers |
| `vm_up` / `vm_total` | number | count of running vs all qemu guests |
| `uptime_days` | number \| null | `status.uptime` / 86400 |

# Citations
- `server/broker.ts` → `fetchProxmox`
- `src/api.ts` → `Proxmox` interface
