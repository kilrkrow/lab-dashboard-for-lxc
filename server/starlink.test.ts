import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import type { IncomingHttpHeaders, ServerHttp2Stream } from 'node:http2';
import {
  bpsToMbps,
  decodeDishStatus,
  encodeDishStatusResponse,
  encodeGetStatusRequest,
  fetchStarlinkSample,
  loadStarlinkSettings,
  resetStarlinkCache,
  unwrapGrpcFrames,
  wrapGrpcFrame,
  FIELD_GET_STATUS,
  STARLINK_GRPC_PATH,
} from './starlink.ts';

describe('bpsToMbps', () => {
  it('treats dish rates as bits/sec (does not ×8)', () => {
    assert.equal(bpsToMbps(50_000_000), 50);
    assert.equal(bpsToMbps(1_250_000), 1.25);
    assert.equal(bpsToMbps(0), 0);
    // UniFi-style ×8 would yield 400 — that is the bug we must not regress
    assert.notEqual(bpsToMbps(50_000_000), 400);
  });
});

describe('loadStarlinkSettings', () => {
  it('is off unless STARLINK / WANGLASS_STARLINK is set', () => {
    const s = loadStarlinkSettings({});
    assert.equal(s.enabled, false);
    assert.equal(s.host, '192.168.100.1');
    assert.equal(s.port, 9200);
  });

  it('accepts wan-glass aliases and host:port override', () => {
    const s = loadStarlinkSettings({
      WANGLASS_STARLINK: '1',
      WANGLASS_STARLINK_HOST: '10.0.0.4:9201',
    });
    assert.equal(s.enabled, true);
    assert.equal(s.host, '10.0.0.4');
    assert.equal(s.port, 9201);
  });

  it('accepts STARLINK=true and STARLINK_HOST defaulting to Haven dish', () => {
    const s = loadStarlinkSettings({ STARLINK: 'true' });
    assert.equal(s.enabled, true);
    assert.equal(s.host, '192.168.100.1');
    assert.equal(s.port, 9200);
  });
});

describe('protobuf get_status / dish_get_status', () => {
  it('encodes Request.get_status = 1004 empty message', () => {
    const buf = encodeGetStatusRequest();
    // tag 1004/len + length 0 → E2 3E 00
    assert.deepEqual([...buf], [0xe2, 0x3e, 0x00]);
  });

  it('round-trips instantaneous rates and latency', () => {
    const raw = encodeDishStatusResponse({
      downBps: 42_000_000,
      upBps: 8_500_000,
      latencyMs: 27.4,
    });
    const s = decodeDishStatus(raw);
    assert.equal(s.downMbps, 42);
    assert.equal(s.upMbps, 8.5);
    assert.equal(s.latencyMs, 27);
    assert.equal(s.connected, true);
  });

  it('marks disconnected when outage cause is set', () => {
    const raw = encodeDishStatusResponse({
      downBps: 0,
      upBps: 0,
      outageCause: 6, // OBSTRUCTED
    });
    const s = decodeDishStatus(raw);
    assert.equal(s.connected, false);
  });
});

function listenMockDish(
  handler: (payload: Buffer) => Buffer,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http2.createServer();
  server.on('stream', (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    if (headers[':path'] !== STARLINK_GRPC_PATH) {
      stream.respond({ ':status': 404 }, { endStream: true });
      return;
    }
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => {
      try {
        const req = unwrapGrpcFrames(Buffer.concat(chunks));
        assert.equal(req[0], encodeGetStatusRequest()[0]);
        void FIELD_GET_STATUS;
        const body = wrapGrpcFrame(handler(req));
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' });
        stream.end(body);
      } catch (err) {
        stream.respond({ ':status': 500 }, { endStream: true });
        void err;
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve({
        port: addr.port,
        close: () => new Promise((res, rej) => {
          server.close((e) => (e ? rej(e) : res()));
        }),
      });
    });
    server.on('error', reject);
  });
}

describe('fetchStarlinkSample', () => {
  beforeEach(() => resetStarlinkCache());

  it('reads live dish rates over HTTP/2 gRPC', async () => {
    const mock = await listenMockDish(() => encodeDishStatusResponse({
      downBps: 12_000_000,
      upBps: 3_000_000,
      latencyMs: 19,
    }));
    try {
      const r = await fetchStarlinkSample({ enabled: true, host: '127.0.0.1', port: mock.port }, 2000);
      assert.equal(r.error, null);
      assert.equal(r.stale, false);
      assert.equal(r.sample?.downMbps, 12);
      assert.equal(r.sample?.upMbps, 3);
      assert.equal(r.sample?.latencyMs, 19);
    } finally {
      await mock.close();
    }
  });

  it('fails soft and returns last-good when the dish is unreachable', async () => {
    const mock = await listenMockDish(() => encodeDishStatusResponse({
      downBps: 9_000_000,
      upBps: 1_000_000,
    }));
    const settings = { enabled: true, host: '127.0.0.1', port: mock.port };
    const live = await fetchStarlinkSample(settings, 2000);
    assert.equal(live.sample?.downMbps, 9);
    await mock.close();

    const stale = await fetchStarlinkSample({ enabled: true, host: '127.0.0.1', port: mock.port }, 500);
    assert.equal(stale.stale, true);
    assert.ok(stale.error);
    assert.equal(stale.sample?.downMbps, 9);
  });

  it('does not throw when no sample has ever succeeded', async () => {
    const r = await fetchStarlinkSample({ enabled: true, host: '127.0.0.1', port: 1 }, 300);
    assert.equal(r.sample, null);
    assert.equal(r.stale, true);
    assert.ok(r.error);
  });
});
