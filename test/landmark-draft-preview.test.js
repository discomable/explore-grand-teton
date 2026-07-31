import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync('terrain/src/LandmarkManager.js', 'utf8');

function manager(hostname, search) {
  const window = { THREE: {}, location: { hostname, search } };
  vm.runInNewContext(source, { window, URLSearchParams });
  return new window.LandmarkManager({
    scene: {}, camera: {}, sampleGround: () => 0,
    url: 'terrain/public/landmarks.json',
  });
}

test('localhost can opt into a sanitized ignored landmark draft run', () => {
  const value = manager('localhost', '?landmarkDraftRun=all-six-2026-07-28');
  assert.equal(value.draftRun, 'all-six-2026-07-28');
  assert.equal(value.url,
    'terrain/pipeline/work/landmark-batches/all-six-2026-07-28/preview/landmarks.json');
});

test('deployed hosts always retain the production landmark manifest', () => {
  const value = manager('grand-teton.pages.dev', '?landmarkDraftRun=all-six-2026-07-28');
  assert.equal(value.draftRun, null);
  assert.equal(value.url, 'terrain/public/landmarks.json');
});

test('unsafe run ids cannot escape the ignored batch directory', () => {
  const value = manager('127.0.0.1', '?landmarkDraftRun=../../public');
  assert.equal(value.draftRun, null);
  assert.equal(value.url, 'terrain/public/landmarks.json');
});
