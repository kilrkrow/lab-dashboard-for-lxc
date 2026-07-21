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
| `npm run deploy` / `.\deploy.ps1` | Ship to LXC (needs env) |

## Out of scope for CI (for now)

- Live UniFi / Proxmox / AdGuard / GitHub network calls
- Visual browser QA
- Full ESLint clean (track separately)
