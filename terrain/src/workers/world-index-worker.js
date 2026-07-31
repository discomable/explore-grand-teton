import { WorldIndex } from './world-index.js';

export function createWorldIndexMessageHandler(post) {
  const index = new WorldIndex();
  const cancelled = new Set();

  return async function handle(message) {
    const { id, kind, generation = 0, payload = {} } = message || {};
    try {
      if (kind === 'cancel') {
        cancelled.add(payload.id ?? id);
        return;
      }
      if (cancelled.delete(id)) return;
      if (kind === 'init') {
        index.clear({ generation });
        for (const descriptor of payload.descriptors || []) index.install(descriptor);
        post({ id, generation, ok: true, meta: index.memory() });
        return;
      }
      if (generation !== index.generation) {
        post({ id, generation, ok: false, error: 'stale generation' });
        return;
      }
      if (kind === 'install') {
        for (const descriptor of payload.descriptors || []) index.install(descriptor);
        post({ id, generation, ok: true, meta: index.memory() });
      } else if (kind === 'installSpatial') {
        for (const descriptor of payload.descriptors || []) index.installSpatial(descriptor);
        post({ id, generation, ok: true, meta: index.memory() });
      } else if (kind === 'installWaterSurface') {
        index.installWaterSurface(payload.descriptor);
        post({ id, generation, ok: true, meta: index.memory() });
      } else if (kind === 'remove') {
        for (const key of payload.ids || []) index.remove(key);
        post({ id, generation, ok: true, meta: index.memory() });
      } else if (kind === 'sample') {
        const points = payload.points;
        if (!(points instanceof Float64Array) || points.length % 2) {
          throw new TypeError('sample points must be Float64Array x,z pairs');
        }
        const values = new Float64Array(points.length / 2);
        const method = payload.method === 'bilinear' ? 'sampleBilinear' :
          payload.method === 'height' ? 'sampleHeight' : 'sampleNearest';
        for (let i = 0; i < values.length; i++) {
          if ((i & 255) === 0 && cancelled.has(id)) {
            cancelled.delete(id); return;
          }
          values[i] = method === 'sampleHeight'
            ? index.sampleHeight(points[i * 2], points[i * 2 + 1], Number.NaN)
            : index[method](payload.index, points[i * 2], points[i * 2 + 1], Number.NaN);
        }
        post({ id, generation, ok: true, meta: { count: values.length },
          buffers: { values } }, [values.buffer]);
      } else if (kind === 'memory') {
        post({ id, generation, ok: true, meta: index.memory() });
      } else if (kind === 'sampleRoad') {
        const points = payload.points;
        const count = points.length / 2;
        const values = new Float64Array(count * 2);
        const classCodes = new Uint8Array(count);
        for (let i = 0; i < count; i++) {
          const value = index.queryRoad(points[i * 2], points[i * 2 + 1]);
          values[i * 2] = value.distance; values[i * 2 + 1] = value.clearance;
          classCodes[i] = value.classCode;
        }
        post({ id, generation, ok: true, meta: { count, installed: index.spatial.has('roads') },
          buffers: { values, classCodes } }, [values.buffer, classCodes.buffer]);
      } else if (kind === 'sampleBuildings') {
        const points = payload.points, count = points.length / 2;
        const blocked = new Uint8Array(count), proximity = new Float64Array(count);
        for (let i = 0; i < count; i++) {
          const value = index.queryBuilding(points[i * 2], points[i * 2 + 1],
            payload.y?.[i], payload.pad || 0);
          blocked[i] = value.blocked ? 1 : 0; proximity[i] = value.proximity;
        }
        post({ id, generation, ok: true, meta: { count, installed: index.spatial.has('buildings') },
          buffers: { blocked, proximity } }, [blocked.buffer, proximity.buffer]);
      } else if (kind === 'sampleWaterSurface') {
        const points = payload.points, count = points.length / 2;
        const values = new Float64Array(count * 2), valid = new Uint8Array(count);
        for (let i = 0; i < count; i++) {
          const value = index.queryWaterSurface(points[i * 2], points[i * 2 + 1]);
          values[i * 2] = value.surface; values[i * 2 + 1] = value.bias;
          valid[i] = value.valid ? 1 : 0;
        }
        post({ id, generation, ok: true,
          meta: { count, installed: !!index.waterSurface },
          buffers: { values, valid } }, [values.buffer, valid.buffer]);
      } else if (kind === 'sampleCanopyShell') {
        const result = index.sampleCanopyShell(payload.points);
        const buffers = {
          terrainHeight: result.terrainHeight,
          vegetation: result.vegetation,
          forestProbability: result.forestProbability,
          valid: result.valid,
        };
        post({ id, generation, ok: true, meta: {
          count: result.count, installed: result.installed, coverage: result.coverage,
        }, buffers }, [
          buffers.terrainHeight.buffer, buffers.vegetation.buffer,
          buffers.forestProbability.buffer, buffers.valid.buffer,
        ]);
      } else {
        throw new Error(`unknown world-index job: ${kind}`);
      }
    } catch (error) {
      post({ id, generation, ok: false, error: error?.message || String(error) });
    }
  };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  const handle = createWorldIndexMessageHandler((message, transfer) =>
    self.postMessage(message, transfer || []));
  self.onmessage = (event) => handle(event.data);
}
