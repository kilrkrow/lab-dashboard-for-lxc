# Cloudflare Pages + Worker Migration Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Migrate the Haven Lab Dashboard from Proxmox LXC to Cloudflare Pages + Worker so agents can iterate with near-zero friction (git push → deploy).

**Architecture:** Static React app on Cloudflare Pages. A Cloudflare Worker acts as a secure proxy for GitHub API calls (`/api/repos`) and optional config fetching, injecting secrets server-side. This removes SSH/rsync/LXC entirely.

**Tech Stack:** Cloudflare Pages, Cloudflare Workers, Vite, React, TypeScript

---

## Context & Assumptions

- Current hosting: Proxmox LXC with Nginx serving static files + proxying `/api/repos` and `/config.json`.
- Current deploy: Manual or `deploy.ps1` rsync.
- Pain point: High friction for autonomous agents.
- Telemetry (DreamRouter7 / UnifiHUD) is acknowledged as broken after migration unless we build a separate gated service.
- User is okay with telemetry breakage for now.

## Blind Spots to Address

- Telemetry from `d:\_dev\UnifiHUD` will no longer work (different hosting).
- Any hardcoded LXC assumptions in code or docs.
- Domain (`home.lan.monkiesaresm.art`) will need to move or be aliased.
- Existing GitHub PAT handling must move into the Worker.
- Local dev experience must still work after migration.

## Proposed Approach

1. Keep the existing Vite + React codebase largely intact.
2. Add a `wrangler.toml` and a Worker (`src/worker.js` or TypeScript equivalent).
3. Update Vite config to point API calls at the Worker during both dev and prod.
4. Move secret injection into the Worker.
5. Update documentation and remove LXC-specific deploy scripts.
6. Deploy via Cloudflare Pages connected to the GitHub repo.

---

## Task Plan

### Task 1: Create Worker directory and basic proxy

**Objective:** Set up the folder structure and a minimal Worker that proxies `/api/repos`.

**Files:**
- Create: `workers/api-proxy/src/index.ts`

**Step 1: Write the Worker**

```ts
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    
    if (url.pathname.startsWith('/api/repos')) {
      const githubUrl = 'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,organization_member';
      
      const res = await fetch(githubUrl, {
        headers: {
          'Authorization': `token ${env.GITHUB_TOKEN}`,
          'User-Agent': 'haven-dashboard',
        },
      });
      
      return new Response(await res.text(), {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    return new Response('Not found', { status: 404 });
  },
};
```

**Step 2: Create `wrangler.toml` at project root**

```toml
name = "haven-api-proxy"
main = "workers/api-proxy/src/index.ts"
compatibility_date = "2024-06-01"

[vars]
# GITHUB_TOKEN will be set via `wrangler secret put`
```

**Step 3: Add to `package.json` scripts**

```json
"deploy:worker": "wrangler deploy --config wrangler.toml"
```

### Task 2: Update Vite config for Worker proxy in development

**Objective:** Make local dev call the Worker (or a local mock) instead of the old Nginx proxy.

**Files:**
- Modify: `vite.config.ts`

**Step 1: Update proxy section**

Replace the current `/api/repos` proxy with a target pointing at the deployed Worker URL (or localhost during early dev).

### Task 3: Update README with new deployment instructions

**Objective:** Remove LXC/rsync instructions and document the Cloudflare flow.

**Files:**
- Modify: `README.md` (sections: "Recommended Deployment", "Advanced: Live GitOps", "LXC Update Script Example")

### Task 4: Add environment variable documentation

**Objective:** Document that `GITHUB_TOKEN` now lives as a Worker secret.

**Files:**
- Create: `.env.example` update (or new `workers/README.md`)

### Task 5: Remove or deprecate old deploy scripts

**Objective:** Clean up `deploy.ps1`, `publish.ps1`, and `update.sh` or mark them as deprecated.

**Files:**
- Modify: `deploy.ps1` (add deprecation notice at top)
- Modify: `publish.ps1` (add deprecation notice)

### Task 6: Handle telemetry blind spot

**Objective:** Explicitly document that DreamRouter7 / UnifiHUD telemetry will stop working after migration.

**Files:**
- Modify: `README.md` (add a "Known Limitations" section)

### Task 7: Domain & DNS considerations

**Objective:** Note that `home.lan.monkiesaresm.art` will need to be pointed at Cloudflare (or use a new subdomain).

**Files:**
- Modify: `README.md` (add DNS section)

---

## Risks & Trade-offs

- **Telemetry breakage**: Accepted by user.
- **Loss of "zero overhead" LXC philosophy**: Cloudflare Worker adds a small runtime layer.
- **Domain change**: May require updating bookmarks / internal references.
- **Local dev still needs a PAT**: For the Worker in development.

## Open Questions

- Should we keep a minimal LXC version as a fallback?
- Do we want to build the "NPM gated service" the user mentioned for future telemetry?
- Preferred Worker runtime (JavaScript vs TypeScript)?

## Verification Steps (High Level)

After migration:
1. `npm run dev` still works with GitHub data.
2. Push to GitHub triggers Cloudflare Pages deploy.
3. Live site at new URL shows repos and edit functionality.
4. No more SSH or rsync required for deploys.

---

**Plan saved to:** `.hermes/plans/2026-06-23_162000-cloudflare-migration.md`

Ready to execute using subagent-driven-development when you give the signal.