#!/usr/bin/env bun

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCAL_UPDATE_APP_KEYS,
  LOCAL_UPDATE_FILES,
  LOCAL_UPDATE_HASHES,
  LOCAL_UPDATE_PORT,
} from '../e2e/localUpdateConfig.ts';

declare const Bun: any;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const artifactsRoot = path.resolve(moduleDir, '../.e2e-artifacts');
const port = Number(process.env.E2E_ASSET_PORT || LOCAL_UPDATE_PORT);
const appKeyToPlatform = Object.fromEntries(
  Object.entries(LOCAL_UPDATE_APP_KEYS).map(([platform, appKey]) => [
    appKey,
    platform,
  ]),
);

const contentTypes: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.ppk': 'application/octet-stream',
  '.patch': 'application/octet-stream',
  '.apk': 'application/vnd.android.package-archive',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function safeResolve(urlPath: string) {
  const relativePath = urlPath.replace(/^\/artifacts/, '');
  const normalized = path
    .normalize(decodeURIComponent(relativePath))
    .replace(/^(\.\.(\/|\\|$))+/, '');
  const target = path.resolve(artifactsRoot, `.${normalized}`);
  if (!target.startsWith(artifactsRoot)) {
    return null;
  }
  return target;
}

function buildUpdateResponse(
  platform: string,
  currentHash: string,
  origin: string,
) {
  const assetBasePath = `${origin}/artifacts/${platform}`;

  if (!currentHash) {
    return {
      update: true,
      name: 'local-full-v1',
      hash: LOCAL_UPDATE_HASHES.full,
      description: 'Serve a full package from local e2e server.',
      metaInfo: JSON.stringify({ stage: 'full', platform }),
      paths: [assetBasePath],
      full: LOCAL_UPDATE_FILES.full,
    };
  }

  if (currentHash === LOCAL_UPDATE_HASHES.full) {
    return {
      update: true,
      name: 'local-diff-v2',
      hash: LOCAL_UPDATE_HASHES.ppkPatch,
      description: 'Serve a ppk diff package from local e2e server.',
      metaInfo: JSON.stringify({ stage: 'diff', platform }),
      paths: [assetBasePath],
      diff: LOCAL_UPDATE_FILES.ppkDiff,
    };
  }

  if (platform === 'android' && currentHash === LOCAL_UPDATE_HASHES.ppkPatch) {
    return {
      update: true,
      name: 'local-pdiff-v3',
      hash: LOCAL_UPDATE_HASHES.packagePatch,
      description: 'Serve an Android package diff from local e2e server.',
      metaInfo: JSON.stringify({ stage: 'pdiff', platform }),
      paths: [assetBasePath],
      pdiff: LOCAL_UPDATE_FILES.packageDiff,
    };
  }

  return {
    upToDate: true,
  };
}

const server = Bun.serve({
  port,
  hostname: '0.0.0.0',
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    if (url.pathname.startsWith('/checkUpdate/')) {
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405 });
      }

      const appKey = url.pathname.split('/').pop();
      const platform = appKey ? appKeyToPlatform[appKey] : null;
      if (!platform) {
        return json({ message: 'unknown appKey' }, 404);
      }

      const payload = (await request
        .json()
        .catch(() => ({}))) as { hash?: unknown };
      const currentHash = typeof payload.hash === 'string' ? payload.hash : '';

      return json(buildUpdateResponse(platform, currentHash, url.origin));
    }

    if (url.pathname.startsWith('/artifacts/')) {
      const filePath = safeResolve(url.pathname);
      if (
        !filePath ||
        !fs.existsSync(filePath) ||
        fs.statSync(filePath).isDirectory()
      ) {
        return new Response('not found', { status: 404 });
      }

      const file = Bun.file(filePath);
      const ext = path.extname(filePath);
      const contentType = contentTypes[ext] || 'application/octet-stream';

      return new Response(request.method === 'HEAD' ? null : file, {
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(file.size),
          'Cache-Control': 'no-store',
        },
      });
    }

    return new Response('not found', { status: 404 });
  },
});

console.log(`local e2e server listening on ${server.hostname}:${server.port}`);
