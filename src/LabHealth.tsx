import { useEffect, useRef } from 'react';
import { X, ChevronRight } from 'lucide-react';
import type { Envelope, LabHealth, LabState, LabGroup, LabHost, LabStorage } from './api';

// Homepage light + slide-over host panel, fed by one /api/lab response.

const DOT: Record<LabState, string> = { ok: 'dot', warn: 'dot warn', bad: 'dot bad', unknown: 'dot unknown' };
const GROUPS: Array<{ key: LabGroup; label: string; setup: string }> = [
  { key: 'proxmox', label: 'Proxmox', setup: 'PROXMOX_TOKENID + PROXMOX_SECRET' },
  { key: 'backups', label: 'Backups', setup: 'PBS_HOST + PBS_TOKENID + PBS_SECRET' },
  { key: 'docker', label: 'Docker', setup: 'PORTAINER_HOST + PORTAINER_TOKEN' },
];

function since(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function clock(ms: number): string {
  const d = new Date(ms);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `today ${t}` : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
}

function verdict(lab: LabHealth | null | undefined, env: Envelope<LabHealth> | null): { text: string; sub: string } {
  if (!env) return { text: 'Checking…', sub: '' };
  if (!lab) return { text: 'No data', sub: env.error ?? 'The broker did not answer.' };
  const configured = GROUPS.filter((g) => lab.sources[g.key].state !== 'off');
  if (!configured.length) return { text: 'Not set up yet', sub: 'Add read-only tokens to the broker .env' };
  const n = lab.findings.length;
  if (!n) return { text: 'All green', sub: '' };
  return { text: `${n} thing${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} a look`, sub: '' };
}

export function LabHealthCard({ env, onOpen }: { env: Envelope<LabHealth> | null; onOpen: () => void }) {
  const lab = env?.data;
  const state: LabState = lab?.state ?? 'unknown';
  const v = verdict(lab, env);
  return (
    <button type="button" className={'vcard glass labcard is-' + state} onClick={onOpen} aria-haspopup="dialog" aria-label={`Lab health: ${v.text}. Show hosts`}>
      <div className="vh"><span className="lbl">Lab health</span><span className="ico"><span className={DOT[state]} /></span></div>
      <div className="lab-verdict">{v.text}</div>
      <div className="lab-lights">
        {GROUPS.map((g) => {
          const off = !lab || lab.sources[g.key].state === 'off';
          const s: LabState = off ? 'unknown' : lab.groups[g.key];
          return (
            <div key={g.key} className={'lab-light s-' + s} title={off ? `Not set up (${g.setup})` : lab.sources[g.key].error ?? g.label}>
              <span className={DOT[s]} /><span className="nm">{g.label}</span>
            </div>
          );
        })}
      </div>
      <span className="lab-more">{v.sub || 'Tap for hosts'} <ChevronRight size={13} /></span>
    </button>
  );
}

function Bar({ label, pct, state = 'ok', violet = false }: { label: string; pct: number | null; state?: LabState; violet?: boolean }) {
  const cls = state === 'bad' ? ' bad' : state === 'warn' ? ' warn' : violet ? ' violet' : '';
  return (
    <div className="bar"><span className="lab-bl" title={label}>{label}</span><div className="track"><div className={'fill' + cls} style={{ width: (pct ?? 0) + '%' }} /></div><span className="pc">{pct ?? '—'}%</span></div>
  );
}

function Count({ x, of, label, state }: { x: number | string; of?: number; label: string; state?: LabState }) {
  return (
    <div className={'lab-cnt' + (state && state !== 'ok' ? ' s-' + state : '')}>
      <span className="x">{x}{of != null && <small>/{of}</small>}</span><span className="y">{label}</span>
    </div>
  );
}

function storageBars(list: LabStorage[], violet = false) {
  return list.slice(0, 4).map((s) => <Bar key={s.name} label={s.name} pct={s.pct} state={s.state} violet={violet} />);
}

function HostCard({ h }: { h: LabHost }) {
  const flag = h.state === 'bad' || h.state === 'warn' ? ' flag-' + h.state : '';
  if (h.kind === 'pve') {
    return (
      <div className={'lab-host glass' + flag}>
        <div className="lab-hh"><div className="lab-ic">PVE</div><div className="lab-hn"><b>{h.name}</b><small>Proxmox VE · {h.online ? `up ${h.uptime_days ?? '?'} days` : 'offline'}</small></div><span className={DOT[h.state]} /></div>
        <div className="bars"><Bar label="CPU" pct={h.cpu_pct} /><Bar label="RAM" pct={h.mem_pct} />{storageBars(h.storages)}</div>
        <div className="lab-counts">
          <Count x={h.lxc_up} of={h.lxc_total} label="LXC up" state={h.lxc_up + h.expected_stopped.filter((g) => g.startsWith('CT')).length < h.lxc_total ? 'bad' : 'ok'} />
          <Count x={h.vm_up} of={h.vm_total} label="VMs up" state={h.vm_up + h.expected_stopped.filter((g) => g.startsWith('VM')).length < h.vm_total ? 'bad' : 'ok'} />
          <Count x={h.storages.length} label="Storages" />
        </div>
        {h.expected_stopped.length > 0 && <div className="lab-foot"><span className="dot unknown" />{h.expected_stopped.join(', ')} stopped (expected)</div>}
      </div>
    );
  }
  if (h.kind === 'pbs') {
    const lb = h.last_backup;
    return (
      <div className={'lab-host glass' + flag}>
        <div className="lab-hh"><div className="lab-ic v">PBS</div><div className="lab-hn"><b>{h.name}</b><small>Proxmox Backup Server</small></div><span className={DOT[h.state]} /></div>
        <div className="bars">{storageBars(h.datastores, true)}</div>
        <div className="lab-counts">
          <Count x={lb ? lb.ok : '—'} of={lb?.guests} label="Last run" state={lb && lb.failed ? 'bad' : 'ok'} />
          <Count x={h.last_verify_at ? since(h.last_verify_at).replace(' ago', '') : 'never'} label="Since verify" />
          <Count x={h.last_gc ? (h.last_gc.ok ? 'ok' : 'failed') : '—'} label="GC" state={h.last_gc && !h.last_gc.ok ? 'warn' : 'ok'} />
        </div>
        <div className="lab-foot lab-split"><span>Last 7 nights</span>
          <span className="lab-blips" aria-label={'Backups, last 7 nights: ' + h.nights.join(', ')}>{h.nights.map((n, i) => <i key={i} className={'n-' + n} />)}</span>
        </div>
        <div className="lab-foot">{lb ? <>Last backup <b>{clock(lb.at)}</b></> : 'No backups found'}</div>
      </div>
    );
  }
  return (
    <div className={'lab-host glass' + flag}>
      <div className="lab-hh"><div className="lab-ic g">PT</div><div className="lab-hn"><b>{h.name}</b><small>Portainer environment · {h.online ? 'up' : 'unreachable'}</small></div><span className={DOT[h.state]} /></div>
      <div className="lab-counts">
        <Count x={h.running} label="Running" />
        <Count x={h.stopped} label="Stopped" state={h.state === 'bad' ? 'bad' : 'ok'} />
        <Count x={h.unhealthy} label="Unhealthy" state={h.unhealthy ? 'warn' : 'ok'} />
      </div>
      <div className="lab-foot"><b>{h.stacks}</b> stacks · {h.snapshot_at ? <>snapshot <b>{since(h.snapshot_at)}</b></> : 'no snapshot yet'}</div>
    </div>
  );
}

export function LabPanel({ env, onClose }: { env: Envelope<LabHealth> | null; onClose: () => void }) {
  const lab = env?.data;
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const state: LabState = lab?.state ?? 'unknown';
  const v = verdict(lab, env);
  const off = lab ? GROUPS.filter((g) => lab.sources[g.key].state === 'off') : [];

  return (
    <div className="lab-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lab-sheet glass" role="dialog" aria-modal="true" aria-label="Lab health">
        <div className="lab-sh">
          <span className={DOT[state]} /><span className="ttl">Lab health</span>
          {env?.ts && <span className="lab-ts">checked {since(env.ts)}</span>}
          <button ref={closeRef} type="button" className="lab-x" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="lab-body">
          {lab && lab.findings.length > 0 && (
            <>
              <div className="lab-k">Needs you</div>
              <div className="lab-finds">
                {lab.findings.map((f, i) => (
                  <div key={i} className="lab-find"><span className={DOT[f.state]} /><div className="what"><b>{f.title}</b><small>{f.detail}</small></div><span className="where">{f.where}</span></div>
                ))}
              </div>
            </>
          )}
          {lab && lab.findings.length === 0 && off.length < GROUPS.length && (
            <div className="lab-clear"><span className="dot" /><div><b>Nothing needs you</b><small>Every guest, backup and container that's set up looks fine.</small></div></div>
          )}
          {!lab && <div className="lab-clear s-unknown"><span className="dot unknown" /><div><b>{v.text}</b><small>{v.sub}</small></div></div>}
          {off.length > 0 && (
            <div className="lab-setup">
              <b>Not set up:</b> {off.map((g) => g.label).join(', ')}. Add {off.map((g) => g.setup).join('; ')} to the broker <code>.env</code> with read-only tokens, then restart it.
            </div>
          )}
          {lab && lab.hosts.length > 0 && (
            <>
              <div className="lab-k">Hosts</div>
              <div className="lab-hosts">{lab.hosts.map((h) => <HostCard key={h.kind + h.name} h={h} />)}</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
