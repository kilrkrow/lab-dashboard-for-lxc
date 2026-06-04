import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Search, Hexagon, Pencil, Zap, ArrowDownAZ, Lock } from 'lucide-react';
import { getEnvelope } from './api';
import type { Repo, Dr7, Proxmox, Adguard, Envelope } from './api';
import './App.css';

/* ---------- config.json (apps/sections), served locally by the broker ---------- */
interface AppItem { name: string; url: string; description?: string; icon?: string | null; grafana?: boolean; wan?: boolean; }
interface Category { name: string; faith?: boolean; svc?: boolean; apps: AppItem[]; }
interface DashConfig { title: string; editConfigUrl?: string; categories: Category[]; }

// Accept a full URL or root-relative path as-is; otherwise treat it as a dashboard-icons slug.
const ICON = (s: string) => /^(https?:|\/)/.test(s) ? s : `https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/${s}.png`;
const LANG_COLOR: Record<string, string> = { TypeScript: '#3178c6', Python: '#3572A5', 'C#': '#178600', JavaScript: '#f1e05a', Shell: '#89e051' };
const LAT = 44.6587, LON = -123.84;

/* ---------- generic polling hook ---------- */
function usePoll<T>(path: string, intervalMs: number): Envelope<T> | null {
  const [env, setEnv] = useState<Envelope<T> | null>(null);
  useEffect(() => {
    let alive = true;
    const run = async () => { const e = await getEnvelope<T>(path); if (alive) setEnv(e); };
    run();
    const id = setInterval(run, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [path, intervalMs]);
  return env;
}

/* ---------- canvas sparkline ---------- */
function Spark({ values, color = '#00f0ff', h = 34 }: { values: number[]; color?: string; h?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const r = c.getBoundingClientRect(); c.width = r.width * devicePixelRatio; c.height = Math.max(1, r.height) * devicePixelRatio;
    const ctx = c.getContext('2d')!; const w = c.width, hh = c.height; ctx.clearRect(0, 0, w, hh);
    if (values.length < 2) return;
    const max = Math.max(...values) * 1.15, min = Math.min(...values) * 0.85, rng = (max - min) || 1;
    ctx.beginPath();
    values.forEach((v, i) => { const x = i / (values.length - 1) * w, y = hh - ((v - min) / rng) * hh; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = color; ctx.lineWidth = 1.6 * devicePixelRatio; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.lineTo(w, hh); ctx.lineTo(0, hh); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, hh); g.addColorStop(0, 'rgba(0,240,255,.2)'); g.addColorStop(1, 'rgba(0,240,255,0)'); ctx.fillStyle = g; ctx.fill();
  }, [values, color]);
  return <canvas ref={ref} className="spark" style={{ height: h }} />;
}
function DualSpark({ down, up }: { down: number[]; up: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const r = c.getBoundingClientRect(); c.width = r.width * devicePixelRatio; c.height = Math.max(1, r.height) * devicePixelRatio;
    const ctx = c.getContext('2d')!; const w = c.width, h = c.height; ctx.clearRect(0, 0, w, h);
    const max = Math.max(...down, ...up, 1) * 1.2;
    const ln = (d: number[], color: string, fill: string | null) => {
      if (d.length < 2) return;
      ctx.beginPath(); d.forEach((v, i) => { const x = i / (d.length - 1) * w, y = h - (v / max) * h; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = color; ctx.lineWidth = 1.7 * devicePixelRatio; ctx.lineJoin = 'round'; ctx.stroke();
      if (fill) { ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, fill); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fill(); }
    };
    ln(down, '#00f0ff', 'rgba(0,240,255,.16)'); ln(up, '#a5b4fc', null);
  }, [down, up]);
  return <canvas ref={ref} className="dr7-spark" />;
}

/* ---------- header clock ---------- */
function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);
  return (
    <div className="clock">
      <div className="t">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      <div className="d">{now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</div>
    </div>
  );
}

/* ---------- weather (client-side open-meteo, with graceful fallback) ---------- */
const WCODE = (c: number): [string, string] => c === 0 ? ['Clear', '☀️'] : c <= 3 ? ['Partly cloudy', '⛅'] : c <= 48 ? ['Foggy', '🌫️'] : c <= 67 ? ['Rain', '🌧️'] : c <= 77 ? ['Snow', '🌨️'] : c <= 82 ? ['Showers', '🌦️'] : ['Storm', '⛈️'];
const dayName = (i: number) => { const d = new Date(); d.setDate(d.getDate() + i); return d.toLocaleDateString([], { weekday: 'short' }); };
interface Wx { temp: number; feels: number; code: number; daily: { hi: number; lo: number; pp: number }[]; rainHour: { t: string; p: number } | null; offline: boolean; }
const WX_SEED: Wx = { temp: 54, feels: 53, code: 3, daily: [{ hi: 62, lo: 49, pp: 2 }, { hi: 58, lo: 44, pp: 11 }, { hi: 60, lo: 42, pp: 59 }], rainHour: null, offline: false };

function WeatherCard() {
  const [wx, setWx] = useState<Wx>(WX_SEED);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const u = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,apparent_temperature,weather_code&hourly=precipitation_probability&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&timezone=auto&forecast_days=3`;
        const j = await (await fetch(u)).json();
        if (!alive) return;
        let rainHour: Wx['rainHour'] = null;
        for (let i = 0; i < Math.min(j.hourly.time.length, 18); i++) {
          if (j.hourly.precipitation_probability[i] >= 50) { rainHour = { t: new Date(j.hourly.time[i]).toLocaleTimeString([], { hour: 'numeric' }), p: j.hourly.precipitation_probability[i] }; break; }
        }
        setWx({
          temp: j.current.temperature_2m, feels: j.current.apparent_temperature, code: j.current.weather_code,
          daily: j.daily.time.map((_: string, i: number) => ({ hi: Math.round(j.daily.temperature_2m_max[i]), lo: Math.round(j.daily.temperature_2m_min[i]), pp: j.daily.precipitation_probability_max[i] })),
          rainHour, offline: false,
        });
      } catch { if (alive) setWx((w) => ({ ...w, offline: true })); }
    };
    load(); const id = setInterval(load, 15 * 60 * 1000); return () => { alive = false; clearInterval(id); };
  }, []);

  const [label, emoji] = WCODE(wx.code);
  const d = wx.daily;
  const maxPP = Math.max(...d.map((x) => x.pp));
  const l1 = wx.rainHour ? `Rain likely ~${wx.rainHour.t} (${wx.rainHour.p}%)` : maxPP < 30 ? `No rain next 3 days (<${maxPP}%)` : `Showers building — ${maxPP}% by ${dayName(2)}`;
  const trend = d[2].hi - d[0].hi;
  const l2 = (d[0].lo <= 38 ? `Cold tonight — low ${d[0].lo}°. ` : '') + (trend >= 6 ? `Heating up: ${d[0].hi}° → ${d[2].hi}° by ${dayName(2)}.` : trend <= -6 ? `Cooling: ${d[0].hi}° → ${d[2].hi}° by ${dayName(2)}.` : `Steady around ${d[0].hi}°.`);

  return (
    <div className="vcard glass">
      <div className="vh"><span className="lbl">Weather</span><span className="ico">{emoji}</span></div>
      <div className="vbig">{Math.round(wx.temp)}°</div>
      <div className="vsub">{label} now · feels {Math.round(wx.feels)}°. {l1}.</div>
      <div className="vsub" style={{ marginTop: '.15rem' }}>{l2}</div>
      <div className="status-line" style={{ color: 'var(--t3)' }}>
        <span className={'dot' + (wx.offline ? ' warn' : '')} style={{ width: 6, height: 6 }} />
        {wx.offline ? 'cached — WAN offline' : 'Home · OR · live'}
      </div>
    </div>
  );
}

/* ---------- DR7 module ---------- */
function Dr7Module({ env }: { env: Envelope<Dr7> | null }) {
  const d = env?.data;
  const hist = useRef<{ down: number[]; up: number[]; ts: number | null }>({ down: [], up: [], ts: null });
  if (d && env?.ts !== hist.current.ts) {
    // only advance the sparkline on a genuinely new poll, not on unrelated re-renders
    hist.current.ts = env?.ts ?? Date.now();
    hist.current.down = [...hist.current.down, d.wan.down_mbps].slice(-44);
    hist.current.up = [...hist.current.up, d.wan.up_mbps].slice(-44);
  }
  const down = d && d.wan.status !== 'down';
  const wanLed = <span className={'pdot' + (down ? '' : ' bad')} />;
  return (
    <section className="dr7-sec">
      <div className="cat-head">
        <div className="cat-title dr7t">Dream Router 7</div>
        <div className="cat-meta">gateway · WiFi 7 · 10G</div>
        {!down && <span className="badge-off" style={{ display: 'inline-flex' }}>WAN failover — gateway still local</span>}
        <div className="ic-btn"><span className="status-line"><span className="pdot" /><span>gateway online{d?.gateway.uptime_days != null ? ` · up ${d.gateway.uptime_days}d` : ''}</span></span></div>
      </div>
      <div className="dr7 glass">
        <div className="dr7-device">
          <div className="router">
            <span className="led">{wanLed}</span>
            <div className="screen">
              <span className="s">↓ {d ? Math.round(d.wan.down_mbps) : '--'}</span>
              <span className="s up">↑ {d ? Math.round(d.wan.up_mbps) : '--'}</span>
              <span className="s" style={{ color: 'var(--t3)', fontSize: '.5rem' }}>Mbps</span>
            </div>
            <div className="wifi-waves"><i /><i /><i /></div>
          </div>
          <div style={{ textAlign: 'center' }}><div className="label">UDR7</div><div className="sub">10G · WiFi 7 · A53</div></div>
        </div>
        <div className={'dr7-col' + (down ? '' : ' down')} id="dr7WanWrap">
          <span className="k">WAN throughput</span>
          <div className="big">
            <div className="rate"><span className="ar">↓</span> {down && d ? Math.round(d.wan.down_mbps) : '—'}<small> Mbps</small></div>
            <div className="rate up"><span className="ar">↑</span> {down && d ? Math.round(d.wan.up_mbps) : '—'}<small> Mbps</small></div>
          </div>
          <DualSpark down={hist.current.down} up={hist.current.up} />
          <div className="wanrow">{wanLed}<b style={{ color: 'var(--t1)' }}>{down ? 'Online' : 'WAN DOWN'}</b> · {down ? `${d?.wan.ip || ''} · ${d?.wan.port || ''}` : 'no WAN · failover'} · {down && d?.wan.latency_ms != null ? `${d.wan.latency_ms}ms` : '—'}</div>
        </div>
        <div className="dr7-col">
          <span className="k">WiFi 7 radios</span>
          {(d?.radios || [{ band: '6', clients: 0, util_pct: 0 }, { band: '5', clients: 0, util_pct: 0 }, { band: '2.4', clients: 0, util_pct: 0 }]).map((r) => (
            <div className="radio" key={r.band}><span className="band">{r.band} GHz</span><div className="track"><div className="fill" style={{ width: r.util_pct + '%' }} /></div><span className="cl">{r.clients} cl</span></div>
          ))}
          <div className="row" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.74rem', color: 'var(--t2)', marginTop: '.4rem' }}><span>Total clients</span><b style={{ color: 'var(--t1)' }}>{d?.clients.total ?? '—'}</b></div>
        </div>
        <div className="dr7-col">
          <span className="k">Gateway</span>
          <div className="dr7-side">
            <div className="row"><span>PoE draw</span><b>{d ? d.poe.used_w : '—'} / {d?.poe.max_w ?? 15.4} W</b></div>
            <div className="row"><span>CPU · RAM</span><b>{d?.gateway.cpu_pct ?? '—'}% · {d?.gateway.mem_pct ?? '—'}%</b></div>
            <div className="row"><span>Temp · clients</span><b>{d?.gateway.temp_c ?? '—'}° · {d ? `${d.clients.wired}w/${d.clients.wireless}wl` : '—'}</b></div>
          </div>
          <div className="ports">
            <span className="port">{wanLed}SFP+ 10G</span>
            <span className="port"><span className="pdot" />2.5G WAN</span>
            <span className="port poe"><span className="pdot" />LAN1 PoE</span>
            <span className="port"><span className="pdot" />LAN2</span>
            <span className="port"><span className="pdot" />LAN3</span>
          </div>
        </div>
      </div>
      {!down && <div className="cached-note" style={{ display: 'block' }}>During the WAN outage the DR7 stays fully reachable on the LAN — radios, clients, PoE and LAN ports keep reporting. Only the WAN line drops. This is your triage screen.</div>}
    </section>
  );
}

/* ---------- app tiles ---------- */
function AppTile({ app, svc, grafanaData, wanDown }: { app: AppItem; svc?: boolean; grafanaData: number[]; wanDown?: boolean }) {
  const [imgErr, setImgErr] = useState(false);
  return (
    <a href={app.url} className="tile" target={app.url !== '#' ? '_blank' : undefined} rel="noopener noreferrer" data-svc={svc ? '1' : undefined} data-wan={app.wan ? '1' : '0'}>
      <div className="ic">{app.icon && !imgErr ? <img src={ICON(app.icon)} alt={app.name} onError={() => setImgErr(true)} /> : app.name[0].toUpperCase()}</div>
      <div className="body">
        <div className="ttl">{app.name}</div>
        <div className="sub">{app.description}</div>
        {app.grafana && <Spark values={grafanaData} h={22} />}
      </div>
      {svc && <span className="svc-dot"><span className={'dot' + (app.wan && wanDown ? ' bad' : '')} /></span>}
    </a>
  );
}

/* ---------- GitHub section ---------- */
function GithubSection({ env }: { env: Envelope<Repo[]> | null }) {
  const [alpha, setAlpha] = useState(true);
  const repos = env?.data || [];
  const stale = !!env?.stale && repos.length > 0;
  const isNew = (iso: string) => (Date.now() - new Date(iso).getTime()) / 86400000 <= 7;
  const ago = (iso: string) => { const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); return d <= 0 ? 'today' : d === 1 ? '1d ago' : d < 30 ? d + 'd ago' : Math.floor(d / 30) + 'mo ago'; };
  const rows = useMemo(() => [...repos].sort((a, b) => alpha ? a.name.localeCompare(b.name) : +new Date(b.pushed_at) - +new Date(a.pushed_at)), [repos, alpha]);
  const totalIssues = repos.reduce((s, r) => s + (r.open_issues || 0), 0);
  if (!repos.length) return null;
  return (
    <section className="cat">
      <div className="cat-head">
        <div className="cat-title">GitHub</div>
        <div className="cat-meta">{repos.length} repos · <span style={{ color: 'var(--warn)' }}>{totalIssues} open issues</span></div>
        {stale && <span className="badge-off" style={{ display: 'inline-flex' }}>offline · cached {env?.ts ? ago(new Date(env.ts).toISOString()) : ''}</span>}
        <div className="ic-btn"><button className={'sortbtn' + (alpha ? ' active' : '')} onClick={() => setAlpha((a) => !a)}><ArrowDownAZ size={16} /> {alpha ? 'A–Z' : 'Recent'}</button></div>
      </div>
      <div className="grid" style={stale ? { opacity: 0.6, filter: 'saturate(.5)' } : undefined}>
        {rows.map((r) => (
          <a key={r.name} href={r.html_url} className="tile repo" target={r.html_url !== '#' ? '_blank' : undefined} rel="noopener noreferrer">
            <div className="ic">{r.name[0].toUpperCase()}</div>
            <div className="body">
              <div className="ttl"><span>{r.name}</span>{r.private ? <span className="lock"><Lock size={12} /></span> : isNew(r.pushed_at) ? <span className="new">NEW</span> : null}</div>
              <div className="sub">{r.description || '—'}</div>
              <div className="meta">
                {r.language && <span className="chip"><span className="langdot" style={{ background: LANG_COLOR[r.language] || '#888' }} />{r.language}</span>}
                <span className={'chip' + (r.open_issues > 0 ? ' alert' : '')}>◆ {r.open_issues}</span>
                {r.open_prs > 0 && <span className="chip">⑂ {r.open_prs}</span>}
                <span className="chip">· {ago(r.pushed_at)}</span>
              </div>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}

/* ---------- command palette (⌘K) ---------- */
interface CmdItem { type: string; label: string; sub: string; url: string; icon?: string | null; tag?: string; }
const BANGS: Record<string, { n: string; u: (q: string) => string }> = {
  '!g': { n: 'Google', u: (q) => 'https://www.google.com/search?q=' + q },
  '!gh': { n: 'GitHub', u: (q) => 'https://github.com/search?q=' + q },
  '!yt': { n: 'YouTube', u: (q) => 'https://www.youtube.com/results?search_query=' + q },
  '!w': { n: 'Wikipedia', u: (q) => 'https://en.wikipedia.org/w/index.php?search=' + q },
  '!npm': { n: 'npm', u: (q) => 'https://www.npmjs.com/search?q=' + q },
  '!maps': { n: 'Maps', u: (q) => 'https://www.google.com/maps/search/' + q },
};
function CommandPalette({ index }: { index: CmdItem[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results: CmdItem[] = useMemo(() => {
    const tr = q.trim(); const bm = tr.match(/^(![a-z]+)\s*(.*)$/i);
    if (bm && BANGS[bm[1].toLowerCase()]) { const b = BANGS[bm[1].toLowerCase()]; const term = (bm[2] || '').trim(); return [{ type: 'web', label: term ? `Search ${b.n} for “${term}”` : `Search ${b.n}…`, sub: 'press Enter', url: b.u(encodeURIComponent(term || ' ')), tag: b.n }]; }
    const ql = tr.toLowerCase();
    const base = ql ? index.filter((x) => x.label.toLowerCase().includes(ql) || x.sub.toLowerCase().includes(ql)).slice(0, 8) : index.slice(0, 7);
    if (ql) base.push({ type: 'web', label: `Search Google for “${tr}”`, sub: 'press Enter', url: 'https://www.google.com/search?q=' + encodeURIComponent(tr), tag: 'web' });
    return base;
  }, [q, index]);
  useEffect(() => { setSel(0); }, [q]);
  const go = useCallback((r?: CmdItem) => { if (r && r.url && r.url !== '#') window.open(r.url, '_blank', 'noopener'); setOpen(false); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); return; }
      if (e.key === '/' && !open && (document.activeElement as HTMLElement)?.tagName !== 'INPUT') { e.preventDefault(); setOpen(true); return; }
      if (!open) return;
      if (e.key === 'Escape') setOpen(false);
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); go(results[sel]); }
    };
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey);
  }, [open, results, sel, go]);
  useEffect(() => { if (open) { setQ(''); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);
  (window as unknown as { openCmdK?: () => void }).openCmdK = () => setOpen(true);
  if (!open) return null;
  return (
    <div className="cmdk-back open" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="cmdk glass">
        <div className="cmdk-in"><Search size={18} color="var(--accent)" /><input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps, repos…  or try !g, !gh, !yt, !npm" /></div>
        <div className="cmdk-list">
          {results.map((r, i) => (
            <div key={i} className={'cmdk-row' + (i === sel ? ' sel' : '')} onClick={() => go(r)} onMouseEnter={() => setSel(i)}>
              <div className="ric">{r.icon ? <img src={ICON(r.icon)} alt="" /> : r.type === 'repo' ? '{ }' : r.type === 'web' ? '⌕' : r.label[0].toUpperCase()}</div>
              <div className="rl"><div className="a">{r.label}</div><div className="b">{r.sub}</div></div>
              <span className="tag">{r.tag || r.type}</span>
            </div>
          ))}
        </div>
        <div className="cmdk-foot"><span>↑↓ navigate</span><span>↵ open</span><span>esc close</span><span style={{ marginLeft: 'auto' }}>bangs: !g !gh !yt !w !npm !maps</span></div>
      </div>
    </div>
  );
}

/* ===================== APP ===================== */
export default function App() {
  const [cfg, setCfg] = useState<DashConfig | null>(null);
  const [cfgErr, setCfgErr] = useState(false);
  const repos = usePoll<Repo[]>('/api/repos', 5 * 60 * 1000);
  const dr7 = usePoll<Dr7>('/api/dr7', 3000);
  const proxmox = usePoll<Proxmox>('/api/proxmox', 5000);
  const adguard = usePoll<Adguard>('/api/adguard', 30000);
  const [grafana, setGrafana] = useState<number[]>(Array.from({ length: 24 }, () => 40 + Math.random() * 30));

  useEffect(() => {
    fetch('/config.json', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((d: DashConfig) => { setCfg(d); if (d.title) document.title = d.title; }).catch(() => setCfgErr(true));
  }, []);
  useEffect(() => { const id = setInterval(() => setGrafana((g) => [...g.slice(1), 40 + Math.random() * 30]), 1600); return () => clearInterval(id); }, []);

  const wanDown = !!repos?.stale; // GitHub needs the WAN; staleness == outage signal
  const px = proxmox?.data, ag = adguard?.data;

  const cmdIndex: CmdItem[] = useMemo(() => {
    const items: CmdItem[] = [];
    cfg?.categories.forEach((c) => c.apps.forEach((a) => items.push({ type: 'app', label: a.name, sub: `${c.name} · ${a.description || ''}`, url: a.url, icon: a.icon })));
    (repos?.data || []).forEach((r) => items.push({ type: 'repo', label: r.name, sub: (r.private ? 'private' : `${r.open_issues} issues`) + ` · ${r.description || ''}`, url: r.html_url }));
    return items;
  }, [cfg, repos]);

  if (cfgErr) return <div className="app-container" style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ff6b6b', textAlign: 'center' }}>Could not load config.json<br />Check the broker / CONFIG_PATH.</div>;
  if (!cfg) return <div className="app-container" style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t2)' }}>Loading Haven Lab…</div>;

  return (
    <div className="wrap" data-offline={wanDown || undefined}>
      <header className="glass">
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div className="brand"><span className="hex"><Hexagon size={26} /></span><span className="name">{cfg.title || 'Haven Lab'}</span></div>
          <Clock />
        </div>
        <div className="hdr-right">
          {wanDown && <span className="badge-off" style={{ display: 'inline-flex' }}><Zap size={13} /> WAN offline</span>}
          {cfg.editConfigUrl && <a className="pill-btn" href={cfg.editConfigUrl} target="_blank" rel="noopener noreferrer" title="Edit config"><Pencil size={15} /></a>}
          <button className="pill-btn search-trigger" onClick={() => (window as unknown as { openCmdK?: () => void }).openCmdK?.()}>
            <Search size={15} /><span className="ph">Search apps & repos…</span><kbd>⌘K</kbd>
          </button>
        </div>
      </header>

      <div className="vitals">
        <WeatherCard />
        <div className="vcard glass">
          <div className="vh"><span className="lbl">AdGuard</span><span className="ico">🛡</span></div>
          <div className="donut">
            <div><div className="vbig" style={{ fontSize: '1.35rem' }}>{ag ? ag.blocked_pct : '—'}%</div><div className="vsub">blocked today<br /><b>{ag ? ag.blocked.toLocaleString() : '—'}</b> / {ag ? Math.round(ag.queries / 1000) + 'k' : '—'} queries</div></div>
          </div>
        </div>
        <div className="vcard glass">
          <div className="vh"><span className="lbl">Proxmox · {px?.node || 'pve'}</span><span className="ico"><span className="dot" /></span></div>
          <div className="bars">
            <div className="bar"><span style={{ width: 30 }}>CPU</span><div className="track"><div className="fill" style={{ width: (px?.cpu_pct ?? 0) + '%' }} /></div><span className="pc">{px?.cpu_pct ?? '—'}%</span></div>
            <div className="bar"><span style={{ width: 30 }}>RAM</span><div className="track"><div className="fill" style={{ width: (px?.mem_pct ?? 0) + '%' }} /></div><span className="pc">{px?.mem_pct ?? '—'}%</span></div>
            <div className="bar"><span style={{ width: 30 }}>TEMP</span><div className="track"><div className="fill warn" style={{ width: ((px?.temp_c ?? 0) / 100 * 100) + '%' }} /></div><span className="pc">{px?.temp_c ?? '—'}°</span></div>
          </div>
          <div className="status-line"><span className="dot" /><span>{px ? `${px.lxc_up} LXC · ${px.vm_up} VM up` : 'loading…'}</span></div>
        </div>
      </div>

      <Dr7Module env={dr7} />

      <main>
        {cfg.categories.map((cat) => (
          <section className="cat" key={cat.name}>
            <div className="cat-head"><div className={'cat-title' + (cat.faith ? ' faith' : '')}>{cat.name}</div><div className="cat-meta">{cat.apps.length} apps</div></div>
            <div className="grid">{cat.apps.map((a) => <AppTile key={a.name} app={a} svc={cat.svc} grafanaData={grafana} wanDown={wanDown} />)}</div>
          </section>
        ))}
        <GithubSection env={repos} />
      </main>

      <CommandPalette index={cmdIndex} />
    </div>
  );
}
