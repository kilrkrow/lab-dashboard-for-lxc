# Cloudflare Migration Plan v2 — Hybrid (Pages + Tunnel)

> **For Hermes:** Supersedes the v1 plan. Read the
> [Haven Lab OKF bundle](../../docs/homelab-okf/index.md) first — every architectural
> claim below is sourced there. Use subagent-driven-development to implement
> task-by-task **only after Guy approves**.

**Goal:** Cut frontend deploy friction to "git push → live" **without breaking the
live panels.** Keep all data sources working.

**Why v1 was wrong (one sentence):** v1 proposed Cloudflare Pages + a single
Worker that proxies `/api/repos`, accepting "telemetry loss." But a Cloudflare
Worker runs on the public edge and **cannot reach `192.168.x.x`**, so 3 of the
4 data panels (DR7, Proxmox, AdGuard — polled every 3/5/30s) would go dark, not
just "telemetry." v1 also only addressed 1 of the broker's 6 paths and was
written from the README's Nginx recipe, not from `server/broker.ts`.

---

## Decision: Option A (Hybrid), variant A1

Split the system by **network reachability** (see
[Network Topology](../../docs/homelab-okf/reference/network-topology.md)):

```
Browser ──▶ Cloudflare Pages (static SPA)  ◀── git push to deploy
               │
               ├─ /api/repos, PUT /api/config, /api/dr7,
               │  /api/proxmox, /api/adguard, /config.json
               ▼
        Pages Function (thin same-origin proxy)
               │  (CF Access service token)
               ▼
        Cloudflare Tunnel (cloudflared on a LAN host)
               ▼
        Haven Broker :3000  ── UniFi / Proxmox / AdGuard (LAN) + GitHub (public)
```

**A1 = keep the broker whole; the "Worker" is a thin proxy.** The Pages Function
forwards every `/api/*` and `/config.json` request to the broker through a
Cloudflare Tunnel. The broker is **unchanged** — it already injects secrets
server-side and already returns the `Envelope` shape with `open_prs` enrichment.

### Why A1 over "put the GitHub token in the Worker" (A2)

v1's instinct — move the GitHub token into a Worker — solves a problem we don't
have: the broker *already* hides the token server-side. Doing it the Worker way
forces us to **re-implement** the broker's per-repo `open_prs` enrichment and the
`Envelope` wrapper at the edge (the exact thing v1 got wrong — it returned a bare
GitHub array, which breaks `getEnvelope<Repo[]>`), and it **duplicates the GitHub
token** into two places (Worker secret + broker, since
[`PUT /api/config`](../../docs/homelab-okf/endpoints/api-config.md) commits to GitHub
from disk). A1 avoids all of it. The only thing A1 gives up: the repos panel
depends on the LAN host being up — a non-issue for a dashboard whose other half
is the LAN itself.

### Honest cost (what v1 oversold)

This does **not** "remove the LXC/LAN host entirely." LAN telemetry requires a
box on the LAN running the broker + `cloudflared`. What you gain is push-to-deploy
for the **frontend** and a clean public origin with real auth. The broker still
updates via `git pull` + restart (rare; that's where the UniFi/Proxmox/AdGuard
logic lives).

---

## Task Plan

### Task 1 — Stand up the tunnel to the broker
- On the LAN host running the broker, install `cloudflared`; create a **named
  tunnel**; route a hostname (e.g. `haven-broker.<zone>`) → `http://localhost:3000`.
- Put the hostname behind **Cloudflare Access** with a **service-token** policy
  (reuse the `fpoc` pattern — see the topology doc's note, incl. the WAF-in-front-
  of-Access gotcha).
- **DoD:** `curl` with `CF-Access-Client-Id/Secret` against `haven-broker.<zone>/api/proxmox` returns the same envelope as hitting the broker on the LAN.

### Task 2 — Cloudflare Pages project
- Connect the repo; build `npm run build`, output dir `dist/`. Push-to-deploy on `main`.
- Keep `dist/` build output **out of git** going forward (Pages builds it) — coordinate with Task 6 deprecations.
- **DoD:** a push to `main` produces a live Pages deploy of the static SPA.

### Task 3 — Pages Function: same-origin proxy (this is the whole "Worker")
- Add `functions/` (e.g. `functions/api/[[path]].ts` + `functions/config.json.ts`,
  or a single `functions/_middleware.ts`) that forwards `/api/*` and `/config.json`
  to the tunnel hostname, attaching the Access service-token headers from Pages
  **environment secrets** (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`).
- Pass method, body, and content-type through (needed for `PUT /api/config`).
- **Do NOT transform bodies** — the broker already returns the correct `Envelope`
  with `open_prs`. The frontend stays byte-for-byte unchanged.
- **DoD:** the deployed Pages site shows live DR7/Proxmox/AdGuard/repos and the config editor's "Sync to GitHub" works.

### Task 4 — Access in front of the human-facing app
- The SPA was implicitly protected by being LAN-only (see
  [trust boundary](../../docs/homelab-okf/reference/network-topology.md)). Put the
  **Pages app** behind Cloudflare Access (Google login or email OTP) so it isn't
  world-readable.
- **DoD:** an un-authed request to the Pages URL is challenged; an authed user sees the dashboard.

### Task 5 — Local dev parity
- Update `vite.config.ts`: proxy `/api/*` **and** `/config.json` to a locally-run
  broker (`http://localhost:3000`). Remove the direct-to-GitHub `/api/repos`
  rewrite (the broker owns that now).
- Document: `npm run broker` + `npm run dev` for full-stack local dev.
- **DoD:** `npm run dev` shows the same data locally as production.

### Task 6 — Docs (README)
- Replace the LXC/rsync/Nginx narrative with the hybrid topology (link the OKF bundle).
- Add an honest **Known Limitations**: a LAN host running broker + `cloudflared`
  is still required; if it's down, live panels render `stale` (the `Envelope`
  already degrades gracefully) while the static shell stays up.
- Correct the v1 "removes LXC entirely" claim.

### Task 7 — Retire frontend deploy scripts
- `publish.ps1` / `update.sh`: mark **deprecated for the frontend** (Pages owns it).
  Keep a short note that the **broker** host still updates via `git pull` + restart.
- There is **no `deploy.ps1`** to modify (v1 error). Don't add a deprecation
  notice to a file that doesn't exist.
- Leave `broker:*` scripts and `tsconfig.server.json` intact — the broker stays.

### Task 8 — Cutover & rollback
- DNS: decide `home.lan.monkiesaresm.art`'s fate — it currently looks split-horizon
  (LAN-only). Either repoint to Pages (public) or give the public app a new hostname.
- Rollback: the broker can still serve `dist/` directly on the LAN, so the
  pre-migration setup remains a working fallback during cutover.

---

## Open Questions (genuinely undecided)
1. **Which LAN host** runs broker + `cloudflared` — the existing LXC, or move it to a Pi/NUC?
2. **Access mode for humans** — Google login vs email OTP?
3. **`config.json` long-term** — keep broker-on-disk (private IPs stay off the repo, recommended), or migrate to fetching from a private repo via the broker?
4. **Public hostname** — repoint the `.lan` name, or mint a new public subdomain?

## Verification (high level)
1. Push to `main` → Pages deploys; static shell loads.
2. All four data panels show **live** (non-stale) data through the tunnel.
3. Config editor "Sync to GitHub" commits and the panel reflects it.
4. Un-authed access to the Pages URL is blocked by Access.
5. Kill the broker → panels go `stale` (not blank); static shell still loads. Restart → live again.

---

**Provisional paths:** this RFC assumes the OKF bundle lands somewhere the repo
can link to (`homelab-okf/` at repo root, a `docs/` subdir, or a sibling repo —
TBD). Adjust the `../../docs/homelab-okf/...` links once placement is decided.
