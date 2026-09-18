# Change Log

History of meaningful changes to this bundle, newest first.

## 2026-09-17

**Starlink WAN meter** — `/api/dr7` `wan.down_mbps` / `wan.up_mbps` prefer the
Starlink dish (wan-glass `StarlinkMetricsSource` semantics: instantaneous
bits/sec, host `192.168.100.1:9200`) when `STARLINK=1`. UniFi remains the source
for clients, radios, gateway, and PoE. Soft-fail to last-good dish sample.

## 2026-06-23

**Creation** — Initial bundle. Captured the pre-migration architecture of the
Haven Lab Dashboard (`kilrkrow/lab-dashboard-for-lxc` @ `630d312`):
the React SPA, the Node broker and its seven HTTP paths, the LAN topology, and
the current deploy runbook. Authored by the Developer agent from a read of
`server/broker.ts`, `src/api.ts`, and `src/App.tsx` during the Cloudflare
migration review.
