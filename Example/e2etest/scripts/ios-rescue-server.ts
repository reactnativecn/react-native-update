#!/usr/bin/env bun
// One-off server for the §11 iOS crash-rescue experiment (not part of the
// regular e2e suites). Update chain: no hash → brick; brick → fix. The /state
// endpoint reports what was served, so the driver can assert the sequence.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

declare const Bun: any;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const artifactsDir = path.resolve(moduleDir, '../.e2e-artifacts/ios-rescue');
// The app hardcodes this port (localUpdateConfig LOCAL_UPDATE_PORT).
const port = 31337;

const BRICK_HASH = 'e2e-rescue-brick';
const FIX_HASH = 'e2e-rescue-fix';

const served: string[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

const server = Bun.serve({
  port,
  hostname: '0.0.0.0',
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === '/state') {
      return json({ served });
    }

    if (url.pathname.startsWith('/checkUpdate/')) {
      const payload = (await request.json().catch(() => ({}))) as {
        hash?: unknown;
      };
      const currentHash = typeof payload.hash === 'string' ? payload.hash : '';
      const assetBasePath = `${url.origin}/artifacts`;
      let response: Record<string, unknown>;
      if (!currentHash) {
        response = {
          update: true,
          name: 'rescue-brick',
          hash: BRICK_HASH,
          description: 'brick: crashes on launch after arming',
          paths: [assetBasePath],
          full: 'brick.ppk',
          // Deliver the brick via forceBoot (the app runs checkStrategy:null /
          // afterDownload:none, so nothing else would activate it). The FIX
          // response deliberately has no forceBoot: its activation must come
          // from the crash-rescue window itself.
          config: { forceBoot: true },
        };
      } else if (currentHash === BRICK_HASH) {
        response = {
          update: true,
          name: 'rescue-fix',
          hash: FIX_HASH,
          description: 'fix: disarms the brick flag',
          paths: [assetBasePath],
          full: 'fix.ppk',
        };
      } else {
        response = { upToDate: true };
      }
      served.push(`${currentHash || '(base)'} -> ${JSON.stringify(response.hash ?? 'upToDate')}`);
      console.log(`[checkUpdate] hash=${currentHash || '(base)'} ->`, response.hash ?? 'upToDate');
      return json(response);
    }

    if (url.pathname.startsWith('/artifacts/')) {
      const name = path.basename(url.pathname);
      const filePath = path.join(artifactsDir, name);
      if (!fs.existsSync(filePath)) {
        return new Response('not found', { status: 404 });
      }
      console.log(`[artifact] ${name}`);
      const file = Bun.file(filePath);
      return new Response(request.method === 'HEAD' ? null : file, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(file.size),
          'Cache-Control': 'no-store',
        },
      });
    }

    return new Response('not found', { status: 404 });
  },
});

console.log(`ios rescue server listening on ${server.hostname}:${server.port}`);
