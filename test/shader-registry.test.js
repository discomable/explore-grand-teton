import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
await import('../terrain/src/shader-extension-registry.js?test');

test('shader extensions assert anchors and compose stable cache keys', () => {
  const material = {
    needsUpdate: false,
    onBeforeCompile() {},
    customProgramCacheKey: () => 'base',
  };
  GTShaderExtensions.install(material, {
    id: 'test-extension',
    version: 3,
    patch(shader, edit) {
      edit.replace('vertex', '#include <begin_vertex>', '#include <begin_vertex>\nfloat testValue=1.0;');
    },
  });
  const shader = {
    uniforms: {},
    vertexShader: 'void main(){\n#include <begin_vertex>\n}',
    fragmentShader: 'void main(){}',
  };
  material.onBeforeCompile(shader);
  assert.match(shader.vertexShader, /testValue/);
  assert.equal(material.customProgramCacheKey(), 'base|test-extension@3');
  assert.equal(material.needsUpdate, true);

  assert.throws(
    () => material.onBeforeCompile({ vertexShader: 'void main(){}', fragmentShader: 'void main(){}' }),
    /missing vertex anchor/,
  );
});
