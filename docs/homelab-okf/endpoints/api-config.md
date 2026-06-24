---
type: API Endpoint
title: PUT /api/config
description: Saves edited dashboard config to disk AND commits it to GitHub via the Contents API.
resource: https://github.com/kilrkrow/lab-dashboard-for-lxc/blob/main/server/broker.ts
tags: [github, config, write, mixed-reachability]
timestamp: 2026-06-23
---

# PUT /api/config

Backs the in-browser config editor's "Sync to GitHub" button (`src/App.tsx`
`handleSyncToGitHub`). Served by the [Haven Broker](../systems/haven-broker.md).

**Reachability: MIXED — this endpoint does two things at once.**
1. **Disk write** (LAN-only): writes the new config to `CONFIG_PATH` so
   [`/config.json`](config-json.md) stays in sync. Needs a writable
   filesystem on a LAN host.
2. **GitHub commit** (public): reads `editConfigUrl` from the on-disk config,
   parses `owner/repo/branch/path`, GETs the current file SHA, then PUTs the new
   content (base64) via `api.github.com`. Uses the same `GITHUB_TOKEN`.

Because half of it touches disk, this endpoint **cannot** run wholesale on a
stateless edge runtime. The clean migration keeps it in the broker.

## Behaviour

- `editConfigUrl` must be present in `config.json` or the call fails with a clear message.
- 404 on the GitHub GET ⇒ treated as "create new file" (no SHA).
- On success: commit message `chore: update dashboard config via Haven Lab editor`, then local disk is rewritten.
- Returns `{ ok, message }` (HTTP 200 on success, 502 on GitHub failure, 400 on bad JSON body).

# Citations
- `server/broker.ts` → `pushConfigToGithub`, `parseEditConfigUrl`, the `PUT /api/config` handler
- `src/App.tsx` → `handleSyncToGitHub`
