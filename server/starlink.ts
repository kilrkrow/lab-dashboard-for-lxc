/**
 * Starlink dish status client — JS/TS equivalent of wan-glass
 * `src/WanGlass.Unifi/Starlink/` (StarlinkSettings, StarlinkDishClient,
 * StarlinkMetricsSource).
 *
 * Talks plaintext gRPC (HTTP/2) to the dish. Instantaneous up/down rates
 * are already bits/sec — convert to Mbps with / 1e6, never ×8.
 *
 * Protocol: server/starlink_status.proto (SpaceX.API.Device field numbers).
 */

import http2 from 'node:http2';

export const STARLINK_DEFAULT_HOST = '192.168.100.1';
export const STARLINK_DEFAULT_PORT = 9200;
export const STARLINK_GRPC_PATH = '/SpaceX.API.Device.Device/Handle';

const WT_VARINT = 0;
const WT_I64 = 1;
const WT_LEN = 2;
const WT_I32 = 5;

/** Request.get_status */
export const FIELD_GET_STATUS = 1004;
/** Response.dish_get_status */
export const FIELD_DISH_GET_STATUS = 2004;
/** DishGetStatus.downlink_throughput_bps (float, bits/sec) */
export const FIELD_DOWNLINK_BPS = 1007;
/** DishGetStatus.uplink_throughput_bps (float, bits/sec) */
export const FIELD_UPLINK_BPS = 1008;
/** DishGetStatus.pop_ping_latency_ms (float) */
export const FIELD_POP_PING_MS = 1009;
/** DishGetStatus.outage */
export const FIELD_OUTAGE = 1014;
/** Older firmware scalar doubles (fallback only). */
const FIELD_LEGACY_DOWNLINK = 7;
const FIELD_LEGACY_UPLINK = 8;

export interface StarlinkSettings {
  enabled: boolean;
  host: string;
  port: number;
}

export interface StarlinkSample {
  downBps: number;
  upBps: number;
  downMbps: number;
  upMbps: number;
  latencyMs: number | null;
  connected: boolean;
}

export interface StarlinkFetchResult {
  sample: StarlinkSample | null;
  stale: boolean;
  error: string | null;
}

function truthy(v: string | undefined): boolean {
  return !!v && /^(1|true|yes|on)$/i.test(v.trim());
}

function writeVarint(n: number | bigint): Buffer {
  let v = typeof n === 'bigint' ? n : BigInt(n >>> 0);
  if (typeof n === 'number' && n < 0) v = BigInt(n);
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function readVarint(buf: Buffer, offset: number): { value: bigint; offset: number } {
  let v = 0n;
  let shift = 0n;
  while (offset < buf.length) {
    const b = buf[offset++];
    v |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) break;
  }
  return { value: v, offset };
}

function writeTag(field: number, wt: number): Buffer {
  return writeVarint((field << 3) | wt);
}

export function encodeLenField(field: number, payload: Buffer): Buffer {
  return Buffer.concat([writeTag(field, WT_LEN), writeVarint(payload.length), payload]);
}

export function encodeFloatField(field: number, value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeFloatLE(value);
  return Buffer.concat([writeTag(field, WT_I32), b]);
}

export function encodeVarintField(field: number, value: number | bigint): Buffer {
  return Buffer.concat([writeTag(field, WT_VARINT), writeVarint(value)]);
}

/** Request { get_status: {} } */
export function encodeGetStatusRequest(): Buffer {
  return encodeLenField(FIELD_GET_STATUS, Buffer.alloc(0));
}

export function encodeDishStatusResponse(opts: {
  downBps: number;
  upBps: number;
  latencyMs?: number;
  outageCause?: number;
  outageDurationNs?: number;
}): Buffer {
  const parts: Buffer[] = [
    encodeFloatField(FIELD_DOWNLINK_BPS, opts.downBps),
    encodeFloatField(FIELD_UPLINK_BPS, opts.upBps),
  ];
  if (opts.latencyMs != null) parts.push(encodeFloatField(FIELD_POP_PING_MS, opts.latencyMs));
  if (opts.outageCause != null || opts.outageDurationNs != null) {
    const o: Buffer[] = [];
    if (opts.outageCause != null) o.push(encodeVarintField(1, opts.outageCause));
    if (opts.outageDurationNs != null) o.push(encodeVarintField(3, opts.outageDurationNs));
    parts.push(encodeLenField(FIELD_OUTAGE, Buffer.concat(o)));
  }
  return encodeLenField(FIELD_DISH_GET_STATUS, Buffer.concat(parts));
}

interface ProtoField {
  field: number;
  wt: number;
  bytes?: Buffer;
  varint?: bigint;
}

export function decodeMessage(buf: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let i = 0;
  while (i < buf.length) {
    const tag = readVarint(buf, i);
    i = tag.offset;
    const field = Number(tag.value >> 3n);
    const wt = Number(tag.value & 7n);
    if (wt === WT_VARINT) {
      const v = readVarint(buf, i);
      i = v.offset;
      fields.push({ field, wt, varint: v.value });
    } else if (wt === WT_I64) {
      if (i + 8 > buf.length) break;
      fields.push({ field, wt, bytes: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wt === WT_I32) {
      if (i + 4 > buf.length) break;
      fields.push({ field, wt, bytes: buf.subarray(i, i + 4) });
      i += 4;
    } else if (wt === WT_LEN) {
      const len = readVarint(buf, i);
      i = len.offset;
      const n = Number(len.value);
      if (n < 0 || i + n > buf.length) break;
      fields.push({ field, wt, bytes: buf.subarray(i, i + n) });
      i += n;
    } else {
      break;
    }
  }
  return fields;
}

function readNumeric(f: ProtoField | undefined): number | undefined {
  if (!f) return undefined;
  if (f.wt === WT_I32 && f.bytes && f.bytes.length >= 4) return f.bytes.readFloatLE(0);
  if (f.wt === WT_I64 && f.bytes && f.bytes.length >= 8) return f.bytes.readDoubleLE(0);
  if (f.varint != null) return Number(f.varint);
  return undefined;
}

/** Dish rates are bits/sec. Do not ×8 (that UniFi path is bytes/sec). */
export function bpsToMbps(bps: number): number {
  if (!Number.isFinite(bps)) return 0;
  return +(Math.max(0, bps) / 1_000_000).toFixed(2);
}

export function decodeDishStatus(responseBytes: Buffer): StarlinkSample {
  const top = decodeMessage(responseBytes);
  const dish = top.find((f) => f.field === FIELD_DISH_GET_STATUS && f.wt === WT_LEN);
  if (!dish?.bytes) throw new Error('Starlink response missing dish_get_status (field 2004)');

  const inner = decodeMessage(dish.bytes);
  const byField = (n: number) => inner.find((f) => f.field === n);

  const downBps = readNumeric(byField(FIELD_DOWNLINK_BPS)) ?? readNumeric(byField(FIELD_LEGACY_DOWNLINK)) ?? 0;
  const upBps = readNumeric(byField(FIELD_UPLINK_BPS)) ?? readNumeric(byField(FIELD_LEGACY_UPLINK)) ?? 0;
  const latency = readNumeric(byField(FIELD_POP_PING_MS));

  let connected = true;
  const outage = byField(FIELD_OUTAGE);
  if (outage?.bytes && outage.bytes.length > 0) {
    const of = decodeMessage(outage.bytes);
    const cause = of.find((f) => f.field === 1)?.varint ?? 0n;
    const duration = of.find((f) => f.field === 3)?.varint ?? 0n;
    if (cause !== 0n || duration !== 0n) connected = false;
  }

  return {
    downBps,
    upBps,
    downMbps: bpsToMbps(downBps),
    upMbps: bpsToMbps(upBps),
    latencyMs: latency != null && Number.isFinite(latency) ? Math.round(latency) : null,
    connected,
  };
}

export function loadStarlinkSettings(env: NodeJS.Dict<string> = process.env): StarlinkSettings {
  // Analogous to wan-glass WANGLASS_STARLINK / WANGLASS_STARLINK_HOST.
  const enabled = truthy(env.STARLINK ?? env.STARLINK_ENABLED ?? env.WANGLASS_STARLINK);
  let host = (env.STARLINK_HOST || env.WANGLASS_STARLINK_HOST || STARLINK_DEFAULT_HOST).trim();
  host = host.replace(/^https?:\/\//i, '');
  let port = parseInt(env.STARLINK_PORT || String(STARLINK_DEFAULT_PORT), 10);

  const bracket = host.match(/^\[([^\]]+)](?::(\d+))?$/);
  if (bracket) {
    host = bracket[1];
    if (bracket[2]) port = parseInt(bracket[2], 10);
  } else {
    const lastColon = host.lastIndexOf(':');
    if (lastColon > 0 && host.indexOf(':') === lastColon && /^\d+$/.test(host.slice(lastColon + 1))) {
      port = parseInt(host.slice(lastColon + 1), 10);
      host = host.slice(0, lastColon);
    }
  }
  if (!Number.isFinite(port) || port <= 0 || port > 65535) port = STARLINK_DEFAULT_PORT;
  if (!host) host = STARLINK_DEFAULT_HOST;
  return { enabled, host, port };
}

export function wrapGrpcFrame(payload: Buffer): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

export function unwrapGrpcFrames(buf: Buffer): Buffer {
  const parts: Buffer[] = [];
  let i = 0;
  while (i + 5 <= buf.length) {
    const compressed = buf[i];
    const len = buf.readUInt32BE(i + 1);
    i += 5;
    if (compressed) throw new Error('Starlink gRPC compressed frame not supported');
    if (len < 0 || i + len > buf.length) break;
    parts.push(buf.subarray(i, i + len));
    i += len;
  }
  if (!parts.length) throw new Error('Starlink gRPC empty response');
  return Buffer.concat(parts);
}

export function grpcHandle(
  host: string,
  port: number,
  payload: Buffer,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let client: http2.ClientHttp2Session | undefined;
    const done = (err: Error | null, data?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client?.close(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(data!);
    };

    const timer = setTimeout(
      () => done(new Error(`Starlink timeout ${timeoutMs}ms ${host}:${port}`)),
      timeoutMs,
    );

    try {
      client = http2.connect(`http://${host}:${port}`);
    } catch (err) {
      done(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    client.on('error', (e) => done(e instanceof Error ? e : new Error(String(e))));

    const req = client.request({
      ':method': 'POST',
      ':path': STARLINK_GRPC_PATH,
      ':scheme': 'http',
      ':authority': `${host}:${port}`,
      'content-type': 'application/grpc',
      te: 'trailers',
      'user-agent': 'havenlab-broker/starlink',
    });

    const chunks: Buffer[] = [];
    let grpcStatus = '';
    req.on('response', (headers) => {
      if (headers['grpc-status'] != null) grpcStatus = String(headers['grpc-status']);
    });
    req.on('trailers', (headers) => {
      if (headers['grpc-status'] != null) grpcStatus = String(headers['grpc-status']);
    });
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', (e) => done(e instanceof Error ? e : new Error(String(e))));
    req.on('end', () => {
      if (grpcStatus && grpcStatus !== '0') {
        done(new Error(`Starlink gRPC status ${grpcStatus}`));
        return;
      }
      try {
        done(null, unwrapGrpcFrames(Buffer.concat(chunks)));
      } catch (e) {
        done(e instanceof Error ? e : new Error(String(e)));
      }
    });
    req.end(wrapGrpcFrame(payload));
  });
}

let lastGood: StarlinkSample | null = null;
let lastError: string | null = null;

export function resetStarlinkCache(): void {
  lastGood = null;
  lastError = null;
}

export function starlinkHealth(): { lastError: string | null; hasSample: boolean } {
  return { lastError, hasSample: !!lastGood };
}

/**
 * Fetch instantaneous dish rates. Never throws — last-good sample is returned
 * as stale when the dish is unreachable.
 */
export async function fetchStarlinkSample(
  settings: StarlinkSettings,
  timeoutMs = 4000,
): Promise<StarlinkFetchResult> {
  if (!settings.enabled) return { sample: null, stale: false, error: null };
  try {
    const raw = await grpcHandle(settings.host, settings.port, encodeGetStatusRequest(), timeoutMs);
    const sample = decodeDishStatus(raw);
    lastGood = sample;
    lastError = null;
    return { sample, stale: false, error: null };
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    if (lastGood) return { sample: lastGood, stale: true, error: lastError };
    return { sample: null, stale: true, error: lastError };
  }
}
