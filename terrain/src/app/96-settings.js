'use strict';
/* 96-settings.js — opt-in QUALITY presets for visitors on varied hardware. Toggle with O
   (or the ⚙ button). Persists to localStorage. DEFAULT 'ultra' reproduces the pre-settings
   look exactly (min(dpr,2), shadows on, reflections on) — no change to the tuned experience;
   the lower presets are purely opt-in for weaker GPUs.
   DECLARES: window.GT_toggleSettings, window.GT_applyQuality.
   CONSUMES: renderer (20), window.SHADOW_FORCE_OFF (20), window.GT_waterBuilder (92, lazy).
   `GT_waterBuilder` is the one public reference published by boot after it creates the
   lexical `waterBuilder` instance. */
(function (global) {
  const PRESETS = {
    // ratioCap: cap on devicePixelRatio (render scale); shadows/reflect: feature toggles
    ultra:    { label: 'Ultra (default)', ratioCap: 2.0,  shadows: true,  reflect: true  },
    high:     { label: 'High',            ratioCap: 1.5,  shadows: true,  reflect: true  },
    balanced: { label: 'Balanced',        ratioCap: 1.0,  shadows: true,  reflect: false },
    low:      { label: 'Low (smoothest)', ratioCap: 0.75, shadows: false, reflect: false },
  };
  const ORDER = ['ultra', 'high', 'balanced', 'low'];
  const requested = new URLSearchParams(location.search).get('quality');
  let current = requested || localStorage.getItem('gt-quality') || 'ultra';
  if (!PRESETS[current]) current = 'ultra';

  // M7.x — adaptive governor default ON for the public deploy: weak GPUs self-heal (it only steps
  // DOWN when fps genuinely sags; a strong GPU never trips it, so it costs power users nothing). A
  // manual preset pick PINS quality (userChose + persisted opt-out below), so one click locks Ultra
  // forever on your own machine while a random visitor's laptop stays smooth. Opt out session-wide
  // with ?noautoquality, or persistently via the "Auto" panel toggle.
  let autoOn = !( /[?&]noautoquality(?:&|$)/.test(location.search) ||
                  localStorage.getItem('gt-quality-auto') === '0' );

  function apply() {
    const p = PRESETS[current];
    // render scale — the biggest lever. Re-setSize applies the new pixel ratio.
    renderer.setPixelRatio(Math.min(devicePixelRatio, p.ratioCap));
    renderer.setSize(innerWidth, innerHeight);
    global.SHADOW_FORCE_OFF = !p.shadows;
    // Terrain owns the dominant CPU/GPU working set. Resize it with the selected preset and trim
    // old tiles immediately instead of changing only framebuffer/effect cost.
    global.GT_terrain?.setQuality?.(current);
    // Water may not exist on the first pass. Boot publishes its actual lexical instance as
    // GT_waterBuilder and immediately calls GT_applyQuality; the deferred pass below remains a
    // fallback for slow boot paths.
    if (global.GT_waterBuilder) global.GT_waterBuilder.reflections = p.reflect;
  }
  global.GT_applyQuality = apply;
  global.GT_qualityInfo = () => ({
    current,
    auto: autoOn,
    pixelRatio: renderer.getPixelRatio(),
    preset: Object.assign({}, PRESETS[current])
  });

  let userChose = localStorage.getItem('gt-quality') != null;   // a persisted preset = an explicit pin (blocks auto)
  function set(key) {
    if (!PRESETS[key]) return;
    current = key;
    userChose = true;                        // manual pick: stop the adaptive governor, persist, respect it
    autoOn = false; localStorage.setItem('gt-quality-auto', '0');  // a manual pick PINS (persists opt-out of auto)
    localStorage.setItem('gt-quality', key);
    apply();
    render();
  }
  function setAuto(on) {                      // opt in/out of the adaptive governor from the panel
    autoOn = on;
    if (on) { localStorage.removeItem('gt-quality-auto'); userChose = false; }   // default state
    else localStorage.setItem('gt-quality-auto', '0');                            // persist opt-out
    render();
  }

  /* --- panel --- */
  let panel = null;
  function build() {
    panel = document.createElement('div');
    panel.id = 'settings';
    panel.innerHTML = '<div class="set-h">Graphics quality</div><div id="set-opts"></div>' +
      '<div class="set-note">Default is Ultra. Drop it if the frame rate is low — ' +
      'affects render scale, shadows &amp; water reflections.</div>' +
      '<div class="set-note" style="opacity:.6">O to close</div>';
    document.body.appendChild(panel);
    render();
  }
  function render() {
    if (!panel) return;
    const box = panel.querySelector('#set-opts');
    box.innerHTML = '';
    for (const k of ORDER) {
      const b = document.createElement('button');
      b.className = 'set-opt' + (k === current && !autoOn ? ' on' : '');
      b.textContent = PRESETS[k].label;
      b.onclick = () => set(k);
      box.appendChild(b);
    }
    const a = document.createElement('button');   // opt-in adaptive governor (default OFF)
    a.className = 'set-opt' + (autoOn ? ' on' : '');
    a.textContent = 'Auto (adapt to frame rate)';
    a.onclick = () => setAuto(!autoOn);
    box.appendChild(a);
  }
  global.GT_toggleSettings = function () {
    if (!panel) build();
    panel.classList.toggle('open');
  };

  apply();                                   // pixel-ratio + shadow immediately
  setTimeout(apply, 2500);                   // re-apply once water reflector exists (boot lag)
  addEventListener('resize', () => renderer.setPixelRatio(Math.min(devicePixelRatio, PRESETS[current].ratioCap)));

  /* --- adaptive quality (continuous) — default ON, gated by `autoOn` (M7.x) -------------------
     Steps the preset DOWN over any sustained low-fps window (dense-forest overdraw from altitude →
     ~9 fps, streamer starves, canopy "fuzz"). Default ON so a random visitor's weak GPU self-heals;
     a strong GPU never trips it, so power users lose nothing. It steps DOWN only (never up — no
     oscillation), holds ~24 fps or hits 'low', and yields the instant the visitor picks a preset by
     hand (userChose) — which also persists an opt-out, so ONE manual Ultra pick pins quality forever.
     Auto steps themselves are session-only (not persisted). Off via ?noautoquality / the Auto toggle;
     the rAF tick stays installed but early-returns before any work when off. */
  (function adaptiveGovernor() {
    const WINDOW_MS = 3000, MIN_FPS = 22;    // require a sustained low window before stepping down
    let frames = 0, acc = 0, last = performance.now(), wStart = last;
    (function tick(now) {
      requestAnimationFrame(tick);
      const dt = now - last; last = now;
      if (dt > 0 && dt < 500) { acc += dt; frames++; }         // ignore tab-hidden / huge stalls
      if (now - wStart < WINDOW_MS) return;
      const fps = frames > 4 ? frames / (acc / 1000) : 60;
      frames = 0; acc = 0; wStart = now;                       // reset the window
      if (!autoOn || userChose) return;                        // OPT-IN: pinned to the chosen preset by default
      const i = ORDER.indexOf(current);
      if (fps < MIN_FPS && i < ORDER.length - 1) {
        current = ORDER[i + 1]; apply(); render();
        if (typeof toast === 'function') toast('Graphics → ' + PRESETS[current].label + ' for a smoother frame rate (press O to change)');
      }
    })(last);
  })();
})(window);
