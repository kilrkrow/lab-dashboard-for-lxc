import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Search, Hexagon, Pencil, Zap, ArrowDownAZ, Lock, RefreshCw, Plus, Trash2, X, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { getEnvelope } from './api';
import type { Repo, Dr7, Proxmox, Adguard, Envelope } from './api';
import './App.css';

/* ---------- config.json (apps/sections), served locally by the broker ---------- */
interface AppItem { name: string; url: string; description?: string; icon?: string | null; grafana?: boolean; wan?: boolean; }
interface Category { name: string; faith?: boolean; svc?: boolean; apps: AppItem[]; }
interface DashConfig { title: string; editConfigUrl?: string; categories: Category[]; }

// Accept a full URL or root-relative path as-is; otherwise treat it as a dashboard-icons slug.
const ICON = (s: string) => /^(https?:|\/|data:)/.test(s) ? s : `https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/${s}.png`;
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

/* ---------- header clock — 24h military time ---------- */
function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return (
    <div className="clock">
      <div className="t">{hh}:{mm}</div>
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

/* ---------- per-category sort + last-used (localStorage) ---------- */
type CatSortMode = 'alpha' | 'recent';
const CAT_SORT_KEY = 'haven.lab.catSort.v1';
const APP_USED_KEY = 'haven.lab.appLastUsed.v1';

function loadJson<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    if (!s) return fallback;
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function appKey(app: Pick<AppItem, 'name' | 'url'>): string {
  return `${app.name}\0${app.url || ''}`;
}

function sortApps(apps: AppItem[], mode: CatSortMode, lastUsed: Record<string, number>): AppItem[] {
  const copy = [...apps];
  if (mode === 'alpha') {
    copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  } else {
    copy.sort((a, b) => {
      const ta = lastUsed[appKey(a)] ?? 0;
      const tb = lastUsed[appKey(b)] ?? 0;
      if (tb !== ta) return tb - ta;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    });
  }
  return copy;
}

/* ---------- app tiles ---------- */
function AppTile({
  app, svc, grafanaData, wanDown, onOpen,
}: {
  app: AppItem; svc?: boolean; grafanaData: number[]; wanDown?: boolean; onOpen?: (app: AppItem) => void;
}) {
  const [imgErr, setImgErr] = useState(false);
  return (
    <a
      href={app.url}
      className="tile"
      target={app.url !== '#' ? '_blank' : undefined}
      rel="noopener noreferrer"
      data-svc={svc ? '1' : undefined}
      data-wan={app.wan ? '1' : '0'}
      onClick={() => onOpen?.(app)}
    >
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

/* ---------- category section with sort toggle ---------- */
function CategorySection({
  cat, sortMode, onToggleSort, lastUsed, onAppOpen, grafanaData, wanDown,
}: {
  cat: Category;
  sortMode: CatSortMode;
  onToggleSort: () => void;
  lastUsed: Record<string, number>;
  onAppOpen: (app: AppItem) => void;
  grafanaData: number[];
  wanDown: boolean;
}) {
  const apps = useMemo(
    () => sortApps(cat.apps, sortMode, lastUsed),
    [cat.apps, sortMode, lastUsed],
  );
  const alpha = sortMode === 'alpha';
  return (
    <section className="cat">
      <div className="cat-head">
        <div className={'cat-title' + (cat.faith ? ' faith' : '')}>{cat.name}</div>
        <div className="cat-meta">{cat.apps.length} apps</div>
        <div className="ic-btn">
          <button
            type="button"
            className={'sortbtn' + (alpha ? ' active' : '')}
            onClick={onToggleSort}
            title={alpha ? 'Sorted A–Z — click for last used' : 'Sorted by last used — click for A–Z'}
          >
            <ArrowDownAZ size={16} /> {alpha ? 'A–Z' : 'Last used'}
          </button>
        </div>
      </div>
      <div className="grid">
        {apps.map((a) => (
          <AppTile
            key={appKey(a)}
            app={a}
            svc={cat.svc}
            grafanaData={grafanaData}
            wanDown={wanDown}
            onOpen={onAppOpen}
          />
        ))}
      </div>
    </section>
  );
}

/* ---------- GitHub section with refresh button ---------- */
function GithubSection({ env, onRefresh }: { env: Envelope<Repo[]> | null; onRefresh: () => void }) {
  // Default A–Z (case-insensitive). Toggle switches to most recently pushed.
  const [alpha, setAlpha] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const repos = env?.data || [];
  const stale = !!env?.stale && repos.length > 0;
  const isNew = (iso: string) => (Date.now() - new Date(iso).getTime()) / 86400000 <= 7;
  const ago = (iso: string) => { const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); return d <= 0 ? 'today' : d === 1 ? '1d ago' : d < 30 ? d + 'd ago' : Math.floor(d / 30) + 'mo ago'; };
  const rows = useMemo(() => {
    const copy = [...repos];
    if (alpha) {
      copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    } else {
      copy.sort((a, b) => +new Date(b.pushed_at) - +new Date(a.pushed_at));
    }
    return copy;
  }, [repos, alpha]);
  const totalIssues = repos.reduce((s, r) => s + (r.open_issues || 0), 0);
  const totalPrs = repos.reduce((s, r) => s + (r.open_prs || 0), 0);

  // Track when env updates (successful refresh)
  const prevTs = useRef<number | null>(null);
  useEffect(() => {
    if (env?.ts != null && env.ts !== prevTs.current) {
      prevTs.current = env.ts;
      if (refreshing) { setRefreshing(false); setLastRefreshed(new Date()); }
    }
  }, [env?.ts, refreshing]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    onRefresh();
    setTimeout(() => setRefreshing(false), 20000);
  }, [onRefresh]);

  const refreshedLabel = lastRefreshed
    ? `refreshed ${lastRefreshed.getHours().toString().padStart(2,'0')}:${lastRefreshed.getMinutes().toString().padStart(2,'0')}`
    : env?.ts ? `as of ${new Date(env.ts).getHours().toString().padStart(2,'0')}:${new Date(env.ts).getMinutes().toString().padStart(2,'0')}` : null;

  if (!repos.length && !refreshing && !env?.error) return null;
  return (
    <section className="cat">
      <div className="cat-head">
        <div className="cat-title">GitHub</div>
        <div className="cat-meta">
          {repos.length} repos
          {totalIssues > 0 && <> · <span style={{ color: 'var(--warn)' }}>{totalIssues} issues</span></>}
          {totalPrs > 0 && <> · {totalPrs} PRs</>}
        </div>
        {stale && <span className="badge-off" style={{ display: 'inline-flex' }}>offline · cached {env?.ts ? ago(new Date(env.ts).toISOString()) : ''}</span>}
        {env?.error && !repos.length && <span className="badge-off" style={{ display: 'inline-flex' }} title={env.error}>repos error</span>}
        <div className="ic-btn" style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
          {refreshedLabel && !refreshing && <span className="gh-refresh-ts">{refreshedLabel}</span>}
          <button
            className={'pill-btn gh-refresh' + (refreshing ? ' spinning' : '')}
            onClick={handleRefresh}
            title="Refresh repos + open issues/PRs from GitHub"
            disabled={refreshing}
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            className={'sortbtn' + (alpha ? ' active' : '')}
            onClick={() => setAlpha((a) => !a)}
            title={alpha ? 'Sorted A–Z — click for most recently pushed' : 'Sorted by recent push — click for A–Z'}
          >
            <ArrowDownAZ size={16} /> {alpha ? 'A–Z' : 'Recent'}
          </button>
        </div>
      </div>
      <div className="grid" style={stale ? { opacity: 0.6, filter: 'saturate(.5)' } : undefined}>
        {rows.map((r) => (
          <a
            key={r.html_url || r.name}
            href={r.html_url}
            className={'tile repo ' + (r.private ? 'private' : 'public')}
            target={r.html_url !== '#' ? '_blank' : undefined}
            rel="noopener noreferrer"
            title={r.private ? 'Private repository' : 'Public repository'}
          >
            <div className="ic">{r.name[0].toUpperCase()}</div>
            <div className="body">
              <div className="ttl"><span>{r.name}</span>{r.private ? <span className="lock" title="Private"><Lock size={12} /></span> : isNew(r.pushed_at) ? <span className="new">NEW</span> : null}</div>
              <div className="sub">{r.description || '—'}</div>
              <div className="meta">
                {r.language && <span className="chip"><span className="langdot" style={{ background: LANG_COLOR[r.language] || '#888' }} />{r.language}</span>}
                <span className={'chip' + (r.open_issues > 0 ? ' alert' : '')} title="Open issues (PRs excluded)">◆ {r.open_issues}</span>
                {r.open_prs > 0 && <span className="chip" title="Open pull requests">⑂ {r.open_prs}</span>}
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
function CommandPalette({ index, onOpenApp }: { index: CmdItem[]; onOpenApp?: (app: AppItem) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results: CmdItem[] = useMemo(() => {
    const tr = q.trim(); const bm = tr.match(/^(![a-z]+)\s*(.*)$/i);
    if (bm && BANGS[bm[1].toLowerCase()]) { const b = BANGS[bm[1].toLowerCase()]; const term = (bm[2] || '').trim(); return [{ type: 'web', label: term ? `Search ${b.n} for "${term}"` : `Search ${b.n}…`, sub: 'press Enter', url: b.u(encodeURIComponent(term || ' ')), tag: b.n }]; }
    const ql = tr.toLowerCase();
    const base = ql ? index.filter((x) => x.label.toLowerCase().includes(ql) || x.sub.toLowerCase().includes(ql)).slice(0, 8) : index.slice(0, 7);
    if (ql) base.push({ type: 'web', label: `Search Google for "${tr}"`, sub: 'press Enter', url: 'https://www.google.com/search?q=' + encodeURIComponent(tr), tag: 'web' });
    return base;
  }, [q, index]);
  useEffect(() => { setSel(0); }, [q]);
  const go = useCallback((r?: CmdItem) => {
    if (r && r.url && r.url !== '#') {
      if (r.type === 'app' && onOpenApp) onOpenApp({ name: r.label, url: r.url, icon: r.icon });
      window.open(r.url, '_blank', 'noopener');
    }
    setOpen(false);
  }, [onOpenApp]);
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

/* ===================== CONFIG EDITOR MODAL ===================== */

function AppEditor({ app, onChange, onDelete }: {
  app: AppItem;
  onChange: (a: AppItem) => void;
  onDelete: () => void;
}) {
  return (
    <div className="cfg-app-row">
      <input className="cfg-input" value={app.name} placeholder="Name" onChange={e => onChange({ ...app, name: e.target.value })} />
      <input className="cfg-input cfg-url" value={app.url} placeholder="URL" onChange={e => onChange({ ...app, url: e.target.value })} />
      <input className="cfg-input" value={app.description ?? ''} placeholder="Description" onChange={e => onChange({ ...app, description: e.target.value })} />
      <input className="cfg-input cfg-icon" value={app.icon ?? ''} placeholder="Icon slug or URL" onChange={e => onChange({ ...app, icon: e.target.value || null })} />
      <button className="cfg-del-btn" title="Remove app" onClick={onDelete}><Trash2 size={14} /></button>
    </div>
  );
}

function CategoryEditor({ cat, onChange, onDelete, onMoveUp, onMoveDown, isFirst, isLast }: {
  cat: Category;
  onChange: (c: Category) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const addApp = () => onChange({ ...cat, apps: [...cat.apps, { name: 'New App', url: '#', description: '' }] });
  return (
    <div className="cfg-cat">
      <div className="cfg-cat-head">
        <button className="cfg-collapse-btn" onClick={() => setCollapsed(c => !c)}>
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        <input
          className="cfg-input cfg-cat-name"
          value={cat.name}
          placeholder="Category name"
          onChange={e => onChange({ ...cat, name: e.target.value })}
        />
        <label className="cfg-check-label" title="Faith category">
          <input type="checkbox" checked={!!cat.faith} onChange={e => onChange({ ...cat, faith: e.target.checked || undefined })} /> faith
        </label>
        <label className="cfg-check-label" title="Service category (shows status dot)">
          <input type="checkbox" checked={!!cat.svc} onChange={e => onChange({ ...cat, svc: e.target.checked || undefined })} /> svc
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '.3rem' }}>
          <button className="cfg-move-btn" onClick={onMoveUp} disabled={isFirst} title="Move up">↑</button>
          <button className="cfg-move-btn" onClick={onMoveDown} disabled={isLast} title="Move down">↓</button>
          <button className="cfg-del-btn" onClick={onDelete} title="Delete category"><Trash2 size={14} /></button>
        </div>
      </div>
      {!collapsed && (
        <>
          {cat.apps.map((app, i) => (
            <AppEditor
              key={i}
              app={app}
              onChange={updated => {
                const apps = [...cat.apps]; apps[i] = updated; onChange({ ...cat, apps });
              }}
              onDelete={() => {
                const apps = cat.apps.filter((_, j) => j !== i); onChange({ ...cat, apps });
              }}
            />
          ))}
          <button className="cfg-add-btn" onClick={addApp}><Plus size={13} /> Add app</button>
        </>
      )}
    </div>
  );
}

type SyncState = 'idle' | 'pushing' | 'ok' | 'err';

function ConfigEditor({ cfg, onSave, onClose }: { cfg: DashConfig; onSave: (c: DashConfig) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<DashConfig>(() => JSON.parse(JSON.stringify(cfg)));
  const [saved, setSaved] = useState(false);
  const [jsonView, setJsonView] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const updateCat = (i: number, cat: Category) => {
    const categories = [...draft.categories]; categories[i] = cat; setDraft({ ...draft, categories });
  };
  const deleteCat = (i: number) => setDraft({ ...draft, categories: draft.categories.filter((_, j) => j !== i) });
  const moveCat = (i: number, dir: -1 | 1) => {
    const cats = [...draft.categories];
    const j = i + dir; if (j < 0 || j >= cats.length) return;
    [cats[i], cats[j]] = [cats[j], cats[i]]; setDraft({ ...draft, categories: cats });
  };
  const addCat = () => setDraft({ ...draft, categories: [...draft.categories, { name: 'New Category', apps: [] }] });

  const handleSave = () => {
    onSave(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleSyncToGitHub = async () => {
    setSyncState('pushing');
    setSyncMsg(null);
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft, null, 2),
      });
      const j: { ok: boolean; message: string } = await res.json();
      if (j.ok) {
        setSyncState('ok');
        setSyncMsg(j.message);
        // Also apply locally
        onSave(draft);
      } else {
        setSyncState('err');
        setSyncMsg(j.message);
      }
    } catch (err) {
      setSyncState('err');
      setSyncMsg(String(err));
    }
    setTimeout(() => setSyncState('idle'), 6000);
  };

  const openJsonView = () => { setJsonText(JSON.stringify(draft, null, 2)); setJsonErr(null); setJsonView(true); };
  const applyJson = () => {
    try { const parsed = JSON.parse(jsonText); setDraft(parsed); setJsonView(false); setJsonErr(null); }
    catch (e) { setJsonErr(String(e)); }
  };

  return (
    <div className="cfg-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cfg-modal glass">
        <div className="cfg-modal-head">
          <span className="cfg-modal-title">Edit Dashboard Config</span>
          <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
            <button className="cfg-json-btn" onClick={jsonView ? () => setJsonView(false) : openJsonView}>
              {jsonView ? 'Visual' : 'JSON'}
            </button>
            <button className="pill-btn" onClick={onClose}><X size={15} /></button>
          </div>
        </div>

        {jsonView ? (
          <div className="cfg-json-wrap">
            <textarea
              className="cfg-json-textarea"
              value={jsonText}
              onChange={e => { setJsonText(e.target.value); setJsonErr(null); }}
              spellCheck={false}
            />
            {jsonErr && <div className="cfg-json-err">{jsonErr}</div>}
            <button className="cfg-save-btn" onClick={applyJson}>Apply JSON</button>
          </div>
        ) : (
          <div className="cfg-body">
            <div className="cfg-row">
              <label className="cfg-label">Dashboard title</label>
              <input className="cfg-input" value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} />
            </div>
            <div className="cfg-row">
              <label className="cfg-label">Edit config URL</label>
              <input className="cfg-input cfg-url" value={draft.editConfigUrl ?? ''} placeholder="https://github.com/…/edit/main/config.json" onChange={e => setDraft({ ...draft, editConfigUrl: e.target.value || undefined })} />
            </div>
            <div className="cfg-section-head">Categories</div>
            {draft.categories.map((cat, i) => (
              <CategoryEditor
                key={i}
                cat={cat}
                onChange={c => updateCat(i, c)}
                onDelete={() => deleteCat(i)}
                onMoveUp={() => moveCat(i, -1)}
                onMoveDown={() => moveCat(i, 1)}
                isFirst={i === 0}
                isLast={i === draft.categories.length - 1}
              />
            ))}
            <button className="cfg-add-btn cfg-add-cat" onClick={addCat}><Plus size={13} /> Add category</button>
          </div>
        )}

        <div className="cfg-modal-foot">
          <div className="cfg-foot-left">
            <span className="cfg-foot-note">Apply = in-session only. Save to GitHub = writes to repo &amp; disk.</span>
            {syncMsg && (
              <span className={'cfg-sync-msg' + (syncState === 'ok' ? ' ok' : syncState === 'err' ? ' err' : '')}>
                {syncMsg}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '.5rem' }}>
            <button className={'cfg-save-btn secondary' + (saved ? ' saved' : '')} onClick={handleSave}>
              {saved ? <><Check size={14} /> Applied</> : 'Apply'}
            </button>
            <button
              className={'cfg-save-btn gh-sync' + (syncState === 'pushing' ? ' pushing' : syncState === 'ok' ? ' saved' : syncState === 'err' ? ' err' : '')}
              onClick={handleSyncToGitHub}
              disabled={syncState === 'pushing'}
            >
              {syncState === 'pushing'
                ? <><RefreshCw size={14} className="spin-icon" /> Saving…</>
                : syncState === 'ok'
                  ? <><Check size={14} /> Saved to GitHub</>
                  : <><span style={{ fontSize: '1em' }}>↑</span> Save to GitHub</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===================== APP ===================== */
export default function App() {
  const [cfg, setCfg] = useState<DashConfig | null>(null);
  const [cfgErr, setCfgErr] = useState(false);
  const [cfgEditorOpen, setCfgEditorOpen] = useState(false);

  // Per-category sort mode + last-used map (persist across sessions)
  const [catSort, setCatSort] = useState<Record<string, CatSortMode>>(() => loadJson(CAT_SORT_KEY, {}));
  const [lastUsed, setLastUsed] = useState<Record<string, number>>(() => loadJson(APP_USED_KEY, {}));

  const toggleCatSort = useCallback((catName: string) => {
    setCatSort((prev) => {
      const cur = prev[catName] ?? 'alpha';
      const next = { ...prev, [catName]: (cur === 'alpha' ? 'recent' : 'alpha') as CatSortMode };
      try { localStorage.setItem(CAT_SORT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const markAppUsed = useCallback((app: AppItem) => {
    setLastUsed((prev) => {
      const next = { ...prev, [appKey(app)]: Date.now() };
      try { localStorage.setItem(APP_USED_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Manual refresh trigger for GitHub (also forces broker cache bust via ?refresh=1)
  const [repoRefreshKey, setRepoRefreshKey] = useState(0);
  const [repos, setRepos] = useState<Envelope<Repo[]> | null>(null);

  const dr7 = usePoll<Dr7>('/api/dr7', 3000);
  const proxmox = usePoll<Proxmox>('/api/proxmox', 5000);
  const adguard = usePoll<Adguard>('/api/adguard', 30000);
  const [grafana, setGrafana] = useState<number[]>(() => Array.from({ length: 24 }, (_, i) => 35 + ((i * 17) % 40)));

  // GitHub polling — repoRefreshKey forces immediate refresh with ?refresh=1
  useEffect(() => {
    let alive = true;
    const force = repoRefreshKey > 0;
    const path = force ? '/api/repos?refresh=1' : '/api/repos';
    const run = async () => {
      const e = await getEnvelope<Repo[]>(path);
      if (alive) setRepos(e);
    };
    run();
    const id = setInterval(() => {
      // background poll never force-busts (uses broker 30s warm cache)
      getEnvelope<Repo[]>('/api/repos').then((e) => { if (alive) setRepos(e); });
    }, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(id); };
  }, [repoRefreshKey]);

  const triggerRepoRefresh = useCallback(() => setRepoRefreshKey(k => k + 1), []);

  useEffect(() => {
    fetch('/config.json', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((d: DashConfig) => { setCfg(d); if (d.title) document.title = d.title; }).catch(() => setCfgErr(true));
  }, []);
  useEffect(() => {
    const id = setInterval(() => setGrafana((g) => [...g.slice(1), 35 + ((g[g.length - 1] + 13) % 40)]), 1600);
    return () => clearInterval(id);
  }, []);

  // WAN badge from DR7 (not GitHub stale — that was a misleading coupling)
  const wanDown = !!dr7?.data && dr7.data.wan.status === 'down';
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
          {/* Config editor button — replaces raw GitHub edit link */}
          <button className="pill-btn" onClick={() => setCfgEditorOpen(true)} title="Edit dashboard config">
            <Pencil size={15} />
          </button>
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
          <CategorySection
            key={cat.name}
            cat={cat}
            sortMode={catSort[cat.name] ?? 'alpha'}
            onToggleSort={() => toggleCatSort(cat.name)}
            lastUsed={lastUsed}
            onAppOpen={markAppUsed}
            grafanaData={grafana}
            wanDown={wanDown}
          />
        ))}
        <GithubSection env={repos} onRefresh={triggerRepoRefresh} />
      </main>

      <CommandPalette index={cmdIndex} onOpenApp={markAppUsed} />

      {cfgEditorOpen && (
        <ConfigEditor
          cfg={cfg}
          onSave={(updated) => { setCfg(updated); if (updated.title) document.title = updated.title; }}
          onClose={() => setCfgEditorOpen(false)}
        />
      )}
    </div>
  );
}
