# Agent / contributor contract

## Goal: easy live iteration

Human should **not** run shell QA every cycle. After one-time `deploy.env` setup,
agents can **check → deploy → smoke → auto-restore** via:

```powershell
.\agent-cycle.ps1
```

### Human one-time setup

1. Copy `deploy.env.example` → `deploy.env` (gitignored).
2. Fill:
   - `LXC_USER`, `LXC_HOST`, `LXC_PATH`, `LXC_SSH_KEY` (OpenSSH private key, not `.ppk`)
   - `HAVEN_URL` (LAN or public URL for smoke)
   - Optional integrations: `BROKER_REMOTE_DIR`, `BROKER_RESTART_CMD`, `BROKER_URL`
3. Prove SSH once:  
   `ssh -o BatchMode=yes -i $env:LXC_SSH_KEY $env:LXC_USER@$env:LXC_HOST "echo ok"`
4. Tell the agent: **“iterate live”** / **“run agent-cycle”**.

### Agent loop (integrations: DR7, GitHub, etc.)

1. Edit code.
2. `npm run check` (also inside agent-cycle).
3. `.\agent-cycle.ps1`  
   - Deploys static with timestamped backup  
   - Optionally ships `server/broker.ts` if `BROKER_REMOTE_DIR` set  
   - Smokes homepage + `/api/*`  
   - **Auto `restore.ps1` if homepage critical-fail**
4. If smoke API soft-fails (no broker): fix nginx/broker, re-run cycle with `-StrictApi` when APIs required.
5. Commit/push when cycle is green (ask human before force-push / main if policy requires).

### Commands

| Command | Use |
|---------|-----|
| `npm run check` | typecheck client+broker + production build |
| `.\agent-cycle.ps1` | full live iteration cycle |
| `.\agent-cycle.ps1 -WhatIf` | check + dry-run deploy only |
| `.\agent-cycle.ps1 -SkipBroker` | static only |
| `.\agent-cycle.ps1 -StrictApi` | fail if `/api/dr7` or `/api/repos` soft-fail |
| `.\smoke.ps1` | smoke only (no deploy) |
| `.\deploy.ps1` | static deploy + backup |
| `.\restore.ps1` / `-List` / `-Stamp …` | rollback static |

### Rules

- **Do not** ask the human to re-run shell QA each iteration when `deploy.env` exists.
- **Do** auto-restore on critical homepage smoke fail unless human said otherwise.
- **Do not** deploy if `npm run check` fails.
- Prefer green CI on PRs; live cycle is for integration proof on LAN.
- Never commit `deploy.env`, `.env`, `backups/`, or private keys.

### Local-only (optional)

| Command | Use |
|---------|-----|
| `npm run dev` | UI (proxies `/api` → broker :3000) |
| `npm run broker` | local broker with `.env` |

Local is optional when live cycle + rollback is available.

## Out of scope for CI (for now)

- Live UniFi / Proxmox / AdGuard / GitHub network calls
- Visual browser QA
- Full ESLint clean (existing App debt)
