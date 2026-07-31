/* Terrain tile shaders (Three.js r184, global THREE).
 *
 * Vertex: displaces a shared unit grid using the height texture, sampled through a UV sub-window
 * (uHWin: offset.xy + scale.z) so a deep quadtree node can read a region of a coarser ancestor
 * tile. Normals by finite differences at the SOURCE texel step. Skirt ring drops below the seam.
 *
 * Fragment: albedo from NAIP imagery (own sub-window) when available, else the procedural
 * elevation/slope palette. Lighting = lambert sun (uSunColor, golden-hour aware) shadowed by the
 * baked 8-azimuth horizon maps (terrain casts real 20 km shadows across the valley), plus a
 * sky-ish ambient, plus distance fog whose color tracks the time of day.
 */
window.TerrainShaders = {
  vertex: /* glsl */`
    precision highp float;
    uniform sampler2D uHeight;
    uniform vec3  uHWin;         // (offsetU, offsetV, scale) into the height source tile
    uniform vec2  uUVMax;        // valid-data clamp in node uv ((1,1) except at the raster edge)
    uniform vec2  uTileOrigin;
    uniform float uTileSize;
    uniform float uSkirt;
    uniform float uMorphBase;    // this node's LOD handoff distance h (ring = [h, 2h))
    uniform vec4  uCUV;          // ancestor-lattice steps in node uv toward z-1..z-4; 0 = none
    uniform vec4  uEdgeR;        // per-edge stitch ratio (-x,+x,-z,+z); 0 = no stitch, else
                                 //   fine-segments-per-coarse-segment toward a 1-level-coarser edge
    uniform float uGridN;        // this tile's grid subdivisions (segments across a full edge)
    varying vec3 vWorld;
    varying vec3 vNormal;
    varying float vHeight;
    varying vec2 vUv;

    /* Height read in SOURCE-TILE uv. Tiles are area-registered with NO duplicated edge rows,
       so hardware bilinear is only valid between texel centers; a plain clamped read sits half
       a texel short of the tile border and two neighbouring tiles disagreed by gradient*texel
       there — a hairline crack along every tile border (worst on cliff faces). In the outer
       half-texel band, gradient-extrapolate from the two innermost texels instead: both sides
       of a border then derive the same boundary height up to curvature (cm), which the skirt
       swallows. */
    uniform float uHTexelM;      // meters per source-height texel (extrapolation slope cap)
    float hTex(vec2 s){
      const float T = 512.0;
      vec2 c = clamp(s, 0.5 / T, 1.0 - 0.5 / T);
      float h0 = texture2D(uHeight, c).r;
      vec2 ex = (s - c) * T;               // texels beyond the last center row (|ex| <= 0.5)
      // cap the extrapolation slope at ~72 deg: on a smooth slope the gradient term recovers
      // the true border height to 2nd order, but across a data cliff/terrace the two tiles'
      // one-sided gradients diverge and UNCLAMPED extrapolation overshot into black slots
      float cap = 3.0 * uHTexelM;
      float h = h0;
      if(abs(ex.x) > 1.0e-5){
        float hx = texture2D(uHeight, vec2(c.x - sign(ex.x) / T, c.y)).r;
        h += clamp(h0 - hx, -cap, cap) * abs(ex.x);
      }
      if(abs(ex.y) > 1.0e-5){
        float hy = texture2D(uHeight, vec2(c.x, c.y - sign(ex.y) / T)).r;
        h += clamp(h0 - hy, -cap, cap) * abs(ex.y);
      }
      return h;
    }
    // uUVMax: beyond the raster's last column/row the baked tiles hold floor-value padding
    // (a giant cliff + grey imagery at the world edge); clamping the SAMPLE (not the vertex)
    // edge-extends the terrain instead. All nodes clamp at the same world line, so seams stay
    // consistent.
    float hAt(vec2 uv){ return hTex(uHWin.xy + min(clamp(uv,0.0,1.0), uUVMax)*uHWin.z); }

    /* Height exactly as an ANCESTOR k levels up renders it: its grid vertices land on the
       step-s lattice in this node's uv (grids are even and divisible by 2^k, so quadrant
       offsets cancel), and its surface is piecewise-linear over those cells with the shared
       grid's anti-diagonal split. */
    float hLattice(vec2 uv, float s){
      vec2 g = clamp(uv, 0.0, 1.0) / s;
      vec2 i = floor(g), f = g - i;
      vec2 b = i * s;
      float h00 = hAt(b);
      float h10 = hAt(b + vec2(s, 0.0));
      float h01 = hAt(b + vec2(0.0, s));
      float h11 = hAt(b + vec2(s, s));
      // same triangulation as makeGrid: cells split along the (i+1,j)-(i,j+1) anti-diagonal
      return (f.x + f.y < 1.0)
        ? h00 + (h10 - h00) * f.x + (h01 - h00) * f.y
        : h11 + (h01 - h11) * (1.0 - f.x) + (h10 - h11) * (1.0 - f.y);
    }

    /* CASCADED geomorph: the rendered surface is a function of world position and camera
       distance ONLY — never of which node happens to render it. Band k (k = 1..4) morphs
       lattice level z-k+1 onto z-k over d in 2^(k-1) * [1.55h, 1.95h]; bands are disjoint
       and identical across neighbouring nodes because handoffs double per level exactly. The
       old single-level morph violated this: a coarse node partway through ITS morph (toward
       z-2) bordered a fine node whose edge targeted the z-1 base — the mismatch opened the
       chevron sky-slits along ridgelines. Constraints on the band: full by 2h (a coarser
       neighbour's base surface starts there — required for the edge stitch) and 0 at the
       ring start h (finer neighbours collapse onto OUR base). Within that freedom the band
       sits as LATE as possible: it is also what far corners of every node render, and an
       early band needlessly flattened summit silhouettes by a whole extra LOD. A node's own
       ring [h, 2h) only needs band 1, but balance-forced far nodes and node EXTENT reach into
       later bands, so cascade until the lattice runs out (uCUV = 0), then hold — both sides
       of any seam saturate at the same absolute level. */
    float surfaceH(vec2 uv){
      vec2 w = uTileOrigin + clamp(uv,0.0,1.0)*uTileSize;
      float d = distance(w, cameraPosition.xz);
      float h = hAt(uv);
      float band = uMorphBase;
      for(int k = 0; k < 4; k++){
        float s = uCUV[k];
        if(s <= 0.0) break;
        float m = smoothstep(1.55 * band, 1.95 * band, d);
        if(m <= 0.0) break;
        h = mix(h, hLattice(uv, s), m);
        band *= 2.0;
      }
      return h;
    }

    /* Edge stitch: with a 2:1-balanced quadtree a boundary edge either matches its neighbour
       or the neighbour is exactly one level coarser. In the coarse case this fine tile carries
       r = 2*fineN/coarseN boundary vertices per coarse segment; the r-1 "extra" ones between
       coarse-aligned samples must be collapsed onto the straight segment the coarse neighbour
       draws — otherwise they dangle off it as a T-junction crack. Linearly interpolate the two
       coarse-aligned surface samples that bracket this vertex. Coarse-aligned vertices (and both
       edge corners, since fineN is divisible by r) are returned unchanged via a sentinel. */
    float collapseEdge(float fixedU, bool xFixed, float along, float r){
      float k = floor(along * uGridN + 0.5);        // integer boundary-vertex index
      float m = mod(k, r);                          // 0 at coarse-aligned indices
      if (m < 0.5) return -1.0e9;
      float a0 = (k - m) / uGridN, a1 = (k - m + r) / uGridN;
      vec2 uv0 = xFixed ? vec2(fixedU, a0) : vec2(a0, fixedU);
      vec2 uv1 = xFixed ? vec2(fixedU, a1) : vec2(a1, fixedU);
      return mix(surfaceH(uv0), surfaceH(uv1), m / r);
    }

    void main(){
      vec2 g = position.xz;
      // uUVMax also clips GEOMETRY: grid columns/rows past the raster edge collapse onto the
      // data-boundary line (degenerate, zero-area). Every z then renders exactly the same
      // world extent — without this, ceil-sized tile grids covered DIFFERENT east/south spans
      // per zoom, so subdividing a boundary node dropped whole child quadrants (the stepped
      // sky-holes at the world edge) and unsplit coarse nodes rendered km of padding slabs.
      vec2 uv = min(clamp(g, 0.0, 1.0), uUVMax);
      float skirt = (g.x < 0.0 || g.x > 1.0 || g.y < 0.0 || g.y > 1.0) ? uSkirt : 0.0;

      float h = surfaceH(uv);
      // stitch: a non-corner boundary vertex lies on at most one edge; corners collapse to a
      // no-op. Skirt-ring vertices share the boundary uv, so they collapse too and stay attached.
      float hc = -1.0e9;
      if      (g.x <= 0.0 && uEdgeR.x > 0.5) hc = collapseEdge(0.0, true,  uv.y, uEdgeR.x);
      else if (g.x >= 1.0 && uEdgeR.y > 0.5) hc = collapseEdge(1.0, true,  uv.y, uEdgeR.y);
      else if (g.y <= 0.0 && uEdgeR.z > 0.5) hc = collapseEdge(0.0, false, uv.x, uEdgeR.z);
      else if (g.y >= 1.0 && uEdgeR.w > 0.5) hc = collapseEdge(1.0, false, uv.x, uEdgeR.w);
      if (hc > -1.0e8) h = hc;
      h -= skirt;

      vec2 wxz = uTileOrigin + uv*uTileSize;
      vHeight = h; vUv = uv;

      // finite-difference normal at the source texel step (in node-uv units)
      float e = (1.0 / 512.0) / uHWin.z;
      float hx = hAt(uv + vec2(e,0.0)) - hAt(uv - vec2(e,0.0));
      float hz = hAt(uv + vec2(0.0,e)) - hAt(uv - vec2(0.0,e));
      float d  = 2.0 * e * uTileSize;
      vec3 nrm = normalize(vec3(-hx, d, -hz));
      // (a) MACRO NORMAL: at range the fine per-texel normal mips/coarsens toward flat and the
      // massif's major ridges/gullies stop catching light — the "painted-flat" distant look. Add
      // a second finite diff at a WIDER (4-texel) step, gradient-exaggerated so major relief stays
      // dramatic, and blend fine->macro by camera distance so it only dominates beyond ~3 km (near
      // ground keeps crisp per-texel shading). The branch keeps the extra 4 height fetches off the
      // dense near-field grids (whole near tiles evaluate macroMix~0 uniformly).
      float dc = distance(wxz, cameraPosition.xz);
      float macroMix = smoothstep(2500.0, 6000.0, dc);
      if(macroMix > 0.001){
        float em = 4.0 * e;
        float hxm = hAt(uv + vec2(em,0.0)) - hAt(uv - vec2(em,0.0));
        float hzm = hAt(uv + vec2(0.0,em)) - hAt(uv - vec2(0.0,em));
        float dm  = 2.0 * em * uTileSize;
        // gradient exaggeration: base 1.5, ramped HARDER high on the massif (datum-rel h) so the
        // Grand's aretes/couloirs still catch raking light at 8-15 km instead of washing flat —
        // this is shading only (normal), the vertex position/silhouette is unchanged, so seams and
        // the stitch are untouched.
        float exag = mix(1.5, 2.9, smoothstep(900.0, 1450.0, h));
        vec3 nMacro = normalize(vec3(-hxm * exag, dm, -hzm * exag));
        nrm = normalize(mix(nrm, nMacro, macroMix));
      }
      vNormal = nrm;

      vec3 world = vec3(wxz.x, h, wxz.y);
      vWorld = world;
      gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
    }`,

  fragment: /* glsl */`
    precision highp float;
    uniform sampler2D uImagery;
    uniform vec3  uIWin;
    uniform vec2  uUVMax;        // valid-data clamp (see vertex): grey padding never sampled
    uniform float uHasImg;
    uniform vec3  uSun;          // direction TO the active light (sun or moon)
    uniform vec3  uSunColor;
    uniform vec3  uAmb;          // ambient sky tint, dims to deep blue at night
    uniform vec3  uEnvColor;     // low-frequency sky environment (PMREM counterpart for custom terrain)
    uniform float uWet;          // weather-driven wetness; only exposed on bare steep granite below
    uniform vec2  uSunAngles;    // (azimuth rad from +x toward +z, elevation rad)
    uniform sampler2D uHorizonA; // horizon angles, azimuth bins 0-3 in RGBA
    uniform sampler2D uHorizonB; // bins 4-7
    uniform float uHasHorizon;
    uniform sampler2D uAO;       // baked sky-visibility (bake_ao.py): 1 = open sky, ~0.5 = couloir
    uniform float uHasAO;
    uniform float uHorizonMax;   // encoded angle range (rad)
    uniform vec2  uWorldMin;     // park extent for horizon-map uv
    uniform vec2  uWorldInv;
    uniform vec3  uFogColor;
    uniform float uFogNear;
    uniform float uFogFar;

    // The NAIP tiles and every procedural palette below are authored as display/sRGB colours.
    // ShaderMaterial does not run Three's mapTexelToLinear() helper for arbitrary samplers, so
    // treating those values as linear makes mid-tones carry roughly twice their intended energy
    // in the half-float pipeline. Keep all classification/detail work in authored space, then
    // decode the finished albedo exactly once immediately before lighting.
    vec3 authoredToLinear(vec3 c){
      vec3 lo = c / 12.92;
      vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
      return mix(lo, hi, step(vec3(0.04045), c));
    }
    uniform float uSnowLine;
    uniform float uNaturalColor; // calibrated valley palette; ?naturalcolor=0 preserves A/B control
    uniform float uSeason;       // 0 = summer (default) .. 0.45 autumn .. 1 = deep winter.
                                 //   Adopted onto each tile material by ScatterManager BEFORE the
                                 //   tile's first render; if that never runs it is filtered out by
                                 //   three's seqWithValue and defaults to 0 (summer) — no crash.
    uniform float uTime;         // seconds; drives drifting cloud shadows (matches sky dome rate)
    uniform sampler2D uNoise;    // baked seamless tiling noise atlas (replaces per-pixel value-noise
                                 //   octaves): R,B = 1-octave value noise (decorrelated seeds);
                                 //   G = 5-octave fBm (cloud-shadow field); A = 2-octave grain fBm.
    uniform sampler2D uDetailN;  // tiling rocky detail-normal: RG = height-gradient, 0.5 = flat
                                 //   (runtime-baked in TerrainStreamer._buildDetailNormal)
    uniform float uHasDetailN;
    uniform sampler2D uRoads;    // baked road SDF: R = dist 0..40 m, G = class (see uHasRoads)
    uniform vec2  uRoadsOrigin;  // world (x,z) of the SDF texel origin
    uniform vec2  uRoadsInv;     // 1 / (world span) so (world - origin) * inv = uv
    uniform float uHasRoads;     // 0 when no roads baked — the fragment path is skipped entirely
    /* ---- terrain-aware headlights (HEADLIGHT_UNIFORMS contract, driven by 82-drive each frame).
       SpotLights only light the built-in Lambert materials (buildings/grass); the terrain custom
       shader ignores them, so the beams are re-derived here: two cones (left/right lamp), warm
       Lambert response on the geometric normal, smooth cone edge + inverse-square-ish falloff.
       uHLParams.w (master intensity) is 0 in daytime / when parked / not near, so the whole block
       early-outs to zero cost then — the producer gates it on nightAmt. */
    uniform vec3  uHLPos[2];      // beam origins (world)
    uniform vec3  uHLDir[2];      // beam axis directions (normalized, world)
    uniform vec3  uHLColor;       // warm beam color
    uniform vec4  uHLParams;      // x=cosInner y=cosOuter z=range(m) w=masterIntensity
    varying vec3 vWorld;
    varying vec3 vNormal;
    varying float vHeight;
    varying vec2 vUv;

    vec3 hlBeam(vec3 world, vec3 nrm, vec3 bpos, vec3 bdir){
      vec3 toF = world - bpos;
      float dist = length(toF);
      vec3 L = toF / max(dist, 1.0e-3);           // origin -> fragment
      float cone = smoothstep(uHLParams.y, uHLParams.x, dot(L, bdir));
      float atten = (1.0 - smoothstep(0.55 * uHLParams.z, uHLParams.z, dist))
                  / (1.0 + 0.015 * dist + 0.0012 * dist * dist);  // softer falloff → beam throws much further
      return uHLColor * (cone * atten * max(dot(nrm, -L), 0.0));
    }
    vec3 headlight(vec3 world, vec3 nrm){
      if(uHLParams.w < 0.001) return vec3(0.0);
      return (hlBeam(world, nrm, uHLPos[0], uHLDir[0])
            + hlBeam(world, nrm, uHLPos[1], uHLDir[1])) * uHLParams.w;
    }

    /* Ground detail + cloud shadows now READ a baked seamless tiling noise atlas (uNoise) instead
       of evaluating ~17 sin-based value-noise octaves per pixel every frame. The atlas holds 64
       base lattice cells across its [0,1) uv (built in TerrainStreamer._buildNoiseAtlas to match
       the old vnoise/fbmSky recipes), so a site that used vnoise(X) now reads noiseTex(X) =
       texture2D(uNoise, X/64) with REPEAT wrap — seamless, deterministic, and drift-safe.
       Channels: R,B = 1-octave value noise (decorrelated seeds); G = 5-octave fBm (clouds);
       A = 2-octave fBm (fine grain). (Var names avoid the reserved patch/filter/sample.) */
    vec4 noiseTex(vec2 X){ return texture2D(uNoise, X * 0.015625); }   // 0.015625 = 1/64

    /* 1 = clear, ~0.8 under a cloud. Approximates the sky dome's cloud field projected from a
       ~2.5 km deck onto the ground so shadow patches drift with the visible clouds. Day only:
       gate on sun elevation AND on the active light being the warm sun (moonlight is cool,
       r < b, so the same test kills it at night). */
    float cloudShade(){
      float dayAmt = smoothstep(0.04, 0.14, uSunAngles.y)
                   * smoothstep(0.02, 0.12, uSunColor.r - uSunColor.b);
      if(dayAmt < 0.005) return 1.0;
      vec2 cuv = vWorld.xz / 2680.0;
      vec2 drift = vec2(uTime*0.006, uTime*0.0022);
      // G channel = the 5-octave fbmSky field; two fetches (was 2x fbmSky = 10 value-noise evals).
      // drift is added in noise units, so with REPEAT wrap the atlas scrolls seamlessly forever.
      float c = noiseTex(cuv*1.35 + drift).g + 0.45*noiseTex(cuv*3.4 - drift*2.0).g;
      // slightly looser threshold than the sky's (0.86, 1.18): the shadow of a cloud is wider
      // and softer than its bright core, and the ground window samples far less of the field
      float cover = smoothstep(0.72, 1.06, c);
      return 1.0 - 0.28*cover*dayAmt;
    }

    /* ---- real cast shadows (near trees/buildings/car): ONE camera-following 2048 PCF map.
       20-scene owns the light + depth pass and shares {map, matrix, on} via SHADOW_UNIFORMS;
       the terrain samples it manually (custom shader — built-in shadow chunks don't apply).
       4-tap PCF at ~0.7 texel spread; the box edge fades over its last ~6% so the ~260 m
       shadow ring never ends on a hard line. Terrain itself never CASTS into this map (the
       baked horizon maps already carry terrain-scale shadows), so there is no acne and the
       depth bias can stay tiny. uShadowOn gates all cost (0 above ~600 m camera height). */
    uniform sampler2D uShadowMap;
    uniform mat4  uShadowMtx;    // world -> shadow uv/depth, all 0..1 (directional: w = 1)
    uniform float uShadowOn;
    float shadowDepthUnpack(vec4 v){
      return dot(v, vec4(1.0, 1.0/255.0, 1.0/65025.0, 1.0/16581375.0)) * (255.0/256.0);
    }
    float sunCastShadow(){       // 1 = lit, 0 = inside a real cast shadow
      if(uShadowOn < 0.5) return 1.0;
      vec3 sc = (uShadowMtx * vec4(vWorld, 1.0)).xyz;
      vec2 db = min(sc.xy, 1.0 - sc.xy);
      float inBox = smoothstep(0.0, 0.06, min(db.x, db.y)) * step(sc.z, 1.0);
      if(inBox <= 0.0) return 1.0;
      float zr = sc.z - 0.0006;
      // Rotated multi-tap PCF (world-anchored hash → the tap pattern is static per point).
      // The shadow box is 260 m over 2048 texels = 12.7 cm/texel; underfoot that texel magnifies
      // across many screen pixels, so a near tree's DAPPLED crown shadow used to quantise into a
      // texel-lattice grain (the "dapple"). Fix: widen the kernel AND take more taps as the
      // fragment nears the camera, averaging the crown's holes into soft solid shade. Far-in-box
      // fragments keep a tight radius + cheap tap count so crisp contact shadows (car on asphalt)
      // stay clean and unregressed — this only touches the near-field softness, not the caster.
      float near = 1.0 - smoothstep(15.0, 95.0, length(vWorld - cameraPosition));
      float e = (1.1 + 3.4 * near) / 2048.0;         // ~1.1 texel far → ~4.5 texel very near
      float ra = fract(sin(dot(vWorld.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2832;
      float lit = step(zr, shadowDepthUnpack(texture2D(uShadowMap, sc.xy)));   // centre tap
      float taps = 1.0;
      // outer ring: 8 rotated taps at the (widened) radius — enough that a big near-field kernel
      // reads as a smooth penumbra, not the old 5-level 4-tap banding
      for(int i = 0; i < 8; i++){
        float a = ra + float(i) * 0.7853981634;      // 45° steps
        vec2 off = vec2(cos(a), sin(a)) * e;
        lit += step(zr, shadowDepthUnpack(texture2D(uShadowMap, sc.xy + off)));
        taps += 1.0;
      }
      // inner ring only where the kernel is actually wide (near): fills the disc so tree shade
      // is solid, not a donut. Skipped in the far field, so contact-shadow cost/crispness holds.
      if(near > 0.01){
        for(int i = 0; i < 4; i++){
          float a = ra + float(i) * 1.5707963268 + 0.3926990817;   // 90° steps, offset from ring
          vec2 off = vec2(cos(a), sin(a)) * (0.5 * e);
          lit += step(zr, shadowDepthUnpack(texture2D(uShadowMap, sc.xy + off)));
          taps += 1.0;
        }
      }
      return mix(1.0, lit / taps, inBox);
    }

    float horizonBin(int k, vec2 uv){
      vec4 A = texture2D(uHorizonA, uv), B = texture2D(uHorizonB, uv);
      if(k==0) return A.r; if(k==1) return A.g; if(k==2) return A.b; if(k==3) return A.a;
      if(k==4) return B.r; if(k==5) return B.g; if(k==6) return B.b; return B.a;
    }

    /* 1 = lit, 0 = terrain-cast shadow */
    float sunVisibility(){
      if(uHasHorizon < 0.5) return 1.0;
      vec2 uvH = (vWorld.xz - uWorldMin) * uWorldInv;
      float az = uSunAngles.x;                       // 0..2π from +x toward +z
      float bin = fract(az / 6.2831853) * 8.0;       // 8 azimuth bins, 45° each
      int k0 = int(floor(bin));
      float f = fract(bin);
      float h0 = horizonBin(k0, uvH), h1 = horizonBin(int(mod(float(k0)+1.0, 8.0)), uvH);
      float horizon = mix(h0, h1, f) * uHorizonMax;
      return smoothstep(horizon - 0.01, horizon + 0.04, uSunAngles.y);
    }

    /* ---- class-aware near-field ground detail: NLCD landcover class (landcover.png R channel,
       NEAREST — codes must not interpolate) selects one of four baked tiling material fields in
       uDetailA (R dry grass/sage, G forest duff, B gravel scree, A snow grain; each mean-0.5 so
       overlay + mipmap fade are no-ops). Both fetches gated to < ~140 m by detAmt. */
    uniform sampler2D uLandcover; // R = NLCD class / 255
    uniform float uHasLC;
    uniform vec2  uLCMin;         // landcover world min (x,z) — its OWN extent, not uWorldMin
    uniform vec2  uLCInv;         // 1 / landcover world span
    uniform sampler2D uDetailA;   // runtime-baked atlas (TerrainStreamer._buildDetailAlbedo)

    void main(){
      vec3 n = normalize(vNormal);
      float slope = 1.0 - n.y;

      // SEASON: winter drops the effective snowline so the existing snow cues (class-aware snow,
      // procedural palette, rock-frost fade) all descend the massif — "more snow" for free.
      // effSnow == uSnowLine at season 0, so summer is byte-for-byte unchanged.
      float effSnow = uSnowLine - uSeason * 520.0;

      vec3 albedo;
      float dCam = length(vWorld - cameraPosition);
      vec2 groundGrad = vec2(0.0);
      float groundRelief = 0.0;
      float groundRoughness = 1.0;
      if(uHasImg > 0.5){
        // (b) MIP BIAS: at long range the draped NAIP selects a low (blurry) mip, so far peaks
        // read as a soft green/white smear vs the crisp near ground. Nudge the sample toward a
        // sharper mip past ~3 km (aniso is already max), capped at -0.6 so mid range and near
        // ground are untouched and grazing far angles don't shimmer.
        float mipBias = -0.6 * smoothstep(3000.0, 7000.0, dCam);
        albedo = texture2D(uImagery, uIWin.xy + min(vUv, uUVMax)*uIWin.z, mipBias).rgb;
        // near-field detail: the NAIP texel is 1.25 m, so underfoot it magnifies into airbrush.
        // Rebuild plausible ground structure — domain-warped vegetation patches that shift the
        // hue between dry-grass gold and sage green, plus mid + fine grain for lighting texture.
        float nearAmt = 1.0 - smoothstep(40.0, 260.0, dCam);
        if(nearAmt > 0.003){
          // NOTE: avoid GLSL reserved-ish names (patch, filter, sample) — ANGLE rejects them
          vec2 p = vWorld.xz;
          vec4 nw = noiseTex(p*0.13);                       // R,B = two decorrelated low-freq fields
          vec2 warp = vec2(nw.r, nw.b) * 4.0;
          float veg   = noiseTex((p + warp)*0.22).r;        // ~5 m vegetation clumps
          float coarse= noiseTex(p*1.7).r;
          float grain = noiseTex(p*6.1).a;                  // A = 2-octave grain fBm (6.1 & 13.7 freq)
          float lum = (veg-0.5)*0.20 + (coarse-0.5)*0.16 + (grain-0.5)*0.20;
          albedo *= 1.0 + lum*nearAmt;
          vec3 dry = albedo*vec3(1.10, 1.02, 0.80);
          vec3 grn = albedo*vec3(0.86, 1.03, 0.78);
          albedo = mix(albedo, mix(dry, grn, smoothstep(0.30, 0.70, veg)), 0.38*nearAmt);

          // ---- class-aware material detail: within ~140 m overlay a tiling ground-material
          // field picked by NLCD class, so the ground underfoot reads as dry grass / duff /
          // scree / snow instead of magnified NAIP airbrush. NAIP keeps the base color: this
          // is a mean-0.5 luma overlay (~0.35 strength) + a faint hue nudge, fully faded by
          // 140 m. Cost: +2 fetches (landcover, detail atlas) on near fragments only.
          float detAmt = (1.0 - smoothstep(60.0, 140.0, dCam)) * uHasLC;
          if(detAmt > 0.003){
            // class lookup jittered by the low-freq warp fields (already fetched) so the
            // 10 m NLCD lattice never prints a staircase into the ground
            vec2 lcuv = (p + (vec2(nw.r, nw.b) - 0.5)*9.0 - uLCMin) * uLCInv;
            float cls = floor(texture2D(uLandcover, lcuv).r * 255.0 + 0.5);
            float wFor = float((cls > 40.5 && cls < 43.5) || (cls > 89.5 && cls < 90.5));
            float wWat = float(cls > 10.5 && cls < 11.5);   // open water: leave it alone
            float scrCls = float(cls > 30.5 && cls < 31.5); // NLCD barren rock/talus
            float wShr = float(cls > 51.5 && cls < 52.5);
            float wMead = float(cls > 70.5 && cls < 71.5);
            // scree: NLCD barren, or steep + high talus (NLCD often maps talus as shrub)
            float wScr = max(scrCls, (1.0 - smoothstep(0.88, 0.95, n.y))
                           * smoothstep(250.0, 550.0, vHeight) * (1.0 - wFor));
            // snow: NLCD 12, or VERY bright albedo near the snow line. Threshold sits above
            // pale granite talus (~0.55-0.65 luma) and mapped barren resists the cue, so
            // sunlit scree keeps its stones; class-12 permanent snowfields are absolute.
            float wSnw = max(float(cls > 11.5 && cls < 12.5),
                             smoothstep(0.66, 0.80, dot(albedo, vec3(0.3333)))
                           * smoothstep(effSnow - 250.0, effSnow, vHeight)
                           * (1.0 - 0.85*scrCls));
            // ~3.5 m repeat, domain-warped by the other low-freq field pair and amplitude-
            // varied by the veg clump field, so the tile repeat never reads
            vec4 dtl = texture2D(uDetailA, (p + (vec2(nw.b, nw.r) - 0.5)*2.6) * 0.285);
            float dm = dtl.r;                               // grass/sage is the default
            dm = mix(dm, dtl.g, wFor);
            dm = mix(dm, dtl.b, clamp(wScr, 0.0, 1.0));
            dm = mix(dm, dtl.a, clamp(wSnw, 0.0, 1.0));
            float str = mix(0.35, 0.20, clamp(wSnw, 0.0, 1.0))   // snow grain stays subtle
                      * (1.0 - wWat) * (0.75 + 0.5*veg) * detAmt;
            albedo *= 1.0 + (dm - 0.5) * 2.0 * str;
            // Biome material separation: exposed mineral soil between sage bunches, warm
            // needle/leaf duff under forest, restrained meadow green and cool gravel on scree.
            float barePocket = smoothstep(0.62, 0.30, veg) * (1.0-wFor) * (1.0-wMead);
            vec3 tnt = mix(vec3(1.04,1.00,0.91), vec3(0.83,0.75,0.64), barePocket*wShr);
            tnt = mix(tnt, vec3(0.82,0.74,0.63), 0.72*wFor);
            tnt = mix(tnt, vec3(0.93,1.01,0.88), 0.30*wMead);
            tnt = mix(tnt, vec3(0.99, 0.99, 1.02), clamp(wScr, 0.0, 1.0));
            tnt = mix(tnt, vec3(1.0), clamp(wSnw, 0.0, 1.0));
            albedo *= mix(vec3(1.0), tnt, 0.52 * (1.0 - wWat) * detAmt);

            // Turn the same stable material field into underfoot micro-relief. Channel selection
            // mirrors dm exactly, so grass, duff, gravel and snow do not share a generic normal.
            vec2 duv = vec2(1.0/256.0,0.0);
            vec2 detailUv = (p + (vec2(nw.b,nw.r)-0.5)*2.6)*0.285;
            vec4 dtlX=texture2D(uDetailA,detailUv+duv);
            vec4 dtlZ=texture2D(uDetailA,detailUv+duv.yx);
            float dmX=dtlX.r, dmZ=dtlZ.r;
            dmX=mix(dmX,dtlX.g,wFor); dmZ=mix(dmZ,dtlZ.g,wFor);
            dmX=mix(dmX,dtlX.b,clamp(wScr,0.0,1.0));
            dmZ=mix(dmZ,dtlZ.b,clamp(wScr,0.0,1.0));
            dmX=mix(dmX,dtlX.a,clamp(wSnw,0.0,1.0));
            dmZ=mix(dmZ,dtlZ.a,clamp(wSnw,0.0,1.0));
            groundGrad=vec2(dmX-dm,dmZ-dm);
            groundRelief=detAmt*(1.0-wWat)*(1.0-0.55*wSnw);
            groundRoughness=mix(0.90,0.98,wFor);
            groundRoughness=mix(groundRoughness,0.84,clamp(wScr,0.0,1.0));
            groundRoughness=mix(groundRoughness,0.94,clamp(wSnw,0.0,1.0));
          }
        }
      } else {
        // procedural fallback palette (pre-imagery look)
        vec3 sage   = vec3(0.52,0.55,0.38);
        vec3 forest = vec3(0.16,0.30,0.16);
        vec3 rock   = vec3(0.53,0.53,0.56);
        vec3 snow   = vec3(0.95,0.97,1.0);
        albedo = mix(sage, forest, smoothstep(60.0,260.0, vHeight));
        albedo = mix(albedo, rock, smoothstep(320.0,760.0, vHeight));
        albedo = mix(albedo, rock, smoothstep(0.32,0.55, slope));
        if (vHeight > effSnow && slope < 0.5)
          albedo = mix(albedo, snow, smoothstep(effSnow, effSnow+120.0, vHeight)*smoothstep(0.5,0.28,slope));
        float d2 = noiseTex(vWorld.xz*0.35).r*0.6 + noiseTex(vWorld.xz*1.6).r*0.4;
        albedo *= 0.90 + 0.20*d2;
      }

      // ---- HIGH-ALPINE CORE CORRECTION (the "foothill" fix): above the real treeline the
      // draped NAIP + veg tint stays GREEN and the massif reads as a forested foothill. Gate on
      // datum-relative ELEVATION (vHeight) + slope so it is position-stable at EVERY distance and
      // LOD — pure albedo, no geometry, seam-safe. Treeline here ~ vHeight 1000-1450 (≈2900-3350 m
      // real; datum 1897 m). Three moves: (1) strip green vegetation tint that has no business
      // above treeline; (2) push STEEP high faces to bare granite so the east face reads as rock,
      // not turf; (3) let bright snow hold only where it physically can (gentle high benches +
      // couloir shade) instead of dusting the rounded tops.
      float alpE = smoothstep(820.0, 1250.0, vHeight);
      if(alpE > 0.001){
        float lm = dot(albedo, vec3(0.299, 0.587, 0.114));
        // greenness: how far G sits above the R/B mean (bare rock/snow ~ 0)
        float grn = clamp(albedo.g - 0.5*(albedo.r + albedo.b), 0.0, 0.5);
        // luma-preserving light-granite (Teton granite reads pale cool grey in sun)
        vec3 granite = vec3(0.56, 0.55, 0.585) * (0.46 + 1.02*lm);
        // steep = low n.y; drive steep high faces hard toward rock, and rock-ify ANY green tint
        // (the vegetation cast above treeline is the strongest foothill cue — hit it hard)
        float steepA = smoothstep(0.92, 0.64, n.y);
        float rockMix = alpE * clamp(max(steepA, grn * 6.0), 0.0, 1.0);
        albedo = mix(albedo, granite, 0.80 * rockMix);
        // desaturate the residual green everywhere high (kills the forest-flank cast)
        albedo = mix(albedo, vec3(lm), 0.70 * alpE * smoothstep(0.015, 0.12, grn));
        // couloir/cirque snow: keep bright snow only on the gentler high ground; on steep faces
        // the rock-ify above already removed it, so what remains reads as snow held in chutes
        float snowHi = smoothstep(0.68, 0.84, lm) * alpE * (1.0 - 0.7*steepA);
        albedo = mix(albedo, vec3(0.95, 0.965, 1.0), 0.34 * snowHi);
      }

      // ---- SEASONAL SNOW / AUTUMN (window.SEASON via uSeason). Pure albedo, position-stable
      // (vHeight + geometric slope), seam-safe at every LOD, and a STRICT no-op at season 0 so the
      // summer look is unregressed. Winter lays a snow blanket that descends from the peaks toward
      // the valley as the season deepens (holding on gentle ground, shed by cliffs), plus a cool
      // wintry cast on the low ground that still shows through. Autumn (peak ~0.45) warms the low
      // vegetated valley toward gold — the ground echo of the aspens ScatterManager turns.
      if(uSeason > 0.002){
        float gentle = smoothstep(0.62, 0.86, n.y);                       // snow keeps to gentle ground
        float cov    = smoothstep(effSnow - 220.0, effSnow + 120.0, vHeight); // high ground whitens first
        float valley = smoothstep(0.55, 1.0, uSeason) * (1.0 - smoothstep(140.0, 520.0, vHeight));
        float snowAmt = clamp(max(cov, 0.6 * valley), 0.0, 1.0) * gentle * smoothstep(0.0, 0.16, uSeason);
        albedo = mix(albedo, vec3(0.93, 0.95, 0.99), 0.9 * snowAmt);
        // low ground that isn't yet blanketed still reads cold/blue-grey in deep winter
        albedo = mix(albedo, albedo * vec3(0.92, 0.96, 1.06), 0.25 * valley * (1.0 - snowAmt));
      }
      float autumnT = clamp(1.0 - abs(uSeason - 0.45) * 2.4, 0.0, 1.0);
      if(autumnT > 0.01){
        float grnT   = clamp(albedo.g - 0.5*(albedo.r + albedo.b), 0.0, 0.4);  // vegetated pixels only
        float lowVeg = 1.0 - smoothstep(320.0, 720.0, vHeight);                // valley / lower flanks
        float amtT   = autumnT * smoothstep(0.02, 0.12, grnT) * lowVeg * 0.5;
        albedo = mix(albedo, albedo * vec3(1.32, 1.02, 0.42), amtT);
      }

      // Photographic valley calibration. NAIP was captured under bright growing-season light;
      // the near-detail overlays and real-time sun can otherwise compound its yellow/green
      // chroma into a synthetic fluorescent meadow. Compress only low-elevation vegetation
      // toward its own luminance and add a minute cool-neutral balance. High granite, snow, and
      // intentional autumn colour remain authoritative. This costs no texture fetches and the
      // query flag preserves a same-camera production A/B.
      if(uNaturalColor > 0.5){
        float valleyNatural = (1.0 - smoothstep(380.0, 920.0, vHeight))
                            * (1.0 - 0.72*autumnT);
        float naturalLum = dot(albedo, vec3(0.299, 0.587, 0.114));
        albedo = mix(albedo, vec3(naturalLum), 0.14*valleyNatural);
        albedo *= mix(vec3(1.0), vec3(0.985, 0.975, 1.015), 0.35*valleyNatural);
      }

      // ---- roads: the baked SDF splat is RETIRED. Roads are now real ribbon geometry
      // (terrain/src/RoadRibbon.js) draped on the terrain — crisp asphalt with white edge lines
      // and a double-yellow centerline, instead of a 5.1 m/px blurry blob. The uRoads* uniforms
      // are left declared (TerrainStreamer still plumbs them) but the fragment no longer samples
      // the SDF. roads.png stays on disk, unused. Reference uHasRoads once so the uniform isn't
      // optimised out from under the streamer's plumbing.
      if(false && uHasRoads > 0.5){ albedo += texture2D(uRoads, vUv).rgb * 0.0; }

      // ---- rock micro-relief: perturb the geometric normal with the tiling detail-normal map
      // on STEEP fragments NEAR the camera only, so cliff faces gain crag/graininess in raking
      // light while the valley floor and far ranges are untouched. Two scales (non-integer
      // ratio hides the tile repeat); mipmaps average RG back to flat under minification, so
      // there is no sparkle at distance even inside the 3 km window. Snow (bright albedo at
      // high altitude) fades the strength so snowfields stay smooth. Cost: 2 texture fetches
      // on gated fragments, 0 elsewhere.
      // slope gate tuned to THIS DEM: normals sample at the 1.25 m texel step, where even the
      // Teton cliff bands sit at n.y 0.75-0.93 (measured on tile 7/18/34 — n.y<0.75 is <1% of
      // pixels). Valley floor is ~0.98+, so 0.93 still excludes it entirely.
      float dRock = length(vWorld - cameraPosition);
      float rockAmt = (1.0 - smoothstep(0.80, 0.93, n.y))          // slope gate: steep only
                    * (1.0 - smoothstep(1800.0, 3200.0, dRock));   // distance gate: < ~3 km
      if(uHasDetailN > 0.5 && rockAmt > 0.01){
        float snowy = smoothstep(0.58, 0.72, dot(albedo, vec3(0.3333)))
                    * smoothstep(effSnow - 250.0, effSnow, vHeight);
        rockAmt *= 1.0 - 0.8*snowy;
        // scales sized for the ref viewing distances (0.3–3 km): features must span ~1–36 m
        // or mip minification flattens them before they ever reach the screen
        vec2 t1 = texture2D(uDetailN, vWorld.xz * 0.0222).rg * 2.0 - 1.0;  // ~45 m repeat: grain
        vec2 t2 = texture2D(uDetailN, vWorld.xz * 0.00537).rg * 2.0 - 1.0; // ~186 m repeat: crags
        vec2 tp = t1*0.6 + t2*1.0;
        float k = 0.4 * rockAmt;
        n = normalize(vec3(n.x + tp.x*k, n.y, n.z + tp.y*k));
      }
      if(groundRelief > 0.003){
        float gk=2.25*groundRelief;
        n=normalize(vec3(n.x-groundGrad.x*gk,n.y,n.z-groundGrad.y*gk));
      }

      float vis = sunVisibility();
      float diff = max(dot(n, uSun), 0.0) * vis * sunCastShadow();
      float amb  = mix(0.32, 0.52, n.y*0.5+0.5) * (0.75 + 0.25*vis);

      // ---- baked terrain AO (ao.png = cosine-weighted sky visibility from the 10 m DEM).
      // Dims the AMBIENT term only — direct sun is already shadowed by the horizon maps, so
      // couloirs gain depth without double-darkening lit slopes. skyV ~0.5 in a couloir,
      // ~0.9 valley floor, ~1.0 open ridge; squaring stretches that band before strength.
      vec3 ambC = uAmb;
      if(uHasAO > 0.5){
        float skyV = texture2D(uAO, (vWorld.xz - uWorldMin) * uWorldInv).r;
        // stronger AO contrast high on the massif: couloirs/cirques (skyV~0.5) read as real
        // self-shadowed chutes rather than flat grey — the missing vertical depth cue the audit
        // flagged. Ambient-only, so lit ridges are untouched.
        float ao = mix(1.0, skyV*skyV, mix(0.62, 0.86, alpE));
        amb *= ao;
        // a touch of AO into diffuse only when the sun grazes the horizon: low raking light
        // barely reaches concave ground, and this sells the form of gullies at golden hour
        float graze = 1.0 - smoothstep(0.12, 0.40, uSunAngles.y);
        diff *= mix(1.0, 0.65 + 0.35*ao, graze);
        // sky-tint gradient: open fragments see blue sky, occluded ones mostly warm bounce
        // off facing rock/ground — slight, but it reads as depth rather than dirt
        float openAmt = smoothstep(0.55, 0.95, skyV);
        ambC *= mix(vec3(1.05, 0.98, 0.90), vec3(0.97, 1.0, 1.05), openAmt);
      }
      // (e) DISTANT SHADOW: the baked 8-azimuth horizon maps already carry the massif's own cast
      // shadows (sunVisibility), but heavy ambient fill washes the shaded ridges flat at 8-15 km.
      // Deepen the ambient inside horizon-shadowed DISTANT slopes (day only) so ridgelines read as
      // real shade across the range. Gated by (1-vis) so lit faces are untouched and by distance
      // so the near valley keeps its soft fill; the near-field cast-shadow map is unaffected.
      float distSh = smoothstep(3000.0, 9000.0, dCam) * smoothstep(0.06, 0.18, uSunAngles.y);
      amb *= 1.0 - 0.32 * distSh * (1.0 - vis);
      // NAIP albedo is already midday-lit photography: full Lambert on top double-lights it and
      // washes the noon valley to cream. Soft-cap the total light so high sun stays ~unity while
      // low raking sun (golden hour) keeps its full contrast.
      vec3 light = vec3(amb)*ambC + uSunColor*diff*1.05;
      float lum = dot(light, vec3(0.299, 0.587, 0.114));
      light *= mix(1.0, 1.18/max(lum, 1.18), smoothstep(1.05, 1.5, lum));
      vec3 linearAlbedo = authoredToLinear(clamp(albedo, 0.0, 1.0));
      vec3 col = linearAlbedo * light * cloudShade();

      // Snow is a broad, rough dielectric rather than a mirror.  A Blinn lobe retains a faint
      // sun glint at distance, then deliberately broadens/weakens with range so tiled terrain
      // never sparkles.  Its classification follows the same high/gentle bright-snow cues used
      // by the albedo path, preserving NAIP everywhere else.
      vec3 viewDir = normalize(cameraPosition - vWorld);
      vec3 halfSun = normalize(uSun + viewDir);
      float snowMask = smoothstep(0.67, 0.84, dot(albedo, vec3(0.3333)))
                     * smoothstep(effSnow - 180.0, effSnow + 90.0, vHeight)
                     * smoothstep(0.52, 0.82, n.y);
      float snowRough = mix(72.0, 14.0, smoothstep(250.0, 4500.0, dCam));
      float snowSpec = pow(max(dot(n, halfSun), 0.0), snowRough) * snowMask * vis
                     * mix(1.0,groundRoughness,groundRelief);
      col += uSunColor * snowSpec * mix(0.075, 0.022, smoothstep(400.0, 5000.0, dCam));

      // Restrained Fresnel sky response, intentionally ONLY steep, high, bare granite when wet.
      // It is analytic because this custom shader cannot directly sample Three's PMREM cube-UV
      // atlas; the car uses that real PMREM.  The gates keep vegetation, NAIP valley imagery,
      // snow, and the planar-reflection water path completely untouched.
      float steepGranite = smoothstep(0.91, 0.68, n.y) * alpE;
      float bareGranite = 1.0 - smoothstep(0.62, 0.78, dot(albedo, vec3(0.3333)));
      float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 5.0);
      col += uEnvColor * (0.055 * steepGranite * bareGranite * uWet * fresnel);

      // terrain-aware headlights: warm beam reflected off the ground's own albedo (dark asphalt
      // reads dim, pale sage bright) — added before fog so distant scatter still fades. Night-only
      // via the producer's uHLParams.w gate; free by day (early-out above).
      col += linearAlbedo * headlight(vWorld, n);

      // golden haze: as the sun drops, the distance fog warms toward late-light amber instead
      // of staying a uniform grey; scaled by the sun's actual warmth so night stays untouched
      float fd = dCam;
      float gold = (1.0 - smoothstep(0.10, 0.38, uSunAngles.y))
                 * smoothstep(0.05, 0.25, uSunColor.r - uSunColor.b);
      vec3 hazeC = mix(uFogColor, vec3(1.0, 0.75, 0.5)*(0.55 + 0.5*uSunColor.g), 0.75*gold);
      // (d) AERIAL PERSPECTIVE — graded recession (M7.3, restrained). Read distance as DEPTH via a
      // gentle CHROMA loss (grey, not blue — grey still reads with contrast against the blue sky) plus
      // only a whisper of cool cast. NOT amplified on high peaks: an earlier version ramped the blue UP
      // with altitude, which made the Cathedral Group the MOST blued and washed it into the sky, losing
      // all its snow/rock contrast (the whole point of the hero view). Suppressed toward golden hour.
      float aer  = smoothstep(1800.0, 11000.0, fd);
      float coolK = 1.0 - 0.7 * gold;
      float gray = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(gray), 0.20 * aer * coolK);                           // gentle grey recession, no lift
      col = mix(col, col * vec3(0.90, 0.94, 1.0), clamp(0.22 * aer * coolK, 0.0, 0.45));  // whisper of cool, uniform (no altitude amp)

      // (e) HORIZON HAZE BAND — the luminous atmospheric layer that pools in the valley and at the
      // base of distant ranges (every real mountain vista has one). Gated to LOW terrain height so
      // peaks stay clear, and to distance so near ground is untouched. Self-gates at night via dayAmt
      // (fog-colour brightness → 0 in the dark, no glowing band). Cool toward the sky by day, warm at
      // golden hour. This is the one place we DO lift distant tone — only at the valley-level base.
      float dayAmt = clamp(dot(uFogColor, vec3(0.3333)) * 2.1, 0.0, 1.0);
      float band = smoothstep(2600.0, 7000.0, fd) * (1.0 - smoothstep(150.0, 950.0, vHeight));
      vec3 bandC = mix(uFogColor, vec3(0.87, 0.91, 0.97), 0.42 * dayAmt);
      bandC = mix(bandC, vec3(1.0, 0.82, 0.60), 0.5 * gold);                    // warms at golden hour
      col = mix(col, bandC, clamp(band * 0.62 * dayAmt, 0.0, 0.75));

      float alp = smoothstep(300.0, 1400.0, vHeight) * smoothstep(3200.0, 9000.0, fd) * (1.0 - gold);
      hazeC = mix(hazeC, hazeC * vec3(0.86, 0.91, 0.98), 0.25 * alp);   // only a faint cool on high-peak haze (was 0.60 → over-blued the Tetons)
      col = mix(col, hazeC, smoothstep(uFogNear, uFogFar, fd));
      gl_FragColor = vec4(col, 1.0);
    }`
};
