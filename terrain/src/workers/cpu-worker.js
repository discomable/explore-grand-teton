const cancelled = new Set();

self.onmessage = async ({ data: request }) => {
  if (request.kind === 'cancel') {
    cancelled.add(request.id);
    return;
  }
  const { id, kind, generation, payload } = request;
  try {
    const result = await handlers[kind](payload, () => cancelled.has(id));
    if (cancelled.delete(id)) return;
    const buffers = result.buffers || [];
    self.postMessage({ id, generation, ok: true, meta: result.meta || {}, buffers }, buffers);
  } catch (error) {
    cancelled.delete(id);
    self.postMessage({
      id, generation, ok: false,
      error: `${error?.name || 'Error'}: ${error?.message || String(error)}`,
    });
  }
};

const handlers = {
  async fetchImagery({ url, size, validX = size, validY = size }, isCancelled) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`imagery HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob());
    if (isCancelled()) {
      bitmap.close?.();
      throw new DOMException('cancelled', 'AbortError');
    }
    if (validX >= size && validY >= size) {
      return { meta: { width: size, height: size }, buffers: [bitmap] };
    }
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, size, size);
    bitmap.close?.();
    if (validX < size) context.drawImage(canvas, validX - 1, 0, 1, size, validX, 0, size - validX, size);
    if (validY < size) context.drawImage(canvas, 0, validY - 1, size, 1, 0, validY, size, size - validY);
    const prepared = canvas.transferToImageBitmap();
    return { meta: { width: size, height: size, edgePadded: true }, buffers: [prepared] };
  },

  async decodeHeight({ bitmap, size, encoding, datum, elevationMin, validX = size, validY = size }, isCancelled) {
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0, size, size);
    bitmap.close?.();
    const rgba = context.getImageData(0, 0, size, size).data;
    const heights = new Float32Array(size * size);
    const floor = elevationMin - datum;
    let min = Infinity, max = -Infinity;
    for (let p = 0, q = 0; p < rgba.length; p += 4, q++) {
      if ((q & 16383) === 0 && isCancelled()) throw new DOMException('cancelled', 'AbortError');
      const value = rgba[p + 3] < 128 ? floor
        : encoding.baseval + (rgba[p] * 65536 + rgba[p + 1] * 256 + rgba[p + 2]) * encoding.interval - datum;
      heights[q] = value;
      min = Math.min(min, value); max = Math.max(max, value);
    }
    if (validX < size) for (let y = 0; y < size; y++) {
      heights.fill(heights[y * size + validX - 1], y * size + validX, (y + 1) * size);
    }
    if (validY < size) {
      const row = heights.slice((validY - 1) * size, validY * size);
      for (let y = validY; y < size; y++) heights.set(row, y * size);
    }
    return { meta: { min, max, width: size, height: size }, buffers: [heights.buffer] };
  },

  async scatterMatrices({ points, scale = 1, y = 0 }, isCancelled) {
    const source = new Float32Array(points);
    const matrices = new Float32Array((source.length / 2) * 16);
    for (let i = 0; i < source.length / 2; i++) {
      if ((i & 4095) === 0 && isCancelled()) throw new DOMException('cancelled', 'AbortError');
      const o = i * 16;
      matrices[o] = matrices[o + 5] = matrices[o + 10] = scale;
      matrices[o + 12] = source[i * 2]; matrices[o + 13] = y; matrices[o + 14] = source[i * 2 + 1];
      matrices[o + 15] = 1;
    }
    return { meta: { count: source.length / 2 }, buffers: [matrices.buffer] };
  },
};
