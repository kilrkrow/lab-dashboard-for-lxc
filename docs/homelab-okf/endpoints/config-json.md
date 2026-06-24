---
type: API Endpoint
title: GET /config.json
description: Runtime dashboard configuration (tiles, categories, title, editConfigUrl) read from disk.
resource: file:///etc/haven/config.json
tags: [config, runtime, gitignored, secrets-adjacent]
timestamp: 2026-06-23
---

# GET /config.json

The dashboard's entire content (categories, app tiles, title, and
`editConfigUrl`) is loaded here at runtime — `src/App.tsx` fetches it once on
mount. Served by the [Haven Broker](../systems/haven-broker.md) by reading
`CONFIG_PATH` (default `../dist/config.json`; documented prod path
`/etc/haven/config.json`).

**Reachability: LAN / disk-backed.** It is read from the local filesystem, so a
stateless edge host has nothing to read. More importantly:

> **`config.json` is deliberately git-ignored** because it contains the user's
> private internal hostnames/IPs. The README is explicit about this. Any
> migration must preserve the property that those internal addresses never land
> in a public repo or a public build artifact.

This is why the safe migration proxies `/config.json` back to the broker (which
holds the file on the LAN) rather than bundling it into a Cloudflare Pages build.

# Schema
Free-form JSON consumed as `DashConfig`: `{ title?, editConfigUrl?, categories: [{ name, apps: [{ name, url, icon, description? }] }] }`. A redacted template ships as `public/config.example.json`.

# Citations
- `server/broker.ts` → `/config.json` handler, `CONFIG_PATH`
- `README.md` → "add `public/config.json` to your `.gitignore`"
- `src/App.tsx` → config fetch on mount
