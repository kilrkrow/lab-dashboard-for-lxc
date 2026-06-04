// Typed client for the local broker. Every call returns an envelope so the UI
// can tell live data from cached/stale (offline) data.
export interface Repo {
  name: string; description: string | null; html_url: string; language: string | null;
  pushed_at: string; stars: number; private: boolean; fork: boolean; archived: boolean;
  open_prs: number; open_issues: number;
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
