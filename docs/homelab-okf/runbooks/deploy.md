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

## Reality checks

- There is **no `deploy.ps1`** in the repo — only `publish.ps1` and `update.sh`.
  (A common misremember; flagged here so plans don't reference a phantom file.)
- The README documents an Nginx-based static + GitOps recipe, but the running
  backend is the [Haven Broker](../systems/haven-broker.md), which can serve the
  static site itself. Confirm which is actually deployed before changing deploy
  steps.

# Citations
- `publish.ps1`, `update.sh`, `package.json` scripts, `README.md`
