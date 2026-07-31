import * as THREE from 'three';

let renderer, scene, camera, clock, input = { keys: {}, dx: 0, dy: 0 };
let yaw = 0, pitch = -0.12, frames = 0, telemetryAt = 0;

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') init(data);
    else if (data.type === 'resize') resize(data);
    else if (data.type === 'input') input = data;
  } catch (error) {
    self.postMessage({ type: 'fatal', error: error?.stack || String(error) });
  }
};

function init({ canvas, width, height, pixelRatio }) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x88a9bd);
  scene.fog = new THREE.Fog(0x88a9bd, 500, 3500);
  camera = new THREE.PerspectiveCamera(66, width / height, 0.5, 5000);
  camera.position.set(0, 75, 260);
  scene.add(new THREE.HemisphereLight(0xcce7ff, 0x4b5148, 1.4));
  const sun = new THREE.DirectionalLight(0xffedcf, 3.2); sun.position.set(-500, 700, 350); scene.add(sun);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000, 64, 64),
    new THREE.MeshStandardMaterial({ color: 0x526b48, roughness: 0.92 }),
  );
  ground.rotation.x = -Math.PI / 2; scene.add(ground);
  clock = new THREE.Clock();
  self.postMessage({ type: 'ready', renderer: 'WebGLRenderer', revision: THREE.REVISION });
  renderer.setAnimationLoop(frame);
}

function frame(time) {
  const dt = Math.min(clock.getDelta(), 0.05);
  yaw -= input.dx * 0.002; pitch = THREE.MathUtils.clamp(pitch - input.dy * 0.002, -1.45, 1.45);
  const f = (input.keys.KeyW ? 1 : 0) - (input.keys.KeyS ? 1 : 0);
  const s = (input.keys.KeyD ? 1 : 0) - (input.keys.KeyA ? 1 : 0);
  camera.position.x += (-Math.sin(yaw) * f + Math.cos(yaw) * s) * 80 * dt;
  camera.position.z += (-Math.cos(yaw) * f - Math.sin(yaw) * s) * 80 * dt;
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
  renderer.render(scene, camera);
  frames++;
  if (time - telemetryAt > 1000) {
    self.postMessage({ type: 'telemetry', fps: frames, drawCalls: renderer.info.render.calls });
    frames = 0; telemetryAt = time;
  }
}

function resize({ width, height, pixelRatio }) {
  renderer.setPixelRatio(pixelRatio); renderer.setSize(width, height, false);
  camera.aspect = width / height; camera.updateProjectionMatrix();
}
