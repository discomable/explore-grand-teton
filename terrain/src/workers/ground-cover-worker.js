import { finalizeGroundCover, generateGroundCoverRandoms } from './ground-cover-candidates.js';

const cancelled = new Set();

self.onmessage = event => {
  const request = event.data;
  if (request.kind === 'cancel') {
    cancelled.add(request.id);
    return;
  }
  const { id, generation, payload } = request;
  try {
    if (request.kind === 'groundCoverFinalize') {
      const result = finalizeGroundCover(payload, () => cancelled.has(id));
      if (cancelled.delete(id)) return;
      self.postMessage({
        id, generation, ok: true, meta: { phase: 'final', cx: payload.cx, cz: payload.cz, used: result.used },
        buffers: {
          matrices: result.matrices.buffer, colors: result.colors.buffer, atlas: result.atlas.buffer,
        },
      }, [result.matrices.buffer, result.colors.buffer, result.atlas.buffer]);
      return;
    }
    const randoms = generateGroundCoverRandoms(payload, () => cancelled.has(id));
    if (cancelled.delete(id)) return;
    self.postMessage({
      id, generation, ok: true, meta: { phase: 'candidates', cx: payload.cx, cz: payload.cz },
      buffers: { randoms: randoms.buffer },
    }, [randoms.buffer]);
  } catch (error) {
    cancelled.delete(id);
    self.postMessage({
      id, generation, ok: false,
      error: { name: error?.name || 'Error', message: error?.message || String(error) },
    });
  }
};
