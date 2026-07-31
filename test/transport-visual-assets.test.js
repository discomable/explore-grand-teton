import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const roadSource = new URL('../terrain/src/RoadRibbon.js', import.meta.url);
const trailSource = new URL('../terrain/src/TrailBuilder.js', import.meta.url);
const trackAlbedo = new URL(
  '../terrain/public/materials/transport/dry-two-track-albedo.webp', import.meta.url);
const trailAlbedo = new URL(
  '../terrain/public/materials/transport/packed-trail-albedo.webp', import.meta.url);

test('photographic transport material assets are checked in and residency-bounded', async () => {
  const [track, trail] = await Promise.all([stat(trackAlbedo), stat(trailAlbedo)]);
  assert.ok(track.size > 100_000, 'track material should contain useful photographic detail');
  assert.ok(trail.size > 100_000, 'trail material should contain useful photographic detail');
  assert.ok(track.size < 600_000, 'track material must remain compact');
  assert.ok(trail.size < 600_000, 'trail material must remain compact');
});

test('tracks and trails consume photographic materials with deterministic broken edges', async () => {
  const [road, trail] = await Promise.all([
    readFile(roadSource, 'utf8'),
    readFile(trailSource, 'utf8'),
  ]);
  assert.match(road, /dry-two-track-albedo\.webp/);
  assert.match(road, /gravelPhoto/);
  assert.match(road, /gravelCoverage/);
  assert.match(road, /trackCoverage/);
  assert.match(road, /organicWave/);
  assert.match(trail, /packed-trail-albedo\.webp/);
  assert.match(trail, /visibleHalf/);
  assert.match(trail, /widthBreak/);
  assert.match(trail, /stride=structureKind\?3:5/);
});

test('near-field transport details are deterministic pooled instances', async () => {
  const trail = await readFile(trailSource, 'utf8');
  assert.match(trail, /transportNearStones/);
  assert.match(trail, /transportNearRoots/);
  assert.match(trail, /new THREE\.InstancedMesh/);
  assert.match(trail, /Math\.min\(mesh\.instanceMatrix\.count,list\.length\)/);
});
