# Agent / contributor verify contract

Do **not** ask the human to re-run shell QA every iteration.

## After code changes

```bash
npm run check
```

That runs:

1. `tsc -b` (client + vite config)
2. `tsc -p tsconfig.server.json --noEmit` (broker)
3. `vite build` (production bundle)

If `npm run check` fails, fix before claiming done.

## GitHub

PRs and pushes to `main` run the same gate in `.github/workflows/ci.yml`.  
Green check on the PR = build not broken. No need for the human to open a terminal for that.

## Optional local

| Command | Use |
|---------|-----|
| `npm run dev` | UI iteration |
| `npm run broker` | API/broker with `.env` |
| `npm run lint` | ESLint (not yet CI-gated — existing App lint debt) |
| `.\deploy.ps1 -WhatIf` then `.\deploy.ps1` | Ship to LXC (needs env; auto-backups live site) |
| `.\restore.ps1` | Undo last rsync deploy from local snapshot |

**Do not deploy to LXC unless the human explicitly asked.** Prefer green CI + `npm run check` first.

## Out of scope for CI (for now)

- Live UniFi / Proxmox / AdGuard / GitHub network calls
- Visual browser QA
- Full ESLint clean (track separately)
