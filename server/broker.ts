/**
 * Haven Lab — local broker
 *
 * Serves /api/dr7, /api/repos, /api/proxmox, /api/adguard, /config.json
 * and static assets from ../dist.
 *
 * Configuration via environment variables (or .env file):
 *
 *   UNIFI_URL / UNIFI_HOST   UniFi OS base (https://192.168.x.x)
 *   UNIFI_API_KEY            UniFi OS API key (preferred — no CSRF)
 *   UNIFI_USER / UNIFI_PASS  session login fallback
 *   UNIFI_SITE               optional site id (else auto-discover)
 *   UNIFI_API_PREFIX         force path prefix: "" or "/proxy/network"
 *                            (blank = try both; UniFi OS often needs /proxy/network)
 *   GITHUB_TOKEN             PAT with repo scope
 *   GITHUB_USER              login user (fallback only; prefer full_name from API)

 *   PROXMOX_URL      https://192.168.1.10:8006
 *   PROXMOX_TOKEN    PVEAPIToken=user@pam!id=secret
 *   PROXMOX_NODE     pve
 *   ADGUARD_URL      http://192.168.1.20
 *   ADGUARD_USER     admin
 *   ADGUARD_PASS     <password>
 *   CONFIG_PATH      /etc/haven/config.json        (default: ../public/config.json)
 *   PORT             3000
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── env helpers ───────────────────────────────────────────────────────────────
const e = (k: string, fb = '') => process.env[k] ?? fb;
// UniFi — UNIFI_HOST is the base URL (with or without https://);
// falls back to UNIFI_URL for backwards compat
const _unifiHost    = e('UNIFI_HOST') || e('UNIFI_URL', 'https://192.168.1.1');
const UNIFI_URL     = _unifiHost.startsWith('http') ? _unifiHost : `https://${_unifiHost}`;
const UNIFI_API_KEY = e('UNIFI_API_KEY');
const UNIFI_USER    = e('UNIFI_USER');
const UNIFI_PASS    = e('UNIFI_PASS');
const UNIFI_SITE    = e('UNIFI_SITE'); // optional override; auto-discovered if blank
// UniFi OS on UDR/UDM often exposes Network app under /proxy/network (UniFiHUD uses root
// when BaseAddress is set correctly; we probe both unless UNIFI_API_PREFIX is set).
const UNIFI_API_PREFIX_ENV = e('UNIFI_API_PREFIX'); // "" allowed via explicit empty? use sentinel
const UNIFI_PREFIX_FORCED = process.env.UNIFI_API_PREFIX !== undefined;

const GH_TOKEN      = e('GITHUB_TOKEN');
const GH_USER       = e('GITHUB_USER', 'kilrkrow');

// Proxmox — assemble PVEAPIToken string from PROXMOX_TOKENID + PROXMOX_SECRET
// or fall back to a pre-assembled PROXMOX_TOKEN for backwards compat
const _pxHost       = e('PROXMOX_HOST') || e('PROXMOX_URL', 'https://127.0.0.1:8006');
const PX_URL        = _pxHost.startsWith('http') ? _pxHost : `https://${_pxHost}`;
const _pxTokenId    = e('PROXMOX_TOKENID');
const _pxSecret     = e('PROXMOX_SECRET');
const PX_TOKEN      = _pxTokenId && _pxSecret
  ? `PVEAPIToken=${_pxTokenId}=${_pxSecret}`
  : e('PROXMOX_TOKEN');
const PX_NODE       = e('PROXMOX_NODE',  'pve');

// AdGuard — ADGUARD_HOST accepts plain hostname or full URL
const _agHost       = e('ADGUARD_HOST') || e('ADGUARD_URL', 'http://127.0.0.1');
const AG_URL        = _agHost.startsWith('http') ? _agHost : `http://${_agHost}`;
const AG_USER       = e('ADGUARD_USER',  'admin');
const AG_PASS       = e('ADGUARD_PASS');
const PORT          = parseInt(e('PORT', '3000'), 10);

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR   = path.resolve(__dirname, '../dist');
const CONFIG_PATH = e('CONFIG_PATH', path.join(DIST_DIR, 'config.json'));

// ─── envelope ─────────────────────────────────────────────────────────────────
interface Envelope<T> { ok: boolean; stale: boolean; mock?: boolean; ts: number | null; data: T | null; error?: string; }
function ok<T>(data: T): Envelope<T>         { return { ok: true,  stale: false, ts: Date.now(), data }; }
function stale<T>(data: T): Envelope<T>      { return { ok: false, stale: true,  ts: Date.now(), data }; }
function fail<T>(error: string): Envelope<T> { return { ok: false, stale: true,  ts: null, data: null, error }; }

// ─── raw HTTP fetch (Node built-in, no deps) ──────────────────────────────────
interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  rejectUnauthorized?: boolean;
  cookies?: Map<string, string>;
}

function rawFetch(url: string, opts: FetchOpts = {}): Promise<{ status: number; headers: Record<string, string[]>; body: string; rawHeaders: string[] }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const cookieHeader = opts.cookies && opts.cookies.size > 0
      ? [...opts.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
      : undefined;

    const reqHeaders: Record<string, string> = { ...opts.headers };
    if (cookieHeader) reqHeaders['cookie'] = cookieHeader;
    if (opts.body) reqHeaders['content-length'] = Buffer.byteLength(opts.body).toString();

    const reqOpts: https.RequestOptions = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: reqHeaders,
      rejectUnauthorized: opts.rejectUnauthorized ?? false,  // UniFi uses self-signed certs
    };

    const mod = isHttps ? https : http;
    const req = mod.request(reqOpts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        // Collect Set-Cookie into multi-value array
        const headers: Record<string, string[]> = {};
        const raw = res.rawHeaders;
        for (let i = 0; i < raw.length; i += 2) {
          const k = raw[i].toLowerCase();
          if (!headers[k]) headers[k] = [];
          headers[k].push(raw[i + 1]);
        }
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8'), rawHeaders: raw });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function parseJson<T>(body: string): T | null {
  try { return JSON.parse(body) as T; } catch { return null; }
}

// ─── UniFi auth state ─────────────────────────────────────────────────────────
// Mirrors the auth logic from UniFiHUD/Services/UniFiApiService.cs:
//   1. Prefer X-API-Key (stateless, no CSRF needed)
//   2. Fall back to username/password session with CSRF token capture
//   3. Site resolution via /integration/v1/sites (API key) or /api/s/default (session)
//   4. WAN rates from stat/device uplink rx_bytes-r / tx_bytes-r (bytes/sec → Mbps)

let unifiAuthenticated = false;
let unifiCsrfToken: string | null = null;
let unifiCookies: Map<string, string> = new Map();
let resolvedSite: string | null = null; // e.g. /api/s/default or /proxy/network/api/s/default
let unifiLastError: string | null = null;
let unifiApiPrefix = ''; // '' or '/proxy/network' once discovered

function unifiRoot(): string {
  return UNIFI_URL.replace(/\/$/, '');
}

function candidatePrefixes(): string[] {
  if (UNIFI_PREFIX_FORCED) return [UNIFI_API_PREFIX_ENV]; // may be ""
  // Prefer UniFi OS proxy path first (UDR7 / modern OS), then classic root paths (UniFiHUD default)
  return ['/proxy/network', ''];
}

async function unifiAuthHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (UNIFI_API_KEY) {
    h['x-api-key'] = UNIFI_API_KEY;
  } else if (unifiCsrfToken) {
    h['x-csrf-token'] = unifiCsrfToken;
  }
  return h;
}

async function ensureUnifiAuth(): Promise<void> {
  if (unifiAuthenticated) return;

  // API key path — stateless, no login needed (same as UniFiHUD)
  if (UNIFI_API_KEY) { unifiAuthenticated = true; return; }

  // Username/password path
  if (!UNIFI_USER || !UNIFI_PASS) {
    unifiLastError = 'No UNIFI_API_KEY or UNIFI_USER/PASS configured';
    return;
  }

  const payload = JSON.stringify({ username: UNIFI_USER, password: UNIFI_PASS, rememberMe: true, strict: false });
  const loginPaths = ['/api/auth/login', '/api/login'];

  for (const lp of loginPaths) {
    try {
      const res = await rawFetch(unifiRoot() + lp, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });

      if (res.status < 200 || res.status >= 300) continue;
      if (res.body.includes('"rc":"error"')) continue;

      const setCookie = res.headers['set-cookie'] ?? [];
      for (const sc of setCookie) {
        const m = sc.match(/^([^=]+)=([^;]*)/);
        if (m) unifiCookies.set(m[1].trim(), m[2].trim());
      }

      const csrfFromHeader = (res.headers['x-csrf-token'] ?? [])[0];
      if (csrfFromHeader) {
        unifiCsrfToken = csrfFromHeader;
      } else {
        const j = parseJson<{ csrfToken?: string; data?: { csrfToken?: string } }>(res.body);
        unifiCsrfToken = j?.csrfToken ?? j?.data?.csrfToken ?? null;
      }

      unifiAuthenticated = true;
      unifiLastError = null;
      return;
    } catch { /* try next path */ }
  }
  unifiLastError = 'UniFi login failed (tried /api/auth/login and /api/login)';
}

async function resolveSite(): Promise<string> {
  if (resolvedSite) return resolvedSite;

  const siteId = UNIFI_SITE || 'default';
  const prefixes = candidatePrefixes();

  // Manual site id still needs a working prefix
  if (UNIFI_SITE) {
    for (const prefix of prefixes) {
      const sitePath = `${prefix}/api/s/${UNIFI_SITE}`;
      const probe = await unifiProbe(sitePath + '/stat/device');
      if (probe) {
        unifiApiPrefix = prefix;
        resolvedSite = sitePath;
        return resolvedSite;
      }
    }
    // fall through with classic
    unifiApiPrefix = prefixes[0] ?? '';
    resolvedSite = `${unifiApiPrefix}/api/s/${UNIFI_SITE}`;
    return resolvedSite;
  }

  // API key: discover via integration/v1/sites (same as UniFiHUD ResolveSiteAsync)
  if (UNIFI_API_KEY) {
    try {
      const res = await rawFetch(unifiRoot() + '/integration/v1/sites', {
        headers: await unifiAuthHeaders(),
      });
      const j = parseJson<{ data?: Array<{ internalReference: string }> }>(res.body);
      if (j?.data && j.data.length > 0) {
        const ref = j.data[0].internalReference;
        for (const prefix of prefixes) {
          const sitePath = `${prefix}/api/s/${ref}`;
          if (await unifiProbe(sitePath + '/stat/device')) {
            unifiApiPrefix = prefix;
            resolvedSite = sitePath;
            return resolvedSite;
          }
        }
        unifiApiPrefix = prefixes[0] ?? '';
        resolvedSite = `${unifiApiPrefix}/api/s/${ref}`;
        return resolvedSite;
      }
    } catch { /* fall through */ }
  }

  // Probe default site under each prefix
  for (const prefix of prefixes) {
    const sitePath = `${prefix}/api/s/${siteId}`;
    if (await unifiProbe(sitePath + '/stat/device')) {
      unifiApiPrefix = prefix;
      resolvedSite = sitePath;
      return resolvedSite;
    }
  }

  unifiApiPrefix = prefixes[0] ?? '';
  resolvedSite = `${unifiApiPrefix}/api/s/${siteId}`;
  return resolvedSite;
}

async function unifiProbe(pathFromRoot: string): Promise<boolean> {
  try {
    await ensureUnifiAuth();
    const res = await rawFetch(unifiRoot() + pathFromRoot, {
      headers: await unifiAuthHeaders(),
      cookies: unifiCookies,
    });
    if (res.status === 200) {
      const j = parseJson<{ data?: unknown[] }>(res.body);
      return Array.isArray(j?.data);
    }
    return false;
  } catch {
    return false;
  }
}

async function unifiGet<T>(path: string): Promise<T | null> {
  await ensureUnifiAuth();
  const site = await resolveSite();
  const url = unifiRoot() + site + path;
  try {
    const res = await rawFetch(url, {
      headers: await unifiAuthHeaders(),
      cookies: unifiCookies,
    });
    if (res.status === 401 || res.status === 403) {
      unifiAuthenticated = false;
      unifiCsrfToken = null;
      unifiCookies = new Map();
      resolvedSite = null;
      unifiLastError = `UniFi HTTP ${res.status} on ${site}${path}`;
      return null;
    }
    if (res.status !== 200) {
      unifiLastError = `UniFi HTTP ${res.status} on ${site}${path}: ${res.body.slice(0, 120)}`;
      return null;
    }
    unifiLastError = null;
    return parseJson<T>(res.body);
  } catch (err) {
    unifiLastError = String(err);
    return null;
  }
}

// ─── DR7 types (mirrors UniFiModels.cs) ───────────────────────────────────────
interface UniFiDevice {
  name?: string; type?: string; model?: string; is_gateway?: boolean;
  uplink?: {
    'rx_bytes-r'?: number; 'tx_bytes-r'?: number;
    rx_bytes?: number; tx_bytes?: number;
    name?: string; ip?: string; uptime?: number;
  };
  stat?: { gw?: Record<string, unknown> };
  port_table?: Array<{
    port_idx?: number; name?: string; up?: boolean; is_uplink?: boolean;
    'rx_bytes-r'?: number; 'tx_bytes-r'?: number;
  }>;
  system_stats?: { cpu?: string; mem?: string };
  temperatures?: Array<{ name: string; value: number }>;
  uptime?: number;
  'ip_addresses'?: string[];
  port_overrides?: unknown[];
}
interface UniFiSta {
  is_wired?: boolean;
  radio?: string;  // 'ng' = 2.4GHz, 'na' = 5GHz, '6e' = 6GHz
  last_seen?: number;
}

// ─── /api/dr7 ─────────────────────────────────────────────────────────────────
// Matches the Dr7 interface in src/api.ts
interface Dr7Data {
  wan: { status: string; down_mbps: number; up_mbps: number; latency_ms: number | null; ip: string | null; port: string };
  clients: { total: number; wired: number; wireless: number };
  radios: Array<{ band: string; clients: number; util_pct: number }>;
  gateway: { cpu_pct: number | null; mem_pct: number | null; temp_c: number | null; uptime_days: number | null };
  poe: { used_w: number; max_w: number };
}

let dr7Cache: Envelope<Dr7Data> | null = null;

/** Bytes/sec → Mbps (same formula as UniFiHUD GetWanRatesAsync). */
function bytesPerSecToMbps(rate: number | undefined | null): number {
  return Math.max(0, (rate ?? 0) * 8 / 1_000_000);
}

function pickGateway(devs: UniFiDevice[]): UniFiDevice | undefined {
  // Same priority as UniFiHUD GetWanRatesAsync
  return devs.find(d => d.is_gateway)
    ?? devs.find(d => d.type === 'ugw' || d.type === 'udm')
    ?? devs.find(d => d.model && /UDR|UDM|UDW/i.test(d.model));
}

/** Resolve rx/tx rates: prefer uplink (UniFiHUD), else uplink port_table row. */
function wanRatesFromGateway(gw: UniFiDevice | undefined): {
  rx: number; tx: number; port: string; ip: string | null; hasUplink: boolean;
} {
  const uplink = gw?.uplink;
  let rx = uplink?.['rx_bytes-r'] ?? 0;
  let tx = uplink?.['tx_bytes-r'] ?? 0;
  let port = uplink?.name || 'WAN';
  const ip = uplink?.ip ?? gw?.ip_addresses?.[0] ?? null;

  if (rx === 0 && tx === 0 && gw?.port_table?.length) {
    const upPort = gw.port_table.find(p => p.is_uplink)
      ?? gw.port_table.find(p => p.up && /wan|sfp|uplink/i.test(p.name || ''));
    if (upPort) {
      rx = upPort['rx_bytes-r'] ?? 0;
      tx = upPort['tx_bytes-r'] ?? 0;
      port = upPort.name || port;
    }
  }

  return { rx, tx, port, ip, hasUplink: !!uplink || rx > 0 || tx > 0 };
}

async function fetchDr7(force = false): Promise<Envelope<Dr7Data>> {
  if (!UNIFI_URL) return fail('UNIFI_URL/UNIFI_HOST not set');
  if (!UNIFI_API_KEY && !(UNIFI_USER && UNIFI_PASS)) {
    return fail('Set UNIFI_API_KEY or UNIFI_USER/UNIFI_PASS (same secrets as UniFiHUD)');
  }

  try {
    // On force, re-resolve site/prefix (UniFi OS path may change after OS update)
    if (force) {
      resolvedSite = null;
      unifiAuthenticated = false;
    }

    const devResp = await unifiGet<{ data?: UniFiDevice[] }>('/stat/device');
    const staResp = await unifiGet<{ data?: UniFiSta[] }>('/stat/sta');

    if (!devResp?.data?.length) {
      const err = unifiLastError || 'UniFi stat/device returned no data';
      if (dr7Cache?.data) return { ...stale(dr7Cache.data), error: err };
      return fail(err);
    }

    const gw = pickGateway(devResp.data);
    const { rx, tx, port, ip, hasUplink } = wanRatesFromGateway(gw);
    const downMbps = bytesPerSecToMbps(rx);
    const upMbps = bytesPerSecToMbps(tx);

    // UniFiHUD treats 0/0 rates as "check model" not necessarily WAN down.
    // We only mark WAN down when there is no uplink object and no rates.
    const wanStatus = (!hasUplink && rx === 0 && tx === 0) ? 'down' : 'up';

    const cpuPct  = gw?.system_stats?.cpu != null ? parseFloat(gw.system_stats.cpu) : null;
    const memPct  = gw?.system_stats?.mem != null ? parseFloat(gw.system_stats.mem) : null;
    const tempEntry = gw?.temperatures?.find(t => /cpu|board/i.test(t.name));
    const tempC   = tempEntry ? tempEntry.value : null;
    const uptimeDays = gw?.uptime != null ? Math.floor(gw.uptime / 86400) : null;

    const stas: UniFiSta[] = staResp?.data ?? [];
    const wired    = stas.filter(s => s.is_wired).length;
    const wireless = stas.length - wired;
    const clients6 = stas.filter(s => !s.is_wired && (s.radio === '6e' || s.radio === '6g')).length;
    const clients5 = stas.filter(s => !s.is_wired && (s.radio === 'na' || s.radio === '5g' || s.radio === 'ac')).length;
    const clients24 = stas.filter(s => !s.is_wired && (s.radio === 'ng' || s.radio === '2g' || s.radio === 'b' || s.radio === 'g' || s.radio === 'ax')).length;

    const data: Dr7Data = {
      wan: {
        status: wanStatus,
        down_mbps: downMbps,
        up_mbps: upMbps,
        latency_ms: null,
        ip,
        port,
      },
      clients: { total: stas.length, wired, wireless },
      radios: [
        { band: '6',   clients: clients6,  util_pct: 0 },
        { band: '5',   clients: clients5,  util_pct: 0 },
        { band: '2.4', clients: clients24, util_pct: 0 },
      ],
      gateway: { cpu_pct: cpuPct, mem_pct: memPct, temp_c: tempC, uptime_days: uptimeDays },
      poe: { used_w: 0, max_w: 15.4 },
    };

    dr7Cache = ok(data);
    return dr7Cache;
  } catch (err) {
    if (dr7Cache?.data) return { ...stale(dr7Cache.data), error: String(err) };
    return fail(String(err));
  }
}

// ─── /api/repos ───────────────────────────────────────────────────────────────
interface GHRepo {
  name: string; full_name: string; description: string | null; html_url: string;
  language: string | null; pushed_at: string; stargazers_count: number;
  private: boolean; fork: boolean; archived: boolean; open_issues_count: number;
}
interface RepoOut {
  name: string; description: string | null; html_url: string; language: string | null;
  pushed_at: string; stars: number; private: boolean; fork: boolean; archived: boolean;
  open_prs: number; open_issues: number;
}
let reposCache: Envelope<RepoOut[]> | null = null;

const GH_HEADERS = () => ({
  authorization: `Bearer ${GH_TOKEN}`,
  'user-agent': 'haven-lab-broker/1.0',
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
});

/** Count open items via Link last-page or body length (per_page=1). */
function countFromListResponse(res: { headers: Record<string, string[]>; body: string }): number {
  const hdr = res.headers['link']?.[0] ?? '';
  const lastMatch = hdr.match(/[?&]page=(\d+)>;\s*rel="last"/);
  if (lastMatch) return parseInt(lastMatch[1], 10);
  const arr = parseJson<unknown[]>(res.body) ?? [];
  return arr.length;
}

async function fetchRepos(force = false): Promise<Envelope<RepoOut[]>> {
  if (!GH_TOKEN) return fail('GITHUB_TOKEN not set');

  // Return warm cache unless forced (UI refresh button passes ?refresh=1)
  if (!force && reposCache?.ok && reposCache.data && reposCache.ts && (Date.now() - reposCache.ts) < 30_000) {
    return reposCache;
  }

  try {
    // Paginate up to 3 pages (300 repos) — sort=pushed matches "Recent" UI mode
    const all: GHRepo[] = [];
    for (let page = 1; page <= 3; page++) {
      const res = await rawFetch(
        `https://api.github.com/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,organization_member,collaborator`,
        { headers: GH_HEADERS() },
      );
      if (res.status !== 200) throw new Error(`GitHub HTTP ${res.status}: ${res.body.slice(0, 120)}`);
      const batch = parseJson<GHRepo[]>(res.body) ?? [];
      all.push(...batch);
      if (batch.length < 100) break;
    }

    // Open PRs per repo (best-effort). Use full_name so org repos work (not GH_USER/name).
    const prCounts = await Promise.all(all.map(async (r) => {
      try {
        const pr = await rawFetch(
          `https://api.github.com/repos/${r.full_name}/pulls?state=open&per_page=1`,
          { headers: GH_HEADERS() },
        );
        if (pr.status !== 200) return 0;
        return countFromListResponse(pr);
      } catch { return 0; }
    }));

    // GitHub open_issues_count includes PRs — subtract so UI "issues" is issues-only
    const out: RepoOut[] = all.map((r, i) => {
      const openPrs = prCounts[i];
      const issuesOnly = Math.max(0, (r.open_issues_count ?? 0) - openPrs);
      return {
        name: r.name,
        description: r.description,
        html_url: r.html_url,
        language: r.language,
        pushed_at: r.pushed_at,
        stars: r.stargazers_count,
        private: r.private,
        fork: r.fork,
        archived: r.archived,
        open_prs: openPrs,
        open_issues: issuesOnly,
      };
    });

    // Stable A–Z helper: leave order as pushed from API; UI sorts client-side
    reposCache = ok(out);
    return reposCache;
  } catch (err) {
    if (reposCache?.data) return { ...stale(reposCache.data), error: String(err) };
    return fail(String(err));
  }
}

// ─── /api/proxmox ─────────────────────────────────────────────────────────────
let pxCache: Envelope<object> | null = null;

async function fetchProxmox(): Promise<Envelope<object>> {
  if (!PX_TOKEN) return fail('PROXMOX_TOKEN not set');
  try {
    const headers = { authorization: PX_TOKEN, 'content-type': 'application/json' };
    const [nodeRes, lxcRes, vmRes] = await Promise.all([
      rawFetch(`${PX_URL}/api2/json/nodes/${PX_NODE}/status`,    { headers }),
      rawFetch(`${PX_URL}/api2/json/nodes/${PX_NODE}/lxc`,       { headers }),
      rawFetch(`${PX_URL}/api2/json/nodes/${PX_NODE}/qemu`,      { headers }),
    ]);
    const ns = parseJson<{ data?: { cpu: number; memory: { used: number; total: number }; rootfs?: { used: number; total: number }; uptime?: number; thermal_state?: Array<{ name: string; temp: number }> } }>(nodeRes.body);
    const lxc = parseJson<{ data?: Array<{ status: string }> }>(lxcRes.body);
    const vm  = parseJson<{ data?: Array<{ status: string }> }>(vmRes.body);

    if (!ns?.data) {
      if (pxCache) return { ...stale(pxCache.data!), error: 'Proxmox unreachable' };
      return fail('Proxmox node status empty');
    }

    const nd = ns.data;
    const cpuPct = Math.round(nd.cpu * 100);
    const memPct = Math.round((nd.memory.used / nd.memory.total) * 100);
    const lxcUp  = (lxc?.data ?? []).filter(c => c.status === 'running').length;
    const lxcTotal = (lxc?.data ?? []).length;
    const vmUp   = (vm?.data ?? []).filter(c => c.status === 'running').length;
    const vmTotal = (vm?.data ?? []).length;
    const uptimeDays = nd.uptime != null ? Math.floor(nd.uptime / 86400) : null;
    const tempEntry = nd.thermal_state?.find(t => /cpu|package|core 0/i.test(t.name));
    const tempC = tempEntry ? Math.round(tempEntry.temp) : null;

    const data = { node: PX_NODE, cpu_pct: cpuPct, mem_pct: memPct, temp_c: tempC, lxc_up: lxcUp, lxc_total: lxcTotal, vm_up: vmUp, vm_total: vmTotal, uptime_days: uptimeDays };
    pxCache = ok(data);
    return pxCache;
  } catch (err) {
    if (pxCache) return { ...stale(pxCache.data!), error: String(err) };
    return fail(String(err));
  }
}

// ─── /api/adguard ─────────────────────────────────────────────────────────────
let agCache: Envelope<object> | null = null;

async function fetchAdguard(): Promise<Envelope<object>> {
  if (!AG_PASS) return fail('ADGUARD_PASS not set');
  try {
    const basic = Buffer.from(`${AG_USER}:${AG_PASS}`).toString('base64');
    const res = await rawFetch(`${AG_URL}/control/stats`, {
      headers: { authorization: `Basic ${basic}` },
    });
    if (res.status !== 200) throw new Error(`AdGuard HTTP ${res.status}`);
    const j = parseJson<{ num_dns_queries?: number; num_blocked_filtering?: number }>(res.body);
    if (!j) throw new Error('AdGuard empty response');
    const queries = j.num_dns_queries ?? 0;
    const blocked = j.num_blocked_filtering ?? 0;
    const data = { queries, blocked, blocked_pct: queries > 0 ? Math.round(blocked / queries * 1000) / 10 : 0 };
    agCache = ok(data);
    return agCache;
  } catch (err) {
    if (agCache) return { ...stale(agCache.data!), error: String(err) };
    return fail(String(err));
  }
}

// ─── /api/config — save config.json locally + push to GitHub ────────────────
// Parses the editConfigUrl field from the on-disk config.json to determine
// which GitHub owner/repo/branch/path to write back to.  Uses the same
// GITHUB_TOKEN that fetchRepos already relies on.
//
// editConfigUrl pattern:
//   https://github.com/<owner>/<repo>/edit/<branch>/<path...>
//   https://github.com/<owner>/<repo>/blob/<branch>/<path...>  (also accepted)

function parseEditConfigUrl(editConfigUrl: string): { owner: string; repo: string; branch: string; filePath: string } | null {
  try {
    const u = new URL(editConfigUrl);
    if (u.hostname !== 'github.com') return null;
    // /owner/repo/(edit|blob)/branch/path...
    const parts = u.pathname.replace(/^\//, '').split('/');
    if (parts.length < 5) return null;
    const [owner, repo, _verb, branch, ...rest] = parts;
    return { owner, repo, branch, filePath: rest.join('/') };
  } catch { return null; }
}

async function pushConfigToGithub(newConfig: unknown): Promise<{ ok: boolean; message: string }> {
  if (!GH_TOKEN) return { ok: false, message: 'GITHUB_TOKEN not set in broker env' };

  // Read editConfigUrl from the on-disk config
  let editConfigUrl: string | undefined;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = parseJson<{ editConfigUrl?: string }>(raw);
    editConfigUrl = cfg?.editConfigUrl;
  } catch (err) {
    return { ok: false, message: `Could not read local config.json: ${err}` };
  }

  if (!editConfigUrl) return { ok: false, message: 'editConfigUrl not set in config.json — cannot determine target repo/path' };

  const coords = parseEditConfigUrl(editConfigUrl);
  if (!coords) return { ok: false, message: `Could not parse editConfigUrl: ${editConfigUrl}` };

  const { owner, repo, branch, filePath } = coords;
  const ghHeaders = {
    authorization: `Bearer ${GH_TOKEN}`,
    'user-agent': 'haven-lab-broker/1.0',
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  };
  const contentsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;

  // Step 1: GET current file SHA (required for update)
  let sha: string;
  try {
    const getRes = await rawFetch(contentsUrl, { headers: ghHeaders });
    if (getRes.status === 404) {
      // File doesn't exist yet — create it (sha not needed)
      sha = '';
    } else if (getRes.status !== 200) {
      return { ok: false, message: `GitHub GET failed (${getRes.status}): ${getRes.body.slice(0, 200)}` };
    } else {
      const meta = parseJson<{ sha: string }>(getRes.body);
      sha = meta?.sha ?? '';
    }
  } catch (err) {
    return { ok: false, message: `GitHub GET error: ${err}` };
  }

  // Step 2: PUT new content (base64)
  const content = Buffer.from(JSON.stringify(newConfig, null, 2) + '\n').toString('base64');
  const putBody: Record<string, string> = {
    message: 'chore: update dashboard config via Haven Lab editor',
    content,
    branch,
  };
  if (sha) putBody.sha = sha;

  try {
    const putRes = await rawFetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify(putBody),
    });
    if (putRes.status === 200 || putRes.status === 201) {
      // Also write locally so /config.json stays in sync
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2) + '\n', 'utf8');
      return { ok: true, message: `Saved to ${owner}/${repo}:${branch}/${filePath}` };
    }
    return { ok: false, message: `GitHub PUT failed (${putRes.status}): ${putRes.body.slice(0, 300)}` };
  } catch (err) {
    return { ok: false, message: `GitHub PUT error: ${err}` };
  }
}

// ─── static file helpers ──────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
};

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';
  const pathname = url.split('?')[0];

  const json = (data: unknown, status = 200) => {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(body);
  };

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,PUT,OPTIONS', 'access-control-allow-headers': 'content-type' });
    return res.end();
  }

  try {
    const q = new URL(url, 'http://localhost').searchParams;
    const force = q.get('refresh') === '1' || q.get('force') === '1';

    if (pathname === '/api/dr7')      return json(await fetchDr7(force));
    if (pathname === '/api/repos')    return json(await fetchRepos(force));
    if (pathname === '/api/proxmox')  return json(await fetchProxmox());
    if (pathname === '/api/adguard')  return json(await fetchAdguard());
    if (pathname === '/api/health') {
      return json({
        ok: true,
        unifi: { url: UNIFI_URL, prefix: unifiApiPrefix, site: resolvedSite, lastError: unifiLastError },
        github: !!GH_TOKEN,
        cache: { dr7: !!dr7Cache, repos: !!reposCache },
      });
    }

    // PUT /api/config — save edited config to disk + push to GitHub
    if (pathname === '/api/config' && req.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      const newConfig = parseJson<unknown>(body);
      if (!newConfig) return json({ ok: false, message: 'Invalid JSON body' }, 400);
      const result = await pushConfigToGithub(newConfig);
      return json(result, result.ok ? 200 : 502);
    }

    if (pathname === '/config.json') {
      try {
        const body = fs.readFileSync(CONFIG_PATH, 'utf8');
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(body);
      } catch {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'config.json not found at ' + CONFIG_PATH }));
      }
    }

    // Static assets from dist/
    let filePath = path.join(DIST_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(filePath)) filePath = path.join(DIST_DIR, 'index.html'); // SPA fallback
    const ext  = path.extname(filePath);
    const mime = MIME[ext] ?? 'application/octet-stream';
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'content-type': mime, 'cache-control': ext === '.html' ? 'no-store' : 'public,max-age=604800' });
    res.end(content);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`Haven Lab broker running on http://0.0.0.0:${PORT}`);
  console.log(`  UniFi: ${UNIFI_URL} ${UNIFI_API_KEY ? '(API key)' : UNIFI_USER ? '(user/pass)' : '(no auth — DR7 will return mock)'}`);
  console.log(`  Dist:  ${DIST_DIR}`);
  console.log(`  Config:${CONFIG_PATH}`);
});
