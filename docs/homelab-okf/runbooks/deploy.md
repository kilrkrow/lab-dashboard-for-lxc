---
type: Runbook
title: Deploy / Update (current)
description: How the dashboard ships today — local build, push to GitHub, pull on the LAN host.
resource: https://github.com/kilrkrow/lab-dashboard-for-lxc/blob/main/publish.ps1
tags: [deploy, runbook, gitops, lxc]
timestamp: 2026-06-23
---

# Deploy / Update (current state)

The pre-migration deploy flow. This is the friction the Cloudflare migration RFC
aims to reduce for the **frontend** — captured here as the baseline.

## Steps

1. **Build + push (dev machine)** — `publish.ps1`:
   - `npm run build` (`tsc -b && vite build`) → `dist/`
   - `git add .` → commit (`"Automated build and deploy via publish.ps1"`) → `git push origin main`
   - Note: the compiled `dist/` is committed to the repo.
2. **Pull (LAN host / LXC)** — `update.sh` at the webroot (`/var/www/html`):
   - `git fetch --all --prune` → `git reset --hard origin/main`
   - optional `chown -R www-data:www-data .`, then reload Nginx
3. **Broker** runs separately as a long-lived process (`npm run broker:start`),
   serving the API and (optionally) the static `dist/`.

## Auth notes (from README)

Prefer `gh auth login` / SSH deploy keys over PATs embedded in remotes. For the
private config repo, a fine-grained PAT scoped to `Contents: Read` is suggested.

## Fast path (rsync) — preferred for agent iteration

1. **Gate** — `npm run check` (also forced inside `deploy.ps1`).
2. **Dry run** — `.\deploy.ps1 -WhatIf`
3. **Deploy** — `.\deploy.ps1`
   - Snapshots live LXC → `backups/lxc-last-good/` (gitignored)
   - rsyncs `dist/` to `LXC_USER@LXC_HOST:LXC_PATH`
4. **Smoke** — hard-refresh homepage; check tiles / console.
5. **Rollback** — `.\restore.ps1` (puts snapshot back).

Env: `LXC_USER`, `LXC_HOST`, `LXC_PATH`.

## Reality checks

- Two ship paths exist: **git** (`publish.ps1` + `update.sh`) and **rsync** (`deploy.ps1` + `restore.ps1`).
- Confirm whether the live host is Nginx static, broker-served, or both before changing steps.
- Never deploy on red CI or failed `npm run check`.

# Citations
- `deploy.ps1`, `restore.ps1`, `publish.ps1`, `update.sh`, `package.json`, `README.md`, `.github/workflows/ci.yml`
