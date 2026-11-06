/**
 * Headless evidence for AdGuard protection pill states (#10).
 * Serves dist/, mocks /api/* + /config.json, captures screenshots.
 * Not part of CI — run after npm run build.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const outDir = path.join(root, 'docs/images');
const cfg = JSON.parse(fs.readFileSync('/tmp/lab-ag-mock/config.json', 'utf8'));

fs.mkdirSync(outDir, { recursive: true });

function envelope(data, extra = {}) {
  return JSON.stringify({
    ok: true,
    stale: false,
    ts: Date.now(),
    data,
    ...extra,
  });
}

const baseAg = {
  queries: 12400,
  blocked: 1860,
  blocked_pct: 15,
  protection_enabled: true,
  protection_disabled_duration_ms: 0,
  running: true,
};

let agState = { ...baseAg };
let agError = null;

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://127.0.0.1');
  if (u.pathname === '/config.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(cfg));
    return;
  }
  if (u.pathname === '/api/adguard') {
    const body = agError
      ? JSON.stringify({ ok: false, stale: true, ts: Date.now(), data: null, error: agError })
      : envelope(agState, agState.protection_enabled == null ? { error: 'status unavailable' } : {});
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }
  if (u.pathname.startsWith('/api/')) {
    // Quiet stubs so vitals neighbors don't spin forever
    const stubs = {
      '/api/dr7': { wan: { status: 'up', down_mbps: 100, up_mbps: 20, latency_ms: 12, ip: null, port: 'eth0' }, clients: { total: 1, wired: 1, wireless: 0 }, radios: [], gateway: { cpu_pct: 1, mem_pct: 2, temp_c: null, uptime_days: 1 }, poe: { used_w: 0, max_w: 0 } },
      '/api/lab': { state: 'ok', groups: { proxmox: 'ok', backups: 'ok', docker: 'ok' }, findings: [], hosts: [], sources: { proxmox: { state: 'ok' }, backups: { state: 'ok' }, docker: { state: 'ok' } } },
      '/api/status': {},
      '/api/repos': [],
      '/api/issues': [],
    };
    const data = stubs[u.pathname] ?? {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(envelope(data));
    return;
  }
  let filePath = path.join(dist, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!filePath.startsWith(dist)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(dist, 'index.html');
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'content-type': mime[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log('serving', base);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

async function shot(name) {
  await page.waitForSelector('.vitals .vcard .ag-ico', { timeout: 15000 });
  await page.waitForTimeout(400);
  const vitals = page.locator('.vitals');
  const dest = path.join(outDir, name);
  await vitals.screenshot({ path: dest });
  console.log('wrote', dest);
}

async function gotoPoll() {
  await page.goto(`${base}/?agPollMs=800`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.app-version', { timeout: 15000 });
}

// enabled
agState = { ...baseAg, protection_enabled: true, protection_disabled_duration_ms: 0 };
agError = null;
await gotoPoll();
await shot('adguard-pill-enabled.png');

// disabled (timed pause)
agState = {
  ...baseAg,
  protection_enabled: false,
  protection_disabled_duration_ms: 15 * 60 * 1000,
};
await page.reload({ waitUntil: 'networkidle' });
await shot('adguard-pill-disabled-pause.png');

// unknown
agState = {
  ...baseAg,
  protection_enabled: null,
  protection_disabled_duration_ms: null,
  running: null,
};
await page.reload({ waitUntil: 'networkidle' });
await shot('adguard-pill-unknown.png');

// live flip: disabled -> enabled without full navigation (poll picks it up)
agState = {
  ...baseAg,
  protection_enabled: false,
  protection_disabled_duration_ms: 0,
};
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.ag-ico-bad', { timeout: 15000 });
await shot('adguard-pill-flip-before.png');
agState = { ...baseAg, protection_enabled: true, protection_disabled_duration_ms: 0 };
await page.waitForSelector('.ag-ico-ok', { timeout: 10000 });
await shot('adguard-pill-flip-after.png');

// version label visible
const ver = await page.locator('.app-version').innerText();
console.log('version label:', ver);
if (ver.trim() !== 'v0.1.0') throw new Error(`version mismatch: ${ver}`);

await browser.close();
server.close();
console.log('done');
