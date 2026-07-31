/* Central registry for built-in Three.js material shader extensions.
 *
 * Managers remain classic scripts during the module migration, so this file exposes
 * a deliberately small API as window.GTShaderExtensions. Load it before any manager
 * that registers an extension.
 */
(function (global) {
  'use strict';

  const records = new WeakMap();

  function assertText(value, label) {
    if (typeof value !== 'string' || !value) {
      throw new TypeError('[shader-extension] ' + label + ' must be a non-empty string');
    }
  }

  function requireAnchor(source, anchor, extensionId, stage) {
    assertText(anchor, 'anchor');
    if (!source.includes(anchor)) {
      throw new Error(
        '[shader-extension:' + extensionId + '] missing ' + stage +
        ' anchor ' + JSON.stringify(anchor)
      );
    }
  }

  function makeEditor(shader, extensionId) {
    return {
      prepend(stage, source) {
        assertText(source, 'prepend source');
        const key = stage + 'Shader';
        if (typeof shader[key] !== 'string') {
          throw new Error('[shader-extension:' + extensionId + '] invalid shader stage ' + stage);
        }
        shader[key] = source + shader[key];
      },

      replace(stage, anchor, replacement) {
        const key = stage + 'Shader';
        const source = shader[key];
        if (typeof source !== 'string') {
          throw new Error('[shader-extension:' + extensionId + '] invalid shader stage ' + stage);
        }
        requireAnchor(source, anchor, extensionId, stage);
        shader[key] = source.replace(anchor, replacement);
      },

      require(stage, anchor) {
        const key = stage + 'Shader';
        const source = shader[key];
        if (typeof source !== 'string') {
          throw new Error('[shader-extension:' + extensionId + '] invalid shader stage ' + stage);
        }
        requireAnchor(source, anchor, extensionId, stage);
      },
    };
  }

  function install(material, extension) {
    if (!material || typeof material !== 'object') {
      throw new TypeError('[shader-extension] material is required');
    }
    if (!extension || typeof extension !== 'object') {
      throw new TypeError('[shader-extension] extension is required');
    }
    assertText(extension.id, 'extension.id');
    if (typeof extension.patch !== 'function') {
      throw new TypeError('[shader-extension:' + extension.id + '] patch must be a function');
    }

    let record = records.get(material);
    if (!record) {
      const previousCompile = material.onBeforeCompile;
      const previousCacheKey = material.customProgramCacheKey;
      record = { extensions: [], previousCompile, previousCacheKey };
      records.set(material, record);

      material.onBeforeCompile = function (shader, renderer) {
        if (typeof record.previousCompile === 'function') {
          record.previousCompile.call(this, shader, renderer);
        }
        for (const item of record.extensions) {
          item.patch(shader, makeEditor(shader, item.id), renderer);
        }
      };

      material.customProgramCacheKey = function () {
        const base = typeof record.previousCacheKey === 'function'
          ? record.previousCacheKey.call(this)
          : '';
        const keys = record.extensions.map((item) =>
          item.id + '@' + String(item.version == null ? 1 : item.version)
        );
        return [base].concat(keys).filter(Boolean).join('|');
      };
    }

    if (record.extensions.some((item) => item.id === extension.id)) {
      throw new Error('[shader-extension:' + extension.id + '] already installed on material');
    }
    record.extensions.push({
      id: extension.id,
      version: extension.version,
      patch: extension.patch,
    });
    material.needsUpdate = true;
    return material;
  }

  global.GTShaderExtensions = Object.freeze({ install });
})(window);
