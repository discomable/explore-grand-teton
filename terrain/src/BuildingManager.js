/* BuildingManager — the park's buildings extruded from OSM footprints (Three.js r184, global THREE).
 *
 * Reads terrain/public/buildings.json ({attribution, buildings:[{pts:[[x,z]..], h, cls, name?, imp}]},
 * world-metre footprint rings) and extrudes every footprint into low-poly walls + a roof, ALL merged
 * into ONE vertex-colored BufferGeometry / ONE draw call (MeshLambertMaterial → scene sun/hemi/fog).
 *
 *  - Roof by shape: fit a min-area oriented bbox over the ring; near-rectangular rings
 *    (ringArea/obbArea >= RECT_RATIO) get a gable (barn steep, residential medium, outbuilding
 *    shallow) or hip (lodge/commercial); irregular rings get a flat roof slab a PARAPET below the
 *    wall top (+ an inward-facing parapet strip so you can't see through the rim).
 *  - TEXTURE DETAIL (revert: set TEXTURED=false — vertex colors fall back to the old flat look):
 *    one runtime-painted, deterministic 2048x1024 canvas ATLAS (8x4 cells of 256px — a MATERIAL
 *    LIBRARY: painted clapboard in six colours (white/cream/sage/barn-red/slate/brown), stacked
 *    logs, board-and-batten, lodge timber, dark NPS timber, stucco, outbuilding board, barn board
 *    (plain + landmark white-trim), fieldstone foundation, a GRAND lodge facade (stone base +
 *    picture-window great room + clerestory, mapped full-height), and shingle/metal-seam/shake/
 *    membrane roofs). Per-building material/colour is chosen by pickCells() from a REGION palette
 *    (Colter/Mormon Row/Moose/Teton Village) indexed by a stable centroid hash, so clusters vary
 *    yet stay regionally coherent. Walls UV in world METRES (u = running perimeter length, v =
 *    height above base; 3 m storey tile — barn & grand facades map v over the full wall height so
 *    the whole facade shows once). A per-vertex aCell float picks the atlas cell; the material's
 *    instance onBeforeCompile swaps <map_fragment> for a fract()-tiled atlas lookup, so ONE
 *    Lambert material / ONE draw call survives. Window glass is painted with alpha<1 — the same
 *    lookup turns (1-alpha) into a faint warm emissive so windows read "lit" (no 2nd texture).
 *    Per-frame cost: +1 texture fetch & ~6 ALU per building fragment, +0 draw calls; walls are
 *    split at grade (skirt quad shows a squashed stone-foundation band, never buried windows).
 *    Vertex-color tint still MULTIPLIES the texture (walls: neutral jitter, roofs: region tint
 *    over a near-neutral roof texture) for per-building variation.
 *  - LANDMARKS: barns (Moulton etc.) get a gambrel two-pitch roof silhouette; Jackson Lake Lodge
 *    & the big low lodges/visitor centers get the GRAND glass-and-timber facade + stone base.
 *  - base y = min sampleGround over the ring; walls extend SKIRT (1.5 m) below it so streamed
 *    terrain never opens a gap under a corner.
 *  - Boot heights are coarse: update() lazily re-bases each building (uniform Y shift of its
 *    vertex range — normals/UVs unchanged, v is base-relative so it stays valid) as finer height
 *    tiles stream in, using the same converged-signature + amortized-budget pattern as
 *    RoadRibbon.update().
 *  - Collision: RoadIndex-style grid buckets over footprint bboxes; window.buildingBlocked(x,z,y?)
 *    does point-in-ring on the few nearby candidates (y, when given, lets you fly/jump over).
 *
 *   const bm = await new BuildingManager({scene, terrain, sampleGround}).build();
 *   bm.stats            // {tris, drawCalls, count}
 *   bm.update()         // per-frame; cheap gate, budgeted re-base as fine tiles settle
 */
(function (global) {
  'use strict';
  const THREE = global.THREE;

  const TEXTURED = true;    // false → old flat vertex-color buildings (full lane revert)
  const SKIRT = 1.5;        // metres of wall below the ground min (hides streamed-terrain gaps)
  const PARAPET = 0.55;     // flat-roof slab sits this far below the wall top
  const OVERHANG = 0.3;     // gable/hip eave overhang beyond the oriented bbox
  const RECT_RATIO = 0.72;  // ringArea/obbArea above this → pitched roof; below → flat+parapet
  const CELL = 24;          // collision grid cell (m) — footprints are ~10-40 m
  const DRAPE_BUDGET = 400; // buildings re-based per frame during an amortized re-drape pass

  // muted, style-matched palette + roof pitch (rise/run) per class; hip for the big public ones.
  // Values are kept LOW: the renderer outputs sRGB, which lifts Lambert vertex colors — mid-grey
  // inputs read near-white, so these are pre-darkened to land as muted park tones on screen.
  // When TEXTURED, wall colors are painted INTO the atlas cells and the vertex color carries only
  // jitter; roof colors ride the vertex tint (from ROOF_TINT via the region palette) over the
  // near-neutral roof texture. In the non-textured fallback STYLE.wall/roof are used directly.
  const STYLE = {
    lodge:       { wall: [0.28, 0.20, 0.13], roof: [0.13, 0.18, 0.12], pitch: 0.55, hip: true  },
    commercial:  { wall: [0.40, 0.36, 0.31], roof: [0.18, 0.18, 0.20], pitch: 0.40, hip: true  },
    residential: { wall: [0.46, 0.39, 0.29], roof: [0.22, 0.19, 0.16], pitch: 0.72, hip: false },
    barn:        { wall: [0.36, 0.14, 0.10], roof: [0.30, 0.31, 0.33], pitch: 1.05, hip: false },
    outbuilding: { wall: [0.33, 0.32, 0.30], roof: [0.22, 0.22, 0.23], pitch: 0.30, hip: false },
    generic:     { wall: [0.42, 0.37, 0.30], roof: [0.24, 0.22, 0.19], pitch: 0.62, hip: false },
  };
  const ROOF_PAINT = 0.72;  // avg luminance the roof atlas cells are painted at (tint divides it)

  /* ---- MATERIAL LIBRARY: atlas cell indices (8 cols x 4 rows; see makeAtlas) ----------------
     Walls tile 3 m (windows land at storey height); roofs tile ~3 m; membrane/stone are painted
     to tile cleanly. WALL.grand & the barn cells map v over the FULL wall height (one facade). */
  const WALL = {
    white: 0, cream: 1, sage: 2, red: 3, grey: 4, brown: 5, log: 6, bandb: 7,
    timber: 8, outb: 9, barn: 10, barnLand: 11, stone: 12, grand: 13, npsbrown: 14, stucco: 15,
    green: 20, buff: 21, bluegrey: 22, entrance: 23,   // added — break the brown monotony + doors
  };
  const ROOFC = { shingle: 16, metal: 17, shake: 18, membrane: 19 };

  // roof tints (pre-sRGB, ~STYLE.roof magnitude): divided by ROOF_PAINT, x per-building jitter.
  const ROOF_TINT = {
    grey:     [0.25, 0.25, 0.26], brown: [0.23, 0.17, 0.13], green: [0.10, 0.17, 0.12],
    red:      [0.30, 0.11, 0.09], charcoal: [0.14, 0.14, 0.16], shake: [0.27, 0.22, 0.16],
    silver:   [0.34, 0.35, 0.37],
  };

  // region character by world centroid → coherent-but-varied clusters (Colter/Mormon Row/Moose/
  // Teton Village). Houses draw a wall from HOUSE_PAL, a roof from ROOF_PAL, keyed by a stable hash.
  function regionOf(cx, cz) {
    if (cz < -12000) return 'lake';                                       // Colter Bay / Jackson Lake
    if (cx > 3200 && cx < 6300 && cz > 6300 && cz < 9300) return 'ranch'; // Mormon Row / Moulton
    if (cx > -1600 && cx < 1900 && cz > 6400 && cz < 11600) return 'moose';
    if (cz > 12000) return 'resort';                                      // Teton Village / Jackson
    return 'default';
  }
  // Palettes are deliberately hue-spread so a cluster is not read as monotone brown: browns/logs
  // stay the regional backbone but grey, sage-green, buff and weathered white/cream are mixed in
  // (real park villages read that way — timber cabins beside painted grey/green service buildings).
  const HOUSE_PAL = {
    lake:    [WALL.log, WALL.brown, WALL.npsbrown, WALL.grey, WALL.green, WALL.buff, WALL.timber, WALL.log, WALL.bluegrey],
    ranch:   [WALL.red, WALL.white, WALL.grey, WALL.brown, WALL.buff, WALL.barn, WALL.green],
    moose:   [WALL.npsbrown, WALL.brown, WALL.sage, WALL.green, WALL.grey, WALL.buff, WALL.timber, WALL.log],
    resort:  [WALL.cream, WALL.grey, WALL.timber, WALL.stucco, WALL.bluegrey, WALL.buff, WALL.white, WALL.green],
    default: [WALL.brown, WALL.grey, WALL.cream, WALL.npsbrown, WALL.sage, WALL.green, WALL.buff],
  };
  const ROOF_PAL = {
    lake:    [[ROOFC.metal, 'green'], [ROOFC.shingle, 'grey'], [ROOFC.shake, 'shake'], [ROOFC.metal, 'charcoal'], [ROOFC.metal, 'red'], [ROOFC.shingle, 'brown']],
    ranch:   [[ROOFC.metal, 'grey'], [ROOFC.metal, 'red'], [ROOFC.shake, 'shake'], [ROOFC.shingle, 'grey'], [ROOFC.metal, 'green']],
    moose:   [[ROOFC.metal, 'green'], [ROOFC.shingle, 'grey'], [ROOFC.metal, 'charcoal'], [ROOFC.shake, 'shake'], [ROOFC.metal, 'red']],
    resort:  [[ROOFC.shingle, 'grey'], [ROOFC.shingle, 'brown'], [ROOFC.metal, 'charcoal'], [ROOFC.shake, 'shake'], [ROOFC.metal, 'green']],
    default: [[ROOFC.shingle, 'grey'], [ROOFC.metal, 'green'], [ROOFC.shingle, 'brown'], [ROOFC.metal, 'charcoal']],
  };

  /* ================================ material atlas ==========================================
     8 cols x 4 rows of 256px cells on a 2048x1024 (power-of-two) canvas, painted ONCE at build
     (deterministic mulberry32 stream — same pixels every run). uv row 0 = canvas BOTTOM (flipY).
     Cell map (indices are the WALL/ROOFC tables above):
       0 white clapboard   1 cream clapboard   2 sage clapboard   3 barn-red clapboard
       4 slate clapboard   5 brown board       6 stacked logs     7 board&batten (commercial)
       8 lodge timber      9 outbuilding board 10 barn board plain 11 landmark barn board+trim
      12 fieldstone (foundation) 13 GRAND lodge facade (full-height: stone base + picture windows)
      14 dark NPS timber   15 stucco
      16 shingle roof      17 standing-seam metal 18 wood shake    19 membrane flat roof
     Wall cells tile 3 m x 3 m (windows land at storey height). WALL.grand + the two barn cells
     map v over the FULL wall height (one whole facade, not a repeated storey). Window GLASS is
     drawn at alpha<1 — the shader reads (1-alpha) as a warm emissive glow. Cells tile through
     fract(); patterns align to cell edges so the wrap seam lands on a board/course line. */
  const ATLAS_W = 2048, ATLAS_H = 1024, COLS = 8, ROWS = 4, CELL_PX = 256;

  function mulberry(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function rgb(r, g, b) { return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')'; }

  function makeAtlas() {
    const cv = document.createElement('canvas');
    cv.width = ATLAS_W; cv.height = ATLAS_H;
    const ctx = cv.getContext('2d');
    const rnd = mulberry(0x7e701);
    ctx.fillStyle = rgb(150, 145, 138); ctx.fillRect(0, 0, ATLAS_W, ATLAS_H);
    const M = CELL_PX / 3;                       // px per metre at the 3 m tile

    const cell = (idx, fn) => {
      const x0 = (idx % COLS) * CELL_PX, y0 = ATLAS_H - (Math.floor(idx / COLS) + 1) * CELL_PX;
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, CELL_PX, CELL_PX); ctx.clip();
      ctx.translate(x0, y0); fn(); ctx.restore();
    };
    /* window stamp: white trim frame, semi-transparent glass (alpha marks glow), mullion cross */
    const winPx = (x, y, w, h, T) => {
      T = T || 4;
      ctx.fillStyle = rgb(201, 195, 182);
      ctx.fillRect(x - T, y - T, w + 2 * T, h + 2 * T);
      ctx.clearRect(x, y, w, h);
      ctx.fillStyle = 'rgba(13,17,24,0.55)';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = 'rgba(180,200,220,0.20)';        // sky glint along the top
      ctx.fillRect(x, y, w, 4);
      ctx.fillStyle = 'rgba(198,192,178,0.95)';
      ctx.fillRect(x + w / 2 - 1, y, 2, h);
      ctx.fillRect(x, y + h / 2 - 1, w, 2);
    };
    const winM = (cxM, sillM, wM, hM, T) =>      // metric placement (3 m cells; y up from base)
      winPx(cxM * M - wM * M / 2, CELL_PX - (sillM + hM) * M, wM * M, hM * M, T);

    const hCourses = (r, g, b, ch, amp) => {     // horizontal siding courses
      for (let y = 0; y < CELL_PX; y += ch) {
        const k = 1 + (rnd() * 2 - 1) * amp;
        ctx.fillStyle = rgb(r * k, g * k, b * k); ctx.fillRect(0, y, CELL_PX, ch);
        ctx.fillStyle = 'rgba(0,0,0,0.16)'; ctx.fillRect(0, y + ch - 2, CELL_PX, 2);
      }
    };
    // painted clapboard house: tight courses in a solid colour + a corner-board trim + a window
    const clap = (r, g, b) => { hCourses(r, g, b, 12, 0.05); winM(1.5, 0.95, 1.1, 1.35); };
    const vBoards = (r, g, b, bw, amp, streaks) => {   // vertical boards + optional grain
      for (let x = 0; x < CELL_PX; x += bw) {
        const k = 1 + (rnd() * 2 - 1) * amp;
        ctx.fillStyle = rgb(r * k, g * k, b * k); ctx.fillRect(x, 0, bw, CELL_PX);
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(x, 0, 1, CELL_PX);
        if (streaks) for (let s = 0; s < 3; s++) {
          const sx = x + 2 + rnd() * (bw - 3), sy = rnd() * CELL_PX;
          let sl = 20 + rnd() * 90; if (sy + sl > CELL_PX) sl = CELL_PX - sy;
          ctx.fillStyle = 'rgba(30,16,10,0.13)'; ctx.fillRect(sx, sy, 1, sl);
        }
      }
    };
    const barnBoards = (landmark) => {
      vBoards(landmark ? 96 : 92, landmark ? 34 : 38, landmark ? 24 : 28, 16, 0.14, true);
      for (let i = 0; i < 7; i++) {              // sun-bleached boards (aligned to board columns)
        const bx = ((rnd() * 16) | 0) * 16;
        ctx.fillStyle = 'rgba(168,156,142,' + (0.05 + rnd() * 0.07).toFixed(3) + ')';
        ctx.fillRect(bx + 1, 0, 15, CELL_PX);
      }
      // big sliding barn door (v from base) + white fascia under the eave (v~1) for the landmark
      ctx.fillStyle = 'rgba(20,12,8,0.55)'; ctx.fillRect(96, 150, 64, 106);   // dark door recess
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(96, 150, 64, 3); ctx.fillRect(126, 150, 3, 106);
      if (landmark) {
        ctx.fillStyle = rgb(206, 200, 188); ctx.fillRect(0, 0, CELL_PX, 10);
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(0, 10, CELL_PX, 2);
        winPx(112, 96, 32, 40, 5);
      }
    };
    // fieldstone rubble — used for the foundation skirt band and the grand-lodge base
    const stoneRect = (x0, y0, w, h) => {
      ctx.fillStyle = rgb(96, 92, 86); ctx.fillRect(x0, y0, w, h);
      const rows = Math.max(1, Math.round(h / 20));
      for (let ry = 0; ry < rows; ry++) {
        const yy = y0 + ry * (h / rows);
        for (let sx = x0 - (ry % 2) * 14; sx < x0 + w; sx += 26 + rnd() * 10) {
          const sw = 18 + rnd() * 12, sh = (h / rows) - 3;
          const t = 0.72 + rnd() * 0.5;
          ctx.fillStyle = rgb(104 * t, 99 * t, 92 * t); ctx.fillRect(sx, yy + 1, sw, sh);
          ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(sx, yy, sw + 2, 2);
        }
      }
    };
    const shingles = (r, g, b, ragged) => {
      let row = 0;
      for (let y = 0; y < CELL_PX; y += 16, row++) {
        const k = 1 + (rnd() * 2 - 1) * 0.07;
        ctx.fillStyle = rgb(r * k, g * k, b * k); ctx.fillRect(0, y, CELL_PX, 16);
        ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(0, y + 14, CELL_PX, 2);
        for (let x = (row % 2) ? 16 : 0; x < CELL_PX; x += 32) {
          if (ragged) {
            ctx.fillStyle = 'rgba(' + (rnd() < 0.5 ? '0,0,0' : '255,255,255') + ',' +
              (0.04 + rnd() * 0.07).toFixed(3) + ')';
            ctx.fillRect(x, y, 32, 14);
          }
          ctx.fillStyle = 'rgba(0,0,0,0.22)';
          ctx.fillRect(x + (ragged ? (rnd() * 6 - 3) | 0 : 0), y + 2, 1, 12);
        }
      }
    };
    // GRAND lodge facade (Jackson Lake Lodge): mapped over the FULL wall height, so canvas TOP
    // (y=0) is the eave (v=1) and canvas BOTTOM (y=CELL_PX) is grade (v=0). Stone base, a tall
    // picture-window great-room band, then an upper clerestory row — the JLL signature.
    const grandFacade = () => {
      const H = CELL_PX;
      for (let y = 0; y < H; y += 16) {            // dark timber body
        const k = 1 + (rnd() * 2 - 1) * 0.06;
        ctx.fillStyle = rgb(94 * k, 74 * k, 54 * k); ctx.fillRect(0, y, H, 16);
        ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(0, y + 14, H, 2);
      }
      stoneRect(0, H * 0.80, H, H * 0.20);          // stone base band (grade → ~1.6 m)
      // picture-window great room: LIGHT reflective glazing in a heavy timber frame (the JLL
      // signature). Glass is cleared then filled semi-transparent so it reads bright by day AND
      // keeps a faint warm night glow via the shader's (1-alpha) term.
      const wy0 = H * 0.26, wy1 = H * 0.80, bays = 5, gap = 4;
      ctx.fillStyle = rgb(126, 100, 66); ctx.fillRect(0, wy0 - 7, H, (wy1 - wy0) + 14);   // frame band
      for (let i = 0; i < bays; i++) {
        const bx = i * (H / bays) + gap, bw = H / bays - 2 * gap;
        ctx.clearRect(bx, wy0, bw, wy1 - wy0);
        const g = ctx.createLinearGradient(0, wy0, 0, wy1);
        g.addColorStop(0, 'rgba(168,192,214,0.78)');       // sky reflection up top
        g.addColorStop(0.55, 'rgba(128,156,182,0.72)');
        g.addColorStop(1, 'rgba(96,120,146,0.72)');        // darker (interior) low down
        ctx.fillStyle = g; ctx.fillRect(bx, wy0, bw, wy1 - wy0);
        ctx.fillStyle = 'rgba(60,42,26,0.92)';             // timber mullions
        for (let mx = bx + bw / 2; mx < bx + bw - 1; mx += bw / 2) ctx.fillRect(mx - 1, wy0, 2, wy1 - wy0);
        for (let my = wy0 + (wy1 - wy0) / 3; my < wy1 - 1; my += (wy1 - wy0) / 3) ctx.fillRect(bx, my - 1, bw, 2);
      }
      for (let i = 0; i < 5; i++) winPx(i * (H / 5) + H / 10 - 20, 24, 40, 34, 4);   // clerestory
      ctx.fillStyle = rgb(126, 100, 66); ctx.fillRect(0, 0, H, 9);                  // eave fascia
    };

    cell(WALL.white,  () => clap(200, 197, 189));
    cell(WALL.cream,  () => clap(191, 172, 136));
    cell(WALL.sage,   () => clap(139, 148, 122));
    cell(WALL.red,    () => clap(150, 60, 50));
    cell(WALL.grey,   () => clap(134, 137, 140));
    cell(WALL.brown,  () => { vBoards(107, 94, 77, 16, 0.10, true); winM(1.5, 0.95, 1.1, 1.3); });
    cell(WALL.log,    () => {                     // stacked logs + chinking, small cabin window
      for (let y = 0; y < CELL_PX; y += 32) {
        const k = 0.9 + rnd() * 0.25;
        const g = ctx.createLinearGradient(0, y, 0, y + 32);
        g.addColorStop(0, rgb(64 * k, 48 * k, 33 * k));
        g.addColorStop(0.35, rgb(118 * k, 90 * k, 62 * k));
        g.addColorStop(0.8, rgb(96 * k, 72 * k, 48 * k));
        g.addColorStop(1, rgb(52 * k, 39 * k, 27 * k));
        ctx.fillStyle = g; ctx.fillRect(0, y, CELL_PX, 32);
        ctx.fillStyle = 'rgba(212,204,190,0.5)'; ctx.fillRect(0, y + 29, CELL_PX, 2);
      }
      winM(1.5, 1.0, 0.95, 1.05, 5);
    });
    cell(WALL.bandb,  () => {                      // board & batten + storefront-ish window
      ctx.fillStyle = rgb(102, 92, 79); ctx.fillRect(0, 0, CELL_PX, CELL_PX);
      for (let x = 0; x < CELL_PX; x += 32) {
        ctx.fillStyle = 'rgba(0,0,0,' + (0.10 + rnd() * 0.08).toFixed(3) + ')';
        ctx.fillRect(x, 0, 5, CELL_PX);
        ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(x + 5, 0, 2, CELL_PX);
      }
      winM(1.5, 0.85, 1.5, 1.4, 5);
    });
    cell(WALL.timber, () => { hCourses(72, 51, 33, 24, 0.08); winM(1.5, 1.0, 1.0, 1.35, 4); });
    cell(WALL.outb,   () => vBoards(84, 82, 77, 16, 0.12, true));
    cell(WALL.barn,   () => barnBoards(false));
    cell(WALL.barnLand, () => barnBoards(true));
    cell(WALL.stone,  () => stoneRect(0, 0, CELL_PX, CELL_PX));
    cell(WALL.grand,  () => grandFacade());
    cell(WALL.npsbrown, () => { hCourses(88, 70, 52, 14, 0.06); winM(1.5, 0.95, 1.1, 1.3); });
    cell(WALL.stucco, () => { clap(198, 186, 168); });
    cell(WALL.green,  () => clap(92, 108, 84));        // sage/forest-green painted cabin
    cell(WALL.buff,   () => clap(178, 152, 112));      // buff / tan painted siding
    cell(WALL.bluegrey, () => clap(120, 132, 142));    // weathered blue-grey siding
    cell(WALL.entrance, () => {                        // fronted ENTRANCE: timber wall + doors + sign
      hCourses(84, 66, 49, 14, 0.06);                  // NPS timber body
      // sign board band under the eave (v ~ 2.4 m)
      ctx.fillStyle = rgb(58, 44, 32); ctx.fillRect(28, 20, CELL_PX - 56, 26);
      ctx.fillStyle = 'rgba(206,196,178,0.85)';
      for (let sx = 44; sx < CELL_PX - 44; sx += 22) ctx.fillRect(sx, 30, 12, 6);   // faux lettering
      // flanking windows (either side of the doors)
      winM(0.62, 0.95, 0.9, 1.2, 4); winM(2.38, 0.95, 0.9, 1.2, 4);
      // central double-door entry (recessed, glazed upper) with a bold timber frame
      const dw = 1.5 * M, dh = 2.05 * M, dx = CELL_PX / 2 - dw / 2, dy = CELL_PX - dh;
      ctx.fillStyle = rgb(120, 96, 64); ctx.fillRect(dx - 7, dy - 7, dw + 14, dh + 7);   // frame
      ctx.fillStyle = rgb(46, 34, 24); ctx.fillRect(dx, dy, dw, dh);                     // recess
      ctx.fillStyle = 'rgba(150,176,198,0.55)';                                          // glazed tops
      ctx.fillRect(dx + 3, dy + 4, dw / 2 - 5, dh * 0.42);
      ctx.fillRect(dx + dw / 2 + 2, dy + 4, dw / 2 - 5, dh * 0.42);
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(dx + dw / 2 - 1, dy, 2, dh);       // meeting stile
      ctx.fillStyle = rgb(196, 176, 120); ctx.fillRect(dx + dw / 2 - 2, dy + dh * 0.6, 4, 6); // handles
    });
    cell(ROOFC.shingle, () => shingles(186, 182, 176, false));
    cell(ROOFC.metal, () => {                      // standing-seam metal (tinted per building)
      ctx.fillStyle = rgb(186, 188, 191); ctx.fillRect(0, 0, CELL_PX, CELL_PX);
      for (let x = 0; x < CELL_PX; x += 32) {
        ctx.fillStyle = 'rgba(0,0,0,' + (0.02 + rnd() * 0.05).toFixed(3) + ')';
        ctx.fillRect(x, 0, 32, CELL_PX);
        ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(x, 0, 2, CELL_PX);
        ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(x + 2, 0, 2, CELL_PX);
      }
    });
    cell(ROOFC.shake, () => shingles(182, 176, 166, true));
    cell(ROOFC.membrane, () => {                   // membrane flat roof: speckle + seam grid
      ctx.fillStyle = rgb(184, 182, 178); ctx.fillRect(0, 0, CELL_PX, CELL_PX);
      for (let i = 0; i < 400; i++) {
        ctx.fillStyle = 'rgba(' + (rnd() < 0.5 ? '0,0,0' : '255,255,255') + ',0.06)';
        ctx.fillRect(rnd() * CELL_PX, rnd() * CELL_PX, 2, 2);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      for (let x = 0; x < CELL_PX; x += 64) { ctx.fillRect(x, 0, 2, CELL_PX); ctx.fillRect(0, x, CELL_PX, 2); }
    });
    return cv;
  }

  /* per-building material selection: wall + roof cell + roof tint + foundation-skirt cell, chosen
     by class and — for houses/generics — a region palette indexed by a stable per-building hash,
     so a cluster varies (colour, roof, material) but stays regionally coherent. imp:1 barns get
     the landmark white-trim board; big low lodges (Jackson Lake Lodge) get the GRAND facade. */
  function pickCells(cls, imp, area, h, cx, cz) {
    const region = regionOf(cx, cz);
    const hw = jit(cx, cz, 11), hr = jit(cx, cz, 13);
    let w;
    if (cls === 'barn') w = imp === 1 ? WALL.barnLand : WALL.barn;
    else if (cls === 'lodge') {
      if (area > 1250 && h < 13) w = WALL.grand;
      else { const lp = [WALL.timber, WALL.npsbrown, WALL.brown, WALL.grey, WALL.timber]; w = lp[(hw * lp.length) | 0]; }
    }
    else if (cls === 'commercial') { const cp = [WALL.bandb, WALL.timber, WALL.grey, WALL.brown, WALL.red, WALL.bandb]; w = cp[(hw * cp.length) | 0]; }
    else if (cls === 'outbuilding') { const op = [WALL.outb, WALL.outb, WALL.grey, WALL.red, WALL.green]; w = op[(hw * op.length) | 0]; }
    else {                                         // generic + residential → region house palette
      const pal = HOUSE_PAL[region];
      w = (area < 90 && h < 5.6 && region === 'lake') ? WALL.log : pal[(hw * pal.length) | 0];
    }
    let r, tintName;
    if (cls === 'barn') { r = hr < 0.5 ? ROOFC.metal : ROOFC.shake; tintName = hr < 0.22 ? 'red' : hr < 0.5 ? 'grey' : 'shake'; }
    else if (w === WALL.grand) { r = ROOFC.membrane; tintName = 'charcoal'; }
    else { const rp = ROOF_PAL[region], pk = rp[(hr * rp.length) | 0]; r = pk[0]; tintName = pk[1]; }
    let skirt;
    if (cls === 'lodge' || cls === 'commercial') skirt = WALL.stone;
    else if (w === WALL.log || w === WALL.barn || w === WALL.barnLand || w === WALL.outb || w === WALL.timber) skirt = w;
    else skirt = WALL.stone;
    const isBarn = w === WALL.barn || w === WALL.barnLand;
    return { w, r, tint: ROOF_TINT[tintName], skirt, isBarn, grand: w === WALL.grand,
             fullMap: isBarn || w === WALL.grand };
  }

  /* deterministic 0..1 hash from a building's centroid (stable per-building tint jitter) */
  function jit(cx, cz, s) {
    const t = Math.sin(cx * 12.9898 + cz * 78.233 + s * 37.719) * 43758.5453;
    return t - Math.floor(t);
  }

  /* signed shoelace area of a ring in the (x,z) plane */
  function shoelace(pts) {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
      a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    return a / 2;
  }

  /* min-area oriented bbox over the ring (tries every edge direction). Returns centre, unit long
     axis u, v = rot90(u) (recomputed after any axis swap so handedness — and thus every roof
     winding built from it — stays fixed), half-extents hu >= hv, and area. */
  function obbFit(pts) {
    let best = null;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz); if (l < 0.5) continue;
      dx /= l; dz /= l;
      let minU = 1e9, maxU = -1e9, minV = 1e9, maxV = -1e9;
      for (const p of pts) {
        const u = p[0] * dx + p[1] * dz, vv = -p[0] * dz + p[1] * dx;
        if (u < minU) minU = u; if (u > maxU) maxU = u;
        if (vv < minV) minV = vv; if (vv > maxV) maxV = vv;
      }
      const area = (maxU - minU) * (maxV - minV);
      if (!best || area < best.area) best = { area, dx, dz, minU, maxU, minV, maxV };
    }
    if (!best) return null;
    const cu = (best.minU + best.maxU) / 2, cv = (best.minV + best.maxV) / 2;
    let ux = best.dx, uz = best.dz;
    let hu = (best.maxU - best.minU) / 2, hv = (best.maxV - best.minV) / 2;
    const cx = ux * cu - uz * cv, cz = uz * cu + ux * cv;   // centre back to world (v = (-uz,ux))
    if (hv > hu) { const t = hu; hu = hv; hv = t; const tx = ux; ux = -uz; uz = tx; } // long axis → u
    return { cx, cz, ux, uz, vx: -uz, vz: ux, hu, hv, area: best.area };
  }

  /* even-odd point-in-ring over a flat [x0,z0,x1,z1,...] array */
  function inRing(x, z, r) {
    let inside = false;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }

  /* ============================ BESPOKE LANDMARK MASSING ====================================
     A handful of named landmarks read as monolithic warehouse blocks under the generic extrude.
     These builders compose their silhouette from a few rectangular sub-masses (emitMass) — a long
     low great-room lodge for Jackson Lake Lodge, a fronted gable hall + projecting entrance for the
     Colter Bay Visitor Center — while emitting into the SAME merged arrays (one draw call) with the
     same atlas cells, world-metre UVs and skirt-below-base seating, so LOD re-base + collision are
     unchanged. Sub-masses sit within the footprint's oriented bbox, so nothing floats past grade. */
  function roofRGB(name) {
    const rt = ROOF_TINT[name] || ROOF_TINT.grey;
    return [rt[0] / ROOF_PAINT, rt[1] / ROOF_PAINT, rt[2] / ROOF_PAINT];
  }

  /* Emit ONE rectangular sub-mass (4 walls + foundation skirt + hip/gable/flat roof). Long axis is
     (ux,uz); hu>=hv are half-extents. Side index (CCW, area>0 → outward walls): 0=+v long side,
     1=-u end, 2=-v long side, 3=+u end. frontGrand → picture-window glass on BOTH long sides;
     frontEntrance → the ENTRANCE facade (doors+sign, mapped once over the mass height) on +v. */
  function emitMass(em, o) {
    const push = em.push, tri = em.tri, quad = em.quad;
    const cx = o.cx, cz = o.cz, ux = o.ux, uz = o.uz, vx = -uz, vz = ux;
    const hu = o.hu, hv = o.hv, baseY = o.baseY, y0 = o.y0;
    const height = o.height, top = baseY + height;
    const wall = o.wall, roof = o.roof, wcell = o.wcell, rcell = o.rcell;
    const skirtCell = o.skirtCell != null ? o.skirtCell : WALL.stone;
    const kind = o.roofKind || 'hip', pU = 3;
    const W = (du, dv) => [cx + ux * du + vx * dv, cz + uz * du + vz * dv];
    const corners = [W(hu, hv), W(-hu, hv), W(-hu, -hv), W(hu, -hv)];   // CCW (area>0)
    let per = o.phase || 0;
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const isLong = (i === 0 || i === 2);
      // grand glazing maps one 5-bay great-room facade per 12 m of wall (big picture windows, not
      // the 3 m storey grid); the entrance facade maps ONCE across its wall so the doors sit centred.
      let cell = wcell, pV = 3, u0, u1;
      if (o.frontGrand && isLong) { cell = WALL.grand; pV = height; u0 = 0; u1 = L / 20; }
      else if (o.frontEntrance && i === 2) { cell = WALL.entrance; pV = height; u0 = 0; u1 = 1; }
      else { if (o.fullMap) pV = height; u0 = per / pU; u1 = (per + L) / pU; }
      const vT = (top - baseY) / pV;
      let a0 = push(a[0], baseY, a[1], wall, u0, 0, cell),
          b0 = push(b[0], baseY, b[1], wall, u1, 0, cell),
          b1 = push(b[0], top, b[1], wall, u1, vT, cell),
          a1 = push(a[0], top, a[1], wall, u0, vT, cell);
      tri(b0, a0, a1); tri(b0, a1, b1);
      const vS = 0.28 / pV, sc = (cell !== wcell || o.fullMap) ? cell : skirtCell;
      a0 = push(a[0], y0, a[1], wall, u0, vS, sc);
      b0 = push(b[0], y0, b[1], wall, u1, vS, sc);
      b1 = push(b[0], baseY, b[1], wall, u1, 0, sc);
      a1 = push(a[0], baseY, a[1], wall, u0, 0, sc);
      tri(b0, a0, a1); tri(b0, a1, b1);
      per += L;
    }
    if (kind === 'flat') {
      const yR = top - PARAPET, wallDim = [wall[0] * 0.8, wall[1] * 0.8, wall[2] * 0.8];
      let pp = o.phase || 0;                                   // inward parapet strip (no see-through rim)
      for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) % 4];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const u0 = pp / pU, u1 = (pp + L) / pU;
        const ia0 = push(a[0], yR, a[1], wallDim, u0, 0, wcell),
              ib0 = push(b[0], yR, b[1], wallDim, u1, 0, wcell),
              ib1 = push(b[0], top, b[1], wallDim, u1, PARAPET / 3, wcell),
              ia1 = push(a[0], top, a[1], wallDim, u0, PARAPET / 3, wcell);
        tri(ia0, ib0, ib1); tri(ia0, ib1, ia1);
        pp += L;
      }
      const pRF = 4;
      const rp = (du, dv) => push(cx + ux * du + vx * dv, yR, cz + uz * du + vz * dv, roof, du / pRF, dv / pRF, ROOFC.membrane);
      quad(rp(-hu, -hv), rp(hu, -hv), rp(hu, hv), rp(-hu, hv));   // up-facing (matches generic slab)
    } else {
      const rise = Math.min(hv * (o.pitch || 0.4), height * 0.9);
      const yE = top, yTop = top + rise, pR = 3, H = hu + OVERHANG, V = hv + OVERHANG;
      const pt = (du, dv, y, uu, vv) => push(cx + ux * du + vx * dv, y, cz + uz * du + vz * dv, roof, uu, vv, rcell);
      const vR = Math.hypot(V, rise) / pR;
      if (kind === 'hip') {
        const ru = Math.max(hu - hv, 0.01);
        quad(pt(-H, V, yE, -H / pR, 0), pt(H, V, yE, H / pR, 0), pt(ru, 0, yTop, ru / pR, vR), pt(-ru, 0, yTop, -ru / pR, vR));
        quad(pt(H, -V, yE, H / pR, 0), pt(-H, -V, yE, -H / pR, 0), pt(-ru, 0, yTop, -ru / pR, vR), pt(ru, 0, yTop, ru / pR, vR));
        const vH = Math.hypot(H - ru, rise) / pR;
        tri(pt(H, V, yE, V / pR, 0), pt(H, -V, yE, -V / pR, 0), pt(ru, 0, yTop, 0, vH));
        tri(pt(-H, -V, yE, -V / pR, 0), pt(-H, V, yE, V / pR, 0), pt(-ru, 0, yTop, 0, vH));
      } else {                                                  // gable + wall-textured gable ends
        quad(pt(-H, V, yE, -H / pR, 0), pt(H, V, yE, H / pR, 0), pt(H, 0, yTop, H / pR, vR), pt(-H, 0, yTop, -H / pR, vR));
        quad(pt(H, -V, yE, H / pR, 0), pt(-H, -V, yE, -H / pR, 0), pt(-H, 0, yTop, -H / pR, vR), pt(H, 0, yTop, H / pR, vR));
        const eV = (yE - baseY) / 3, aV = (yTop - baseY) / 3;
        const gp = (du, dv, y, uu, vv) => push(cx + ux * du + vx * dv, y, cz + uz * du + vz * dv, wall, uu, vv, wcell);
        tri(gp(hu, hv, yE, hv / pU, eV), gp(hu, -hv, yE, -hv / pU, eV), gp(hu, 0, yTop, 0, aV));
        tri(gp(-hu, -hv, yE, -hv / pU, eV), gp(-hu, hv, yE, hv / pU, eV), gp(-hu, 0, yTop, 0, aV));
      }
    }
  }

  const NEUTRAL = [0.96, 0.97, 0.96];   // near-white wall tint → texture colour shows nearly straight
  const BESPOKE = {
    // Long low great-room lodge: a long hip-roofed timber mass + a raised central great room whose
    // long sides are the JLL signature picture-window glazing (grand facade), low flat roof.
    'Jackson Lake Lodge': function (em) {
      const o = em.obb, b = { cx: o.cx, cz: o.cz, ux: o.ux, uz: o.uz, baseY: em.baseY, y0: em.y0 };
      const H = Math.max(em.h, 7.5);
      // long low timber lodge with a shallow hip roof
      emitMass(em, Object.assign({}, b, { hu: o.hu * 0.97, hv: o.hv * 0.58, height: H,
        wall: NEUTRAL, wcell: WALL.timber, roof: roofRGB('green'), rcell: ROOFC.metal,
        skirtCell: WALL.stone, roofKind: 'hip', pitch: 0.28 }));
      // raised central great room: long axis = u (glass on the broad ±v sides), projects past the
      // lodge walls and rises above the hip roof so the picture-window great room reads from the road
      emitMass(em, Object.assign({}, b, { hu: o.hu * 0.55, hv: o.hv * 0.66, height: H * 1.4,
        wall: NEUTRAL, wcell: WALL.timber, roof: roofRGB('charcoal'), rcell: ROOFC.membrane,
        skirtCell: WALL.stone, roofKind: 'flat', frontGrand: true }));
    },
    // Fronted visitor center: a gable-roofed NPS-timber hall + a projecting lower entrance mass
    // (double doors + sign board, mapped once over its height) pushed out past the front wall.
    'Colter Bay Visitor Center': function (em) {
      const o = em.obb, b = { cx: o.cx, cz: o.cz, ux: o.ux, uz: o.uz, baseY: em.baseY, y0: em.y0 };
      const H = Math.max(em.h, 7);
      emitMass(em, Object.assign({}, b, { hu: o.hu * 0.92, hv: o.hv * 0.72, height: H,
        wall: NEUTRAL, wcell: WALL.npsbrown, roof: roofRGB('green'), rcell: ROOFC.metal,
        skirtCell: WALL.stone, roofKind: 'gable', pitch: 0.5 }));
      // projecting lower entrance mass pushed out along -v (the approach/road side); its -v wall is
      // the ENTRANCE facade (double doors + sign board), so the VC reads as fronted, not a warehouse.
      const proj = o.hv * 0.72, vx = -o.uz, vz = o.ux;
      emitMass(em, { cx: o.cx - vx * proj, cz: o.cz - vz * proj, ux: o.ux, uz: o.uz,
        baseY: em.baseY, y0: em.y0, hu: o.hu * 0.40, hv: o.hv * 0.30, height: H * 0.66,
        wall: NEUTRAL, wcell: WALL.timber, roof: roofRGB('charcoal'), rcell: ROOFC.metal,
        skirtCell: WALL.stone, roofKind: 'gable', pitch: 0.42, frontEntrance: true });
    },
  };

  class BuildingManager {
    constructor(o) {
      this.scene = o.scene;
      this.terrain = o.terrain || null;
      this.transportSurface = o.transportSurface || global.transportSurface || null;
      this.sampleGround = o.sampleGround ||
        (o.terrain ? (x, z) => o.terrain.heightAt(x, z) : null);
      this.url = o.url || 'terrain/public/buildings.json';
      this.replacementNames = new Set(o.replacementNames || []);
      this.mesh = null;
      this.recs = [];              // per building: ring, bbox, baseY/topY, merged vertex range
      this.grid = new Map();       // collision buckets: "cx,cz" → [rec index]
      this.stats = { tris: 0, drawCalls: 0, count: 0 };
      // lazy re-base state (same converged-signature pattern as RoadRibbon.update())
      this._zBase = null; this._maxZoom = null;
      this._drapedSig = -1; this._frame = 0; this._pass = null;
    }

    async build() {
      let data;
      try {
        const res = await fetch(this.url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
      } catch (e) {
        console.info('[buildings] buildings.json unavailable — skipping.', e && e.message || e);
        return this;
      }
      if (!this.sampleGround) { console.info('[buildings] no ground sampler — skipping.'); return this; }

      const P = [], C = [], UV = [], CE = [], I = [];
      let v = 0;
      const push = (x, y, z, c, uu, vv, cel) => {
        P.push(x, y, z); C.push(c[0], c[1], c[2]);
        if (TEXTURED) { UV.push(uu, vv); CE.push(cel); }
        return v++;
      };
      const tri = (a, b, c) => { I.push(a, b, c); };
      const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };
      const approachFeatureId = (x, z) => {
        const out = {};
        return this.transportSurface &&
          this.transportSurface.nearest(x, z, 80, s => s.vehicleAllowed, out)
          ? out.featureId : null;
      };

      for (const b of (data.buildings || [])) {
        const raw = b.pts;
        if (!raw || raw.length < 3) continue;
        // clean: drop consecutive near-duplicates + a closing duplicate
        const pts = [raw[0]];
        for (let i = 1; i < raw.length; i++) {
          const p = raw[i], q = pts[pts.length - 1];
          if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= 0.3) pts.push(p);
        }
        if (pts.length >= 2) {
          const f = pts[0], l = pts[pts.length - 1];
          if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 0.3) pts.pop();
        }
        if (pts.length < 3) continue;
        let area = shoelace(pts);
        if (Math.abs(area) < 2) continue;                  // degenerate sliver
        if (area < 0) { pts.reverse(); area = -area; }     // normalize winding → outward walls

        // base from ground min over the ring (coarse at boot; refined lazily by update())
        let baseY = Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        let cx = 0, cz = 0;
        for (const p of pts) {
          const gy = this.sampleGround(p[0], p[1]);
          if (gy < baseY) baseY = gy;
          if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
          if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1];
          cx += p[0]; cz += p[1];
        }
        cx /= pts.length; cz /= pts.length;

        const h = b.h || 4;
        // Model-backed landmarks retain this precise footprint for collision and
        // world indexing, but contribute no generic extrusion geometry.
        if (b.name && this.replacementNames.has(b.name)) {
          const ring = new Float32Array(pts.length * 2);
          for (let i = 0; i < pts.length; i++) {
            ring[i * 2] = pts[i][0]; ring[i * 2 + 1] = pts[i][1];
          }
          this.recs.push({ ring, minX, maxX, minZ, maxZ, baseY, topY: baseY + 9,
            vStart: v, vCount: 0, replacement: b.name,
            approachFeatureId: approachFeatureId(cx, cz) });
          continue;
        }
        const st = STYLE[b.cls] || STYLE.generic;
        const cells = pickCells(b.cls, b.imp, area, h, cx, cz);
        const j1 = 0.90 + 0.20 * jit(cx, cz, 1), j2 = 0.92 + 0.16 * jit(cx, cz, 2);
        let wall, roof;
        if (TEXTURED) {
          // texture carries the wall colour; vertex tint = near-neutral jitter (slight warm/cool
          // cast). roof colour rides the vertex tint (region palette) over the neutral roof cell.
          const rt = cells.tint;
          const t = 0.90 + 0.16 * jit(cx, cz, 1);
          wall = [t * (0.98 + 0.05 * jit(cx, cz, 4)), t, t * (0.98 + 0.05 * jit(cx, cz, 5))];
          roof = [rt[0] / ROOF_PAINT * j2, rt[1] / ROOF_PAINT * j2, rt[2] / ROOF_PAINT * j2];
        } else {
          wall = [st.wall[0] * j1, st.wall[1] * j1, st.wall[2] * j1];
          roof = [st.roof[0] * j2, st.roof[1] * j2, st.roof[2] * j2];
        }
        const wallDim = [wall[0] * 0.8, wall[1] * 0.8, wall[2] * 0.8];

        const obb = obbFit(pts);

        // bespoke landmark massing (JLL, Colter VC): compose a distinctive silhouette from a few
        // sub-masses into the same merged geometry, then register the footprint for collision/rebase.
        const bespoke = b.name && BESPOKE[b.name];
        if (bespoke && obb) {
          const vS = v;
          bespoke({ push, tri, quad, obb, baseY, h, y0: baseY - SKIRT, cx, cz });
          const ring = new Float32Array(pts.length * 2);
          for (let i = 0; i < pts.length; i++) { ring[i * 2] = pts[i][0]; ring[i * 2 + 1] = pts[i][1]; }
          this.recs.push({ ring, minX, maxX, minZ, maxZ, baseY,
            topY: baseY + Math.max(h * 2.2, 16), vStart: vS, vCount: v - vS,
            approachFeatureId: approachFeatureId(cx, cz) });
          continue;
        }

        const rect = !!obb && area / obb.area >= RECT_RATIO && obb.hv > 1.2;
        const vStart = v;
        const y0 = baseY - SKIRT, yTop = baseY + h;
        const wCell = cells.w, rCell = cells.r;
        const isBarnCell = cells.isBarn;
        const fullMap = cells.fullMap;              // barn/grand facades map v over the whole wall
        const skirtCell = fullMap ? wCell : cells.skirt;   // stone foundation band (else facade)
        const pU = 3, pR = 3;                        // wall/roof world tile (m)
        const phase = 3 * jit(cx, cz, 3);            // per-building u shift → windows de-sync

        /* walls: u = running perimeter metres (grain continues around corners), v = metres above
           base. Split at grade — the skirt quad maps a squashed 0.28 m band (a stone foundation
           course for most buildings; the facade's own base for barn/grand) so buried windows can
           never surface on slopes. */
        const addWalls = (yTopWall, pV) => {
          let per = phase;
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i], b2 = pts[(i + 1) % pts.length];
            const L = Math.hypot(b2[0] - a[0], b2[1] - a[1]);
            const u0 = per / pU, u1 = (per + L) / pU, vT = (yTopWall - baseY) / pV;
            let a0 = push(a[0], baseY, a[1], wall, u0, 0, wCell),
                b0 = push(b2[0], baseY, b2[1], wall, u1, 0, wCell),
                b1 = push(b2[0], yTopWall, b2[1], wall, u1, vT, wCell),
                a1 = push(a[0], yTopWall, a[1], wall, u0, vT, wCell);
            tri(b0, a0, a1); tri(b0, a1, b1);
            const vS = 0.28 / pV;                    // skirt: squashed foundation strip
            a0 = push(a[0], y0, a[1], wall, u0, vS, skirtCell);
            b0 = push(b2[0], y0, b2[1], wall, u1, vS, skirtCell);
            b1 = push(b2[0], baseY, b2[1], wall, u1, 0, skirtCell);
            a1 = push(a[0], baseY, a[1], wall, u0, 0, skirtCell);
            tri(b0, a0, a1); tri(b0, a1, b1);
            per += L;
          }
        };

        if (rect) {
          const pt = (du, dv, y, c, uu, vv, cel) =>
            push(obb.cx + obb.ux * du + obb.vx * dv, y, obb.cz + obb.uz * du + obb.vz * dv, c, uu, vv, cel);
          if (isBarnCell) {
            // ---- gambrel barn roof (two-pitch): steep lower slopes + shallow upper slopes,
            //      giving the unmistakable Moulton/Mormon-Row barn silhouette ----
            const rise = Math.min(obb.hv * st.pitch, h * 0.8);
            const yE = yTop - rise;                        // eave = wall top; ridge = yTop
            const yK = yE + rise * 0.52;                   // knuckle (break) height
            const pV = Math.max(yE - baseY, 2.5);          // full-height facade to the eave
            addWalls(yE, pV);
            const H = obb.hu + OVERHANG, V = obb.hv + OVERHANG, kvR = obb.hv * 0.58;
            const vL = Math.hypot(V - kvR, yK - yE) / pR;  // lower-slope tile length
            const vU = Math.hypot(kvR, yTop - yK) / pR;    // upper-slope tile length
            quad(pt(-H, V, yE, roof, -H / pR, 0, rCell), pt(H, V, yE, roof, H / pR, 0, rCell),
                 pt(H, kvR, yK, roof, H / pR, vL, rCell), pt(-H, kvR, yK, roof, -H / pR, vL, rCell));
            quad(pt(-H, kvR, yK, roof, -H / pR, vL, rCell), pt(H, kvR, yK, roof, H / pR, vL, rCell),
                 pt(H, 0, yTop, roof, H / pR, vL + vU, rCell), pt(-H, 0, yTop, roof, -H / pR, vL + vU, rCell));
            quad(pt(H, -V, yE, roof, H / pR, 0, rCell), pt(-H, -V, yE, roof, -H / pR, 0, rCell),
                 pt(-H, -kvR, yK, roof, -H / pR, vL, rCell), pt(H, -kvR, yK, roof, H / pR, vL, rCell));
            quad(pt(H, -kvR, yK, roof, H / pR, vL, rCell), pt(-H, -kvR, yK, roof, -H / pR, vL, rCell),
                 pt(-H, 0, yTop, roof, -H / pR, vL + vU, rCell), pt(H, 0, yTop, roof, H / pR, vL + vU, rCell));
            // gambrel gable-end fills (pentagon fan, flush with the wall — wall texture)
            const kvW = obb.hv * 0.58;
            const gambrelEnd = (uEnd, s) => {
              const pv = (dv, y) => pt(uEnd, dv, y, wall, dv / pU, (y - baseY) / pV, wCell);
              const Pp = [pv(s * obb.hv, yE), pv(-s * obb.hv, yE), pv(-s * kvW, yK), pv(0, yTop), pv(s * kvW, yK)];
              tri(Pp[0], Pp[1], Pp[2]); tri(Pp[0], Pp[2], Pp[3]); tri(Pp[0], Pp[3], Pp[4]);
            };
            gambrelEnd(obb.hu, 1); gambrelEnd(-obb.hu, -1);
            const ring = new Float32Array(pts.length * 2);
            for (let i = 0; i < pts.length; i++) { ring[i * 2] = pts[i][0]; ring[i * 2 + 1] = pts[i][1]; }
            this.recs.push({ ring, minX, maxX, minZ, maxZ, baseY, topY: yTop,
              vStart, vCount: v - vStart, approachFeatureId: approachFeatureId(cx, cz) });
            continue;
          }
          // ---- pitched roof: gable (or hip) over the oriented bbox ----
          let rise = Math.min(obb.hv * st.pitch, h * 0.7);
          const yE = yTop - rise;                          // eave = wall top; ridge = yTop
          const pV = 3;
          addWalls(yE, pV);
          const H = obb.hu + OVERHANG, V = obb.hv + OVERHANG;
          const vR = Math.hypot(V, rise) / pR;             // slope length up the roof, tiled
          if (st.hip) {
            const ru = Math.max(obb.hu - obb.hv, 0.01);    // ridge shortened by the hip ends
            quad(pt(-H, V, yE, roof, -H / pR, 0, rCell), pt(H, V, yE, roof, H / pR, 0, rCell),
                 pt(ru, 0, yTop, roof, ru / pR, vR, rCell), pt(-ru, 0, yTop, roof, -ru / pR, vR, rCell));
            quad(pt(H, -V, yE, roof, H / pR, 0, rCell), pt(-H, -V, yE, roof, -H / pR, 0, rCell),
                 pt(-ru, 0, yTop, roof, -ru / pR, vR, rCell), pt(ru, 0, yTop, roof, ru / pR, vR, rCell));
            const vH = Math.hypot(H - ru, rise) / pR;      // hip-end slope length
            tri(pt(H, V, yE, roof, V / pR, 0, rCell), pt(H, -V, yE, roof, -V / pR, 0, rCell),
                pt(ru, 0, yTop, roof, 0, vH, rCell));
            tri(pt(-H, -V, yE, roof, -V / pR, 0, rCell), pt(-H, V, yE, roof, V / pR, 0, rCell),
                pt(-ru, 0, yTop, roof, 0, vH, rCell));
          } else {
            quad(pt(-H, V, yE, roof, -H / pR, 0, rCell), pt(H, V, yE, roof, H / pR, 0, rCell),
                 pt(H, 0, yTop, roof, H / pR, vR, rCell), pt(-H, 0, yTop, roof, -H / pR, vR, rCell));
            quad(pt(H, -V, yE, roof, H / pR, 0, rCell), pt(-H, -V, yE, roof, -H / pR, 0, rCell),
                 pt(-H, 0, yTop, roof, -H / pR, vR, rCell), pt(H, 0, yTop, roof, H / pR, vR, rCell));
            // gable-end fill triangles in wall texture (flush with the bbox, no overhang)
            const vE = (yE - baseY) / pV, vA = (yTop - baseY) / pV;
            tri(pt(obb.hu, obb.hv, yE, wall, obb.hv / pU, vE, wCell),
                pt(obb.hu, -obb.hv, yE, wall, -obb.hv / pU, vE, wCell),
                pt(obb.hu, 0, yTop, wall, 0, vA, wCell));
            tri(pt(-obb.hu, -obb.hv, yE, wall, -obb.hv / pU, vE, wCell),
                pt(-obb.hu, obb.hv, yE, wall, obb.hv / pU, vE, wCell),
                pt(-obb.hu, 0, yTop, wall, 0, vA, wCell));
          }
        } else {
          // ---- irregular ring: flat roof slab + parapet rim ----
          const yR = yTop - PARAPET;
          const pV = fullMap ? Math.max(h, 3) : 3;      // grand-lodge / barn facades map full height
          addWalls(yTop, pV);
          let per = phase;                                 // inward parapet strip (dimmed wall)
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i], b2 = pts[(i + 1) % pts.length];
            const L = Math.hypot(b2[0] - a[0], b2[1] - a[1]);
            const u0 = per / pU, u1 = (per + L) / pU;
            const vRi = (yR - baseY) / pV, vTi = (yTop - baseY) / pV;
            const ia0 = push(a[0], yR, a[1], wallDim, u0, vRi, wCell),
                  ib0 = push(b2[0], yR, b2[1], wallDim, u1, vRi, wCell),
                  ib1 = push(b2[0], yTop, b2[1], wallDim, u1, vTi, wCell),
                  ia1 = push(a[0], yTop, a[1], wallDim, u0, vTi, wCell);
            tri(ia0, ib0, ib1); tri(ia0, ib1, ia1);
            per += L;
          }
          let faces = null;
          try {
            faces = THREE.ShapeUtils.triangulateShape(
              pts.map(p => new THREE.Vector2(p[0], p[1])), []);
          } catch (e) { /* self-intersecting ring — fall back to the obb slab */ }
          const pRF = 4;                                   // membrane tile (m), world-aligned
          if (faces && faces.length) {
            for (const f of faces) {
              let [i0, i1, i2] = f;
              const p0 = pts[i0], p1 = pts[i1], p2 = pts[i2];
              // orient each triangle so its normal points UP (+y): needs 2D cross < 0 here
              const cross = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
              const q1 = cross > 0 ? p2 : p1, q2 = cross > 0 ? p1 : p2;
              const A = push(p0[0], yR, p0[1], roof, p0[0] / pRF, p0[1] / pRF, ROOFC.membrane);
              const B = push(q1[0], yR, q1[1], roof, q1[0] / pRF, q1[1] / pRF, ROOFC.membrane);
              const D = push(q2[0], yR, q2[1], roof, q2[0] / pRF, q2[1] / pRF, ROOFC.membrane);
              tri(A, B, D);
            }
          } else if (obb) {
            const pt = (du, dv) =>
              push(obb.cx + obb.ux * du + obb.vx * dv, yR, obb.cz + obb.uz * du + obb.vz * dv,
                   roof, du / pRF, dv / pRF, ROOFC.membrane);
            quad(pt(-obb.hu, -obb.hv), pt(obb.hu, -obb.hv), pt(obb.hu, obb.hv), pt(-obb.hu, obb.hv));
          }
        }

        const ring = new Float32Array(pts.length * 2);
        for (let i = 0; i < pts.length; i++) { ring[i * 2] = pts[i][0]; ring[i * 2 + 1] = pts[i][1]; }
        this.recs.push({ ring, minX, maxX, minZ, maxZ, baseY, topY: yTop,
          vStart, vCount: v - vStart, approachFeatureId: approachFeatureId(cx, cz) });
      }

      if (!this.recs.length) { console.info('[buildings] no valid footprints.'); return this; }
      // M7.1 baked contact AO: darken each building's vertex colours toward its own ground line so
      // wall bases / eaves / tight clusters read as occluded. Baked into the vertex colours the merged
      // Lambert mesh already carries → no shader, no uniform, zero per-frame cost, hardware MSAA intact,
      // and WORLD-ANCHORED so it can never crawl (unlike a screen-space SSAO). Height-based (relative
      // to the footprint's baseY), so sloped sites get a uniform-height band, not a ground-following one.
      for (const r of this.recs) {
        for (let i = r.vStart; i < r.vStart + r.vCount; i++) {
          const yAbove = P[i * 3 + 1] - r.baseY;
          const ao = 0.62 + 0.38 * Math.min(1, Math.max(0, yAbove / 3.5));   // 0.62 at base → 1 by 3.5 m
          C[i * 3] *= ao; C[i * 3 + 1] *= ao; C[i * 3 + 2] *= ao;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
      if (TEXTURED) {
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
        geo.setAttribute('aCell', new THREE.Float32BufferAttribute(CE, 1));
      }
      geo.setIndex(I);
      geo.computeVertexNormals();     // verts are unique per face → clean flat shading
      geo.computeBoundingSphere();
      let mat;
      if (TEXTURED) {
        const tex = new THREE.CanvasTexture(makeAtlas());
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;   // fract() in-shader does the tiling
        tex.anisotropy = 4;                                  // oblique walls stay crisp
        mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: tex });
        // fract()-tiled atlas lookup per fragment: aCell picks the 4x4 cell, vUv is world-metre
        // tiles. (1-alpha) of the texel = painted window glass → faint warm emissive.
        // Anchored on include markers only — the 20-scene display-curve chunk patch is untouched.
        global.GTShaderExtensions.install(mat, {
          id: 'building-atlas-tiles',
          version: 1,
          patch: (shader, edit) => {
            shader.uniforms.uTetonNight = (global.TETON_LIGHT_UNIFORMS =
              global.TETON_LIGHT_UNIFORMS || { uNight:{ value:0 } }).uNight;
            edit.prepend('vertex',
              'attribute float aCell;\nvarying float vTetonCell;\nvarying vec2 vTetonUv;\n');
            edit.replace('vertex', '#include <uv_vertex>',
              '#include <uv_vertex>\n  vTetonCell = aCell;\n  vTetonUv = uv;');
            edit.prepend('fragment',
              'varying float vTetonCell;\nvarying vec2 vTetonUv;\nuniform float uTetonNight;\n');
            edit.replace('fragment', '#include <map_fragment>',
              ['vec2 tetonCellO = vec2(mod(vTetonCell, 8.0) / 8.0, floor(vTetonCell / 8.0) / 4.0);',
               'vec2 tetonAuv = tetonCellO + fract(vTetonUv) * vec2(0.125, 0.25);',
               'vec4 texelColor = texture2D(map, tetonAuv);',
               'diffuseColor.rgb *= texelColor.rgb;',
               // Only painted window panes may emit, and only after dark. Walls remain fully lit
               // by the scene so buildings cannot retain a flat daylight brightness at dusk.
               'float tetonWindowNight = smoothstep(0.45, 0.85, uTetonNight);',
               'totalEmissiveRadiance += vec3(1.0, 0.78, 0.46) * (1.0 - texelColor.a) * 0.08 * tetonWindowNight;'
              ].join('\n'));
          },
        });
      } else {
        mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      }
      this.mesh = new THREE.Mesh(geo, mat);
      this.mesh.frustumCulled = true; // one merged mesh, computed bounds
      // re-basing rewrites vertex Y in place, never the object transform
      this.mesh.matrixAutoUpdate = false; this.mesh.updateMatrix();
      this.scene.add(this.mesh);
      this.stats = { tris: I.length / 3, drawCalls: 1, count: this.recs.length };

      // collision buckets: each building's bbox → every grid cell it overlaps
      for (let bi = 0; bi < this.recs.length; bi++) {
        const r = this.recs[bi];
        const cx0 = Math.floor(r.minX / CELL), cx1 = Math.floor(r.maxX / CELL);
        const cz0 = Math.floor(r.minZ / CELL), cz1 = Math.floor(r.maxZ / CELL);
        for (let cxx = cx0; cxx <= cx1; cxx++) for (let czz = cz0; czz <= cz1; czz++) {
          const key = cxx + ',' + czz;
          let arr = this.grid.get(key);
          if (!arr) { arr = []; this.grid.set(key, arr); }
          arr.push(bi);
        }
      }
      global.buildingBlocked = (x, z, y) => this.blocked(x, z, y);
      const wi = global.GT_APP && global.GT_APP.worldIndex;
      if (wi) {
        const install = () => this._installWorldIndex();
        if (wi.ready) install(); else if (wi.initialized) wi.initialized.then(install);
      }
      console.info('[buildings]', this.stats.count, 'buildings,', this.stats.tris,
        'tris, 1 draw call' + (TEXTURED ? ', atlas-textured' : ''));
      return this;
    }

    _installWorldIndex() {
      const wi = global.GT_APP && global.GT_APP.worldIndex;
      if (!wi || !wi.ready) return Promise.resolve(false);
      return wi.installBuildingIndex({
        records: this.recs, buckets: this.grid, cell: CELL,
      }).catch(e => {
        console.info('[buildings] worker index unavailable', e && e.message || e);
        return false;
      });
    }

    /* true when (x,z) is inside a footprint — and, when y is given, below that building's roof */
    blocked(x, z, y) {
      const arr = this.grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
      if (!arr) return false;
      for (const bi of arr) {
        const r = this.recs[bi];
        if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) continue;
        if (y !== undefined && y > r.topY) continue;
        if (inRing(x, z, r.ring)) return true;
      }
      return false;
    }

    /* ============ lazy re-base — RoadRibbon.update()'s converged-signature pattern ============
       Buildings were placed on the coarse boot heights; as finer tiles stream in, each building
       only needs its base recomputed (min fine ground over its ring) and its WHOLE vertex range
       shifted by the delta — a uniform translate, so normals never need recomputing (and wall v
       is base-relative, so UVs stay valid too). Amortized at DRAPE_BUDGET buildings/frame,
       paused while the streamer is busy (motion frames cheap). */
    update() {
      const t = this.terrain;
      if (!t || !t.hCache || !this.mesh) return;
      if (this._zBase === null) {
        if (!t.m) return;
        this._zBase = Math.min(t.m.minZoom + 3, t.m.maxZoom);
        this._maxZoom = t.m.maxZoom;
      }
      if (this._maxZoom <= this._zBase) return;
      if (this._pass) {
        if (t.fetchQueue.length || t.uploadQueue.length || t.inFlight) return;
        this._stepPass();
        return;
      }
      if ((this._frame = (this._frame + 1) & 0x3fffffff) % 10 !== 0) return;   // poll ~6 Hz
      if (t.fetchQueue.length || t.uploadQueue.length || t.inFlight) return;   // let streams settle
      const sig = this._fineSig();
      if (sig === this._drapedSig) return;
      const idx = this._fineIndex();
      if (!idx) { this._drapedSig = sig; return; }
      this._pass = { sig, idx, bi: 0, touched: false };
      this._stepPass();
    }

    _stepPass() {
      const p = this._pass, idx = p.idx, bnd = idx.bounds;
      const pos = this.mesh.geometry.attributes.position, arr = pos.array;
      let budget = DRAPE_BUDGET;
      while (p.bi < this.recs.length && budget > 0) {
        const r = this.recs[p.bi++]; budget--;
        if (r.maxX < bnd.minX || r.minX > bnd.maxX ||
            r.maxZ < bnd.minZ || r.minZ > bnd.maxZ) continue;   // no fresh fine tile here
        let nb = Infinity, ok = true;
        const ring = r.ring;
        for (let k = 0; k < ring.length; k += 2) {
          const y = idx(ring[k], ring[k + 1]);
          if (y === null) { ok = false; break; }   // partial coverage → wait for a later pass
          if (y < nb) nb = y;
        }
        if (!ok) continue;
        const d = nb - r.baseY;
        r.baseY = nb; r.topY += d;
        if (Math.abs(d) < 0.02) continue;
        this._worldIndexDirty = true;
        const end = (r.vStart + r.vCount) * 3;
        for (let k = r.vStart * 3 + 1; k < end; k += 3) arr[k] += d;
        p.touched = true;
      }
      if (p.touched) { pos.needsUpdate = true; p.touched = false; }
      if (p.bi >= this.recs.length) {
        this._drapedSig = p.sig; this._pass = null;
        if (this._worldIndexDirty) {
          this._worldIndexDirty = false;
          this._installWorldIndex();
        }
      }
    }

    /* cheap signature of decoded finer-than-base height tiles (same as RoadRibbon._fineSig) */
    _fineSig() {
      const t = this.terrain, zBase = this._zBase; let sig = 0;
      for (const e of t.hCache.values()) {
        if (!e.decoded || e.z <= zBase) continue;
        sig = (sig + (((e.z * 73856093) ^ (e.x * 19349663) ^ (e.y * 83492791)) >>> 0)) >>> 0;
      }
      return sig;
    }

    /* bilinear height sampler over decoded finer-than-base tiles (same as RoadRibbon._fineIndex);
       null where no fine tile covers (x,z), plus a .bounds coverage bbox for skip tests */
    _fineIndex() {
      const t = this.terrain, S = t.m.tileSize, uMax = S - 1.001;
      const byZ = []; let zTop = -1;
      const hx = t.spanX / 2, hz = t.spanZ / 2, root = t.rootSpan;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const e of t.hCache.values()) {
        if (!e.decoded || e.z <= this._zBase) continue;
        (byZ[e.z] || (byZ[e.z] = new Map())).set(e.x * 4096 + e.y, e.decoded);
        if (e.z > zTop) zTop = e.z;
        const span = root / (1 << e.z);
        const x0 = e.x * span - hx, z0 = e.y * span - hz;
        if (x0 < minX) minX = x0; if (x0 + span > maxX) maxX = x0 + span;
        if (z0 < minZ) minZ = z0; if (z0 + span > maxZ) maxZ = z0 + span;
      }
      if (zTop < 0) return null;
      const zBase = this._zBase;
      const sampler = (x, z) => {
        for (let zz = zTop; zz > zBase; zz--) {
          const tiles = byZ[zz]; if (!tiles) continue;
          const span = root / (1 << zz);
          const tx = Math.floor((x + hx) / span), ty = Math.floor((z + hz) / span);
          const g = tiles.get(tx * 4096 + ty);
          if (!g) continue;
          let u = ((x + hx) / span - tx) * (S - 1), vv = ((z + hz) / span - ty) * (S - 1);
          u = Math.max(0, Math.min(uMax, u)); vv = Math.max(0, Math.min(uMax, vv));
          const i = u | 0, j = vv | 0, fu = u - i, fv = vv - j;
          const a = g[j * S + i], b = g[j * S + i + 1];
          const c = g[(j + 1) * S + i], d = g[(j + 1) * S + i + 1];
          return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
        }
        return null;
      };
      sampler.bounds = { minX, maxX, minZ, maxZ };
      return sampler;
    }
  }

  global.BuildingManager = BuildingManager;
})(window);
