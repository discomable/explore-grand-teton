import {
  generateCandidateRandoms, processDotSnapshot, processShrubSnapshot, processTreeSnapshot,
} from './vegetation-candidates.js';

const cancelled = new Set();

self.onmessage = event => {
  const request = event.data;
  if (request.kind === 'cancel') {
    cancelled.add(request.id);
    return;
  }
  const { id, generation, payload } = request;
  try {
    if (request.kind === 'processTreeSnapshot') {
      const tree = new Float64Array(payload.tree);
      const treeSpatial = new Float64Array(payload.treeSpatial);
      const snapshot = new Float64Array(payload.snapshot);
      const shrub = new Float64Array(payload.shrub);
      const shrubSpatial = new Float64Array(payload.shrubSpatial);
      const shrubSnapshot = new Float64Array(payload.shrubSnapshot);
      const dotSnapshot = new Float64Array(payload.dotSnapshot);
      const instances = processTreeSnapshot(
        { ...payload, tree, treeSpatial, snapshot }, () => cancelled.has(id));
      const shrubInstances = processShrubSnapshot(
        { ...payload, shrub, shrubSpatial, shrubSnapshot }, () => cancelled.has(id));
      const dotInstances = processDotSnapshot(
        { ...payload, dotSnapshot }, () => cancelled.has(id));
      if (cancelled.delete(id)) return;
      self.postMessage({ id, generation, ok: true, phase: 'instances',
        buffers: { instances: instances.buffer, shrubInstances: shrubInstances.buffer,
          dotInstances: dotInstances.buffer } },
        [instances.buffer, shrubInstances.buffer, dotInstances.buffer]);
      return;
    }
    const result = generateCandidateRandoms(payload, () => cancelled.has(id));
    if (cancelled.delete(id)) return;
    self.postMessage({
      id, generation, ok: true,
      buffers: {
        tree: result.tree.buffer,
        treeSpatial: result.treeSpatial.buffer,
        shrub: result.shrub.buffer,
        shrubSpatial: result.shrubSpatial.buffer,
      },
    }, [
      result.tree.buffer, result.treeSpatial.buffer,
      result.shrub.buffer, result.shrubSpatial.buffer,
    ]);
  } catch (error) {
    cancelled.delete(id);
    self.postMessage({
      id, generation, ok: false,
      error: { name: error?.name || 'Error', message: error?.message || String(error) },
    });
  }
};
