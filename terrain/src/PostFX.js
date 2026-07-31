/* PostFX — compact linear-HDR post-processing stack (Three.js r184).
 *
 * The scene target remains linear. Bloom therefore sees unclipped highlights, and exposure,
 * ACES filmic tone mapping, and the single linear-to-sRGB conversion happen in the final pass:
 *
 *   scene -> MSAA render target (fallback AA) -> bright-pass -> 2-level blur pyramid
 *         -> composite (base + bloom, subtle saturation lift, vignette) -> screen
 *
 * No dependency on three's examples/js. Hand-rolled full-screen passes, one module, ~7 small
 * render targets. Half-float HDR is used only when the context exposes a renderable float colour
 * buffer; the fallback is a bounded unsigned-byte linear pipeline.
 *
 * Auto-tracks renderer.getDrawingBufferSize each frame, so it follows the quality governor's
 * pixel-ratio changes with no external wiring. Experimental: enable with ?postfx; ?post8 forces
 * its byte target. The normal application path renders directly through Three's ACES output.
 */
(function (global) {
  'use strict';
  const THREE = global.THREE;

  // full-screen triangle-ish quad shared by every pass (PlaneGeometry(2,2) + ortho cam)
  const QUAD_GEO = new THREE.PlaneGeometry(2, 2);
  const QUAD_CAM = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // Build a pass material. toneMapped:false + fog:false + an own no-op onBeforeCompile keep the
  // app-wide ShaderMaterial tone-map injection (20-scene.js) from touching these passthrough shaders.
  function passMat(frag, uniforms) {
    const m = new THREE.ShaderMaterial({
      uniforms,
      vertexShader:
        'varying vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: frag,
      depthTest: false, depthWrite: false,
    });
    m.toneMapped = false; m.fog = false;
    m.onBeforeCompile = function () {};   // shadow the prototype teton tone-map hook
    return m;
  }

  function rt(w, h, type) {
    return new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: type, depthBuffer: false, stencilBuffer: false,
    });
  }

  const PREFILTER = [
    'uniform sampler2D tDiffuse; uniform float threshold; uniform float knee; varying vec2 vUv;',
    'void main(){',
    '  vec3 c = texture2D(tDiffuse, vUv).rgb;',
    '  float br = max(c.r, max(c.g, c.b));',
    '  float soft = clamp(br - threshold + knee, 0.0, 2.0*knee);',
    '  soft = soft*soft / (4.0*knee + 1e-4);',           // quadratic soft knee
    '  float contrib = max(soft, br - threshold) / max(br, 1e-4);',
    '  gl_FragColor = vec4(c * contrib, 1.0);',
    '}',
  ].join('\n');

  // separable 9-tap gaussian; uDir = (texelX,0) or (0,texelY)
  const BLUR = [
    'uniform sampler2D tDiffuse; uniform vec2 uDir; varying vec2 vUv;',
    'void main(){',
    '  vec4 s = texture2D(tDiffuse, vUv) * 0.2270270270;',
    '  s += texture2D(tDiffuse, vUv + uDir*1.3846153846) * 0.3162162162;',
    '  s += texture2D(tDiffuse, vUv - uDir*1.3846153846) * 0.3162162162;',
    '  s += texture2D(tDiffuse, vUv + uDir*3.2307692308) * 0.0702702703;',
    '  s += texture2D(tDiffuse, vUv - uDir*3.2307692308) * 0.0702702703;',
    '  gl_FragColor = s;',
    '}',
  ].join('\n');

  const DOWNSAMPLE = [
    'uniform sampler2D tDiffuse; varying vec2 vUv;',
    'void main(){ gl_FragColor = texture2D(tDiffuse, vUv); }',
  ].join('\n');

  const COMPOSITE = [
    'uniform sampler2D tScene, tB0, tB1;',
    'uniform float intensity, saturation, vignette, exposure;',
    'varying vec2 vUv;',
    // Match Three's ACESFilm curve, followed by the exact IEC 61966-2-1 transfer function.
    'vec3 rrtAndOdtFit(vec3 v){',
    '  vec3 a = v*(v+0.0245786)-0.000090537;',
    '  vec3 b = v*(0.983729*v+0.4329510)+0.238081;',
    '  return a/b;',
    '}',
    'vec3 acesFilmic(vec3 x){',
    '  const mat3 acesIn = mat3(',
    '    vec3(0.59719,0.35458,0.04823), vec3(0.07600,0.90834,0.01566), vec3(0.02840,0.13383,0.83777));',
    '  const mat3 acesOut = mat3(',
    '    vec3(1.60475,-0.53108,-0.07367), vec3(-0.10208,1.10813,-0.00605), vec3(-0.00327,-0.07276,1.07602));',
    '  x = acesIn * x;',
    '  x = rrtAndOdtFit(x);',
    '  return clamp(acesOut * x, 0.0, 1.0);',
    '}',
    'vec3 linearToSRGB(vec3 x){',
    '  vec3 lo = x * 12.92;',
    '  vec3 hi = 1.055 * pow(max(x, vec3(0.0)), vec3(1.0/2.4)) - 0.055;',
    '  return mix(lo, hi, step(vec3(0.0031308), x));',
    '}',
    'void main(){',
    '  vec3 base = texture2D(tScene, vUv).rgb;',
    '  vec3 bloom = texture2D(tB0, vUv).rgb*0.64 + texture2D(tB1, vUv).rgb*0.36;',
    '  vec3 col = base + bloom * intensity;',
    '  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));',
    '  col = mix(vec3(l), col, saturation);',
    '  vec2 d = vUv - 0.5;',                                  // soft vignette
    '  float vig = smoothstep(0.90, 0.32, length(d) * 1.35);',
    '  col *= mix(1.0, vig, vignette);',
    '  col = linearToSRGB(acesFilmic(max(col, vec3(0.0)) * (exposure / 0.6)));',
    '  gl_FragColor = vec4(col, 1.0);',
    '}',
  ].join('\n');

  class PostFX {
    constructor(renderer, opts) {
      opts = opts || {};
      this.renderer = renderer;
      this.enabled = true;
      this.params = {
        // HIGH threshold on purpose: bloom is computed in low-res SCREEN-space buffers, so anything
        // that blooms crawls/ribbons across the terrain as the world scrolls under the view when you
        // move. At a low threshold most of a bright daytime scene (snow, pale grass, sky) blooms and
        // that broad glow visibly crawls. Keep the threshold near-white so ONLY genuine highlights
        // (sun glint, brightest snow, night headlights/moon) bloom — too small an area to crawl.
        threshold: opts.threshold !== undefined ? opts.threshold : 1.0,
        knee: opts.knee !== undefined ? opts.knee : 0.5,
        intensity: opts.intensity !== undefined ? opts.intensity : 0.45,
        exposure: opts.exposure !== undefined ? opts.exposure : 1.0,
        // NAIP and the painted foliage already carry strong greens/yellows. A slight photographic
        // desaturation keeps them plausible after ACES instead of amplifying the source imagery.
        saturation: opts.saturation !== undefined ? opts.saturation : 0.96,
        // vignette OFF: a vignette darkens the screen edges into a frame that is locked to the
        // viewport, so it moves/rotates with the camera and reads as a dark "box" tracking the
        // player. Disabled per user. (Set >0 to re-enable; it is screen-space by nature.)
        vignette: opts.vignette !== undefined ? opts.vignette : 0.0,
      };
      this._size = new THREE.Vector2();
      const gl = renderer.getContext();
      const webgl2 = renderer.capabilities.isWebGL2;
      const forceByte = /[?&]post8(?:&|$)/.test(global.location ? global.location.search : '');
      let floatColour = !!(!forceByte && webgl2 && gl.getExtension('EXT_color_buffer_float'));
      // Extension presence is not enough on every driver. Force allocation, bind the candidate
      // framebuffer, and keep HDR only when WebGL reports it complete.
      if (floatColour) {
        const probe = new THREE.WebGLRenderTarget(2, 2, {
          format: THREE.RGBAFormat, type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
        });
        const previous = renderer.getRenderTarget();
        try {
          renderer.setRenderTarget(probe);
          floatColour = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        } catch (_) { floatColour = false; }
        renderer.setRenderTarget(previous);
        probe.dispose();
      }
      this._type = floatColour ? THREE.HalfFloatType : THREE.UnsignedByteType;
      // Three's multisample resolve is dependable for RGBA8. Float resolves vary across WebGL2
      // implementations, so favour real HDR over uncertain MSAA when half-float is active.
      this._msaa = !!(webgl2 && !floatColour);
      this.status = {
        hdr: floatColour,
        targetType: floatColour ? 'half-float' : 'unsigned-byte',
        msaa: this._msaa,
        samples: this._msaa ? 4 : 0,
        toneMapping: 'aces-filmic',
        outputEncoding: 'srgb',
        fallbackReason: floatColour ? null : (forceByte ? 'forced-post8' : 'half-float-unavailable'),
      };

      // uniforms (shared texel across the two blur directions per level via clones below)
      this.uPre = { tDiffuse: { value: null }, threshold: { value: 0 }, knee: { value: 0 } };
      this.uBlur = { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } };
      this.uDown = { tDiffuse: { value: null } };
      this.uComp = {
        tScene: { value: null }, tB0: { value: null }, tB1: { value: null },
        intensity: { value: 0 }, saturation: { value: 0 }, vignette: { value: 0 },
        exposure: { value: 1 },
      };
      this.mPre = passMat(PREFILTER, this.uPre);
      this.mBlur = passMat(BLUR, this.uBlur);
      this.mDown = passMat(DOWNSAMPLE, this.uDown);
      this.mComp = passMat(COMPOSITE, this.uComp);
      this._mesh = new THREE.Mesh(QUAD_GEO, this.mPre);
      this._scene = new THREE.Scene();
      this._scene.add(this._mesh);

      renderer.getDrawingBufferSize(this._size);
      this._build(this._size.x, this._size.y);
    }

    _build(w, h) {
      this._dispose();
      // MSAA scene target when WebGL2 is available — otherwise a plain RT (edges lose AA).
      if (this._msaa) {
        this.rtScene = new THREE.WebGLRenderTarget(w, h, {
          minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
          format: THREE.RGBAFormat, type: this._type, stencilBuffer: false, samples: 4,
        });
      } else {
        this.rtScene = new THREE.WebGLRenderTarget(w, h, {
          minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
          format: THREE.RGBAFormat, type: this._type, stencilBuffer: false,
        });
      }
      this.rtScene.texture.colorSpace = THREE.NoColorSpace;
      // Two levels retain a broad highlight halo while avoiding three extra full-screen passes
      // on the movement-critical path.
      this.levels = [];
      for (let i = 0; i < 2; i++) {
        const s = 2 << i;                        // 1/2, 1/4, 1/8
        this.levels.push({
          rt: rt(w / s, h / s, this._type),
          tmp: rt(w / s, h / s, this._type),
          w: Math.max(1, (w / s) | 0), h: Math.max(1, (h / s) | 0),
        });
      }
      this._w = w; this._h = h;
    }

    _dispose() {
      if (this.rtScene) this.rtScene.dispose();
      if (this.levels) for (const L of this.levels) { L.rt.dispose(); L.tmp.dispose(); }
    }

    _draw(target, material) {
      this._mesh.material = material;
      this.renderer.setRenderTarget(target);
      this.renderer.render(this._scene, QUAD_CAM);
    }

    _blur(level) {
      // horizontal rt->tmp, vertical tmp->rt
      this.uBlur.tDiffuse.value = level.rt.texture;
      this.uBlur.uDir.value.set(1 / level.w, 0);
      this._draw(level.tmp, this.mBlur);
      this.uBlur.tDiffuse.value = level.tmp.texture;
      this.uBlur.uDir.value.set(0, 1 / level.h);
      this._draw(level.rt, this.mBlur);
    }

    render(scene, camera) {
      const r = this.renderer;
      if (!this.enabled) { r.setRenderTarget(null); r.render(scene, camera); return; }

      r.getDrawingBufferSize(this._size);
      if (this._size.x !== this._w || this._size.y !== this._h) this._build(this._size.x, this._size.y);

      // 1) scene -> MSAA target (keeps the antialiased edges the default framebuffer had)
      r.setRenderTarget(this.rtScene);
      r.render(scene, camera);
      this.lastSceneInfo = {
        calls: r.info.render.calls,
        triangles: r.info.render.triangles,
      };

      // 2) bright-pass into level 0
      this.uPre.tDiffuse.value = this.rtScene.texture;
      this.uPre.threshold.value = this.params.threshold;
      this.uPre.knee.value = this.params.knee;
      this._draw(this.levels[0].rt, this.mPre);
      this._blur(this.levels[0]);

      // 3) downsample + blur the rest of the pyramid
      for (let i = 1; i < this.levels.length; i++) {
        this.uDown.tDiffuse.value = this.levels[i - 1].rt.texture;
        this._draw(this.levels[i].rt, this.mDown);
        this._blur(this.levels[i]);
      }

      // 4) composite to screen
      this.uComp.tScene.value = this.rtScene.texture;
      this.uComp.tB0.value = this.levels[0].rt.texture;
      this.uComp.tB1.value = this.levels[1].rt.texture;
      this.uComp.intensity.value = this.params.intensity;
      this.uComp.saturation.value = this.params.saturation;
      this.uComp.vignette.value = this.params.vignette;
      this.uComp.exposure.value = this.params.exposure;
      this._draw(null, this.mComp);
    }
  }

  global.PostFX = PostFX;
})(window);
