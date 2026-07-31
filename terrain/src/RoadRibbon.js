/* RoadRibbon — spline roads with hierarchy + grading, draped on the terrain (Three.js r184).
 *
 * Milestone 1 item 3 (geometry scope — layered surface materials are M4):
 *
 *  SPLINES   Each OSM centerline is fit with a centripetal Catmull-Rom spline and resampled at
 *            ~6 m, then an iterative curvature relaxation enforces a per-class minimum turning
 *            radius (highway 45 m / park 25 m / gravel 12 m / track 6 m) so no sharp diagonal
 *            corners survive. Duplicate/offset twin carriageways in the data (e.g. Teton Park
 *            Rd at Moose is mapped 3x within ~1 m) are deduplicated before extrusion.
 *
 *  HIERARCHY paved > gravel > track. A lower-class ribbon that meets/crosses a higher one is
 *            TRIMMED back to the higher road's edge (+0.3 m) with the exact cut point lerped,
 *            so the higher surface runs continuous. Each class gets its own mesh with a distinct
 *            polygonOffset layer + renderOrder (track < gravel < park < highway) so residual
 *            same-height overlap never z-fights. Where same-rank roads meet at a sharp angle or
 *            3+ ways join, a topology-derived junction polygon (asphalt/gravel, no markings)
 *            joins the actual carriageway mouths — no circular overspill or butt-joint gaps.
 *
 *  GRADING   The carriageway rides a SMOOTHED longitudinal profile — an arc-length moving
 *            average of terrain height along the spline (window ~40 m paved / 20 m dirt) — with
 *            a clamped cross-tilt, raised where needed so terrain never pokes through the slab.
 *            A SHOULDER band each side (~1.5 m paved w/ slight ditch dip, ~0.8 m dirt) has its
 *            outer edge ON the real terrain height, absorbing the profile-vs-terrain delta so
 *            side slopes show no gap/floating edge. Profiles blend to a shared node height at
 *            junctions so meeting roads stay flush. Straight, vertically-quiet runs are
 *            decimated (up to 24-30 m) to hold the triangle budget.
 *
 *  Cross-section = 4 verts [shoulderL, edgeL, edgeR, shoulderR] → 3 quads. Shoulder verts get
 *  uv.x outside [0,1] so the fragment shader reads "metres past the edge" and tints a dirt
 *  verge (markings stay inside the carriageway). Lighting folds in the shared cloud shade +
 *  cast shadows + fog exactly like the terrain.
 *
 *    const rr = new RoadRibbon({scene, sampleGround, terrain, roadsUrl, sun, sunColor, ambient, fog});
 *    await rr.build();      // fetch + spline + trim + grade + mesh; resolves to rr
 *    rr.stats               // {tris, drawCalls}
 *    rr.update();           // per-frame: lazy amortized RE-GRADE onto finer streamed height
 *
 *  The lazy re-drape keeps the old converged-signature contract (poll ~6 Hz, only when streams
 *  are idle, chunked so motion frames stay cheap) but now re-runs the grading pipeline per way
 *  (smoothed profile + tilt + node blend + shoulders) instead of snapping verts to raw ground —
 *  raw snapping would undo the grading. roadQuery / drive (40-terrain, 82-drive) are untouched.
 */
(function (global) {
  'use strict';
  const THREE = global.THREE;

  // per-class recipe: w carriageway width · sh shoulder width (0 ⇒ 2-vert cross-section) ·
  // minR min turn radius · win grading window · rank trim hierarchy · maxRun/hdgTol/eps decimation
  // NOTE tracks get NO shoulder band: they are 3 m dirt 2-tracks, very numerous (~538 km), and
  // the 20 m graded profile at ≤6 m spacing already hugs the terrain — the extra 3x tris of a
  // shoulder strip on every track would blow the ≤1.6x triangle budget for the whole network.
  const CLS = {
    highway:    { w: 9.0, sh: 1.5, minR: 45, win: 40, rank: 2, paved: true,  maxRun: 24, hdgTol: 2.5, eps: 0.07 },
    park_paved: { w: 7.5, sh: 1.5, minR: 25, win: 40, rank: 2, paved: true,  maxRun: 24, hdgTol: 2.5, eps: 0.07 },
    gravel:     { w: 5.0, sh: 0.8, minR: 12, win: 20, rank: 1, paved: false, maxRun: 24, hdgTol: 4.0, eps: 0.10 },
    track:      { w: 3.0, sh: 0,   minR: 6,  win: 20, rank: 0, paved: false, maxRun: 5,  hdgTol: 5.0, eps: 0.16 },
  };
  const ORDER = ['track', 'gravel', 'park_paved', 'highway'];  // ascending draw priority
  const SEG_LEN   = 2.5;    // gravel/track authority; paved is capped to 3 m in _spline
  const LIFT      = 0.25;   // carriageway lift over the graded profile
  const FAN_LIFT  = LIFT + 0.02; // junction polygons sit 2 cm proud of ribbon ends (no coplanar fight)
  const V_TILE    = 6.0;    // metres of road per uv.v = 1
  const TRIM_PAD  = 0.3;    // lower ribbon stops this far past the higher road's edge
  const SH_LIFT   = 0.05;   // shoulder outer edge lift over raw terrain
  const DITCH     = 0.12;   // paved ditch dip where shoulder is level with the slab
  const MAX_TILT  = 0.10;   // max cross-slope (rise per metre of half-width)
  const NODE_BLEND = 24;    // metres over which a profile eases into the shared junction height
  const MIN_RUN   = 9.0;    // trimmed slivers shorter than this are dropped (kills gore stubs)
  /* Re-drape is amortized by WALL CLOCK, not by a section count. The old `600 sections/frame`
     budget was a proxy for work, and the proxy had drifted: per-section cost depends on stride,
     profile layout and how deep the height sampler has to walk, so 600 sections was producing
     frames of 60-134 ms against a comment promising "below the 24 FPS floor" (41.7 ms). Every
     frame spike over 60 ms in the benchmark telemetry had this pass running. A time slice can't
     drift, needs no retuning per machine, and degrades gracefully on a slow one. */
  const DRAPE_SLICE_MS = 4;
  const BR_CELL   = 32;      // spatial-hash cell (m) for the drivableSurfaceAt bridge index
  const BR_PAD    = 1.5;     // query tolerance past the carriageway half-width (m)
  const RENDER_CELL = 1024;  // independently culled transport render cells (metres)
  const LOD_NEAR = 900, LOD_MID = 2200;
  const LOD_HYSTERESIS = 0.10;   // matches the value the per-cell THREE.LOD nodes used

  /* ---- batched transport render cells ---------------------------------------------------
     Roads and trails used to hang one THREE.LOD per 1024 m cell off the scene — 779 + 466 nodes
     carrying about 5% of the frame's triangles, i.e. ~1245 objects that the renderer had to
     traverse, cull, LOD-update and submit individually. Every cell of a class already shares the
     master attribute buffers and one material; only the index differs. So concatenate each LOD
     level's indices into ONE buffer, cell-contiguous and Morton-ordered, and draw one Mesh per
     level whose geometry.groups name the visible runs. Spatially adjacent visible cells merge
     into a single group, so a view typically costs a handful of draws instead of hundreds.

     Nothing about the picture changes: identical triangles, identical material, identical LOD
     distances and hysteresis (replicated from THREE.LOD.update), identical per-cell frustum test
     against the same bounding sphere. Groups are only honoured for array materials, hence [mat].
     The batch keeps rendering from the master attributes, so the lazy re-drape still writes one
     buffer and every level follows. */
  function mortonKey(cx, cz) {
    let x = (cx + 32768) & 0xffff, z = (cz + 32768) & 0xffff, k = 0;
    for (let b = 0; b < 16; b++) k += ((x >> b) & 1) * Math.pow(2, 2 * b) + ((z >> b) & 1) * Math.pow(2, 2 * b + 1);
    return k;
  }

  function buildTransportBatch(master, mat, order, cells, distances) {
    const keys = [...cells[0].keys()].sort((a, b) => {
      const ai = a.indexOf(','), bi = b.indexOf(',');
      return mortonKey(+a.slice(0, ai), +a.slice(ai + 1)) - mortonKey(+b.slice(0, bi), +b.slice(bi + 1));
    });
    const perLevel = distances.map(() => []);
    const records = [];
    const sphere = new THREE.Sphere(), box = new THREE.Box3();
    for (const key of keys) {
      const rec = cells[0].get(key);
      box.min.set(rec.minX, rec.minY - 20, rec.minZ);
      box.max.set(rec.maxX, rec.maxY + 20, rec.maxZ);
      box.getBoundingSphere(sphere);
      const entry = { cx: sphere.center.x, cy: sphere.center.y, cz: sphere.center.z, r: sphere.radius,
        mx: (rec.minX + rec.maxX) * 0.5, mz: (rec.minZ + rec.maxZ) * 0.5,
        n: 0, dist: [], level: [], start: [], count: [], cur: 0, triangles: [] };
      for (let li = 0; li < distances.length; li++) {
        const lr = cells[li].get(key);
        entry.triangles.push(lr ? lr.idx.length / 3 : 0);
        if (!lr || !lr.idx.length) continue;
        const buf = perLevel[li];
        entry.dist.push(distances[li]); entry.level.push(li);
        entry.start.push(buf.length); entry.count.push(lr.idx.length);
        entry.n++;
        for (let i = 0; i < lr.idx.length; i++) buf.push(lr.idx[i]);
      }
      if (entry.n) records.push(entry);
    }
    const meshes = perLevel.map(idx => {
      if (!idx.length) return null;
      const geo = new THREE.BufferGeometry();
      for (const name of Object.keys(master.attributes)) geo.setAttribute(name, master.attributes[name]);
      geo.setIndex(idx);
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
      const mesh = new THREE.Mesh(geo, [mat]);   // array material: required for groups to render
      mesh.renderOrder = order;
      mesh.frustumCulled = false;                // culling is per cell, via the emitted groups
      mesh.matrixAutoUpdate = false;             // static at the origin; skip the per-frame update
      mesh.updateMatrix();
      geo.clearGroups();
      return mesh;
    });
    return { meshes, records, distances };
  }

  /* Per frame: frustum-test each cell, pick its LOD exactly as THREE.LOD.update would, and
     rewrite each level's groups as merged contiguous runs. No buffer uploads — groups are a plain
     array the renderer reads at submit time. */
  function updateTransportBatch(batch, camera, frustum, camPos) {
    if (!batch) return;
    for (const mesh of batch.meshes) if (mesh) mesh.geometry.clearGroups();
    const sphere = updateTransportBatch._s || (updateTransportBatch._s = new THREE.Sphere());
    const runStart = [], runEnd = [];
    for (let li = 0; li < batch.meshes.length; li++) { runStart[li] = -1; runEnd[li] = -1; }
    const flush = li => {
      if (runStart[li] < 0) return;
      batch.meshes[li].geometry.addGroup(runStart[li], runEnd[li] - runStart[li], 0);
      runStart[li] = -1; runEnd[li] = -1;
    };
    for (const rec of batch.records) {
      sphere.center.set(rec.cx, rec.cy, rec.cz); sphere.radius = rec.r;
      if (!frustum.intersectsSphere(sphere)) continue;
      // THREE.LOD.update: walk levels low->high, hysteresis only on the level shown last frame,
      // stop at the first level whose (adjusted) distance the camera has not reached.
      const dx = camPos.x - rec.mx, dy = camPos.y - 0, dz = camPos.z - rec.mz;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) / camera.zoom;
      let sel = 0;
      for (let i = 1; i < rec.n; i++) {
        let ld = rec.dist[i];
        if (i === rec.cur) ld -= ld * LOD_HYSTERESIS;
        if (distance >= ld) sel = i; else break;
      }
      rec.cur = sel;
      const li = rec.level[sel], start = rec.start[sel], count = rec.count[sel];
      if (runStart[li] >= 0 && runEnd[li] === start) { runEnd[li] = start + count; continue; }
      flush(li);
      runStart[li] = start; runEnd[li] = start + count;
    }
    for (let li = 0; li < batch.meshes.length; li++) flush(li);
  }

  global.GT_transportBatch = { build: buildTransportBatch, update: updateTransportBatch };

  const VERT = /* glsl */`
    attribute float aWidth;
    attribute float aMark;
    varying vec2  vUv;
    varying float vWidth;
    varying vec3  vWorld;
    varying vec3  vNormal;
    varying float vMark;
    void main(){
      vUv = uv; vWidth = aWidth; vNormal = normalize(normal); vMark = aMark;
      vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`;

  // shared lighting + fog + cloud-shade tail, identical recipe to the terrain fragment
  const LIGHT_GLSL = /* glsl */`
    uniform vec3  uSun; uniform vec3 uSunColor; uniform vec3 uAmb;
    uniform vec3  uFogColor; uniform float uFogNear; uniform float uFogFar;
    uniform float uCloudTime; uniform float uCloudAmt;
    uniform sampler2D uShadowMap;   // real cast shadows (SHADOW_UNIFORMS contract, 20-scene)
    uniform mat4  uShadowMtx;       // world -> shadow uv/depth 0..1 — same 4-tap PCF as terrain
    uniform float uShadowOn;
    // terrain-aware headlights (HEADLIGHT_UNIFORMS contract, 82-drive) — matches the terrain shader
    uniform vec3  uHLPos[2]; uniform vec3 uHLDir[2]; uniform vec3 uHLColor; uniform vec4 uHLParams;
    vec3 hlBeam(vec3 world, vec3 nrm, vec3 bpos, vec3 bdir){
      vec3 toF = world - bpos; float dist = length(toF);
      vec3 L = toF / max(dist, 1.0e-3);
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
    float shadowDepthUnpack(vec4 v){
      return dot(v, vec4(1.0, 1.0/255.0, 1.0/65025.0, 1.0/16581375.0)) * (255.0/256.0);
    }
    float sunCastShadow(vec3 w){    // 1 = lit, 0 = inside a cast shadow (tree/car/building)
      if(uShadowOn < 0.5) return 1.0;
      vec3 sc = (uShadowMtx * vec4(w, 1.0)).xyz;
      vec2 db = min(sc.xy, 1.0 - sc.xy);
      float inBox = smoothstep(0.0, 0.06, min(db.x, db.y)) * step(sc.z, 1.0);
      if(inBox <= 0.0) return 1.0;
      float zr = sc.z - 0.0006;
      // rotated 4-tap PCF (world-anchored hash) — matches the terrain shader; see
      // terrain-shaders.js for why a fixed tap grid checkerboards under magnified crowns
      float e = 1.2 / 2048.0;
      float ra = fract(sin(dot(w.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2832;
      vec2 t1 = vec2(cos(ra), sin(ra)) * e;
      vec2 t2 = vec2(-t1.y, t1.x);
      float lit = step(zr, shadowDepthUnpack(texture2D(uShadowMap, sc.xy + t1)))
                + step(zr, shadowDepthUnpack(texture2D(uShadowMap, sc.xy - t1)))
                + step(zr, shadowDepthUnpack(texture2D(uShadowMap, sc.xy + t2)))
                + step(zr, shadowDepthUnpack(texture2D(uShadowMap, sc.xy - t2)));
      return mix(1.0, lit * 0.25, inBox);
    }
    float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
    float vnoise(vec2 p){
      vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
                 mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y);
    }
    float fbmSky(vec2 p){ float s=0.0,a=0.5;
      for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.13+vec2(31.4,17.7); a*=0.5; } return s; }
    /* drifting cloud shade — matches the terrain/water CLOUD_UNIFORMS contract */
    float cloudShade(vec3 w){
      if(uCloudAmt < 0.005) return 1.0;
      vec2 cuv = w.xz / 2680.0;
      vec2 drift = vec2(uCloudTime*0.006, uCloudTime*0.0022);
      float c = fbmSky(cuv*1.35 + drift) + 0.45*fbmSky(cuv*3.4 - drift*2.0);
      float cover = smoothstep(0.72, 1.06, c);
      return 1.0 - 0.28*cover*uCloudAmt;
    }
    // multi-scale surface height field for normal relief (asphalt grain / gravel pebbles)
    float surfH(vec2 p){ return vnoise(p*3.0)*0.5 + vnoise(p*11.0)*0.32 + vnoise(p*29.0)*0.18; }
    // gloss in [0,1]: 0 = matte rough asphalt, 1 = polished (wheel-track) — drives a sun glint so
    // roughness variation reads under a raking angle instead of the surface being uniformly flat.
    vec3 shadeSurface(vec3 albedo, vec3 nrm, vec3 world, float retro, float gloss){
      vec3 n = normalize(nrm);
      float sh    = sunCastShadow(world);
      float cloud = cloudShade(world);
      float diff  = max(dot(n, uSun), 0.0) * sh;
      float amb   = mix(0.32, 0.52, n.y*0.5+0.5);
      vec3 col = albedo * (vec3(amb)*uAmb + uSunColor*diff*1.15) * cloud;
      // specular glint from the sun — grazing (Fresnel) boost so a low golden sun rakes the wear
      vec3 V = normalize(cameraPosition - world);
      vec3 H = normalize(uSun + V);
      float sunUp = smoothstep(-0.05, 0.16, uSun.y);
      float fres  = pow(1.0 - max(dot(n, V), 0.0), 4.0);
      float spec  = pow(max(dot(n, H), 0.0), mix(6.0, 120.0, gloss))
                  * (mix(0.03, 0.28, gloss) + 0.22 * fres * gloss);
      col += uSunColor * spec * sh * sunUp * cloud;
      // headlights: beam reflected off the asphalt albedo, plus a strong retroreflective boost on
      // painted markings (retro>0) so the centreline/edge lines flare bright in the beam at night.
      vec3 hl = headlight(world, n);
      col += albedo * hl + hl * retro;
      float fd = length(world - cameraPosition);
      col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, fd));
      return col;
    }`;

  const FRAG_PAVED = /* glsl */`
    precision highp float;
    ${LIGHT_GLSL}
    uniform float uMarkingMode; // 2 highway: double-yellow + edges; 1 park road: single centre
    varying vec2 vUv; varying float vWidth; varying vec3 vWorld; varying vec3 vNormal;
    varying float vMark;
    void main(){
      // per-fragment metres from centerline / nearest edge (aWidth = carriageway width;
      // shoulder verts carry uv.x outside [0,1] so edgeM goes NEGATIVE past the edge)
      float centerM = abs(vUv.x - 0.5) * vWidth;
      float edgeM   = (0.5 - abs(vUv.x - 0.5)) * vWidth;
      float dCam    = length(vWorld - cameraPosition);
      vec2  P       = vWorld.xz;
      // heavy per-pixel surface detail only close in; far road keeps the old clean read (no
      // aggregate/relief shimmer or tiling reveal at range — markings still run to ~4 km).
      float near    = 1.0 - smoothstep(90.0, 300.0, dCam);

      // dark asphalt base with subtle multi-scale grain
      float g = vnoise(P*0.85)*0.5 + vnoise(P*3.6)*0.5;
      vec3 albedo = vec3(0.227,0.231,0.239) * (0.86 + 0.20*g);   // ~#3a3b3d
      float gloss = 0.16;
      vec3  nrm   = vNormal;

      if(near > 0.001){
        // aggregate speckle — fine light/dark stones in the mix, plus occasional bright flecks.
        // Kept LOW-contrast: worn asphalt is mostly one grey, not a mottled pattern.
        float agg = vnoise(P*24.0);
        albedo *= 1.0 + (agg - 0.5) * 0.13 * near;
        float fleck = smoothstep(0.86, 0.96, vnoise(P*44.0 + 5.0));
        albedo = mix(albedo, vec3(0.42,0.42,0.40), fleck*0.30*near);

        // tyre wear — polished wheel paths (~2 per lane at uv.x .15/.37/.63/.85), broken up
        // along the road so they are not perfect stripes. The main "worn" story of the surface.
        float wt = 0.0, q;
        q=(vUv.x-0.15)/0.05; wt += exp(-q*q);
        q=(vUv.x-0.37)/0.05; wt += exp(-q*q);
        q=(vUv.x-0.63)/0.05; wt += exp(-q*q);
        q=(vUv.x-0.85)/0.05; wt += exp(-q*q);
        wt = clamp(wt,0.0,1.0) * (0.65 + 0.35*vnoise(P*vec2(0.4,2.0)));
        albedo *= 1.0 - 0.11*wt*near;          // rubber-darkened, polished-smooth aggregate
        gloss = mix(gloss, 0.50, wt*0.9);      // wheel paths read glossier under a raking sun

        // occasional patch repair — a rare, subtly different asphalt tone with a faint seam
        float bl = vnoise(P*0.14 + 12.0);
        float blotch = smoothstep(0.74, 0.82, bl);
        albedo = mix(albedo, vec3(0.200,0.203,0.213)*(0.90+0.16*g), blotch*0.35*near);
        float seam = smoothstep(0.725,0.74,bl) - smoothstep(0.74,0.755,bl);
        albedo *= 1.0 - 0.18*seam*near;
        gloss = mix(gloss, 0.30, blotch*0.4);

        // sparse hairline cracks — very faint, only in some stretches (kept low so the noise
        // level-sets don't read as regular loops)
        float ck = vnoise(P*vec2(0.6,5.0)+31.0);
        float crack = (smoothstep(0.49,0.5,ck) - smoothstep(0.5,0.51,ck))
                    * smoothstep(0.58,0.80, vnoise(P*0.4+9.0));
        albedo *= 1.0 - 0.10*crack*near;

        // edge dirt + sparse vegetation encroaching from the shoulder onto the slab
        float dirt = smoothstep(0.85, 0.0, edgeM) * smoothstep(0.48,0.66, vnoise(P*2.6));
        albedo = mix(albedo, vec3(0.42,0.37,0.28)*(0.82+0.30*g), dirt*0.55*near);
        float veg = smoothstep(0.66,0.82, vnoise(P*5.5)) * smoothstep(1.00,-0.30, edgeM);
        albedo = mix(albedo, vec3(0.28,0.33,0.15), veg*0.55*near);

        gloss += 0.06*(vnoise(P*1.7)-0.5);
      }
      gloss = clamp(gloss, 0.05, 0.70);

      // lane markings (M3) fade contrast past ~2.5 km so they never shimmer far off; drawn on
      // top of the wear, with patchy fading so the paint itself looks worn near the camera.
      float mk = 1.0 - smoothstep(2500.0, 4200.0, dCam);
      float paintWear = 1.0 - 0.35*clamp(vnoise(P*1.3)*1.4, 0.0, 1.0)*near;
      // Highway shoulders receive edge lines; narrower park roads retain a restrained centreline.
      float white = smoothstep(0.09,0.14, edgeM) * (1.0 - smoothstep(0.28,0.33, edgeM))
                  * step(1.5, uMarkingMode);
      // Highway: double yellow. Park paved: one narrow centre stripe.
      float doubleYellow = (1.0 - smoothstep(0.14,0.17, centerM))
                         * smoothstep(0.045,0.055, centerM);
      float singleYellow = 1.0 - smoothstep(0.045,0.075, centerM);
      float yellow = mix(singleYellow, doubleYellow, step(1.5, uMarkingMode));
      white  *= mk*paintWear*vMark; yellow *= mk*paintWear*vMark;
      albedo = mix(albedo, vec3(0.90,0.90,0.88), white);
      albedo = mix(albedo, vec3(0.86,0.72,0.12), yellow);
      gloss  = mix(gloss, 0.22, max(white,yellow));   // paint is slightly matte

      // shoulder band: blend asphalt → dirt/gravel verge over the metres past the slab edge
      vec3 verge = vec3(0.39,0.365,0.285) * (0.82 + 0.30*g);
      float vergeMask=smoothstep(0.05,0.85,-edgeM);
      float vergeGreen=smoothstep(0.52,0.72,vnoise(P*1.9+41.0))*vergeMask;
      verge=mix(verge,vec3(0.27,0.31,0.15),vergeGreen*0.52);
      albedo = mix(albedo,verge,vergeMask);

      // retroreflective paint: edge lines + centreline bounce the beam straight back, so they
      // read far brighter than the asphalt under headlights (fades with the markings past range)
      float retro = (white + yellow) * 2.2;
      gl_FragColor = vec4(shadeSurface(albedo, nrm, vWorld, retro, gloss), 1.0);
    }`;

  const FRAG_GRAVEL = /* glsl */`
    precision highp float;
    ${LIGHT_GLSL}
    uniform float uSurfaceMode; // 0 gravel, 1 two-track
    uniform sampler2D uTrackAlbedo;
    varying vec2 vUv; varying float vWidth; varying vec3 vWorld; varying vec3 vNormal;
    void main(){
      float edgeM = (0.5 - abs(vUv.x - 0.5)) * vWidth;
      float dCam  = length(vWorld - cameraPosition);
      vec2  P     = vWorld.xz;
      float near  = 1.0 - smoothstep(90.0, 300.0, dCam);
      float ax    = abs(vUv.x-0.5);
      float trackMode = step(0.5, uSurfaceMode);
      // Gravel retains a compacted carriageway, but its authored verge dissolves into the
      // landscape instead of ending as a straight opaque slab.
      float gravelEdge=.615+.085*(vnoise(P*vec2(.31,1.17)+vec2(19.0,73.0))-.5)+
        .045*(vnoise(P*vec2(1.43,.47)+vec2(61.0,7.0))-.5);
      float gravelCoverage=1.0-smoothstep(.390,gravelEdge,ax);
      if(trackMode<.5&&gravelCoverage<hash(floor(P*31.0)+11.0)) discard;
      // A two-track is two worn lanes, not a narrow road. The terrain remains visible through
      // the vegetated crown and verges; only the rut cores are continuously exposed soil.
      float rutDistance=abs(ax-.24);
      float rutCore=1.0-smoothstep(.095,.145,rutDistance);
      float rutDisturbance=(1.0-smoothstep(.145,.235,rutDistance))*
        (.20+.25*vnoise(P*vec2(.71,2.13)+43.0));
      float edgeDisturbance=(1.0-smoothstep(.34,.49,ax))*.08*
        vnoise(P*vec2(1.7,.53)+17.0);
      float trackCoverage=max(rutCore,clamp(rutDisturbance+edgeDisturbance,0.0,.72));
      if(trackMode>.5&&trackCoverage<hash(floor(P*34.0)+29.0)) discard;

      // Two differently scaled, world-anchored reads suppress visible tiling while retaining the
      // real granite grit, compacted soil and dry organic fragments in the curated source tile.
      vec2 trackUvA=P/7.5;
      vec2 trackUvB=mat2(0.819,-0.574,0.574,0.819)*P/13.0+vec2(0.37,0.61);
      vec3 trackPhoto=mix(texture2D(uTrackAlbedo,trackUvA).rgb,
        texture2D(uTrackAlbedo,trackUvB).rgb,0.22);
      float g = vnoise(P*0.9)*0.5 + vnoise(P*4.2)*0.5;
      vec3 gravelProcedural = vec3(0.541,0.490,0.388) * (0.80 + 0.34*g);
      vec3 gravelPhoto=trackPhoto*vec3(1.13,1.08,.98)*
        (.92+.17*vnoise(P*.085+vec2(5.0,37.0)));
      vec3 gravelBase=mix(gravelProcedural,gravelPhoto,.74);
      vec3 trackBase = trackPhoto * vec3(1.08,1.03,0.94) *
        (0.88+0.18*vnoise(P*0.075+vec2(17.0,41.0)));
      vec3 albedo = mix(gravelBase, trackBase, trackMode);
      float gloss = 0.06;                                        // dirt/gravel stays matte
      vec3  nrm   = vNormal;

      if(near > 0.001){
        // coarse pebble speckle + occasional bright dry stones
        float peb = vnoise(P*14.0);
        albedo *= 1.0 + (peb-0.5)*0.24*near;
        float stone = smoothstep(0.74,0.90, vnoise(P*26.0+3.0));
        albedo = mix(albedo, vec3(0.70,0.66,0.55), stone*0.45*near);
        // dust / faint damp tone blotches (dry sagebrush setting — kept light, not muddy)
        float mud = smoothstep(0.60,0.74, vnoise(P*0.16+7.0));
        albedo = mix(albedo, vec3(0.44,0.39,0.30), mud*0.28*near);
        // sparse vegetation creeping in from the edges
        float veg = smoothstep(0.60,0.80, vnoise(P*5.0)) * smoothstep(0.90,-0.20, edgeM);
        albedo = mix(albedo, vec3(0.28,0.32,0.15), veg*0.55*near);
        if(trackMode>0.5){
          // Height cues derived from the photographic tile. Unlike the removed value-noise normal
          // lattice, these gradients are irregular and fixed in world space under headlights.
          vec2 e=vec2(1.0/1024.0,0.0);
          float hx=dot(texture2D(uTrackAlbedo,trackUvA+e.xy).rgb,vec3(.299,.587,.114))-
            dot(texture2D(uTrackAlbedo,trackUvA-e.xy).rgb,vec3(.299,.587,.114));
          float hz=dot(texture2D(uTrackAlbedo,trackUvA+e.yx).rgb,vec3(.299,.587,.114))-
            dot(texture2D(uTrackAlbedo,trackUvA-e.yx).rgb,vec3(.299,.587,.114));
          nrm=normalize(nrm+vec3(-hx*1.7,0.0,-hz*1.7)*near);
        }
        // Authored crown/ruts supply the headlight-readable relief. Procedural finite-difference
        // normals are deliberately omitted: their value-noise lattice repeats under a grazing beam.
      }

      // Compacted wheel paths remain subtle on gravel. Two-track uses the same authored
      // positions as its depressed geometry, but with much darker exposed-soil ruts.
      float wheelPath = exp(-pow((ax-0.24)/0.075,2.0));
      float wearBreak=.52+.48*smoothstep(.30,.67,vnoise(P*vec2(.16,1.4)+63.0));
      wheelPath*=mix(1.0,wearBreak,trackMode);
      albedo *= 1.0 - wheelPath * mix(0.20,0.28,trackMode);
      float rut = wheelPath;
      rut *= 0.7 + 0.3*vnoise(P*vec2(0.5,2.5));
      albedo = mix(albedo, albedo*vec3(0.82,0.80,0.74), rut*trackMode);
      // grassy crown down the centre between the ruts, patchy
      float crownVariation=.72+.18*(vnoise(P*.31+37.0)-.5)+
        .10*(vnoise(P*1.27+11.0)-.5);
      float crown=(1.0-smoothstep(.075,.205,ax))*crownVariation;
      albedo=mix(albedo,vec3(.235,.285,.115),crown*.68*near*trackMode);
      // Encroachment breaks the outer two-track edges without changing its exact drive surface.
      float encroach = smoothstep(0.32,0.48,ax)*smoothstep(0.46,0.70,vnoise(P*2.1+17.0));
      albedo = mix(albedo,vec3(0.25,0.32,0.13),encroach*0.62*near*trackMode);
      float reclaimed=smoothstep(.31,.49,ax)*trackMode;
      vec3 trackVerge=mix(vec3(.30,.32,.16),vec3(.39,.34,.23),vnoise(P*1.35+81.0));
      albedo=mix(albedo,trackVerge,reclaimed*(.38+.38*vnoise(P*3.1+53.0))*near);
      // Dry loose aggregate accumulates outside the compacted gravel wheel paths, while a
      // restrained crown keeps the cross-section readable without turning it into asphalt.
      float gravelShoulder=smoothstep(.34,.58,ax)*(1.0-trackMode);
      vec3 looseGravel=mix(gravelPhoto*vec3(1.10,1.07,1.00),vec3(.49,.43,.32),
        vnoise(P*2.7+vec2(83.0,29.0)));
      albedo=mix(albedo,looseGravel,gravelShoulder*(.30+.22*vnoise(P*5.3+17.0))*near);
      float gravelReclaim=smoothstep(.39,.61,ax)*(1.0-trackMode)*
        (.18+.40*vnoise(P*vec2(.64,1.83)+vec2(23.0,89.0)))*near;
      vec3 gravelVerge=mix(vec3(.37,.34,.20),vec3(.24,.31,.13),
        vnoise(P*.91+vec2(67.0,31.0)));
      albedo=mix(albedo,gravelVerge,gravelReclaim);
      float gravelCrown=(1.0-smoothstep(.05,.21,ax))*(1.0-trackMode);
      albedo*=1.0+gravelCrown*.055*near;

      // shoulder band: darker, slightly greener verge toward the terrain
      albedo = mix(albedo, albedo*vec3(0.80,0.86,0.74), smoothstep(0.0, 0.6, -edgeM));
      gl_FragColor = vec4(shadeSurface(albedo, nrm, vWorld, 0.0, gloss), 1.0);
    }`;

  /* ---------------- small geometry helpers (module-local, no THREE allocs) ---------------- */

  const dist2d = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const featureSeed = value => {
    const text = String(value || 'track'); let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0) / 4294967296;
  };
  const organicWave = (s, seed, phase = 0) =>
    Math.sin(s * .073 + seed * 37.1 + phase) * .52 +
    Math.sin(s * .181 + seed * 19.7 + phase * 1.71) * .31 +
    Math.sin(s * .417 + seed * 11.3 - phase * .63) * .17;

  /* centripetal Catmull-Rom (Barry–Goldman) point on segment p1→p2 at local t in [0,1] */
  function crPoint(p0, p1, p2, p3, t, out) {
    const a = 0.5;
    const t0 = 0;
    const t1 = t0 + Math.max(Math.pow(dist2d(p0, p1), a), 1e-4);
    const t2 = t1 + Math.max(Math.pow(dist2d(p1, p2), a), 1e-4);
    const t3 = t2 + Math.max(Math.pow(dist2d(p2, p3), a), 1e-4);
    const tt = t1 + (t2 - t1) * t;
    const lp = (pa, pb, ta, tb) => {
      const w = (tt - ta) / (tb - ta);
      return [pa[0] + (pb[0] - pa[0]) * w, pa[1] + (pb[1] - pa[1]) * w];
    };
    const A1 = lp(p0, p1, t0, t1), A2 = lp(p1, p2, t1, t2), A3 = lp(p2, p3, t2, t3);
    const B1 = lp(A1, A2, t0, t2), B2 = lp(A2, A3, t1, t3);
    const C = lp(B1, B2, t1, t2);
    out[0] = C[0]; out[1] = C[1];
    return out;
  }

  /* circumradius of the triangle a,b,c (Infinity when collinear) */
  function circumR(a, b, c) {
    const abx = b[0] - a[0], abz = b[1] - a[1];
    const acx = c[0] - a[0], acz = c[1] - a[1];
    const area2 = Math.abs(abx * acz - abz * acx);
    if (area2 < 1e-6) return Infinity;
    const la = Math.hypot(abx, abz), lb = dist2d(b, c), lc = Math.hypot(acx, acz);
    return (la * lb * lc) / (2 * area2);
  }

  /* arc-length moving average, window `win` metres, non-uniform sample spacing `s` (cumulative) */
  function movAvgArc(v, s, win) {
    const n = v.length, out = new Float64Array(n), h = win * 0.5;
    let a = 0, b = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      while (b < n && s[b] <= s[i] + h) { sum += v[b]; b++; }
      while (s[a] < s[i] - h) { sum -= v[a]; a++; }
      out[i] = sum / (b - a);
    }
    return out;
  }

  class RoadRibbon {
    constructor(o) {
      this.scene = o.scene;
      this.camera = o.camera || null;
      this.sampleGround = o.sampleGround ||
        (o.terrain ? (x, z) => o.terrain.heightAt(x, z) : null);
      this.terrain = o.terrain || null;
      // BRIDGES (M6): a clearance FLOOR (waterY+freeboard) fed by BridgeBuilder over detected water
      // crossings — NOT a separate deck datum. The grading samplers below take max(ground, floor) so
      // the ONE graded profile arcs up to clear the water and ties into both banks; the deck mesh and
      // the physics then read that same profile via drivableSurfaceAt(). One surface, read everywhere.
      this._bridgeFloor = o.bridgeFloor || null;
      this._bridgeGrid = new Map();   // CELL-hashed bridge-section segments for drivableSurfaceAt()
      this._gFloored = null;          // cached floored build sampler
      this.roadsUrl = o.roadsUrl || 'terrain/public/roads.json';
      const CU = global.CLOUD_UNIFORMS = global.CLOUD_UNIFORMS ||
        { uCloudTime: { value: 0 }, uCloudAmt: { value: 0 } };
      // real-cast-shadow uniforms (create-or-adopt; 20-scene is the producer)
      const SH = global.SHADOW_UNIFORMS = global.SHADOW_UNIFORMS ||
        { uShadowMap: { value: null }, uShadowMtx: { value: new THREE.Matrix4() },
          uShadowOn: { value: 0 } };
      // terrain-aware headlight uniforms (create-or-adopt; 82-drive is the producer). Same objects
      // the terrain tiles adopt, so beams light the asphalt with the identical cone model.
      const HL = global.HEADLIGHT_UNIFORMS = global.HEADLIGHT_UNIFORMS ||
        { uHLPos:   { value: [new THREE.Vector3(1e6, 1e6, 1e6), new THREE.Vector3(1e6, 1e6, 1e6)] },
          uHLDir:   { value: [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, -1)] },
          uHLColor: { value: new THREE.Color(1.0, 0.92, 0.76) },
          uHLParams:{ value: new THREE.Vector4(0.974, 0.866, 40.0, 0.0) } };
      const fog = o.fog || { color: new THREE.Color(0.8, 0.8, 0.85), near: 1200, far: 9000 };
      const trackAlbedo = new THREE.TextureLoader().load(
        'terrain/public/materials/transport/dry-two-track-albedo.webp');
      trackAlbedo.wrapS = trackAlbedo.wrapT = THREE.RepeatWrapping;
      trackAlbedo.colorSpace = THREE.SRGBColorSpace;
      trackAlbedo.anisotropy = 8;
      const common = () => ({
        uSun: { value: o.sun || new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: o.sunColor || new THREE.Color(1, 0.94, 0.84) },
        uAmb: { value: o.ambient || new THREE.Color(0.78, 0.86, 1.0) },
        uFogColor: { value: fog.color },
        uFogNear: { value: fog.near }, uFogFar: { value: fog.far },
        uCloudTime: CU.uCloudTime, uCloudAmt: CU.uCloudAmt,
        uShadowMap: SH.uShadowMap, uShadowMtx: SH.uShadowMtx, uShadowOn: SH.uShadowOn,
        uHLPos: HL.uHLPos, uHLDir: HL.uHLDir, uHLColor: HL.uHLColor, uHLParams: HL.uHLParams,
      });
      // one material per class: distinct polygonOffset layer per hierarchy rank so residual
      // overlap (e.g. a gravel edge under a highway) resolves deterministically, never z-fights
      this.materials = {};
      ORDER.forEach((cls, i) => {
        const uniforms = common();
        uniforms.uMarkingMode = { value: cls === 'highway' ? 2 : cls === 'park_paved' ? 1 : 0 };
        uniforms.uSurfaceMode = { value: cls === 'track' ? 1 : 0 };
        uniforms.uTrackAlbedo = { value: trackAlbedo };
        this.materials[cls] = new THREE.ShaderMaterial({
          uniforms, vertexShader: VERT,
          fragmentShader: CLS[cls].paved ? FRAG_PAVED : FRAG_GRAVEL,
          fog: false, side: THREE.DoubleSide,
          polygonOffset: true, polygonOffsetFactor: -(i + 1), polygonOffsetUnits: -(i + 1),
        });
      });
      this.group = new THREE.Group();
      this.group.name = 'transportRoads';
      this.scene.add(this.group);
      this.meshes = {};             // class -> THREE.Mesh
      this.renderCells = {};        // class -> batched {meshes, records} over the shared attrs
      this.stats = { tris: 0, drawCalls: 0 };
      this._ways = [];              // per-run grading records {cls,v0,n,nA,nB,bb}
      this._fans = [];              // junction polygons {cls,v0,count,nx,nz}
      this._nodes = [];             // shared junction points [{x,z}]
      // lazy re-drape state (see update())
      this._zBase = null;
      this._maxZoom = null;
      this._drapedSig = -1;
      this._frame = 0;
      this._pass = null;
      this._bridgeSegs = [];        // {ax,az,ay,at, bx,bz,by,bt, hw} — recorded during _buildRun
      this._detailRecords = [];      // deterministic near-field stones, pooled by TrailBuilder
    }

    /* wrap a height sampler so it never returns below the bridge clearance floor (null off-bridge).
       This is the ONLY way the bridge influences the surface — a constraint on the one grade, not a
       second elevation. */
    _floor(fn) {
      const bf = this._bridgeFloor;
      if (!bf) return fn;
      return (x, z) => { const g = fn(x, z), f = bf(x, z); return (f !== null && f > g) ? f : g; };
    }

    /* AUTHORITATIVE running-surface query for BRIDGE SECTIONS ONLY (null everywhere else). Returns
       the graded profile height PRE-LIFT — the exact analog of raw DEM under a normal road — so
       physics (sampleGround + the drive's existing +ROAD_LIFT) seats the car on the deck, and the
       deck mesh reads (this + LIFT). Frozen at build: the re-drape still floors the geometry so the
       asphalt never sinks, but water is flat so the profile barely moves; keeping the index static
       avoids threading updates through the amortized re-drape. See BridgeBuilder. */
    drivableSurfaceAt(x, z) {
      if (!this._bridgeGrid.size) return null;
      const cx = Math.floor(x / BR_CELL), cz = Math.floor(z / BR_CELL);
      let bestY = null, bd = Infinity;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const arr = this._bridgeGrid.get((cx + di) + ',' + (cz + dj)); if (!arr) continue;
        for (const s of arr) {
          const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz;
          let t = l2 > 0 ? ((x - s.ax) * dx + (z - s.az) * dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = s.ax + t * dx, pz = s.az + t * dz, dd = Math.hypot(x - px, z - pz);
          if (dd <= s.hw + BR_PAD && dd < bd) {
            bd = dd;
            const y = s.ay + (s.by - s.ay) * t, tilt = s.at + (s.bt - s.at) * t;
            // signed perpendicular offset (right of travel = +) so the cross-tilt reads correctly
            const nl = Math.sqrt(l2) || 1, perp = ((x - px) * (dz / nl) - (z - pz) * (dx / nl));
            bestY = y + tilt * (s.hw > 0 ? perp / s.hw : 0);
          }
        }
      }
      return bestY;
    }

    /* index the bridge-section segments accumulated during _buildRun into the query grid */
    _indexBridge() {
      this._bridgeGrid.clear();
      for (const s of this._bridgeSegs) {
        const steps = Math.max(1, Math.ceil(Math.hypot(s.bx - s.ax, s.bz - s.az) / BR_CELL));
        let last = null;
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const key = Math.floor((s.ax + (s.bx - s.ax) * t) / BR_CELL) + ',' +
                      Math.floor((s.az + (s.bz - s.az) * t) / BR_CELL);
          if (key === last) continue; last = key;
          let arr = this._bridgeGrid.get(key); if (!arr) { arr = []; this._bridgeGrid.set(key, arr); }
          arr.push(s);
        }
      }
      if (this._bridgeSegs.length)
        console.info('[RoadRibbon] bridge surface:', this._bridgeSegs.length, 'sections published');
    }

    async build() {
      let list;
      try {
        const res = await fetch(this.roadsUrl);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        list = await res.json();
      } catch (e) {
        console.info('[RoadRibbon] roads.json unavailable — skipping ribbons.', e && e.message || e);
        return this;
      }
      if (!this.sampleGround) { console.info('[RoadRibbon] no ground sampler — skipping.'); return this; }

      // 1) spline-fit + resample + turning-radius relaxation, per way
      const ways = [];
      for (const f of list) {
        const baseCfg = CLS[f.class] || CLS.track;
        const taggedWidth = Number.parseFloat(f.width || (f.tags && f.tags.width));
        const laneWidth = Number.parseInt(f.tags && f.tags.lanes, 10) * 3.35;
        const credibleWidth = taggedWidth >= 2 && taggedWidth <= 16 ? taggedWidth :
          laneWidth >= 3 && laneWidth <= 16 ? laneWidth : baseCfg.w;
        const cfg = credibleWidth === baseCfg.w ? baseCfg : { ...baseCfg, w: credibleWidth };
        const pts = this._spline(f.pts, cfg);
        if (pts) ways.push({ cls: f.class in CLS ? f.class : 'track', cfg, pts,
          featureId: f.id || null, name: f.name || null, tags: f.tags || null });
      }

      // 2) drop duplicate / sub-metre-offset twin carriageways (the Moose double-slab)
      this._dedup(ways);

      // 3) hierarchy trim: lower rank cut back to higher rank's edge (+TRIM_PAD) → runs
      const runs = this._trim(ways);

      // 4) junction nodes from run endpoints (height blending + topology polygons)
      const nodeInfo = this._collectNodes(runs);

      // 5) grade + decimate + extrude every run into its class bucket
      const buckets = {};
      ORDER.forEach(c => buckets[c] = { pos: [], uv: [], wid: [], mark: [], idx: [], base: 0 });
      for (const r of runs) this._buildRun(r, buckets[r.cls], nodeInfo);
      this._buildFans(nodeInfo, buckets);
      this._indexBridge();   // publish drivableSurfaceAt over the bridge sections just recorded

      // 6) authoritative geometry plus independently-cullable spatial views.  All views share
      // the position/normal/uv buffers, so lazy re-drape remains one atomic source of truth.
      let tris = 0, calls = 0;
      ORDER.forEach((cls, i) => {
        const mesh = this._toMesh(buckets[cls], this.materials[cls]);
        if (!mesh) return;
        this.meshes[cls] = mesh;
        const batch = this._toRenderCells(mesh.geometry, this.materials[cls], 1 + i, cls);
        this.renderCells[cls] = batch;
        for (const m of batch.meshes) if (m) this.group.add(m);
        tris += buckets[cls].idx.length / 3; calls++;
      });
      // cells are still independently culled and LOD-switched; they are now submitted as merged
      // index runs on one mesh per level rather than one THREE.LOD node each
      const cellCount = Object.values(this.renderCells)
        .reduce((n, b) => n + (b ? b.records.length : 0), 0);
      const meshCount = Object.values(this.renderCells)
        .reduce((n, b) => n + (b ? b.meshes.filter(Boolean).length : 0), 0);
      calls = meshCount;
      this.stats = { tris, drawCalls: calls, cells: cellCount, lods: 3 };
      console.info('[RoadRibbon] built', this._ways.length, 'runs,', this._fans.length,
        'junction polygons,', tris, 'tris,', calls, 'draw calls');
      return this;
    }

    /* ---------------- 1) splines ---------------- */

    /* clean → centripetal Catmull-Rom resample at ~SEG_LEN → min-turning-radius relaxation */
    _spline(raw, cfg) {
      if (!raw || raw.length < 2) return null;
      const clean = [raw[0]];
      for (let i = 1; i < raw.length; i++)
        if (dist2d(raw[i], clean[clean.length - 1]) >= 0.5) clean.push(raw[i]);
      if (clean.length < 2) return null;
      const out = [];
      const tmp = [0, 0];
      const n = clean.length;
      for (let i = 0; i + 1 < n; i++) {
        const p1 = clean[i], p2 = clean[i + 1];
        // reflected ghost points at the ends keep the centripetal knots non-degenerate
        const p0 = i > 0 ? clean[i - 1] : [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]];
        const p3 = i + 2 < n ? clean[i + 2] : [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]];
        const spacing = cfg.paved ? 3.0 : SEG_LEN;
        const segs = Math.max(1, Math.ceil(dist2d(p1, p2) / spacing));
        for (let s = 0; s < segs; s++) {
          crPoint(p0, p1, p2, p3, s / segs, tmp);
          out.push([tmp[0], tmp[1]]);
        }
      }
      out.push([clean[n - 1][0], clean[n - 1][1]]);
      // relaxation: pull any vertex whose local circumradius < minR toward its neighbours' mid
      for (let it = 0; it < 30; it++) {
        let moved = false;
        for (let i = 1; i + 1 < out.length; i++) {
          if (circumR(out[i - 1], out[i], out[i + 1]) >= cfg.minR) continue;
          const mx = (out[i - 1][0] + out[i + 1][0]) * 0.5;
          const mz = (out[i - 1][1] + out[i + 1][1]) * 0.5;
          out[i][0] += (mx - out[i][0]) * 0.5;
          out[i][1] += (mz - out[i][1]) * 0.5;
          moved = true;
        }
        if (!moved) break;
      }
      return out.length >= 2 ? out : null;
    }

    /* ---------------- 2) dedup twin carriageways ---------------- */

    _dedup(ways) {
      const len = w => { let l = 0; for (let i = 0; i + 1 < w.pts.length; i++) l += dist2d(w.pts[i], w.pts[i + 1]); return l; };
      const L = ways.map(len);
      // straightness = max deviation of a way from its own end-to-end chord. The SURVIVOR of a
      // twin pair is the straighter way: drive mode's roadQuery snaps the car to the raw
      // centerlines, and the straight alignment is the one the duplicates were traced around.
      const dev = ways.map(w => {
        const a = w.pts[0], b = w.pts[w.pts.length - 1];
        const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
        if (l < 1) return 1e9;                      // closed loop — never the survivor
        let worst = 0;
        for (const p of w.pts) {
          const d = Math.abs((dx * (p[1] - a[1]) - dz * (p[0] - a[0])) / l);
          if (d > worst) worst = d;
        }
        return worst;
      });
      // candidate pairs: same class, both endpoint pairs within 20 m (either orientation)
      for (let i = 0; i < ways.length; i++) {
        const A = ways[i]; if (A.dead) continue;
        for (let j = i + 1; j < ways.length; j++) {
          const B = ways[j]; if (B.dead || B.cls !== A.cls) continue;
          const a0 = A.pts[0], a1 = A.pts[A.pts.length - 1];
          const b0 = B.pts[0], b1 = B.pts[B.pts.length - 1];
          // cheap reject before the hypots: a0 must sit within 20 m of one of B's ends
          if (Math.min(Math.abs(a0[0] - b0[0]), Math.abs(a0[0] - b1[0])) > 20) continue;
          const e = Math.min(Math.max(dist2d(a0, b0), dist2d(a1, b1)),
                             Math.max(dist2d(a0, b1), dist2d(a1, b0)));
          if (e > 20) continue;
          // shorter way must hug the longer one along its whole length. Twin carriageways are
          // mapped up to ~11 m apart mid-way (TPR at Moose bulges 9.4 m with IDENTICAL ends),
          // while genuine loop halves sharing endpoints deviate far more relative to length —
          // so the hug tolerance scales with length; identical-end pairs get a higher cap.
          const tol = Math.max(3, Math.min(e < 2 ? 14 : 10, 0.08 * Math.min(L[i], L[j])));
          const hugs = (S, G) => {     // does every sampled point of S sit within tol of G?
            for (let k = 0; k < S.pts.length; k += 3) {
              const p = S.pts[k];
              let best = Infinity;
              for (let m = 0; m + 1 < G.pts.length; m++) {
                const q = G.pts[m], r = G.pts[m + 1];
                const dx = r[0] - q[0], dz = r[1] - q[1], l2 = dx * dx + dz * dz;
                let t = l2 > 0 ? ((p[0] - q[0]) * dx + (p[1] - q[1]) * dz) / l2 : 0;
                t = t < 0 ? 0 : t > 1 ? 1 : t;
                const d = Math.hypot(p[0] - (q[0] + t * dx), p[1] - (q[1] + t * dz));
                if (d < best) best = d;
              }
              if (best > tol) return false;
            }
            return true;
          };
          // preferred survivor = straighter way (drive's roadQuery snaps to raw centerlines and
          // the straight alignment is the traced-around one); but a victim that overhangs the
          // survivor cannot be dropped without a hole, so fall back to longest-survivor then.
          const aWins = dev[i] < dev[j] || (dev[i] === dev[j] && L[i] >= L[j]);
          let [S, G] = aWins ? [B, A] : [A, B];
          if (!hugs(S, G)) [S, G] = L[i] >= L[j] ? [B, A] : [A, B];
          if (S !== G && hugs(S, G)) S.dead = true;   // duplicate carriageway — drop it
        }
      }
      let dropped = 0;
      for (let i = ways.length - 1; i >= 0; i--) if (ways[i].dead) { ways.splice(i, 1); L.splice(i, 1); dropped++; }
      if (dropped) console.info('[RoadRibbon] deduped', dropped, 'twin carriageway way(s)');
    }

    /* ---------------- 3) hierarchy trim ---------------- */

    _trim(ways) {
      const CELL = 24;
      const grids = { 1: new Map(), 2: new Map() };  // per-rank segment grids (rank 0 never cuts)
      const markingMouths = [];                       // lower-class approaches at priority-road edges
      const addSeg = (grid, ax, az, bx, bz, cut) => {
        const seg = { ax, az, bx, bz, cut };
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / CELL));
        let lastKey = null;
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const key = Math.floor((ax + (bx - ax) * t) / CELL) + ',' +
                      Math.floor((az + (bz - az) * t) / CELL);
          if (key === lastKey) continue;
          lastKey = key;
          let arr = grid.get(key); if (!arr) { arr = []; grid.set(key, arr); }
          if (arr[arr.length - 1] !== seg) arr.push(seg);
        }
      };
      // signed clearance of (x,z) to the nearest HIGHER-rank edge (+pad); >=0 means keep
      const clearance = (x, z, rank) => {
        let best = Infinity;
        const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
        for (let r = rank + 1; r <= 2; r++) {
          const grid = grids[r]; if (!grid || !grid.size) continue;
          for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
            const arr = grid.get((cx + i) + ',' + (cz + j));
            if (!arr) continue;
            for (const s of arr) {
              const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz;
              let t = l2 > 0 ? ((x - s.ax) * dx + (z - s.az) * dz) / l2 : 0;
              t = t < 0 ? 0 : t > 1 ? 1 : t;
              const d = Math.hypot(x - (s.ax + t * dx), z - (s.az + t * dz)) - s.cut;
              if (d < best) best = d;
            }
          }
        }
        return best;
      };

      // register higher-rank centerlines first (they are never cut by lower ones)
      for (const w of ways) {
        if (w.cfg.rank === 0) continue;
        const cut = w.cfg.w * 0.5 + TRIM_PAD, grid = grids[w.cfg.rank];
        for (let i = 0; i + 1 < w.pts.length; i++)
          addSeg(grid, w.pts[i][0], w.pts[i][1], w.pts[i + 1][0], w.pts[i + 1][1], cut);
      }

      const runs = [];
      for (const w of ways) {
        if (w.cfg.rank === 2) { runs.push({ cls:w.cls,cfg:w.cfg,pts:w.pts,
          featureId:w.featureId,name:w.name,tags:w.tags }); continue; }
        const pts = w.pts, d = pts.map(p => clearance(p[0], p[1], w.cfg.rank));
        let cur = [];
        const flush = () => {
          if (cur.length >= 2) {
            let l = 0; for (let i = 0; i + 1 < cur.length; i++) l += dist2d(cur[i], cur[i + 1]);
            if (l >= MIN_RUN) runs.push({ cls: w.cls, cfg: w.cfg, pts: cur,
              featureId:w.featureId,name:w.name,tags:w.tags });
          }
          cur = [];
        };
        for (let i = 0; i < pts.length; i++) {
          const inKeep = d[i] >= 0;
          if (i > 0 && (d[i] >= 0) !== (d[i - 1] >= 0)) {   // lerp the exact edge crossing
            const t = d[i - 1] / (d[i - 1] - d[i]);
            const bx = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t;
            const bz = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
            markingMouths.push([bx, bz]);
            if (inKeep) cur.push([bx, bz]);       // entering keep-zone: run starts at the edge
            else { cur.push([bx, bz]); flush(); } // leaving: run ends exactly at edge+pad
          }
          if (inKeep) cur.push(pts[i]);
        }
        flush();
      }
      // A tiny spatial mask lets the priority strip keep its centreline through a junction while
      // clipping only the edge paint across each lower-class mouth.  It is derived from the same
      // exact trim crossings, so markings cannot drift away from the rendered approach geometry.
      this._markMouthGrid = new Map();
      const MARK_CELL = 16;
      for (const p of markingMouths) {
        const key = Math.floor(p[0] / MARK_CELL) + ',' + Math.floor(p[1] / MARK_CELL);
        let a = this._markMouthGrid.get(key);
        if (!a) { a = []; this._markMouthGrid.set(key, a); }
        a.push(p);
      }
      return runs;
    }

    _markAuthority(x, z) {
      const grid = this._markMouthGrid;
      if (!grid || !grid.size) return 1;
      const CELL = 16, cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      let best = Infinity;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const a = grid.get((cx + dx) + ',' + (cz + dz));
        if (!a) continue;
        for (const p of a) best = Math.min(best, Math.hypot(x - p[0], z - p[1]));
      }
      return Math.min(1, Math.max(0, (best - 1.1) / 2.4));
    }

    /* ---------------- 4) junction nodes + topology polygons ---------------- */

    _collectNodes(runs) {
      const Q = 0.75, map = new Map(), nodes = [];
      const key = p => Math.round(p[0] / Q) + ',' + Math.round(p[1] / Q);
      const at = p => {
        const k = key(p);
        let n = map.get(k);
        if (!n) { n = { x: p[0], z: p[1], members: [], idx: nodes.length }; map.set(k, n); nodes.push(n); }
        return n;
      };
      for (const r of runs) {
        const p0 = r.pts[0], p1 = r.pts[r.pts.length - 1];
        // heading INTO the node at each end
        const h0 = [p0[0] - r.pts[1][0], p0[1] - r.pts[1][1]];
        const h1 = [p1[0] - r.pts[r.pts.length - 2][0], p1[1] - r.pts[r.pts.length - 2][1]];
        const nA = at(p0), nB = at(p1);
        nA.members.push({ run: r, hdg: h0, cfg: r.cfg, cls: r.cls });
        nB.members.push({ run: r, hdg: h1, cfg: r.cfg, cls: r.cls });
        r.nA = nA.idx; r.nB = nB.idx;
      }
      // decide which nodes blend heights / get a fan
      for (const n of nodes) {
        n.blend = n.members.length >= 2;
        n.fan = null;
        if (n.members.length < 2) continue;
        const ranks = n.members.map(m => m.cfg.rank);
        const sameRank = Math.max(...ranks) === Math.min(...ranks);
        if (!sameRank) continue;                 // cross-rank joints are handled by trimming
        let want = n.members.length >= 3;
        if (!want && n.members.length === 2) {
          const a = n.members[0].hdg, b = n.members[1].hdg;
          const la = Math.hypot(a[0], a[1]) || 1, lb = Math.hypot(b[0], b[1]) || 1;
          // straight-through chain ⇒ in-headings are opposite; deviation from 180° > 25° ⇒ fan
          const cos = -(a[0] * b[0] + a[1] * b[1]) / (la * lb);
          want = cos < Math.cos(25 * Math.PI / 180);
          // differing widths always need a fillet to hide the butt step
          if (n.members[0].cfg.w !== n.members[1].cfg.w) want = true;
        }
        if (want) {
          let best = n.members[0].cls;
          for (const m of n.members)
            if (ORDER.indexOf(m.cls) > ORDER.indexOf(best)) best = m.cls;
          n.fan = { cls: best, outline: this._junctionOutline(n) };
        }
      }
      this._nodes = nodes.map(n => ({ x: n.x, z: n.z, blend: n.blend }));
      return nodes;
    }

    /* Build the central pavement from the mouths which actually meet the node. Each mouth
       contributes its two carriageway corners. Adjacent edge rays also contribute their
       intersection when it is local to the node; this produces the familiar squared/filleted
       envelope at a T, cross, or bend without painting a full disc into unused terrain.
       The convex hull is intentional: all members share one at-grade topology node, and a convex
       central slab cannot self-intersect even for noisy OSM headings. */
    _junctionOutline(node) {
      const mouths = node.members.map(m => {
        const len = Math.hypot(m.hdg[0], m.hdg[1]) || 1;
        const hx = m.hdg[0] / len, hz = m.hdg[1] / len;
        return { hx, hz, lx: -hz, lz: hx, hw: m.cfg.w * 0.5 + 0.04,
          angle: Math.atan2(hz, hx) };
      }).sort((a, b) => a.angle - b.angle);
      const pts = [];
      for (const m of mouths) {
        pts.push([node.x + m.lx * m.hw, node.z + m.lz * m.hw]);
        pts.push([node.x - m.lx * m.hw, node.z - m.lz * m.hw]);
      }
      for (let i = 0; i < mouths.length; i++) {
        const a = mouths[i], c = mouths[(i + 1) % mouths.length];
        // CCW sector: a's left edge meets c's right edge.
        const ax = node.x + a.lx * a.hw, az = node.z + a.lz * a.hw;
        const cx = node.x - c.lx * c.hw, cz = node.z - c.lz * c.hw;
        const det = a.hx * c.hz - a.hz * c.hx;
        if (Math.abs(det) < 1e-4) continue;
        const dx = cx - ax, dz = cz - az;
        const ta = (dx * c.hz - dz * c.hx) / det;
        const tc = (dx * a.hz - dz * a.hx) / det;
        const limit = Math.max(a.hw, c.hw) * 3.0;
        if (ta >= -0.1 && tc >= -0.1 && ta <= limit && tc <= limit)
          pts.push([ax + a.hx * ta, az + a.hz * ta]);
      }
      pts.sort((a, b) => a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]);
      const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) -
        (a[1] - o[1]) * (b[0] - o[0]);
      const hull = [];
      for (const p of pts) {
        while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 1e-5)
          hull.pop();
        hull.push(p);
      }
      const lower = hull.length;
      for (let i = pts.length - 2; i >= 0; i--) {
        const p = pts[i];
        while (hull.length > lower && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 1e-5)
          hull.pop();
        hull.push(p);
      }
      hull.pop();
      return hull;
    }

    /* ---------------- 5) grading + decimation + extrusion ---------------- */

    /* shared grading core (used at build AND every re-drape): smoothed longitudinal profile +
       clamped smoothed cross-tilt + node-height easing + anti-burial raise. All heights pre-LIFT. */
    _grade(cfg, s, gC, gL, gR, hA, hB) {
      const n = gC.length;
      const prof = movAvgArc(gC, s, cfg.win);
      const mt = MAX_TILT * cfg.w * 0.5;
      const tRaw = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const t = (gR[i] - gL[i]) * 0.5;
        tRaw[i] = t < -mt ? -mt : t > mt ? mt : t;
      }
      const tilt = movAvgArc(tRaw, s, cfg.win * 0.5);
      const total = s[n - 1];
      const ease = w => w * w * (3 - 2 * w);
      if (hA !== null) {
        const L = Math.min(NODE_BLEND, total * 0.5) || 1;
        for (let i = 0; i < n && s[i] < L; i++) {
          const w = ease(1 - s[i] / L);
          prof[i] += (hA - prof[i]) * w; tilt[i] *= 1 - w;
        }
      }
      if (hB !== null) {
        const L = Math.min(NODE_BLEND, total * 0.5) || 1;
        for (let i = n - 1; i >= 0 && total - s[i] < L; i--) {
          const w = ease(1 - (total - s[i]) / L);
          prof[i] += (hB - prof[i]) * w; tilt[i] *= 1 - w;
        }
      }
      // never let terrain poke through the slab: raise by the local (moving-max) deficit
      const def = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const d = Math.max(gC[i] - prof[i], gL[i] - (prof[i] - tilt[i]), gR[i] - (prof[i] + tilt[i]), 0);
        def[i] = d;
      }
      for (let i = 0; i < n; i++)
        prof[i] += Math.max(def[i], i > 0 ? def[i - 1] : 0, i + 1 < n ? def[i + 1] : 0);
      return { prof, tilt };
    }

    /* shoulder outer-edge height: ON the real terrain, small lift, paved gets a slight ditch
       dip where the verge is roughly level with the slab (the dip vanishes on real side slopes) */
    _shoulderY(cfg, gOut, edgeY) {
      let y = gOut + SH_LIFT;
      if (cfg.paved) y -= DITCH * Math.max(0, 1 - Math.abs(gOut - edgeY) / 0.7);
      return y;
    }

    /* Class-specific authoritative cross-sections, ordered left-to-right. Lateral is positive
       to the left of travel. Roles drive both rendered relief and re-drape; physics publishes
       these same vertices through TransportSurface.addStrip. */
    _sectionLayout(cls, cfg) {
      const h = cfg.w * .5;
      if (cfg.paved) return [
        { lateral:h+cfg.sh+1.25, role:'ditch' }, { lateral:h+cfg.sh, role:'shoulder' },
        { lateral:h, role:'edge' }, { lateral:0, role:'crown' },
        { lateral:-h, role:'edge' }, { lateral:-h-cfg.sh, role:'shoulder' },
        { lateral:-h-cfg.sh-1.25, role:'ditch' },
      ];
      if (cls === 'gravel') return [
        { lateral:h+cfg.sh, role:'verge' }, { lateral:h, role:'edge' },
        { lateral:h*.52, role:'wheelPath' }, { lateral:0, role:'crown' },
        { lateral:-h*.52, role:'wheelPath' }, { lateral:-h, role:'edge' },
        { lateral:-h-cfg.sh, role:'verge' },
      ];
      return [
        { lateral:h, role:'trackEdge' }, { lateral:h*.48, role:'rut' },
        { lateral:0, role:'trackCrown' }, { lateral:-h*.48, role:'rut' },
        { lateral:-h, role:'trackEdge' },
      ];
    }

    _sectionY(cfg, section, prof, tilt, ground) {
      const half = cfg.w * .5 || 1;
      const slab = prof - tilt * (section.lateral / half) + LIFT;
      switch (section.role) {
        case 'crown': return slab + .055;
        case 'wheelPath': return slab - .025;
        // Vehicle tracks follow the actual landscape. The shallow raised crown and depressed
        // ruts are relative to the locally sampled terrain, not a 25 cm graded road slab.
        case 'trackCrown': return ground + .100;
        case 'rut': return ground + .070;
        case 'shoulder': return ground + SH_LIFT;
        case 'ditch': return ground + SH_LIFT - DITCH;
        case 'verge': return ground + SH_LIFT;
        case 'trackEdge': return ground + .012;
        default: return slab;
      }
    }

    _buildRun(run, b, nodes) {
      const cfg = run.cfg, pts = run.pts, n = pts.length, half = cfg.w * 0.5;
      const g = (this._gFloored || (this._gFloored = this._floor(this.sampleGround)));  // bridge floor folds in
      // mitred cross-section frames at every spline sample
      const dir = [];
      for (let i = 0; i + 1 < n; i++) {
        const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1];
        const l = Math.hypot(dx, dz) || 1; dir.push([dx / l, dz / l]);
      }
      const mx = new Float64Array(n), mz = new Float64Array(n), s = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const dP = dir[i - 1] || dir[i], dN = dir[i] || dir[i - 1];
        const pP = [-dP[1], dP[0]], pN = [-dN[1], dN[0]];
        let x = pP[0] + pN[0], z = pP[1] + pN[1];
        const l = Math.hypot(x, z) || 1; x /= l; z /= l;
        let sc = 1 / Math.max(x * pN[0] + z * pN[1], 0.4);
        sc = Math.min(sc, 2.5);
        mx[i] = x * sc; mz[i] = z * sc;
        if (i > 0) s[i] = s[i - 1] + dist2d(pts[i - 1], pts[i]);
      }
      // Terrain samples along the run and every authored cross-section vertex.
      const layout = this._sectionLayout(run.cls, cfg), stride = layout.length;
      const gC = new Float64Array(n), gL = new Float64Array(n), gR = new Float64Array(n);
      const groundBySection = layout.map(() => new Float64Array(n));
      const ow = Math.max(...layout.map(section => Math.abs(section.lateral)));
      for (let i = 0; i < n; i++) {
        gC[i] = g(pts[i][0], pts[i][1]);
        gL[i] = g(pts[i][0] + mx[i] * half, pts[i][1] + mz[i] * half);
        gR[i] = g(pts[i][0] - mx[i] * half, pts[i][1] - mz[i] * half);
        for (let q = 0; q < stride; q++) {
          const lateral = layout[q].lateral;
          groundBySection[q][i] = g(pts[i][0] + mx[i] * lateral, pts[i][1] + mz[i] * lateral);
        }
      }
      const hA = nodes[run.nA] && nodes[run.nA].blend ? g(nodes[run.nA].x, nodes[run.nA].z) : null;
      const hB = nodes[run.nB] && nodes[run.nB].blend ? g(nodes[run.nB].x, nodes[run.nB].z) : null;
      const { prof, tilt } = this._grade(cfg, s, gC, gL, gR, hA, hB);

      // decimate straight, vertically-quiet spans (greedy; every kept index keeps its frame)
      const keep = [0];
      const sinTol = Math.sin(cfg.hdgTol * Math.PI / 180);
      let i0 = 0;
      while (i0 + 1 < n) {
        let j = i0 + 1;
        for (let jj = i0 + 2; jj < n; jj++) {
          if (s[jj] - s[i0] > cfg.maxRun) break;
          const cx = pts[jj][0] - pts[i0][0], cz = pts[jj][1] - pts[i0][1];
          const cl = Math.hypot(cx, cz) || 1;
          let ok = true;
          for (let k = i0 + 1; k < jj && ok; k++) {
            // lateral: mid points must sit on the chord (heading tolerance)
            const px = pts[k][0] - pts[i0][0], pz = pts[k][1] - pts[i0][1];
            if (Math.abs((cx * pz - cz * px) / cl) > sinTol * (s[k] - s[i0])) { ok = false; break; }
            // vertical: interpolated slab must track the profile and stay above the ground
            const t = (s[k] - s[i0]) / (s[jj] - s[i0]);
            const pI = prof[i0] + (prof[jj] - prof[i0]) * t;
            const tI = tilt[i0] + (tilt[jj] - tilt[i0]) * t;
            if (Math.abs(pI - prof[k]) > cfg.eps) { ok = false; break; }
            if (pI + LIFT < gC[k] + 0.08 ||
                pI - tI + LIFT < gL[k] + 0.08 ||
                pI + tI + LIFT < gR[k] + 0.08) { ok = false; break; }
          }
          if (ok) j = jj; else break;
        }
        keep.push(j); i0 = j;
      }
      // Extrude the authored class cross-section. World-space material anchoring remains in the
      // shader; uv.x describes signed metres relative to the carriageway edges.
      const v0 = b.base;
      const fanA=!!(nodes[run.nA]&&nodes[run.nA].fan);
      const fanB=!!(nodes[run.nB]&&nodes[run.nB].fan);
      const totalS=s[n-1];
      const seed=featureSeed(run.featureId);
      let detailBucket=-1;
      for (const i of keep) {
        const px = pts[i][0], pz = pts[i][1];
        const v = s[i] / V_TILE;
        for (let q = 0; q < stride; q++) {
          const section = layout[q];
          let lateral = section.lateral;
          let relief = 0;
          if (run.cls === 'track') {
            const drift=organicWave(s[i],seed,.3)*.09;
            if(section.role==='trackEdge'){
              const side=section.lateral>0?1:-1;
              lateral=side*half*(.88+.13*organicWave(s[i],seed,side>0?1.7:4.1))+drift;
              relief=organicWave(s[i],seed,side>0?2.2:5.4)*.018;
            } else if(section.role==='rut'){
              const side=section.lateral>0?1:-1;
              lateral=side*half*(.45+.035*organicWave(s[i],seed,side>0?6.0:8.0))+drift;
              relief=-.025*(.5+.5*organicWave(s[i],seed,side>0?3.2:7.3));
            } else if(section.role==='trackCrown'){
              lateral=drift+organicWave(s[i],seed,9.2)*.045;
              relief=.018*organicWave(s[i],seed,10.7);
            }
          }
          b.pos.push(px + mx[i] * lateral,
            this._sectionY(cfg, section, prof[i], tilt[i], groundBySection[q][i])+relief,
            pz + mz[i] * lateral);
          b.uv.push(.5 - lateral / cfg.w, v); b.wid.push(cfg.w);
          const junctionMouth=(fanA&&s[i]<12)||(fanB&&totalS-s[i]<12);
          const centerAuthority=1-Math.min(1,Math.max(0,(Math.abs(lateral/cfg.w)-.16)/.24));
          const wx=px+mx[i]*lateral,wz=pz+mz[i]*lateral;
          b.mark.push(Math.min(junctionMouth?centerAuthority:1,this._markAuthority(wx,wz)));
        }
        if(run.cls==='track'){
          const bucket=Math.floor((s[i]+seed*13.0)/13.0);
          if(bucket!==detailBucket){
            detailBucket=bucket;
            const hsh=.5+.5*organicWave(s[i],seed,12.9);
            const side=hsh>.5?1:-1;
            const lateral=side*half*(.34+.58*Math.abs(organicWave(s[i],seed,14.2)));
            this._detailRecords.push({type:'stone',
              x:px+mx[i]*lateral,z:pz+mz[i]*lateral,
              yaw:Math.atan2(dir[Math.min(i,dir.length-1)][0],dir[Math.min(i,dir.length-1)][1])+
                (hsh-.5)*1.4,
              scale:.72+hsh*.9,seed:hsh});
          }
        }
      }

      // BRIDGES: record the pre-LIFT graded profile over water crossings as drivable-surface segments.
      // Any kept section whose centerline sits within a detected span (bridgeFloor != null) is on a
      // deck; consecutive such sections form the published segments read by physics + the deck mesh.
      if (this._bridgeFloor) {
        let prev = null;
        for (const i of keep) {
          const onBridge = this._bridgeFloor(pts[i][0], pts[i][1]) !== null;
          if (onBridge) {
            const node = { x: pts[i][0], z: pts[i][1], y: prof[i], t: tilt[i] };
            if (prev) this._bridgeSegs.push({ ax: prev.x, az: prev.z, ay: prev.y, at: prev.t,
              bx: node.x, bz: node.z, by: node.y, bt: node.t, hw: half });
            prev = node;
          } else prev = null;   // gap → don't bridge a segment across dry ground
        }
      }
      const m = keep.length;
      for (let q = 0; q + 1 < m; q++) {
        const r0 = v0 + q * stride, r1 = r0 + stride;
        for (let c = 0; c + 1 < stride; c++) {
          b.idx.push(r0 + c, r1 + c, r0 + c + 1, r0 + c + 1, r1 + c, r1 + c + 1);
        }
      }
      b.base += m * stride;

      // grading record for the lazy re-drape (XZ is immutable; Y re-derived from fine tiles)
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const i of keep) {
        if (pts[i][0] < minX) minX = pts[i][0]; if (pts[i][0] > maxX) maxX = pts[i][0];
        if (pts[i][1] < minZ) minZ = pts[i][1]; if (pts[i][1] > maxZ) maxZ = pts[i][1];
      }
      const pad = ow + 4;
      let edgeLeft = layout.findIndex(s => s.role === 'edge');
      let edgeRight = layout.map(s => s.role).lastIndexOf('edge');
      if (edgeLeft < 0) edgeLeft = 0;
      if (edgeRight < 0) edgeRight = stride - 1;
      this._ways.push({ cls: run.cls, cfg, layout, edgeLeft, edgeRight,
        v0, n: m, stride, nA: run.nA, nB: run.nB,
        featureId:run.featureId,name:run.name,tags:run.tags,
        bb: { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad } });
    }

    _buildFans(nodes, buckets) {
      const g = (this._gFloored || (this._gFloored = this._floor(this.sampleGround)));
      for (const nd of nodes) {
        if (!nd.fan) continue;
        const outline = nd.fan.outline;
        if (!outline || outline.length < 3) continue;
        const b = buckets[nd.fan.cls], v0 = b.base;
        const y = g(nd.x, nd.z) + FAN_LIFT;
        b.pos.push(nd.x, y, nd.z); b.uv.push(0.35, 0); b.wid.push(CLS[nd.fan.cls].w); b.mark.push(0);
        for (const p of outline) {
          b.pos.push(p[0], y, p[1]);
          b.uv.push(0.35, 0); b.wid.push(CLS[nd.fan.cls].w); b.mark.push(0);
        }
        for (let k = 0; k < outline.length; k++) {
          const k1 = (k + 1) % outline.length;
          b.idx.push(v0, v0 + 1 + k1, v0 + 1 + k);   // wound for an upward face normal
        }
        b.base += outline.length + 1;
        this._fans.push({ cls: nd.fan.cls, v0, count: outline.length + 1, nx: nd.x, nz: nd.z });
      }
    }

    _toMesh(b, mat) {
      if (!b.pos.length) return null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      geo.setAttribute('aWidth', new THREE.Float32BufferAttribute(b.wid, 1));
      geo.setAttribute('aMark', new THREE.Float32BufferAttribute(b.mark, 1));
      geo.setIndex(b.idx);
      geo.computeVertexNormals();   // graded ribbon → shoulders shade like embankments
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;         // authoritative buffer owner; cell views below are rendered
      return mesh;
    }

    /* Build lighter index-only representations over the authoritative shared attributes.
       Mid drops paved/gravel shoulders. Far additionally spans every second longitudinal
       section. XZ/Y/UV attributes remain the exact rendered/query authority, so re-drape and
       world-space material anchoring stay atomic and seam-free. */
    /* Called once per frame from the main loop (92-boot), before the render. Replaces the
       renderer's implicit per-LOD update, which also ran for the water-mirror camera and for all
       six faces of a sky-probe bake — this runs exactly once, with the main camera. */
    updateRenderCells(camera) {
      const F = this._cellFrustum || (this._cellFrustum = new THREE.Frustum());
      const M = this._cellMtx || (this._cellMtx = new THREE.Matrix4());
      F.setFromProjectionMatrix(M.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      for (const cls in this.renderCells)
        updateTransportBatch(this.renderCells[cls], camera, F, camera.position);
    }

    _lodIndices(master, cls, step) {
      const out = [];
      for (const w of this._ways) {
        if (w.cls !== cls) continue;
        const left = w.edgeLeft, right = w.edgeRight;
        for (let q = 0; q + 1 < w.n; q += step) {
          const q1 = Math.min(q + step, w.n - 1);
          const a = w.v0 + q * w.stride, b = w.v0 + q1 * w.stride;
          for (let c = left; c < right; c++)
            out.push(a + c, b + c, a + c + 1, a + c + 1, b + c, b + c + 1);
        }
      }
      // Junction polygons are already minimal and must remain present at every band.
      for (const f of this._fans) if (f.cls === cls)
        for (let k = 0; k < f.count - 1; k++) {
          const k1 = (k + 1) % (f.count - 1);
          out.push(f.v0, f.v0 + 1 + k1, f.v0 + 1 + k);
        }
      return out;
    }

    _toRenderCells(master, mat, order, cls) {
      const pos = master.attributes.position;
      const levels = [Array.from(master.index.array), this._lodIndices(master, cls, 1),
        this._lodIndices(master, cls, 2)];
      const cells = levels.map(() => new Map());
      const add = (map, a, b, c) => {
        const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
        const z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
        const key = Math.floor(x / RENDER_CELL) + ',' + Math.floor(z / RENDER_CELL);
        let rec = map.get(key);
        if (!rec) {
          rec = { idx: [], minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity,
            minZ: Infinity, maxZ: -Infinity }; map.set(key, rec);
        }
        rec.idx.push(a, b, c);
        for (const v of [a, b, c]) {
          const vx = pos.getX(v), vy = pos.getY(v), vz = pos.getZ(v);
          rec.minX = Math.min(rec.minX, vx); rec.maxX = Math.max(rec.maxX, vx);
          rec.minY = Math.min(rec.minY, vy); rec.maxY = Math.max(rec.maxY, vy);
          rec.minZ = Math.min(rec.minZ, vz); rec.maxZ = Math.max(rec.maxZ, vz);
        }
      };
      levels.forEach((idx, li) => {
        for (let i = 0; i < idx.length; i += 3) add(cells[li], idx[i], idx[i + 1], idx[i + 2]);
      });
      return buildTransportBatch(master, mat, order, cells, [0, LOD_NEAR, LOD_MID]);
    }

    /* ================= lazy re-drape (converged-signature pattern, see WaterBuilder) =========
       The ribbon is graded at boot against the coarse z-base collision tiles; the terrain then
       renders from finer streamed LODs whose surface differs by metres. As fine height tiles
       decode, RE-RUN THE GRADING per way (smoothed profile + tilt + node blend + shoulders)
       against the finest decoded height and rewrite Y in place — NOT a raw per-vertex snap,
       which would undo the grading. Gated exactly like before: poll ~6 Hz, only when the fine
       tile signature changed AND the streamer is idle; the pass drains DRAPE_BUDGET road
       cross-sections a frame so motion frames stay cheap; a mesh's normals recompute once all
       of its ways in the pass are done. Vertices outside fine coverage sample terrain.heightAt
       (the same finest-decoded height), so runs converge exactly like a single-shot re-drape. */
    update() {
      const t = this.terrain;
      if (!t || !t.hCache || !this._ways.length) return;
      if (this._zBase === null) {
        if (!t.m) return;
        this._zBase = Math.min(t.m.minZoom + 3, t.m.maxZoom);   // == _loadBaseCollision's zoom
        this._maxZoom = t.m.maxZoom;
      }
      if (this._maxZoom <= this._zBase) return;

      if (this._pass) {
        this._stepPass();
        return;
      }

      if ((this._frame = (this._frame + 1) & 0x3fffffff) % 2 !== 0) return;
      const sig = this._fineSig();
      if (sig === this._drapedSig) return;
      this._startPass(sig);
      if (this._pass) this._stepPass();
    }

    /* cheap signature of the currently-decoded finer-than-base height tiles (order-independent) */
    _fineSig() {
      const t = this.terrain, zBase = this._zBase; let sig = 0;
      for (const e of t.hCache.values()) {
        if (!e.decoded || e.z <= zBase) continue;
        sig = (sig + (((e.z * 73856093) ^ (e.x * 19349663) ^ (e.y * 83492791)) >>> 0)) >>> 0;
      }
      return sig;
    }

    _startPass(sig) {
      const idx = this._fineIndex();
      if (!idx) { this._drapedSig = sig; return; }
      const ways = [];
      for (let i = 0; i < this._ways.length; i++) {
        const w = this._ways[i], bb = w.bb;
        if (!idx.intersects(bb)) continue;
        ways.push(w);
      }
      const fans = this._fans.filter(f =>
        idx.intersects({ minX: f.nx - 20, maxX: f.nx + 20, minZ: f.nz - 20, maxZ: f.nz + 20 }));
      if (!ways.length && !fans.length) { this._drapedSig = sig; return; }
      const t = this.terrain;
      const S = this._floor((x, z) => { const y = idx(x, z); return y === null ? t.heightAt(x, z) : y; });
      // Visible geometry converges first after a teleport or initial load.
      if(this.camera){
        const cx=this.camera.position.x,cz=this.camera.position.z;
        ways.sort((a,b)=>{
          const ax=(a.bb.minX+a.bb.maxX)*.5-cx,az=(a.bb.minZ+a.bb.maxZ)*.5-cz;
          const bx=(b.bb.minX+b.bb.maxX)*.5-cx,bz=(b.bb.minZ+b.bb.maxZ)*.5-cz;
          return ax*ax+az*az-(bx*bx+bz*bz);
        });
      }else ways.sort((a, c) => ORDER.indexOf(a.cls) - ORDER.indexOf(c.cls));
      this._pass = { sig, S, ways, fans, wi: 0, nodeH: new Map(), touched: new Set() };
    }

    _nodeHeight(p, ni) {
      if (ni === undefined || ni === null || ni < 0) return null;
      const nd = this._nodes[ni];
      if (!nd || !nd.blend) return null;
      let h = p.nodeH.get(ni);
      if (h === undefined) { h = p.S(nd.x, nd.z); p.nodeH.set(ni, h); }
      return h;
    }

    _stepPass() {
      const p = this._pass;
      // Deadline checked AFTER each way, so a pass always makes progress even if one way alone
      // overruns the slice — it can never stall, and it can never batch two long ways together.
      const deadline = performance.now() + DRAPE_SLICE_MS;
      while (p.wi < p.ways.length) {
        const w = p.ways[p.wi];
        this._regradeWay(w, p);
        p.touched.add(w.cls);
        p.wi++;
        // finalize a mesh as soon as its last (class-sorted) way is done
        if (p.wi >= p.ways.length || p.ways[p.wi].cls !== w.cls) this._finalize(w.cls, p);
        if (performance.now() >= deadline) break;
      }
      if (p.wi < p.ways.length) return;
      // ways done → fans (cheap), then commit
      for (const f of p.fans) {
        const mesh = this.meshes[f.cls]; if (!mesh) continue;
        const arr = mesh.geometry.attributes.position.array;
        const y = p.S(f.nx, f.nz) + FAN_LIFT;
        for (let k = 0; k < f.count; k++) arr[(f.v0 + k) * 3 + 1] = y;
        p.touched.add(f.cls);
      }
      for (const cls of p.touched) this._finalize(cls, p);
      this._drapedSig = p.sig;
      this._pass = null;
      global.dispatchEvent(new CustomEvent('transport-geometry-updated'));
    }

    _finalize(cls, p) {
      if (!p.touched.has(cls)) return;
      const mesh = this.meshes[cls]; if (!mesh) { p.touched.delete(cls); return; }
      mesh.geometry.attributes.position.needsUpdate = true;
      mesh.geometry.attributes.normal.needsUpdate = true;
      p.touched.delete(cls);
    }

    _updateWayNormals(w, geometry) {
      const pos = geometry.attributes.position.array, normal = geometry.attributes.normal.array;
      const st = w.stride, n = w.n;
      for (let i = 0; i < n; i++) for (let q = 0; q < st; q++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
        const q0 = Math.max(0, q - 1), q1 = Math.min(st - 1, q + 1);
        const ak = (w.v0 + i0 * st + q) * 3, bk = (w.v0 + i1 * st + q) * 3;
        const ck = (w.v0 + i * st + q0) * 3, dk = (w.v0 + i * st + q1) * 3;
        const tx=pos[bk]-pos[ak], ty=pos[bk+1]-pos[ak+1], tz=pos[bk+2]-pos[ak+2];
        const lx=pos[dk]-pos[ck], ly=pos[dk+1]-pos[ck+1], lz=pos[dk+2]-pos[ck+2];
        let nx=ty*lz-tz*ly, ny=tz*lx-tx*lz, nz=tx*ly-ty*lx;
        if (ny < 0) { nx=-nx; ny=-ny; nz=-nz; }
        const length=Math.hypot(nx,ny,nz)||1, k=(w.v0+i*st+q)*3;
        normal[k]=nx/length; normal[k+1]=ny/length; normal[k+2]=nz/length;
      }
    }

    /* re-run the grading pipeline for one way against sampler p.S, writing Y in place.
       XZ never changes, so centers/edges/shoulder positions are read back from the buffer. */
    _regradeWay(w, p) {
      const mesh = this.meshes[w.cls]; if (!mesh) return;
      const arr = mesh.geometry.attributes.position.array;
      const cfg = w.cfg, n = w.n, S = p.S, st = w.stride, layout = w.layout;
      const li = w.edgeLeft, ri = w.edgeRight;
      const s = new Float64Array(n);
      const gC = new Float64Array(n), gL = new Float64Array(n), gR = new Float64Array(n);
      const grounds = layout.map(() => new Float64Array(n));
      let px = 0, pz = 0;
      for (let i = 0; i < n; i++) {
        const base = w.v0 + i * st;
        const lk = (base + li) * 3, rk = (base + ri) * 3;
        const lx = arr[lk], lz = arr[lk + 2];
        const rx = arr[rk], rz = arr[rk + 2];
        const cx = (lx + rx) * 0.5, cz = (lz + rz) * 0.5;
        if (i > 0) s[i] = s[i - 1] + Math.hypot(cx - px, cz - pz);
        px = cx; pz = cz;
        gC[i] = S(cx, cz); gL[i] = S(lx, lz); gR[i] = S(rx, rz);
        for (let q = 0; q < st; q++) {
          const k = (base + q) * 3;
          grounds[q][i] = S(arr[k], arr[k + 2]);
        }
      }
      const hA = this._nodeHeight(p, w.nA), hB = this._nodeHeight(p, w.nB);
      const { prof, tilt } = this._grade(cfg, s, gC, gL, gR, hA, hB);
      for (let i = 0; i < n; i++) {
        const base = w.v0 + i * st;
        for (let q = 0; q < st; q++)
          arr[(base + q) * 3 + 1] = this._sectionY(cfg, layout[q], prof[i], tilt[i], grounds[q][i]);
      }
      if(w.cls==='track'){
        // Fine DEM curvature can rise between the immutable 5 m rows. Conservatively lift the
        // two ruts and crown from midpoint samples so rendered terrain never punches triangular
        // holes through the authored drive surface after a streamed re-drape.
        const raise=new Float64Array(n);
        for(let i=0;i+1<n;i++) for(let q=1;q+1<st;q++){
          const ak=(w.v0+i*st+q)*3,bk=(w.v0+(i+1)*st+q)*3;
          const ground=S((arr[ak]+arr[bk])*.5,(arr[ak+2]+arr[bk+2])*.5);
          const deficit=ground+.045-(arr[ak+1]+arr[bk+1])*.5;
          if(deficit>0){raise[i]=Math.max(raise[i],deficit);raise[i+1]=Math.max(raise[i+1],deficit);}
        }
        for(let i=0;i<n;i++) if(raise[i]>0) for(let q=1;q+1<st;q++)
          arr[(w.v0+i*st+q)*3+1]+=raise[i];
      }
      this._updateWayNormals(w, mesh.geometry);
    }

    /* fast bilinear height sampler over decoded FINER-than-base tiles: O(zooms) tile index instead
       of scanning the whole cache per sample. Returns null where no finer-than-base tile covers
       (x,z) so the caller can fall back to terrain.heightAt. */
    _fineIndex() {
      const t = this.terrain, S = t.m.tileSize, uMax = S - 1.001;
      const byZ = []; let zTop = -1;
      const hx = t.spanX / 2, hz = t.spanZ / 2, root = t.rootSpan;
      const coverZ = this._zBase + 1, cover = new Set();
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const e of t.hCache.values()) {
        if (!e.decoded || e.z <= this._zBase) continue;
        (byZ[e.z] || (byZ[e.z] = new Map())).set(e.x * 4096 + e.y, e);
        const shift = e.z - coverZ;
        cover.add(`${e.x >> shift},${e.y >> shift}`);
        if (e.z > zTop) zTop = e.z;
        const span = root / (1 << e.z);
        const x0 = e.x * span - hx, z0 = e.y * span - hz;
        if (x0 < minX) minX = x0; if (x0 + span > maxX) maxX = x0 + span;
        if (z0 < minZ) minZ = z0; if (z0 + span > maxZ) maxZ = z0 + span;
      }
      if (zTop < 0) return null;
      const sampler = (x, z) => {
        for (let zz = zTop; zz > this._zBase; zz--) {
          const tiles = byZ[zz]; if (!tiles) continue;
          const span = root / (1 << zz);
          const tx = Math.floor((x + hx) / span), ty = Math.floor((z + hz) / span);
          const e = tiles.get(tx * 4096 + ty);
          if (!e) continue;
          const g = e.decoded;
          let u = ((x + hx) / span - tx) * (S - 1), v = ((z + hz) / span - ty) * (S - 1);
          u = Math.max(0, Math.min(uMax, u)); v = Math.max(0, Math.min(uMax, v));
          const i = u | 0, j = v | 0, fu = u - i, fv = v - j;
          const a = g[j * S + i], b = g[j * S + i + 1];
          const c = g[(j + 1) * S + i], d = g[(j + 1) * S + i + 1];
          return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
        }
        return null;
      };
      sampler.bounds = { minX, maxX, minZ, maxZ };
      sampler.intersects = bb => {
        const span = root / (1 << coverZ);
        const x0 = Math.floor((bb.minX + hx) / span), x1 = Math.floor((bb.maxX + hx) / span);
        const y0 = Math.floor((bb.minZ + hz) / span), y1 = Math.floor((bb.maxZ + hz) / span);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++)
          if (cover.has(`${x},${y}`)) return true;
        return false;
      };
      return sampler;
    }
  }

  global.RoadRibbon = RoadRibbon;
})(window);
