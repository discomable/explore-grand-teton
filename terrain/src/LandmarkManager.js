/* LandmarkManager — a tiny data-driven GLTF LOD layer for named structures.
 *
 * Only one LOD is visible per landmark. Assets are loaded once during optional
 * world boot, use ordinary PBR materials, and are re-based as finer terrain
 * arrives. The matching generic BuildingManager geometry is suppressed while
 * its footprint remains registered for collision.
 */
(function (global) {
  'use strict';
  const THREE = global.THREE;

  class LandmarkManager {
    constructor(options) {
      this.scene = options.scene;
      this.camera = options.camera;
      this.terrain = options.terrain || null;
      this.sampleGround = options.sampleGround;
      this.url = options.url || 'terrain/public/landmarks.json';
      this.draftRun = null;
      // Draft batches are intentionally local-only and live under the ignored pipeline work
      // directory. Never let a deployed query string replace the production landmark manifest.
      try {
        const host = global.location?.hostname || '';
        const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
        const run = new URLSearchParams(global.location?.search || '').get('landmarkDraftRun');
        if (local && run && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(run)) {
          this.draftRun = run;
          this.url = `terrain/pipeline/work/landmark-batches/${run}/preview/landmarks.json`;
        }
      } catch (_) {}
      this.landmarks = [];
      this.stats = { count: 0, triangles: 0, maxDrawCalls: 0, draftRun: this.draftRun };
      this._frame = 0;
      this._preparedMaterials = new WeakSet();
    }

    async build() {
      let data;
      try {
        const response = await fetch(this.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = await response.json();
      } catch (error) {
        console.info('[landmarks] manifest unavailable — skipping.', error && error.message || error);
        return this;
      }
      const loader = new THREE.GLTFLoader();
      await Promise.all((data.landmarks || []).map(record => this._load(record, loader)));
      this.stats.count = this.landmarks.length;
      console.info(this.draftRun ? `[landmarks draft ${this.draftRun}]` : '[landmarks]',
        this.stats.count, 'loaded,', this.stats.triangles,
        'tris across LODs, max', this.stats.maxDrawCalls, 'active draw calls');
      return this;
    }

    async _load(record, loader) {
      if (!record.position || !record.lods || !record.lods.length) return;
      const group = new THREE.Group();
      group.name = record.name;
      group.position.set(record.position[0], this.sampleGround(record.position[0], record.position[1]),
        record.position[1]);
      group.userData.source = record.source;
      this.scene.add(group);

      const lods = await Promise.all(record.lods.map(spec => new Promise((resolve, reject) => {
        loader.load(spec.url, gltf => resolve({ spec, root: gltf.scene }), undefined, reject);
      })));
      let maxCalls = 0;
      const sharedMaps = new Map();
      for (const [index, lod] of lods.entries()) {
        let calls = 0;
        lod.root.name = `${record.name} LOD${index}`;
        lod.root.visible = false;
        lod.root.traverse(child => {
          if (!child.isMesh) return;
          calls++;
          child.castShadow = true;
          child.receiveShadow = true;
          const geometry = child.geometry;
          const count = geometry.index ? geometry.index.count : geometry.attributes.position.count;
          this.stats.triangles += count / 3;
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          for (const material of materials) {
            if (!material) continue;
            if (material.map) {
              // Share one texture per material across a landmark's LODs. Keyed
              // on the material name: the old two-way test funnelled every
              // material except the barn's projection into one bucket, so a
              // building with a wall atlas and a separate roof texture would
              // have had whichever loaded first overwrite the other.
              const mapKey = material.name || 'material-atlas';
              const sharedMap = sharedMaps.get(mapKey);
              if (!sharedMap) sharedMaps.set(mapKey, material.map);
              else if (material.map !== sharedMap) {
                material.map.dispose();
                material.map = sharedMap;
              }
            }
            material.envMapIntensity = 0.45;
            this._prepareMaterial(material);
            material.needsUpdate = true;
          }
        });
        maxCalls = Math.max(maxCalls, calls);
        group.add(lod.root);
      }
      const settingDrawCalls = this._addSetting(record, group);
      this.stats.maxDrawCalls = Math.max(this.stats.maxDrawCalls, maxCalls + settingDrawCalls);
      const item = { record, group, lods, active: -1, groundY: group.position.y };
      this.landmarks.push(item);
      this._select(item, true);
    }

    _addSetting(record, group) {
      const spec = record.setting && record.setting.apron;
      if (!spec || !spec.radius) return 0;
      const rx = spec.radius[0], rz = spec.radius[1];
      const segments = 40, rings = 2;
      const positions = [], colors = [], alpha = [], indices = [];
      const color = new THREE.Color(spec.color || '#765b38');
      const rotation = spec.rotation || 0;
      const cos = Math.cos(rotation), sin = Math.sin(rotation);
      const baseX = group.position.x, baseZ = group.position.z, baseY = group.position.y;
      for (let ring = 0; ring <= rings; ring++) {
        const radial = ring / rings;
        for (let index = 0; index < segments; index++) {
          const angle = index / segments * Math.PI * 2;
          // Fixed low-frequency edge variation avoids the conspicuous perfect decal ellipse.
          const irregular = 1 + 0.075 * Math.sin(angle * 3 + 0.8) +
            0.045 * Math.sin(angle * 7 - 1.1);
          const lx0 = Math.cos(angle) * rx * radial * irregular;
          const lz0 = Math.sin(angle) * rz * radial * irregular;
          const lx = lx0 * cos - lz0 * sin, lz = lx0 * sin + lz0 * cos;
          const worldY = this.sampleGround(baseX + lx, baseZ + lz);
          positions.push(lx, (Number.isFinite(worldY) ? worldY - baseY : 0) + 0.045, lz);
          const shade = 0.80 + 0.12 * Math.sin(angle * 5.0 + radial);
          colors.push(color.r * shade, color.g * shade, color.b * shade);
          alpha.push(radial === 0 ? spec.opacity || 0.58 :
            radial === 1 ? 0 : (spec.opacity || 0.58) * 0.78);
        }
      }
      for (let ring = 0; ring < rings; ring++) {
        for (let index = 0; index < segments; index++) {
          const next = (index + 1) % segments;
          const a = ring * segments + index, b = ring * segments + next;
          const c = (ring + 1) * segments + index, d = (ring + 1) * segments + next;
          indices.push(a, c, b, b, c, d);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.setAttribute('settingAlpha', new THREE.Float32BufferAttribute(alpha, 1));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      const material = new THREE.MeshLambertMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      });
      material.name = `${record.name} dirt apron`;
      material.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader
          .replace('void main() {', 'attribute float settingAlpha;\nvarying float vSettingAlpha;\nvoid main() {\n  vSettingAlpha = settingAlpha;');
        shader.fragmentShader = shader.fragmentShader
          .replace('void main() {', 'varying float vSettingAlpha;\nvoid main() {')
          .replace('#include <color_fragment>',
            '#include <color_fragment>\n  diffuseColor.a *= vSettingAlpha;');
      };
      material.customProgramCacheKey = () => 'landmark-setting-apron-v1';
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `${record.name} worn earth apron`;
      mesh.receiveShadow = true;
      mesh.renderOrder = -1;
      group.add(mesh);
      return 1;
    }

    _prepareMaterial(material) {
      if (this._preparedMaterials.has(material)) return;
      this._preparedMaterials.add(material);
      if (!global.GTShaderExtensions) return;
      if (/weathered_shake_roof/i.test(material.name)) {
        global.GTShaderExtensions.install(material, {
          id: 'moulton-barn-weathered-roof',
          version: 1,
          patch: (shader, edit) => {
            edit.prepend('vertex', 'varying vec3 vBarnRoofLocal;\n');
            edit.replace('vertex', '#include <project_vertex>',
              'vBarnRoofLocal = transformed;\n#include <project_vertex>');
            edit.prepend('fragment', 'varying vec3 vBarnRoofLocal;\n');
            edit.replace('fragment', '#include <color_fragment>', [
              '#include <color_fragment>',
              'float barnRoofBoard = sin(vBarnRoofLocal.x * 29.0 + vBarnRoofLocal.z * 2.1);',
              'float barnRoofFade = 0.92 + 0.055 * barnRoofBoard;',
              'diffuseColor.rgb *= vec3(barnRoofFade * 1.01, barnRoofFade, barnRoofFade * 0.96);',
            ].join('\n'));
          },
        });
        return;
      }
      if (!/weathered_timber/i.test(material.name)) return;
      // Object-space grain is stable, mip-free and costs no additional texture
      // residency/fetch. It breaks the flat GLB base colour at close range while
      // LOD geometry supplies the larger log/plank relief.
      global.GTShaderExtensions.install(material, {
        id: 'moulton-barn-weathered-timber',
        version: 1,
        patch: (shader, edit) => {
          edit.prepend('vertex', 'varying vec3 vBarnLocal;\n');
          edit.replace('vertex', '#include <project_vertex>',
            'vBarnLocal = transformed;\n#include <project_vertex>');
          edit.prepend('fragment', 'varying vec3 vBarnLocal;\n');
          edit.replace('fragment', '#include <color_fragment>', [
            '#include <color_fragment>',
            'float barnCourse = sin(vBarnLocal.y * 23.0 + sin(vBarnLocal.x * 1.7));',
            'float barnGrain = sin(vBarnLocal.z * 47.0 + sin(vBarnLocal.x * 3.1));',
            'float barnWeather = 0.91 + 0.055 * barnCourse + 0.035 * barnGrain;',
            'diffuseColor.rgb *= vec3(barnWeather * 1.04, barnWeather, barnWeather * 0.91);',
          ].join('\n'));
        },
      });
    }

    _select(item, force) {
      const dx = this.camera.position.x - item.group.position.x;
      const dz = this.camera.position.z - item.group.position.z;
      const distance = Math.hypot(dx, dz);
      let selected = item.lods.length - 1;
      for (let index = 0; index < item.lods.length; index++) {
        if (distance <= item.lods[index].spec.maxDistance) {
          selected = index;
          break;
        }
      }
      if (!force && selected === item.active) return;
      for (let index = 0; index < item.lods.length; index++) {
        item.lods[index].root.visible = index === selected;
      }
      item.active = selected;
    }

    update() {
      if (!this.landmarks.length) return;
      for (const item of this.landmarks) this._select(item, false);
      if ((this._frame = (this._frame + 1) % 30) !== 0) return;
      if (this.terrain &&
          (this.terrain.fetchQueue.length || this.terrain.uploadQueue.length || this.terrain.inFlight)) return;
      for (const item of this.landmarks) {
        const x = item.group.position.x, z = item.group.position.z;
        const y = this.sampleGround(x, z);
        if (Number.isFinite(y) && Math.abs(y - item.groundY) > 0.02) {
          item.group.position.y = item.groundY = y;
        }
      }
    }
  }

  global.LandmarkManager = LandmarkManager;
})(window);
