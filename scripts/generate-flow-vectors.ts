// Golden-vector generator for the update-flow decision layer.
//
// src/updateFlowCore.ts is the reference implementation; this script runs it
// over a dense input matrix and writes the results to
// cpp/update_flow_core/tests/flow_vectors.json. The C++ port replays the same
// vectors in CI (scripts/test-update-flow-core.sh), and
// src/__tests__/flowVectors.test.ts fails whenever the TS implementation and
// the committed file disagree — so every semantic change must regenerate the
// vectors (bun scripts/generate-flow-vectors.ts) and keep both sides green.
//
// JSON cannot express `undefined`: an undefined return value is encoded by
// omitting `expected`, and undefined-valued object members disappear on
// serialization — the C++ side mirrors both (Kind::Undefined members are
// skipped by stringify).

import { fileURLToPath } from 'node:url';
import {
  buildCheckRequestBody,
  decideDownload,
  isInRollout,
  isMirrorRetryableCode,
  isValidCheckResult,
  joinUrls,
  murmurhash3_32_gc,
  orderEndpointCandidates,
  resolveCheckResult,
  shouldActivateAfterDownload,
} from '../src/updateFlowCore';

const impls: Record<string, (...args: any[]) => any> = {
  murmurhash3_32_gc,
  isInRollout,
  isMirrorRetryableCode,
  joinUrls,
  orderEndpointCandidates,
  buildCheckRequestBody,
  resolveCheckResult,
  decideDownload,
  shouldActivateAfterDownload,
  // Text in, verdict out: the C++ side parses with its own JSON parser.
  isValidCheckResponse: (text: string) => {
    try {
      return isValidCheckResult(JSON.parse(text));
    } catch {
      return false;
    }
  },
};

export interface FlowVector {
  fn: string;
  args: any[];
  expected?: any;
}

export const buildVectors = (): FlowVector[] => {
  const cases: FlowVector[] = [];
  const add = (fn: string, ...args: any[]) => {
    cases.push({ fn, args, expected: impls[fn](...args) });
  };

  // murmurhash3_32_gc — canonical reference vectors + bucketing inputs
  for (const key of [
    '',
    'hello',
    'test',
    'Hello, world!',
    'The quick brown fox jumps over the lazy dog',
    'test1',
    'test2',
    'test3',
    '123e4567-e89b-12d3-a456-426614174000',
    '123e4567-e89b-12d3-a456-426614174001',
    'a',
    'ab',
    'abc',
    'abcd', // every remainder-length path through the tail switch
    // Non-ASCII keys: the hash reads the low byte of each UTF-16 code unit
    // (charCodeAt & 0xff), so the C++ port must decode UTF-8 to UTF-16 units
    // — including surrogate pairs — rather than hash the UTF-8 bytes.
    'héllo',
    'ключ',
    '日本語',
    '😀',
    'a😀b',
    'é',
  ]) {
    add('murmurhash3_32_gc', key);
  }

  // isMirrorRetryableCode — only PATCH_FAILED is not worth another mirror
  add('isMirrorRetryableCode', 'PATCH_FAILED');
  add('isMirrorRetryableCode', 'DOWNLOAD_FAILED');
  add('isMirrorRetryableCode', '');
  add('isMirrorRetryableCode'); // undefined code

  // isInRollout — boundaries around murmur('test1') % 100 === 62
  add('isInRollout', 63, 'test1');
  add('isInRollout', 62, 'test1');
  add('isInRollout', 61, 'test1');
  add('isInRollout', 0, 'test1');
  add('isInRollout', 100, 'test1');
  add('isInRollout', -1, 'test3');
  add('isInRollout', 54, 'test3');
  add('isInRollout', 53, 'test3');

  // joinUrls
  add('joinUrls', ['example.com']); // no fileName -> undefined
  add('joinUrls', ['example.com'], ''); // falsy fileName -> undefined
  add('joinUrls', [], 'file.txt');
  add('joinUrls', ['example.com', 'test.org'], 'file.txt');
  add('joinUrls', ['example.com///', 'http://example.com///'], 'file.txt');
  add('joinUrls', ['ftp://example.com', 'myapp://some/path'], 'file.txt');
  add('joinUrls', ['192.168.1.1:8080', '10.0.0.1:3000/api'], 'file.txt');
  add('joinUrls', [''], 'file.txt');
  add('joinUrls', ['HTTPS://Upper.example.com'], 'file.txt');
  add('joinUrls', ['a:b://weird'], 'file.txt'); // scheme regex must not match

  // orderEndpointCandidates
  add('orderEndpointCandidates', ['a', 'b', 'c'], 0);
  add('orderEndpointCandidates', ['a', 'b', 'c'], 0.34);
  add('orderEndpointCandidates', ['a', 'b', 'c'], 0.5);
  add('orderEndpointCandidates', ['a', 'b', 'c'], 0.99);
  add('orderEndpointCandidates', ['a', 'b', 'c'], 1); // clamps to last
  add('orderEndpointCandidates', ['a', null, 'a', '', 'b'], 0.6);
  add('orderEndpointCandidates', [], 0.5);
  add('orderEndpointCandidates', ['a'], 0.5);
  // Non-string entries (a misconfigured endpoints list): truthy ones survive
  // and dedupe by === — 1 and '1' stay distinct, 1 and 1 collapse.
  add('orderEndpointCandidates', ['a', 1, 'a', 1, 2, true, 'b', '1', 0], 0);
  add('orderEndpointCandidates', ['a', 1, 'a', 1, 2, true, 'b', '1', 0], 0.5);

  // buildCheckRequestBody
  const cInfo = { rnu: '10.50.0', rn: '0.85.2', os: 'ios 17.5', uuid: 'u-1' };
  add('buildCheckRequestBody', {
    packageVersion: '2.3.4',
    currentVersion: 'abcdef1234',
    buildTime: '1719999999',
    cInfo,
  });
  add('buildCheckRequestBody', {
    packageVersion: '2.3.4',
    currentVersion: 'abcdef1234',
    buildTime: '1719999999',
    cInfo,
    supportedDiffVersion: 2,
    bundleHash: 'a'.repeat(64),
  });
  add('buildCheckRequestBody', {
    packageVersion: '2.3.4',
    currentVersion: '',
    buildTime: '1719999999',
    cInfo,
    supportedDiffVersion: 0,
    bundleHash: '',
  });
  // an empty extra adds no nested copy
  add('buildCheckRequestBody', {
    packageVersion: '2.3.4',
    currentVersion: 'abcdef1234',
    buildTime: '1719999999',
    cInfo,
    extra: {},
  });
  // extra is spread first: it may add keys but the SDK identity fields win
  // (an overridden key keeps extra's key position — JS spread semantics)
  add('buildCheckRequestBody', {
    packageVersion: '2.3.4',
    currentVersion: 'abcdef1234',
    buildTime: '1719999999',
    cInfo,
    extra: { toHash: 'debug-hash', hash: 'override-hash' },
  });
  // dev drops buildTime even when extra re-injects it
  add('buildCheckRequestBody', {
    packageVersion: '2.3.4',
    currentVersion: 'abcdef1234',
    buildTime: '1719999999',
    cInfo,
    isDev: true,
    extra: { buildTime: 'injected' },
  });
  // missing currentVersion: `hash` becomes undefined and vanishes on stringify
  add('buildCheckRequestBody', {
    packageVersion: '2.3.4',
    buildTime: '1719999999',
    cInfo,
  });

  // isValidCheckResponse — schema gate
  for (const text of [
    '{"upToDate":true}',
    '{"update":true,"hash":"h"}',
    '{"update":false}',
    '{"expired":true,"downloadUrl":"https://x"}',
    '{"paused":"app"}',
    '{"error":"internal"}',
    '{}',
    '[]',
    '"upToDate"',
    'null',
    '{"upToDate":"yes"}',
    '{"update":1}',
    '{"paused":true}',
    'not json',
    '',
    // Lone surrogate escapes are accepted by JSON.parse; the C++ parser must
    // accept them too (decoding each to U+FFFD, never invalid UTF-8).
    '{"upToDate":true,"s":"\\ud800"}',
    '{"upToDate":true,"s":"\\udc00x"}',
    '{"upToDate":true,"s":"\\ud800\\u0041"}',
    '{"upToDate":true,"s":"\\ud83d\\ude00"}',
  ]) {
    add('isValidCheckResponse', text);
  }

  // resolveCheckResult
  const identity = {
    packageVersion: '2.3.4',
    currentVersion: 'current-hash',
    uuid: 'test1', // bucket 62
  };
  const gray = (rollout: number, hash = 'gray-hash') => ({
    name: 'gray',
    hash,
    description: 'd',
    metaInfo: 'm',
    config: { rollout: { '2.3.4': rollout } },
  });
  const root = {
    update: true,
    hash: 'root-hash',
    name: 'root',
    description: 'rd',
    metaInfo: 'rm',
    diff: 'a.hdiff',
    pdiff: 'b.phdiff',
    full: 'c.ppk',
    paths: ['cdn.example.com'],
  };
  add('resolveCheckResult', { ...root, expVersion: gray(63) }, identity);
  add('resolveCheckResult', { ...root, expVersion: gray(62) }, identity);
  add(
    'resolveCheckResult',
    { ...root, expVersion: gray(100, 'current-hash') },
    identity
  );
  add('resolveCheckResult', { ...root }, identity);
  add('resolveCheckResult', { ...root, hash: 'current-hash' }, identity);
  add('resolveCheckResult', { upToDate: true }, identity);
  add('resolveCheckResult', { update: false, hash: 'x' }, identity);
  // rollout keyed by another packageVersion is ignored
  add(
    'resolveCheckResult',
    {
      ...root,
      expVersion: { ...gray(100), config: { rollout: { other: 100 } } },
    },
    identity
  );
  // in-rollout target without root paths: nothing inherited
  add(
    'resolveCheckResult',
    { update: true, hash: 'root-hash', expVersion: gray(63) },
    identity
  );
  // strict-equality edge: both hashes undefined -> upToDate
  add(
    'resolveCheckResult',
    {
      update: true,
      hash: 'root-hash',
      expVersion: { ...gray(63), hash: undefined },
    },
    { packageVersion: '2.3.4', uuid: 'test1' }
  );

  // decideDownload
  const dlIdentity = {
    currentVersion: 'current-hash',
    rolledBackVersion: 'bad-hash',
  };
  const dlInfo = {
    update: true,
    hash: 'next-hash',
    diff: 'cur-next.hdiff',
    pdiff: 'pkg-next.phdiff',
    full: 'next.ppk',
    paths: ['cdn.example.com', 'https://mirror.example.com/base/'],
  };
  add('decideDownload', { upToDate: true }, dlIdentity, false);
  add('decideDownload', { update: true }, dlIdentity, false);
  add('decideDownload', { ...dlInfo, hash: 'current-hash' }, dlIdentity, false);
  add('decideDownload', { ...dlInfo, hash: 'bad-hash' }, dlIdentity, false);
  // no rolledBackVersion recorded: same hash must NOT be declined
  add(
    'decideDownload',
    { ...dlInfo, hash: 'bad-hash' },
    { currentVersion: 'current-hash' },
    false
  );
  add('decideDownload', dlInfo, dlIdentity, false);
  add('decideDownload', { ...dlInfo, diff: undefined }, dlIdentity, false);
  add('decideDownload', { ...dlInfo, pdiff: undefined }, dlIdentity, false);
  add(
    'decideDownload',
    { ...dlInfo, diff: undefined, pdiff: undefined, full: undefined },
    dlIdentity,
    false
  );
  add('decideDownload', { ...dlInfo, paths: [] }, dlIdentity, false);
  // a server `paths: null` behaves like an absent field
  add('decideDownload', { ...dlInfo, paths: null }, dlIdentity, false);
  add('decideDownload', { ...dlInfo, paths: null }, dlIdentity, true); // devNoop
  add(
    'decideDownload',
    { update: true, hash: 'next-hash', full: 'next.ppk' },
    dlIdentity,
    false
  ); // paths defaulted to []
  add('decideDownload', dlInfo, dlIdentity, true); // dev: full only
  add('decideDownload', { ...dlInfo, full: undefined }, dlIdentity, true); // devNoop

  // shouldActivateAfterDownload — silent strategies opt in locally, the
  // server's per-version forceBoot overrides remotely (JS truthiness)
  add('shouldActivateAfterDownload', { hash: 'x' }, 'setNeedUpdate');
  add('shouldActivateAfterDownload', { hash: 'x' }, 'none');
  add(
    'shouldActivateAfterDownload',
    { hash: 'x', config: { forceBoot: true } },
    'none'
  );
  add(
    'shouldActivateAfterDownload',
    { hash: 'x', config: { forceBoot: false } },
    'none'
  );
  add(
    'shouldActivateAfterDownload',
    { hash: 'x', config: { forceBoot: 1 } },
    'none'
  );
  add('shouldActivateAfterDownload', { hash: 'x', config: {} }, 'none');
  add('shouldActivateAfterDownload', {
    hash: 'x',
    config: { forceBoot: true },
  });
  add('shouldActivateAfterDownload', { upToDate: true }, 'none');

  return cases;
};

if (import.meta.main) {
  const outPath = fileURLToPath(
    new URL('../cpp/update_flow_core/tests/flow_vectors.json', import.meta.url)
  );
  const doc = {
    generated_by: 'scripts/generate-flow-vectors.ts — do not edit by hand',
    cases: buildVectors(),
  };
  await Bun.write(outPath, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${doc.cases.length} vectors to ${outPath}`);
}
