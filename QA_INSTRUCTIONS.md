# QA Instructions for PR #2 (auth-improvements-docs-and-hygiene)

These are the steps to test the changes in this PR locally before merging.

The PR only touches documentation, dev configuration, and a small helper script. No GUI or core application logic was changed.

## 1. Checkout the branch

```bash
cd /path/to/your/clone/of/lab-dashboard-for-lxc
git fetch origin
git checkout auth-improvements-docs-and-hygiene
```

## 2. Review the changes

```bash
git diff origin/main --stat
git diff origin/main README.md vite.config.ts publish.ps1 update.sh
```

Or just open the files in your editor and look at the new sections.

## 3. Test the build

This is the main check that the project still works after the changes.

```bash
npm install          # make sure dependencies (including TypeScript) are up to date
npm run build
```

- You should see a `dist/` folder created with `index.html`, assets, etc.
- No errors expected.
- If the build fails with "tsc not found", make sure `npm install` completed successfully.

## 4. Test the dev server (new proxy config)

```bash
npm run dev
```

- The server should start (usually on http://localhost:5173).
- The new `server.proxy` configuration is active for:
  - `/config.json`
  - `/api/repos`
- You will likely see warnings on the GitHub proxy side because it needs a real (temporary) PAT to call the API.
- You can temporarily uncomment/add a PAT in the `configure()` block inside `vite.config.ts` if you want to fully test the proxy behavior.
- This change makes `npm run dev` behave more like the production Nginx setup.

## 5. Review the new documentation

Open `README.md` and look for these new/updated sections:

- **Recommended Authentication Practices** (main new section)
- **Nginx Proxy for Dynamic GitHub Repos (`/api/repos`)** (the missing proxy block that was not previously documented)
- **Development Proxy (Vite)**
- **LXC Update Script Example**

Also review the updated comments at the top of `publish.ps1`.

## 6. (Optional) Test the LXC-side script

The new `update.sh` is a simple example for the server/LXC side.

- Copy it to your actual LXC webroot and make it executable: `chmod +x update.sh`
- Review or dry-run the logic (it does a safe git pull).
- It is intentionally simple and well-commented. You can adapt it (e.g. to rsync instead of git) if preferred.

## 7. When you're done testing

Go to the Draft PR:

https://github.com/kilrkrow/lab-dashboard-for-lxc/pull/2

- Leave comments or request changes if anything needs adjustment.
- When satisfied, mark the PR as "Ready for review".
- Merge (or squash-merge) normally.

These instructions are saved as `QA_INSTRUCTIONS.md` in the repo so you (and future contributors) can find them easily on this branch.

---

**Notes**
- All changes in this PR are low-risk (docs + dev server config + one small shell script).
- The goal was to improve the GitOps / auth story (especially around the two GitHub proxies and avoiding long-lived tokens in URLs) while keeping the "zero overhead static site on LXC" philosophy.
- Tokens have already been regenerated on your side. The new recommendations in the docs emphasize fine-grained PATs, SSH/deploy keys, env vars/secrets, and rotation.