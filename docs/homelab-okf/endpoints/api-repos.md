---
type: API Endpoint
title: GET /api/repos
description: GitHub repo list enriched with open-PR and open-issue counts.
resource: https://api.github.com/user/repos
tags: [github, repos, public-internet]
timestamp: 2026-06-23
---

# GET /api/repos

Powers the repos panel. Served by the [Haven Broker](../systems/haven-broker.md).
Polled every **5 minutes** (with a manual refresh trigger in the UI).

**Reachability: PUBLIC.** Upstream is `api.github.com` — reachable from anywhere,
including a public edge runtime. This is the one data endpoint that can move off
the LAN cleanly. See [Network Topology](../reference/network-topology.md).

## Auth

`Authorization: Bearer ${GITHUB_TOKEN}`, with
`accept: application/vnd.github+json` and `x-github-api-version: 2022-11-28`.
Lists `/user/repos?per_page=100&sort=pushed&affiliation=owner`.

## Enrichment (do not drop on migration)

For **each** repo the broker makes a best-effort follow-up call to
`/repos/{user}/{name}/pulls?state=open&per_page=1` and derives `open_prs` from
the `Link` header's `rel="last"` page number (falling back to array length).
This N+1 enrichment is why the panel shows live PR counts. Any reimplementation
of this endpoint must reproduce it **and** the `Envelope` wrapper — a bare
GitHub array will break the frontend's `getEnvelope<Repo[]>` parsing.

# Schema

Response is `Envelope<Repo[]>`. Each `Repo`: `name, description, html_url,
language, pushed_at, stars, private, fork, archived, open_prs, open_issues`
(mapped from GitHub's `stargazers_count` / `open_issues_count` + the derived
`open_prs`).

# Citations
- `server/broker.ts` → `fetchRepos`
- `src/api.ts` → `Repo` interface; `src/App.tsx` → `getEnvelope<Repo[]>` poll
