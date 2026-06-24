---
type: Reference
title: Network Topology & Trust Boundary
description: Hosts, ports, reachability, and the (implicit) trust boundary the dashboard relies on today.
resource: https://github.com/kilrkrow/lab-dashboard-for-lxc
tags: [network, topology, security, trust-boundary, lan]
timestamp: 2026-06-23
---

# Network Topology & Trust Boundary

How the [Haven Broker](../systems/haven-broker.md)'s upstreams are reachable. The
addresses below are the **documented examples / code defaults** from the public
repo — the real values live in the broker's uncommitted `.env`.

| Upstream | Documented address | Protocol | Reachability |
|---|---|---|---|
| UniFi OS (DR7) | `https://192.168.1.1` | HTTPS (self-signed) | LAN-only |
| Proxmox VE | `https://192.168.1.10:8006` | HTTPS | LAN-only |
| AdGuard Home | `http://192.168.1.20` | HTTP | LAN-only |
| GitHub REST | `https://api.github.com` | HTTPS | Public internet |
| Broker itself | `0.0.0.0:3000` | HTTP | LAN-only today |

Dashboard hostname: `home.lan.monkiesaresm.art` — the `.lan.` segment implies
internal (split-horizon) resolution, i.e. it currently resolves on the LAN only.

## The reachability split (the load-bearing fact)

Three of four data sources are RFC1918 LAN addresses. **A public edge runtime
(e.g. a Cloudflare Worker) cannot route to `192.168.x.x`.** So the dashboard
partitions cleanly:

- **Public-safe:** [`/api/repos`](../endpoints/api-repos.md) and the GitHub-commit
  half of [`/api/config`](../endpoints/api-config.md).
- **LAN-bound:** [`/api/dr7`](../endpoints/api-dr7.md),
  [`/api/proxmox`](../endpoints/api-proxmox.md),
  [`/api/adguard`](../endpoints/api-adguard.md), the disk halves of
  [`/api/config`](../endpoints/api-config.md) and
  [`/config.json`](../endpoints/config-json.md).

Anything that serves the LAN-bound set must live on the LAN or reach it through a
tunnel (e.g. Cloudflare Tunnel / `cloudflared`).

## Trust boundary (security gap to carry forward)

There is **no app-level auth in the code.** The dashboard is currently protected
*only* by being LAN-reachable — implicit network trust. Exposing it publicly
(e.g. Cloudflare Pages) removes that protection and requires an explicit access
layer (e.g. Cloudflare Access / Zero Trust). The broker also returns
`access-control-allow-origin: *`.

> Related prior art: the FlowScript POC (`fpoc.foxanddoveconsulting.com`) already
> uses Cloudflare Access **service tokens** (`CF-Access-Client-Id` /
> `CF-Access-Client-Secret`). Note the lesson learned there: a zone-level WAF
> managed/bot challenge can sit *in front of* Access, and a service token does
> not clear it.

# Citations
- `server/broker.ts` (upstream URLs, default ports, CORS header)
- `.env.example`; `README.md`
