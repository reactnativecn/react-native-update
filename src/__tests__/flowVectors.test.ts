import { describe, expect, test } from 'bun:test';
import vectorsFile from '../../cpp/update_flow_core/tests/flow_vectors.json';
import { buildVectors } from '../../scripts/generate-flow-vectors';

describe('flow golden vectors', () => {
  // The committed vectors are the parity contract between src/updateFlowCore.ts
  // (reference) and cpp/update_flow_core (port, replayed by test:flow-core).
  // A semantic change to the TS side must regenerate the file
  // (bun scripts/generate-flow-vectors.ts) AND keep the C++ side green —
  // this test catches the half-done state.
  test('committed vectors match the TS reference implementation', () => {
    // JSON round-trip applies the same undefined-dropping normalization the
    // generator's serialization does.
    expect(JSON.parse(JSON.stringify(buildVectors()))).toEqual(
      vectorsFile.cases
    );
  });
});
