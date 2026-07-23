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
 *   GITHUB_TOKEN             RO PAT for repo list / issues / PRs
 *   GITHUB_WRITE_TOKEN       RW PAT for Save-to-GitHub (config only); falls back to GITHUB_TOKEN
 *   GITHUB_RO_TOKEN          optional alias for GITHUB_TOKEN
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

// Two-token model: RO for dashboard reads; optional RW for config commits only.
const GH_TOKEN_RO   = e('GITHUB_TOKEN') || e('GITHUB_RO_TOKEN');
const GH_TOKEN_RW   = e('GITHUB_WRITE_TOKEN') || e('GITHUB_TOKEN_RW') || GH_TOKEN_RO;
const GH_USER       = e('GITHUB_USER', 'kilrkrow');

/** Ensure scheme; if no explicit port, apply defaultPort (Proxmox API is :8006). */
function normalizeUrl(hostOrUrl: string, defaultScheme: 'http' | 'https', defaultPort?: number): string {
  let h = (hostOrUrl || '').trim();
  if (!h) h = defaultScheme === 'https' ? 'https://127.0.0.1' : 'http://127.0.0.1';
  if (!/^https?:\/\//i.test(h)) h = `${defaultScheme}://${h}`;
  const u = new URL(h);
  if (defaultPort && !u.port) u.port = String(defaultPort);
  // URL.toString() may add trailing slash
  return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`.replace(/\/$/, '');
}

// Proxmox — assemble PVEAPIToken string from PROXMOX_TOKENID + PROXMOX_SECRET
// or fall back to a pre-assembled PROXMOX_TOKEN for backwards compat
const _pxHost       = e('PROXMOX_HOST') || e('PROXMOX_URL', 'https://127.0.0.1:8006');
const PX_URL        = normalizeUrl(_pxHost, 'https', 8006);
const _pxTokenId    = e('PROXMOX_TOKENID');
const _pxSecret     = e('PROXMOX_SECRET');
const PX_TOKEN      = _pxTokenId && _pxSecret
  ? `PVEAPIToken=${_pxTokenId}=${_pxSecret}`
  : e('PROXMOX_TOKEN');
const PX_NODE       = e('PROXMOX_NODE',  'pve');

// AdGuard — ADGUARD_HOST accepts plain hostname or full URL (default http, not https)
const _agHost       = e('ADGUARD_HOST') || e('ADGUARD_URL', 'http://127.0.0.1');
const AG_URL        = normalizeUrl(_agHost, 'http');
const AG_USER       = e('ADGUARD_USER',  'admin');
const AG_PASS       = e('ADGUARD_PASS');
const PORT          = parseInt(e('PORT', '3000'), 10);

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR   = path.resolve(__dirname, '../dist');
// Live LXC: nginx serves config.json from /var/www/html (NOT the broker). Prefer that path.
const CONFIG_PATH = e('CONFIG_PATH')
  || (fs.existsSync('/var/www/html/config.json') ? '/var/www/html/config.json' : '')
  || (fs.existsSync('/var/www/havenlab/config.json') ? '/var/www/havenlab/config.json' : '')
  || (fs.existsSync(path.join(DIST_DIR, 'config.json')) ? path.join(DIST_DIR, 'config.json') : path.join(DIST_DIR, 'config.json'));

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
  /** Default 8000 — prevent hung Proxmox/UniFi from wedging the broker. */
  timeoutMs?: number;
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

    const timeoutMs = opts.timeoutMs ?? 8_000;

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
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout ${timeoutMs}ms ${opts.method || 'GET'} ${url}`));
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function parseJson<T>(body: string): T | null {
  try { return JSON.parse(body) as T; } catch { return null; }
}

// ─── UniFi (DR7) — matches live lib/unifi.mjs that worked on this LXC ─────────
// Password path: POST /api/auth/login → Cookie, then
// GET /proxy/network/api/s/{site}/stat/{health,sta,device}
// API key path: UniFiHUD-style x-api-key + same network paths (and classic fallback).

let unifiCookieHeader: string | null = null;
let unifiCookieAt = 0;
let unifiLastError: string | null = null;
let unifiResolvedBase: string | null = null; // e.g. https://host/proxy/network/api/s/default
const CACHE_DIR = e('CACHE_DIR', path.join(__dirname, 'cache'));
const UNIFI_COOKIE_FILE = path.join(CACHE_DIR, 'unifi-session.json');
const UNIFI_COOKIE_TTL_MS = 8 * 60 * 60_000; // 8h disk reuse (rememberMe login)

function unifiRoot(): string {
  return UNIFI_URL.replace(/\/$/, '');
}

function num(v: unknown, d = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function loadUnifiCookieFromDisk(): void {
  try {
    if (!fs.existsSync(UNIFI_COOKIE_FILE)) return;
    const j = parseJson<{ cookie?: string; at?: number }>(fs.readFileSync(UNIFI_COOKIE_FILE, 'utf8'));
    if (j?.cookie && j.at && Date.now() - j.at < UNIFI_COOKIE_TTL_MS) {
      unifiCookieHeader = j.cookie;
      unifiCookieAt = j.at;
    }
  } catch { /* ignore */ }
}

function saveUnifiCookieToDisk(cookie: string, at: number): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(UNIFI_COOKIE_FILE, JSON.stringify({ cookie, at }), 'utf8');
  } catch { /* ignore */ }
}

loadUnifiCookieFromDisk();

/** Session login — same contract as /opt/havenlab-broker/lib/unifi.mjs */
async function unifiLogin(): Promise<string> {
  if (!UNIFI_USER || !UNIFI_PASS) throw new Error('UNIFI_USER/UNIFI_PASS required');

  // Memory cookie still fresh
  if (unifiCookieHeader && Date.now() - unifiCookieAt < 30 * 60_000) {
    return unifiCookieHeader;
  }
  // Disk cookie (survives broker restart — avoids UniFi login rate limits)
  if (!unifiCookieHeader) loadUnifiCookieFromDisk();
  if (unifiCookieHeader && Date.now() - unifiCookieAt < UNIFI_COOKIE_TTL_MS) {
    return unifiCookieHeader;
  }

  const payload = JSON.stringify({
    username: UNIFI_USER,
    password: UNIFI_PASS,
    rememberMe: true,
  });

  const res = await rawFetch(unifiRoot() + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    timeoutMs: 12_000,
  });

  if (res.status === 429) {
    throw new Error(
      'UniFi login rate-limited (429). Wait ~15-60 min, or set UNIFI_API_KEY in /opt/havenlab-broker/.env (preferred). Do not restart broker repeatedly.',
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`UniFi login HTTP ${res.status}: ${res.body.slice(0, 160)}`);
  }
  if (res.body.includes('"rc":"error"')) {
    throw new Error(`UniFi login error: ${res.body.slice(0, 160)}`);
  }

  const setCookie = res.headers['set-cookie'] ?? [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('UniFi login returned no cookie');

  unifiCookieHeader = cookie;
  unifiCookieAt = Date.now();
  saveUnifiCookieToDisk(cookie, unifiCookieAt);
  unifiLastError = null;
  return cookie;
}

function networkBases(site: string): string[] {
  const root = unifiRoot();
  if (UNIFI_PREFIX_FORCED) {
    const p = UNIFI_API_PREFIX_ENV;
    return [`${root}${p}/api/s/${site}`];
  }
  // Working LXC broker used proxy/network first (UniFi OS on UDR7)
  return [
    `${root}/proxy/network/api/s/${site}`,
    `${root}/api/s/${site}`,
  ];
}

async function unifiGetJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown; body: string }> {
  const res = await rawFetch(url, { headers, timeoutMs: 12_000 });
  return { status: res.status, json: parseJson(res.body), body: res.body };
}

// ─── /api/dr7 ─────────────────────────────────────────────────────────────────
// Matches src/api.ts Dr7 + live lib/unifi.mjs field mapping
interface Dr7Data {
  wan: { status: string; down_mbps: number; up_mbps: number; latency_ms: number | null; ip: string | null; port: string };
  clients: { total: number; wired: number; wireless: number };
  radios: Array<{ band: string; clients: number; util_pct: number }>;
  gateway: { cpu_pct: number | null; mem_pct: number | null; temp_c: number | null; uptime_days: number | null };
  poe: { used_w: number; max_w: number };
}

let dr7Cache: Envelope<Dr7Data> | null = null;

async function fetchDr7(force = false): Promise<Envelope<Dr7Data>> {
  if (!UNIFI_URL) return fail('UNIFI_URL/UNIFI_HOST not set');
  if (!UNIFI_API_KEY && !(UNIFI_USER && UNIFI_PASS)) {
    return fail('Set UNIFI_API_KEY or UNIFI_USER/UNIFI_PASS');
  }

  try {
    if (force) {
      unifiCookieHeader = null;
      unifiCookieAt = 0;
      unifiResolvedBase = null;
    }

    const site = UNIFI_SITE || 'default';
    const headers: Record<string, string> = { Accept: 'application/json' };

    if (UNIFI_API_KEY) {
      headers['X-API-KEY'] = UNIFI_API_KEY;
    } else {
      const cookie = await unifiLogin();
      headers['Cookie'] = cookie;
    }

    // Prefer cached base that already worked this process
    const bases = unifiResolvedBase
      ? [unifiResolvedBase]
      : networkBases(site);

    let health: Array<Record<string, unknown>> = [];
    let sta: Array<Record<string, unknown>> = [];
    let devices: Array<Record<string, unknown>> = [];
    let usedBase = '';
    let lastErr = '';

    for (const base of bases) {
      try {
        const hRes = await unifiGetJson(`${base}/stat/health`, headers);
        if (hRes.status === 401 || hRes.status === 403) {
          // force re-login once
          unifiCookieHeader = null;
          if (!UNIFI_API_KEY) {
            headers['Cookie'] = await unifiLogin();
          }
          const retry = await unifiGetJson(`${base}/stat/health`, headers);
          if (retry.status !== 200) {
            lastErr = `UniFi HTTP ${retry.status} on ${base}/stat/health: ${retry.body.slice(0, 120)}`;
            continue;
          }
          health = (retry.json as { data?: Array<Record<string, unknown>> })?.data ?? [];
        } else if (hRes.status !== 200) {
          lastErr = `UniFi HTTP ${hRes.status} on ${base}/stat/health: ${hRes.body.slice(0, 120)}`;
          continue;
        } else {
          health = (hRes.json as { data?: Array<Record<string, unknown>> })?.data ?? [];
        }

        const [sRes, dRes] = await Promise.all([
          unifiGetJson(`${base}/stat/sta`, headers),
          unifiGetJson(`${base}/stat/device`, headers),
        ]);
        if (sRes.status !== 200 || dRes.status !== 200) {
          lastErr = `UniFi sta=${sRes.status} device=${dRes.status} on ${base}`;
          continue;
        }
        sta = (sRes.json as { data?: Array<Record<string, unknown>> })?.data ?? [];
        devices = (dRes.json as { data?: Array<Record<string, unknown>> })?.data ?? [];
        usedBase = base;
        unifiResolvedBase = base;
        break;
      } catch (err) {
        lastErr = String(err);
      }
    }

    if (!usedBase) {
      unifiLastError = lastErr || 'UniFi network API unreachable';
      if (dr7Cache?.data) return { ...stale(dr7Cache.data), error: unifiLastError };
      return fail(unifiLastError);
    }

    // --- WAN throughput: same source as UniFiHUD GetWanRatesAsync ---
    // Prefer gateway from stat/device + uplink['rx_bytes-r'|'tx_bytes-r'] (bytes/sec → Mbps).
    // stat/health is only used for status / wan_ip / latency (not primary rates).
    const wanH = (health.find((h) => h.subsystem === 'wan') || {}) as Record<string, unknown>;

    // UniFiHUD order: is_gateway → type ugw|udm → model UDR|UDM|UDW
    const gw = (devices.find((d) => d.is_gateway)
      || devices.find((d) => d.type === 'ugw' || d.type === 'udm')
      || devices.find((d) => /UDR|UDM|UDW/i.test(String(d.model || '')))
      || devices.find((d) => /UDR|UDM|gateway/i.test(String(d.model || d.type || '')))
      || devices[0]
      || {}) as Record<string, unknown>;

    const uplink = (gw.uplink || {}) as Record<string, unknown>;
    const rxRate = num(uplink['rx_bytes-r']); // bytes/sec (download on WAN)
    const txRate = num(uplink['tx_bytes-r']); // bytes/sec (upload on WAN)
    // Exact UniFiHUD formula: rate * 8 / 1_000_000
    let downMbps = rxRate * 8 / 1_000_000;
    let upMbps = txRate * 8 / 1_000_000;

    // Fallback only if uplink rates missing entirely (HUD would return null)
    if (rxRate === 0 && txRate === 0) {
      const hRx = num(wanH['rx_bytes-r']);
      const hTx = num(wanH['tx_bytes-r']);
      if (hRx > 0 || hTx > 0) {
        downMbps = hRx * 8 / 1_000_000;
        upMbps = hTx * 8 / 1_000_000;
      }
    }
    downMbps = +downMbps.toFixed(2);
    upMbps = +upMbps.toFixed(2);

    const wanStatus =
      wanH.status === 'ok' || wanH['wan_ip'] || uplink.ip
        ? 'up'
        : (wanH.status ? 'down' : (downMbps > 0 || upMbps > 0 || Object.keys(uplink).length > 0 ? 'up' : 'unknown'));

    const wired = sta.filter((s) => s.is_wired).length;
    const wireless = sta.length - wired;

    const bandLabel: Record<string, string> = { ng: '2.4', na: '5', '6e': '6', '6g': '6' };
    const radioStats = (gw.radio_table_stats as Array<Record<string, unknown>> | undefined) || [];
    let radios = radioStats.map((r) => ({
      band: bandLabel[String(r.radio)] || String(r.radio || '?'),
      clients: num(r.num_sta),
      util_pct: num(r['cu_total'] ?? r.channel_util ?? r.tx_retries, 0),
    }));
    if (!radios.length) {
      // fallback: count by radio field on stations
      const c6 = sta.filter((s) => !s.is_wired && (s.radio === '6e' || s.radio === '6g')).length;
      const c5 = sta.filter((s) => !s.is_wired && (s.radio === 'na' || s.radio === '5g')).length;
      const c24 = sta.filter((s) => !s.is_wired && (s.radio === 'ng' || s.radio === '2g')).length;
      radios = [
        { band: '6', clients: c6, util_pct: 0 },
        { band: '5', clients: c5, util_pct: 0 },
        { band: '2.4', clients: c24, util_pct: 0 },
      ];
    }

    // UniFi uses hyphenated system-stats on many firmwares
    const ss = (gw['system-stats'] || gw.system_stats || {}) as Record<string, unknown>;
    const temps = gw.temperatures as Array<{ name?: string; value?: number }> | undefined;
    const tempC = num(temps?.[0]?.value, NaN);
    const cpuRaw = ss.cpu;
    const memRaw = ss.mem;

    const data: Dr7Data = {
      wan: {
        status: String(wanStatus),
        down_mbps: Math.max(0, downMbps),
        up_mbps: Math.max(0, upMbps),
        latency_ms: wanH.latency != null ? num(wanH.latency, 0) : null,
        ip: (wanH['wan_ip'] as string) || (uplink.ip as string) || null,
        port: uplink.port_idx != null ? `port ${uplink.port_idx}` : '10G SFP+',
      },
      clients: { total: sta.length, wired, wireless },
      radios,
      gateway: {
        cpu_pct: cpuRaw != null && cpuRaw !== '' ? num(parseFloat(String(cpuRaw)), 0) : null,
        mem_pct: memRaw != null && memRaw !== '' ? num(parseFloat(String(memRaw)), 0) : null,
        temp_c: Number.isFinite(tempC) ? tempC : null,
        uptime_days: gw.uptime != null ? Math.floor(num(gw.uptime) / 86400) : null,
      },
      poe: { used_w: num(gw.total_used_power, 0), max_w: 15.4 },
    };

    unifiLastError = null;
    dr7Cache = ok(data);
    return dr7Cache;
  } catch (err) {
    unifiLastError = String(err);
    if (dr7Cache?.data) return { ...stale(dr7Cache.data), error: unifiLastError };
    return fail(unifiLastError);
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

const GH_HEADERS = (token: string) => ({
  authorization: `Bearer ${token}`,
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
  if (!GH_TOKEN_RO) return fail('GITHUB_TOKEN (or GITHUB_RO_TOKEN) not set');

  // Return warm cache unless forced (UI refresh button passes ?refresh=1)
  if (!force && reposCache?.ok && reposCache.data && reposCache.ts && (Date.now() - reposCache.ts) < 30_000) {
    return reposCache;
  }

  try {
    const hdr = GH_HEADERS(GH_TOKEN_RO);
    // Paginate up to 3 pages (300 repos) — sort=pushed matches "Recent" UI mode
    const all: GHRepo[] = [];
    for (let page = 1; page <= 3; page++) {
      const res = await rawFetch(
        `https://api.github.com/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,organization_member,collaborator`,
        { headers: hdr },
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
          { headers: hdr },
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

// ─── /api/issues ──────────────────────────────────────────────────────────────
// Open issues across the authenticated user's repos (not PRs).
interface IssueOut {
  id: number;
  number: number;
  title: string;
  html_url: string;
  repo: string;
  private_repo: boolean;
  updated_at: string;
  labels: string[];
}
let issuesCache: Envelope<IssueOut[]> | null = null;

async function fetchIssues(force = false): Promise<Envelope<IssueOut[]>> {
  if (!GH_TOKEN_RO) return fail('GITHUB_TOKEN (or GITHUB_RO_TOKEN) not set');
  if (!force && issuesCache?.ok && issuesCache.data && issuesCache.ts && (Date.now() - issuesCache.ts) < 30_000) {
    return issuesCache;
  }

  try {
    const hdr = GH_HEADERS(GH_TOKEN_RO);
    // Open issues only (exclude PRs). user: covers owned repos including private with RO token.
    const q = encodeURIComponent(`is:open is:issue user:${GH_USER}`);
    const all: IssueOut[] = [];
    for (let page = 1; page <= 3; page++) {
      const res = await rawFetch(
        `https://api.github.com/search/issues?q=${q}&sort=updated&order=desc&per_page=50&page=${page}`,
        { headers: hdr },
      );
      if (res.status !== 200) throw new Error(`GitHub issues HTTP ${res.status}: ${res.body.slice(0, 160)}`);
      const body = parseJson<{ items?: Array<Record<string, unknown>>; incomplete_results?: boolean }>(res.body);
      const items = body?.items ?? [];
      for (const it of items) {
        const html = String(it.html_url || '');
        // https://github.com/owner/repo/issues/N
        const m = html.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/i);
        const repo = m ? m[1] : String(it.repository_url || '').replace(/.*\/repos\//, '');
        const labels = Array.isArray(it.labels)
          ? (it.labels as Array<{ name?: string }>).map((l) => l.name || '').filter(Boolean)
          : [];
        all.push({
          id: num(it.id),
          number: num(it.number),
          title: String(it.title || ''),
          html_url: html,
          repo,
          private_repo: false, // search payload does not always include; filled below if possible
          updated_at: String(it.updated_at || ''),
          labels,
        });
      }
      if (items.length < 50) break;
    }

    // Mark private using repos cache when available
    const priv = new Set((reposCache?.data || []).filter((r) => r.private).map((r) => {
      try {
        const u = new URL(r.html_url);
        return u.pathname.replace(/^\//, '').toLowerCase();
      } catch { return r.name.toLowerCase(); }
    }));
    for (const iss of all) {
      if (priv.has(iss.repo.toLowerCase())) iss.private_repo = true;
    }

    issuesCache = ok(all);
    return issuesCache;
  } catch (err) {
    if (issuesCache?.data) return { ...stale(issuesCache.data), error: String(err) };
    return fail(String(err));
  }
}

// ─── /api/proxmox ─────────────────────────────────────────────────────────────
let pxCache: Envelope<object> | null = null;

async function fetchProxmox(): Promise<Envelope<object>> {
  if (!PX_TOKEN) return fail('PROXMOX_TOKEN or PROXMOX_TOKENID+PROXMOX_SECRET not set');
  try {
    // Proxmox API token auth (same shape as old havenlab-broker .env)
    const headers = {
      authorization: PX_TOKEN.startsWith('PVEAPIToken=') ? PX_TOKEN : `PVEAPIToken=${PX_TOKEN}`,
      'content-type': 'application/json',
    };
    const [nodeRes, lxcRes, vmRes] = await Promise.all([
      rawFetch(`${PX_URL}/api2/json/nodes/${PX_NODE}/status`, { headers, timeoutMs: 6_000 }),
      rawFetch(`${PX_URL}/api2/json/nodes/${PX_NODE}/lxc`,    { headers, timeoutMs: 6_000 }),
      rawFetch(`${PX_URL}/api2/json/nodes/${PX_NODE}/qemu`,   { headers, timeoutMs: 6_000 }),
    ]);
    if (nodeRes.status !== 200) {
      const err = `Proxmox HTTP ${nodeRes.status}: ${nodeRes.body.slice(0, 160)}`;
      if (pxCache?.data) return { ...stale(pxCache.data), error: err };
      return fail(err);
    }
    const ns = parseJson<{ data?: { cpu: number; memory: { used: number; total: number }; rootfs?: { used: number; total: number }; uptime?: number; thermal_state?: Array<{ name: string; temp: number }> } }>(nodeRes.body);
    const lxc = parseJson<{ data?: Array<{ status: string }> }>(lxcRes.body);
    const vm  = parseJson<{ data?: Array<{ status: string }> }>(vmRes.body);

    if (!ns?.data) {
      if (pxCache?.data) return { ...stale(pxCache.data), error: 'Proxmox unreachable' };
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
    // Prefer env URL; also try flipping http/https if the first scheme times out / fails
    const bases = [AG_URL];
    try {
      const u = new URL(AG_URL);
      u.protocol = u.protocol === 'https:' ? 'http:' : 'https:';
      bases.push(u.toString().replace(/\/$/, ''));
    } catch { /* ignore */ }

    let res: Awaited<ReturnType<typeof rawFetch>> | null = null;
    let lastErr = '';
    for (const base of bases) {
      try {
        res = await rawFetch(`${base}/control/stats`, {
          headers: { authorization: `Basic ${basic}` },
          timeoutMs: 5_000,
        });
        if (res.status === 200) break;
        lastErr = `AdGuard HTTP ${res.status} from ${base}`;
      } catch (err) {
        lastErr = String(err);
        res = null;
      }
    }
    if (!res || res.status !== 200) {
      throw new Error(lastErr || `AdGuard failed from ${AG_URL}`);
    }
    const j = parseJson<{
      num_dns_queries?: number;
      num_blocked_filtering?: number;
      num_replaced_safebrowsing?: number;
      // some versions nest under different keys
      dns_queries?: number;
      blocked_filtering?: number;
    }>(res.body);
    if (!j) throw new Error('AdGuard empty response');
    const queries = j.num_dns_queries ?? j.dns_queries ?? 0;
    const blocked = j.num_blocked_filtering ?? j.blocked_filtering ?? 0;
    const data = { queries, blocked, blocked_pct: queries > 0 ? Math.round(blocked / queries * 1000) / 10 : 0 };
    agCache = ok(data);
    return agCache;
  } catch (err) {
    if (agCache?.data) return { ...stale(agCache.data), error: String(err) };
    return fail(String(err));
  }
}

// ─── /api/config — save config.json locally + push to GitHub ────────────────
// Parses editConfigUrl from on-disk config. Uses GITHUB_WRITE_TOKEN (RW) for
// commits; falls back to GITHUB_TOKEN if write token unset.
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
  if (!GH_TOKEN_RW) {
    return { ok: false, message: 'GITHUB_WRITE_TOKEN (or GITHUB_TOKEN) not set in broker env' };
  }

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
    ...GH_HEADERS(GH_TOKEN_RW),
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
    if (pathname === '/api/issues')   return json(await fetchIssues(force));
    if (pathname === '/api/proxmox')  return json(await fetchProxmox());
    if (pathname === '/api/adguard')  return json(await fetchAdguard());
    if (pathname === '/api/health') {
      return json({
        ok: true,
        unifi: { url: UNIFI_URL, base: unifiResolvedBase, lastError: unifiLastError },
        github: { ro: !!GH_TOKEN_RO, rw: !!GH_TOKEN_RW && GH_TOKEN_RW !== GH_TOKEN_RO ? 'separate' : !!GH_TOKEN_RW },

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
  console.log(`[havenlab-broker] :${PORT}  config=${CONFIG_PATH}`);
  console.log(`  UniFi: ${UNIFI_URL} ${UNIFI_API_KEY ? '(API key)' : UNIFI_USER ? '(user/pass)' : '(no auth)'}`);
  console.log(`  Proxmox: ${PX_URL} node=${PX_NODE} token=${PX_TOKEN ? 'set' : 'MISSING'}`);
  console.log(`  AdGuard: ${AG_URL} user=${AG_USER} pass=${AG_PASS ? 'set' : 'MISSING'}`);
  console.log(`  Dist:  ${DIST_DIR}`);
});
