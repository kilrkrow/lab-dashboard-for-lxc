// Typed client for the local broker. Every call returns an envelope so the UI
// can tell live data from cached/stale (offline) data.
export interface Repo {
  name: string;
  /** owner/name — used for private-safe icon proxy */
  full_name?: string;
  description: string | null; html_url: string; language: string | null;
  pushed_at: string; stars: number; private: boolean; fork: boolean; archived: boolean;
  open_prs: number; open_issues: number;
  /** Broker path e.g. /api/repo-icon/owner/repo when assets/icon.png exists */
  icon_url?: string | null;
}
export interface GhIssue {
  id: number; number: number; title: string; html_url: string;
  repo: string; private_repo: boolean; updated_at: string; labels: string[];
}
export interface Radio { band: string; clients: number; util_pct: number; }
export interface Dr7 {
  wan: { status: string; down_mbps: number; up_mbps: number; latency_ms: number | null; ip: string | null; port: string };
  clients: { total: number; wired: number; wireless: number };
  radios: Radio[];
  gateway: { cpu_pct: number | null; mem_pct: number | null; temp_c: number | null; uptime_days: number | null };
  poe: { used_w: number; max_w: number };
}
export interface Proxmox {
  node: string; cpu_pct: number; mem_pct: number; temp_c: number | null;
  lxc_up: number; lxc_total: number; vm_up: number; vm_total: number; uptime_days: number | null;
}
export interface TileStatus {
  state: 'up' | 'down' | 'pending' | 'maintenance' | 'unknown';
  source: 'kuma' | 'probe';
  ms: number | null;
  /** Recent response times (ms), oldest first */
  history: number[];
  detail?: string;
}
/** Keyed by the tile's url from config.json */
export type StatusMap = Record<string, TileStatus>;
export interface Adguard { queries: number; blocked: number; blocked_pct: number; }

export interface Envelope<T> { ok: boolean; stale: boolean; mock?: boolean; ts: number | null; data: T | null; error?: string; }

export async function getEnvelope<T>(path: string): Promise<Envelope<T>> {
  try {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return (await r.json()) as Envelope<T>;
  } catch (e) {
    return { ok: false, stale: true, ts: null, data: null, error: String(e) };
  }
}

/* ---------- /api/lab — Proxmox VE, PBS and Portainer health ---------- */
export type LabState = 'ok' | 'warn' | 'bad' | 'unknown';
export type LabGroup = 'proxmox' | 'backups' | 'docker';
export interface LabFinding { state: 'warn' | 'bad'; group: LabGroup; title: string; detail: string; where: string; }
export interface LabStorage { name: string; pct: number; state: LabState; }
export interface LabPveHost {
  kind: 'pve'; name: string; state: LabState; online: boolean;
  cpu_pct: number | null; mem_pct: number | null; uptime_days: number | null;
  lxc_up: number; lxc_total: number; vm_up: number; vm_total: number;
  storages: LabStorage[]; expected_stopped: string[];
}
export interface LabPbsHost {
  kind: 'pbs'; name: string; state: LabState;
  datastores: LabStorage[];
  last_backup: { at: number; ok: number; failed: number; guests: number } | null;
  nights: Array<'ok' | 'warn' | 'bad' | 'none'>;
  last_verify_at: number | null;
  last_gc: { at: number; ok: boolean } | null;
}
export interface LabDockerHost {
  kind: 'portainer'; name: string; state: LabState; online: boolean;
  running: number; stopped: number; healthy: number; unhealthy: number; stacks: number;
  snapshot_at: number | null;
}
export type LabHost = LabPveHost | LabPbsHost | LabDockerHost;
export interface LabHealth {
  state: LabState;
  groups: Record<LabGroup, LabState>;
  findings: LabFinding[];
  hosts: LabHost[];
  sources: Record<LabGroup, { state: 'ok' | 'off' | 'error'; error?: string }>;
}
