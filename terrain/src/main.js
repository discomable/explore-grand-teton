import * as ThreeModule from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AppContext } from './app-context.js';
import { WorkerPool } from './workers/WorkerPool.js';
import { WorldIndexClient } from './workers/WorldIndexClient.js';
import { startRenderWorkerIfRequested } from './renderer-worker/client.js';
import { TransportSurface, transportFeatures } from './transport/TransportSurface.js';
import { DrivingInput, activeGamepad } from './vehicle/DrivingInput.js';
import { SUV_PROFILE, createVehicleState, stepVehicle } from './vehicle/ArcadeVehiclePhysics.js';
import { summarizeVisibleTerrain } from './terrain-coverage.js';
import {
  createTerrainTextureArrayPool,
  TerrainTextureArrayCapacityError,
} from './TerrainTextureArrayPool.js';
import {
  buildTerrainFrame,
  compareTerrainSubmissions,
  TERRAIN_INSTANCE_LAYOUT,
} from './terrain-batch-contract.js';
import {
  applyVegetationFade,
  buildVegetationBatchFrame,
  compactVegetationRecord,
  nextVegetationCapacity,
  VEGETATION_SPECIES,
} from './vegetation-batch-contract.js';

const THREE = { ...ThreeModule, GLTFLoader };
window.THREE = THREE;

const params = new URLSearchParams(location.search);
const workersEnabled = params.get('noWorkers') !== '1';
let workerPool = null;
let worldIndex = null;
try {
  workerPool = workersEnabled && WorkerPool.supported ? new WorkerPool() : null;
} catch (error) {
  console.warn('[workers] CPU pool unavailable; continuing on the main thread.', error);
}

try {
  worldIndex = workersEnabled && WorldIndexClient.supported() ? new WorldIndexClient() : null;
} catch (error) {
  console.warn('[world-index] module worker unavailable; continuing with main-thread queries.', error);
}

const context = new AppContext({ THREE, GLTFLoader, workerPool, worldIndex });
window.GT_APP = context;
window.transportSurface = new TransportSurface();
window.GT_transportFeatures = transportFeatures;
window.DrivingInput = DrivingInput;
window.GT_activeGamepad = activeGamepad;
window.GT_VEHICLE_PHYSICS = { SUV_PROFILE, createVehicleState, stepVehicle };
window.GT_TERRAIN_COVERAGE = { summarizeVisibleTerrain };
window.GT_TERRAIN_ARRAYS = { createTerrainTextureArrayPool, TerrainTextureArrayCapacityError };
window.GT_TERRAIN_BATCH = {
  buildTerrainFrame, compareTerrainSubmissions, TERRAIN_INSTANCE_LAYOUT,
};
window.GT_VEGETATION_BATCH = {
  applyVegetationFade, buildVegetationBatchFrame, compactVegetationRecord, nextVegetationCapacity,
  VEGETATION_SPECIES,
};

const rendererWorker = await startRenderWorkerIfRequested(context);
if (!rendererWorker.active) {
  const scripts = [
    'shader-extension-registry.js',
    'terrain-shaders.js', 'TerrainStreamer.js', 'Landcover.js', 'WaterBuilder.js',
    'BridgeBuilder.js', 'RoadRibbon.js', 'SignBuilder.js', 'TrailBuilder.js',
    'BuildingManager.js', 'LandmarkManager.js', 'ScatterManager.js', 'GroundCover.js', 'PropScatter.js',
    'WildlifeManager.js', 'PostFX.js',
    'app/00-core.js', 'app/10-worldgen.js', 'app/20-scene.js', 'app/30-sun-sky.js',
    'app/40-terrain.js', 'app/50-water.js', 'app/60-forest.js', 'app/70-labels.js',
    'app/80-controls.js', 'app/82-drive.js', 'app/84-input.js', 'app/85-fasttravel.js',
    'app/86-capture.js', 'app/88-minimap.js', 'app/89-heldmap.js', 'app/90-auto.js',
    'app/92-boot.js', 'app/96-settings.js', 'app/94-audio.js',
  ];
  for (const path of scripts) await loadClassic(new URL(`terrain/src/${path}`, document.baseURI));
  if (params.get('benchmark') === '1') {
    await loadClassic(new URL('terrain/src/benchmark/runner-classic.js', document.baseURI));
  }
  document.getElementById('gear').addEventListener('click', () => window.GT_toggleSettings?.());
  registerServiceWorker();
}

function loadClassic(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url.href;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Unable to load ${url.pathname}`));
    document.head.appendChild(script);
  });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && !/[?&]nosw(?:&|$)/.test(location.search)) {
    addEventListener('load', () => navigator.serviceWorker.register('sw-tiles.js').catch(() => {}));
  }
}
