/* Landcover — loads the baked landcover.png + landcover.json and answers point queries.
 *
 * The mask is small (~2800x4100 @ 10 m for the whole park, a few MB decoded) so it stays fully
 * resident; no streaming. R channel = NLCD class code, G channel = water mask.
 *
 *   const lc = await new Landcover('terrain/public/landcover.json').init();
 *   lc.classAt(x, z)   -> NLCD code (0 if outside)
 *   lc.waterAt(x, z)   -> true/false
 *   lc.lakes           -> [{id, elev, type, minPx, maxPx, areaPx}]
 *   lc.pixelToWorld(px, py) / lc.worldToPixel(x, z)
 */
(function (global) {
  'use strict';

  class Landcover {
    constructor(url) { this.url = url; }

    async init() {
      this.m = await (await fetch(this.url)).json();
      const base = this.url.replace(/[^/]+$/, '');
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res; img.onerror = () => rej(new Error('landcover.png failed to load'));
        img.src = base + this.m.url;
      });
      const cv = document.createElement('canvas');
      cv.width = this.m.width; cv.height = this.m.height;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      this.data = ctx.getImageData(0, 0, this.m.width, this.m.height).data;
      this.cE = this.m.world.centerEasting;
      this.cN = this.m.world.centerNorthing;
      this.datum = this.m.world.datum;
      this.lakes = this.m.lakes;
      this._installWorldIndexes();
      return this;
    }

    _installWorldIndexes() {
      const client = global.GT_APP && global.GT_APP.worldIndex;
      if (!client?.initialized || typeof client.installRaster !== 'function') return;
      const install = async () => {
        await client.initialized;
        if (!client.ready || client.failed) return;
        const meta = {
          width: this.m.width, height: this.m.height,
          originE: this.m.originE, originN: this.m.originN, res: this.m.res,
          centerEasting: this.cE, centerNorthing: this.cN,
        };
        const channel = (offset) => {
          const out = new Uint8Array(this.m.width * this.m.height);
          for (let i = 0, p = offset; i < out.length; i++, p += 4) out[i] = this.data[p];
          return out;
        };
        await client.installRaster({ id: 'landcover', data: channel(0), ...meta });
        await client.installRaster({ id: 'water-mask', data: channel(1), ...meta });
      };
      this.worldIndexInstall = install().catch(error => {
        console.warn('[world-index] landcover raster install failed; retaining local queries.', error);
      });
    }

    worldToPixel(x, z) {
      const E = x + this.cE, N = this.cN - z;
      return [(E - this.m.originE) / this.m.res, (this.m.originN - N) / this.m.res];
    }
    pixelToWorld(px, py) {
      const E = this.m.originE + px * this.m.res, N = this.m.originN - py * this.m.res;
      return [E - this.cE, this.cN - N];
    }

    _idx(x, z) {
      const [pxf, pyf] = this.worldToPixel(x, z);
      const px = pxf | 0, py = pyf | 0;
      if (px < 0 || py < 0 || px >= this.m.width || py >= this.m.height) return -1;
      return (py * this.m.width + px) * 4;
    }
    classAt(x, z) { const i = this._idx(x, z); return i < 0 ? 0 : this.data[i]; }
    waterAt(x, z) { const i = this._idx(x, z); return i < 0 ? false : this.data[i + 1] > 127; }
  }

  global.Landcover = Landcover;
})(window);
