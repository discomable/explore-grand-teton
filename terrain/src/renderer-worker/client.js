export async function startRenderWorkerIfRequested(context) {
  if (new URLSearchParams(location.search).get('renderWorker') !== '1') return { active: false };
  if (!HTMLCanvasElement.prototype.transferControlToOffscreen || typeof Worker === 'undefined') {
    console.warn('[render-worker] OffscreenCanvas/module workers unavailable; using main-thread renderer.');
    return { active: false };
  }

  const canvas = document.createElement('canvas');
  canvas.id = 'renderCanvas';
  document.body.appendChild(canvas);
  const entryReady = prepareEntryOverlay(canvas);
  const worker = new Worker(new URL('./renderer-worker.js', import.meta.url), { type: 'module' });
  context.services.rendererWorker = worker;
  const offscreen = canvas.transferControlToOffscreen();

  return new Promise(resolve => {
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      console.error('[render-worker] initialization failed; reloading main-thread renderer.', error);
      const url = new URL(location.href);
      url.searchParams.delete('renderWorker');
      location.replace(url);
    };
    const timer = setTimeout(() => fail(new Error('initialization timeout')), 8000);
    worker.onerror = event => fail(event.error || new Error(event.message));
    worker.onmessage = ({ data }) => {
      if (data.type === 'ready' && !settled) {
        settled = true; clearTimeout(timer);
        wireInput(worker, canvas);
        entryReady(data);
        resolve({ active: true, worker });
      } else if (data.type === 'telemetry') {
        window.GT_RENDER_WORKER_TELEMETRY = data;
      } else if (data.type === 'fatal') fail(new Error(data.error));
    };
    worker.postMessage({
      type: 'init', canvas: offscreen, width: innerWidth, height: innerHeight,
      pixelRatio: Math.min(devicePixelRatio, 2),
    }, [offscreen]);
  });
}

function prepareEntryOverlay(canvas) {
  const overlay = document.getElementById('overlay');
  const message = document.getElementById('loadmsg');
  const cta = document.getElementById('ctaText');
  let ready = false;
  let enterRequested = false;
  const enter = () => {
    enterRequested = true;
    if (!ready) {
      if (message) message.textContent = 'Starting renderer worker…';
      return;
    }
    overlay?.classList.add('hidden');
    canvas.requestPointerLock?.();
  };
  overlay?.addEventListener('click', enter);
  return info => {
    ready = true;
    if (message) message.textContent = `Renderer worker ready — Three.js r${info.revision}.`;
    if (cta) cta.textContent = 'Click to enter renderer-worker preview';
    if (enterRequested) enter();
  };
}

function wireInput(worker, canvas) {
  const keys = Object.create(null);
  addEventListener('keydown', event => { keys[event.code] = true; });
  addEventListener('keyup', event => { keys[event.code] = false; });
  let dx = 0, dy = 0;
  addEventListener('mousemove', event => { dx += event.movementX; dy += event.movementY; });
  canvas.addEventListener('click', () => canvas.requestPointerLock?.());
  addEventListener('resize', () => worker.postMessage({
    type: 'resize', width: innerWidth, height: innerHeight, pixelRatio: Math.min(devicePixelRatio, 2),
  }));
  const sample = () => {
    worker.postMessage({ type: 'input', keys: { ...keys }, dx, dy });
    dx = dy = 0;
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}
