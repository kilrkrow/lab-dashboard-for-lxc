/**
 * Haven Lab — local broker
 *
 * Serves /api/dr7, /api/repos, /api/proxmox, /api/adguard, /config.json
 * and static assets from ../dist.
 *
 * Configuration via environment variables (or .env file):
 *
 *   UNIFI_URL        https://192.168.1.1          (UniFi OS base URL)
 *   UNIFI_API_KEY    <API key from UniFi OS>       (preferred — no CSRF needed)
 *   UNIFI_USER       <read-only username>          (fallback if no API key)
 *   UNIFI_PASS       <password>
 *   GITHUB_TOKEN     <PAT with repo scope>
 *   GITHUB_USER      kilrkrow
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
const UNIFI_URL     = e('UNIFI_URL',   'https://192.168.1.1');
const UNIFI_API_KEY = e('UNIFI_API_KEY');
const UNIFI_USER    = e('UNIFI_USER');
const UNIFI_PASS    = e('UNIFI_PASS');
const GH_TOKEN      = e('GITHUB_TOKEN');
const GH_USER       = e('GITHUB_USER', 'kilrkrow');
const PX_URL        = e('PROXMOX_URL',   'https://127.0.0.1:8006');
const PX_TOKEN      = e('PROXMOX_TOKEN');
const PX_NODE       = e('PROXMOX_NODE',  'pve');
const AG_URL        = e('ADGUARD_URL',   'http://127.0.0.1');
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
let resolvedSite: string | null = null;

async function unifiAuthHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (UNIFI_API_KEY) {
    h['x-api-key'] = UNIFI_API_KEY;
  } else if (unifiCsrfToken) {
    h['x-csrf-token'] = unifiCsrfToken;
  }
  return h;
}

async function ensureUnifiAuth(): Promise<void> {
  if (unifiAuthenticated) return;

  // API key path — stateless, no login needed
  if (UNIFI_API_KEY) { unifiAuthenticated = true; return; }

  // Username/password path
  if (!UNIFI_USER || !UNIFI_PASS) return;

  const payload = JSON.stringify({ username: UNIFI_USER, password: UNIFI_PASS, rememberMe: true, strict: false });
  const loginPaths = ['/api/auth/login', '/api/login'];

  for (const lp of loginPaths) {
    try {
      const res = await rawFetch(UNIFI_URL.replace(/\/$/, '') + lp, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });

      if (res.status < 200 || res.status >= 300) continue;
      if (res.body.includes('"rc":"error"')) continue;

      // Capture cookies from Set-Cookie headers
      const setCookie = res.headers['set-cookie'] ?? [];
      for (const sc of setCookie) {
        const m = sc.match(/^([^=]+)=([^;]*)/);
        if (m) unifiCookies.set(m[1].trim(), m[2].trim());
      }

      // Capture CSRF token from response header or JSON body
      const csrfFromHeader = (res.headers['x-csrf-token'] ?? [])[0];
      if (csrfFromHeader) {
        unifiCsrfToken = csrfFromHeader;
      } else {
        const j = parseJson<{ csrfToken?: string; data?: { csrfToken?: string } }>(res.body);
        unifiCsrfToken = j?.csrfToken ?? j?.data?.csrfToken ?? null;
      }

      unifiAuthenticated = true;
      return;
    } catch { /* try next path */ }
  }
}

async function resolveSite(): Promise<string> {
  if (resolvedSite) return resolvedSite;

  // API key: discover via integration/v1/sites (same as UniFiHUD ResolveSiteAsync)
  if (UNIFI_API_KEY) {
    try {
      const res = await rawFetch(UNIFI_URL.replace(/\/$/, '') + '/integration/v1/sites', {
        headers: await unifiAuthHeaders(),
      });
      const j = parseJson<{ data?: Array<{ internalReference: string }> }>(res.body);
      if (j?.data && j.data.length > 0) {
        resolvedSite = `/api/s/${j.data[0].internalReference}`;
        return resolvedSite;
      }
    } catch { /* fall through */ }
  }

  // Session auth fallback
  resolvedSite = '/api/s/default';
  return resolvedSite;
}

async function unifiGet<T>(path: string): Promise<T | null> {
  await ensureUnifiAuth();
  const site = await resolveSite();
  const url = UNIFI_URL.replace(/\/$/, '') + site + path;
  try {
    const res = await rawFetch(url, {
      headers: await unifiAuthHeaders(),
      cookies: unifiCookies,
    });
    if (res.status === 401 || res.status === 403) {
      // Session expired — force re-auth on next poll
      unifiAuthenticated = false;
      unifiCsrfToken = null;
      unifiCookies = new Map();
      resolvedSite = null;
      return null;
    }
    return parseJson<T>(res.body);
  } catch { return null; }
}

// ─── DR7 types (mirrors UniFiModels.cs) ───────────────────────────────────────
interface UniFiDevice {
  name?: string; type?: string; model?: string; is_gateway?: boolean;
  uplink?: { 'rx_bytes-r': number; 'tx_bytes-r': number; rx_bytes?: number; tx_bytes?: number };
  stat?: { gw?: Record<string, unknown> };
  port_table?: Array<{ port_idx: number; name: string; up: boolean; is_uplink?: boolean }>;
  system_stats?: { cpu?: string; mem?: string };
  temperatures?: Array<{ name: string; value: number }>;
  uptime?: number;
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

async function fetchDr7(): Promise<Envelope<Dr7Data>> {
  if (!UNIFI_URL) return fail('UNIFI_URL not set');

  try {
    // stat/device — gateway info, WAN rates (rx_bytes-r / tx_bytes-r)
    const devResp = await unifiGet<{ data?: UniFiDevice[] }>('/stat/device');
    // stat/sta — connected clients
    const staResp = await unifiGet<{ data?: UniFiSta[] }>('/stat/sta');

    if (!devResp?.data) {
      if (dr7Cache) return { ...stale(dr7Cache.data!), error: 'UniFi unreachable — serving cache' };
      return fail('UniFi stat/device returned no data');
    }

    const devs = devResp.data;

    // Find gateway — same priority as UniFiHUD GetWanRatesAsync
    const gw = devs.find(d => d.is_gateway)
      ?? devs.find(d => d.type === 'ugw' || d.type === 'udm')
      ?? devs.find(d => d.model && /UDR|UDM|UDW/i.test(d.model));

    const uplink = gw?.uplink;
    // rx_bytes-r and tx_bytes-r are bytes/sec pre-computed by UniFi OS
    const rxRate = uplink?.['rx_bytes-r'] ?? 0;
    const txRate = uplink?.['tx_bytes-r'] ?? 0;
    const downMbps = rxRate * 8 / 1_000_000;
    const upMbps   = txRate * 8 / 1_000_000;

    // WAN status: if both rates are 0 and no uplink, treat as down
    const wanStatus = (rxRate === 0 && txRate === 0 && !uplink) ? 'down' : 'up';

    // Gateway CPU/RAM/temp from system_stats
    const cpuPct  = gw?.system_stats?.cpu   != null ? parseFloat(gw.system_stats.cpu)   : null;
    const memPct  = gw?.system_stats?.mem   != null ? parseFloat(gw.system_stats.mem)   : null;
    const tempEntry = gw?.temperatures?.find(t => /cpu|board/i.test(t.name));
    const tempC   = tempEntry ? tempEntry.value : null;
    const uptimeDays = gw?.uptime != null ? Math.floor(gw.uptime / 86400) : null;

    // Clients breakdown from stat/sta
    const stas: UniFiSta[] = staResp?.data ?? [];
    const wired    = stas.filter(s => s.is_wired).length;
    const wireless = stas.length - wired;
    const clients6 = stas.filter(s => !s.is_wired && s.radio === '6e').length;
    const clients5 = stas.filter(s => !s.is_wired && (s.radio === 'na' || s.radio === '5g')).length;
    const clients24 = stas.filter(s => !s.is_wired && (s.radio === 'ng' || s.radio === '2g' || s.radio === 'b' || s.radio === 'g')).length;

    const data: Dr7Data = {
      wan: {
        status: wanStatus,
        down_mbps: Math.max(0, downMbps),
        up_mbps:   Math.max(0, upMbps),
        latency_ms: null,
        ip: null,
        port: 'SFP+ 10G',
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
    if (dr7Cache) return { ...stale(dr7Cache.data!), error: String(err) };
    return fail(String(err));
  }
}

// ─── /api/repos ───────────────────────────────────────────────────────────────
interface GHRepo { name: string; description: string | null; html_url: string; language: string | null; pushed_at: string; stargazers_count: number; private: boolean; fork: boolean; archived: boolean; open_issues_count: number; }
interface RepoOut { name: string; description: string | null; html_url: string; language: string | null; pushed_at: string; stars: number; private: boolean; fork: boolean; archived: boolean; open_prs: number; open_issues: number; }
let reposCache: Envelope<RepoOut[]> | null = null;

async function fetchRepos(): Promise<Envelope<RepoOut[]>> {
  if (!GH_TOKEN) return fail('GITHUB_TOKEN not set');
  try {
    const res = await rawFetch(`https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner`, {
      headers: {
        authorization: `Bearer ${GH_TOKEN}`,
        'user-agent': 'haven-lab-broker/1.0',
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (res.status !== 200) throw new Error(`GitHub HTTP ${res.status}: ${res.body.slice(0, 120)}`);
    const repos = parseJson<GHRepo[]>(res.body) ?? [];

    // Fetch open PRs concurrently for each repo (best-effort)
    const prCounts = await Promise.all(repos.map(async r => {
      try {
        const pr = await rawFetch(`https://api.github.com/repos/${GH_USER}/${r.name}/pulls?state=open&per_page=1`, {
          headers: { authorization: `Bearer ${GH_TOKEN}`, 'user-agent': 'haven-lab-broker/1.0', accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        });
        const hdr = pr.headers['link']?.[0] ?? '';
        // If Link header has rel="last", parse page number; otherwise count array
        const lastMatch = hdr.match(/page=(\d+)>; rel="last"/);
        if (lastMatch) return parseInt(lastMatch[1], 10);
        const arr = parseJson<unknown[]>(pr.body) ?? [];
        return arr.length;
      } catch { return 0; }
    }));

    const out: RepoOut[] = repos.map((r, i) => ({
      name: r.name, description: r.description, html_url: r.html_url,
      language: r.language, pushed_at: r.pushed_at, stars: r.stargazers_count,
      private: r.private, fork: r.fork, archived: r.archived,
      open_prs: prCounts[i], open_issues: r.open_issues_count,
    }));
    reposCache = ok(out);
    return reposCache;
  } catch (err) {
    if (reposCache) return { ...stale(reposCache.data!), error: String(err) };
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

  try {
    if (pathname === '/api/dr7')      return json(await fetchDr7());
    if (pathname === '/api/repos')    return json(await fetchRepos());
    if (pathname === '/api/proxmox')  return json(await fetchProxmox());
    if (pathname === '/api/adguard')  return json(await fetchAdguard());

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
