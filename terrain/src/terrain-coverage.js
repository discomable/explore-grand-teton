export function summarizeVisibleTerrain(nodes, meshes, frame) {
  const visible = [];
  for (const node of nodes || []) {
    if (!node || node.internal || !node.render) continue;
    visible.push(node);
  }

  let drawableLeaves = 0;
  let nativeHeightLeaves = 0;
  const missingLeaves = [];
  for (const node of visible) {
    const key = `${node.z}/${node.x}/${node.y}`;
    const entry = meshes?.get?.(key);
    const drawable = Boolean(
      node.hSrc && entry?.mesh?.visible && entry.lastShown === frame
    );
    if (drawable) drawableLeaves++;
    else if (missingLeaves.length < 12) missingLeaves.push(key);

    const nativeZ = Math.min(node.z, node.nativeHeightMaxZoom ?? node.z);
    if (node.hSrc && node.hSrc.z >= nativeZ) nativeHeightLeaves++;
  }

  const visibleLeaves = visible.length;
  const ratio = visibleLeaves ? drawableLeaves / visibleLeaves : 0;
  const nativeHeightRatio = visibleLeaves ? nativeHeightLeaves / visibleLeaves : 0;
  return {
    visibleLeaves,
    drawableLeaves,
    missingLeaves,
    ratio: +ratio.toFixed(6),
    nativeHeightLeaves,
    nativeHeightRatio: +nativeHeightRatio.toFixed(6),
    complete: visibleLeaves > 0 && drawableLeaves === visibleLeaves,
  };
}
