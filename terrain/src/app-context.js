export class AppContext {
  constructor({ THREE, GLTFLoader, workerPool = null, worldIndex = null } = {}) {
    this.THREE = THREE;
    this.GLTFLoader = GLTFLoader;
    this.workerPool = workerPool;
    this.worldIndex = worldIndex;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.uniforms = Object.create(null);
    this.services = Object.create(null);
    this.managers = Object.create(null);
    this.controls = Object.create(null);
    this.ui = Object.create(null);
    this.capture = Object.create(null);
  }

  register(group, name, value) {
    if (!this[group]) throw new Error(`Unknown AppContext group: ${group}`);
    this[group][name] = value;
    return value;
  }
}
