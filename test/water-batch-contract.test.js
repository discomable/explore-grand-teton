import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../terrain/src/WaterBuilder.js', import.meta.url), 'utf8');
const window = { THREE: {}, location: { search: '' } };
vm.runInNewContext(source, { window, console }, { filename: 'WaterBuilder.js' });
const contract = window.GT_WATER_BATCH_CONTRACT;
const plain = value => JSON.parse(JSON.stringify(value));

function geometry(vertexCount, attributes = ['position', 'aEdge', 'aDepth', 'aFlow']) {
  const attrs = new Map(attributes.map(name => [name, { count: vertexCount }]));
  return {
    getAttribute: name => attrs.get(name),
    getIndex: () => null,
  };
}

test('water batching policy honors only the exact legacy control and capability fallback', () => {
  assert.deepEqual(plain(contract.decision('?waterbatch=0', true)),
    { enabled: false, reason: 'url-disabled' });
  assert.deepEqual(plain(contract.decision('?view=lake&waterbatch=0&norefl=1', true)),
    { enabled: false, reason: 'url-disabled' });
  assert.deepEqual(plain(contract.decision('?waterbatch=00', true)),
    { enabled: false, reason: 'experimental-not-requested' });
  assert.deepEqual(plain(contract.decision('?waterbatch=1', false)),
    { enabled: false, reason: 'batched-mesh-unsupported' });
  assert.deepEqual(plain(contract.decision('?waterbatch=1', true, false, true)),
    { enabled: false, reason: 'multi-draw-unsupported' });
  assert.deepEqual(plain(contract.decision('?waterbatch=1', true, true, false)),
    { enabled: false, reason: 'transparent-sort-unsupported' });
  assert.deepEqual(plain(contract.decision('', true)),
    { enabled: false, reason: 'experimental-not-requested' });
  assert.deepEqual(plain(contract.decision('?waterbatch=1', true)),
    { enabled: true, reason: null });
});

test('water batch plan preserves stable chunk membership and exact triangle totals', () => {
  const a = geometry(6), b = geometry(12);
  const plan = contract.plan([
    { mesh: { geometry: a } },
    { mesh: null },
    { mesh: { geometry: b } },
  ]);
  assert.equal(plan.valid, true);
  assert.deepEqual(Array.from(plan.members, member => member.chunkIndex), [0, 2]);
  assert.equal(plan.members[0].geometry, a);
  assert.equal(plan.members[1].geometry, b);
  assert.equal(plan.vertices, 18);
  assert.equal(plan.triangles, 6);

  const replacement = contract.plan([
    { mesh: { geometry: a } },
    { mesh: { geometry: geometry(24) } },
  ]);
  assert.deepEqual(Array.from(replacement.members, member => member.chunkIndex), [0, 1]);
  assert.equal(replacement.vertices, 30);
});

test('water batch plan rejects geometry that could change shader attributes or draw shape', () => {
  assert.deepEqual(plain(contract.plan([{ mesh: { geometry: geometry(6, ['position', 'aDepth', 'aFlow']) } }])), {
    valid: false, reason: 'incompatible-water-attributes', members: [],
  });
  const indexed = geometry(6);
  indexed.getIndex = () => ({ count: 6 });
  assert.deepEqual(plain(contract.plan([{ mesh: { geometry: indexed } }])), {
    valid: false, reason: 'indexed-water-geometry', members: [],
  });
});

test('surfaceAt query result is independent of the submission backend', () => {
  const surfaceAt = window.WaterBuilder.prototype.surfaceAt;
  const sample = () => [15, 0.25];
  for (const batched of [false, true]) {
    const owner = {
      _surf: new Uint16Array([1]), _sampS: sample, _surfaceBatch: batched ? {} : null,
      terrain: { heightAt: () => 14 },
    };
    assert.equal(surfaceAt.call(owner, 10, 20), 15);
    owner.terrain.heightAt = () => 15.25;
    assert.equal(surfaceAt.call(owner, 10, 20), null);
  }
});

test('legacy telemetry reports zero reflection work until a real mirror render', () => {
  const publish = window.WaterBuilder.prototype._publishTelemetry;
  const owner = {
    _chunks: [{ mesh: { geometry: geometry(6) }, band: null, dress: null }],
    _surfaceBatch: null, _batchFallbackReason: 'url-disabled',
    _batchRebuilds: 0, _reflectionPasses: 0,
  };
  publish.call(owner);
  assert.deepEqual({ ...window.GT_WATER_TELEMETRY }, {
    backend: 'legacy', surfaces: 1, batches: 0, calls: 1, triangles: 2,
    rebuilds: 0, reflectionPasses: 0, fallbackReason: 'url-disabled',
  });
});

test('batch replacement, fallback, and failed construction dispose owner resources exactly once', () => {
  const proto = window.WaterBuilder.prototype;
  const sourceGeometry = geometry(6);
  sourceGeometry.boundingSphere = {};
  sourceGeometry.boundingBox = {};
  const group = {
    add(object) { object.parent = this; },
    remove(object) { if (object.parent === this) object.parent = null; },
  };
  const makeBatch = () => ({
    parent: group, disposeCalls: 0,
    dispose() { this.disposeCalls++; },
  });
  class MockBatch {
    constructor() {
      this.geometry = {};
      this.disposeCalls = 0;
      MockBatch.instances.push(this);
    }
    updateMatrix() {}
    addGeometry() {
      if (MockBatch.fail) throw new Error('mock capacity failure');
      return 0;
    }
    addInstance() { return 0; }
    setVisibleAt(id, visible) { this.lastVisibility = { id, visible }; }
    computeBoundingSphere() {}
    onBeforeRender() {}
    dispose() { this.disposeCalls++; }
  }
  MockBatch.instances = [];
  MockBatch.fail = false;
  window.THREE.BatchedMesh = MockBatch;
  window.THREE.Matrix4 = class { multiplyMatrices() { return this; } };
  window.THREE.Frustum = class {
    setFromProjectionMatrix() { return this; }
    intersectsBox(box) { return box.inFrustum !== false; }
  };

  const old = makeBatch();
  const owner = {
    _chunks: [{ mesh: { geometry: sourceGeometry }, band: null, dress: null }],
    _surfaceBatch: old, _batchRebuilds: 0, _batchRequested: true,
    material: {}, group, _publishTelemetry() {},
    _disposeSurfaceBatch: proto._disposeSurfaceBatch,
    _fallbackToLegacy: proto._fallbackToLegacy,
  };
  assert.equal(proto._rebuildSurfaceBatch.call(owner), true);
  assert.equal(Object.hasOwn(owner._surfaceBatch, 'onBeforeRender'), true,
    'water visibility wrapper must feed BatchedMesh before its native sorting lifecycle');
  sourceGeometry.boundingBox.inFrustum = false;
  owner._surfaceBatch.onBeforeRender({}, {}, {
    projectionMatrix: {}, matrixWorldInverse: {},
  }, {}, {}, null);
  assert.deepEqual(owner._surfaceBatch.lastVisibility, { id: 0, visible: false });
  assert.equal(old.disposeCalls, 1, 'successful replacement owns and disposes the old batch');
  proto._disposeSurfaceBatch.call(owner, old);
  assert.equal(old.disposeCalls, 1, 'owner disposal is idempotent');

  const active = owner._surfaceBatch;
  proto._fallbackToLegacy.call(owner, 'test-fallback');
  assert.equal(active.disposeCalls, 1, 'fallback disposes the active batch');
  assert.equal(owner._surfaceBatch, null);

  MockBatch.fail = true;
  owner._batchRequested = true;
  assert.equal(proto._rebuildSurfaceBatch.call(owner), false);
  const failed = MockBatch.instances.at(-1);
  assert.equal(failed.disposeCalls, 1, 'failed construction disposes partial owner resources');
  assert.equal(owner._surfaceBatch, null);
});
