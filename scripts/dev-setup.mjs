#!/usr/bin/env node
/*
 * dev-setup.mjs — fetch a local terrain tile pyramid for offline development.
 *
 * A fresh clone has the ~13 MB of baked rasters, manifests and models tracked in git,
 * but NOT the bulk height/imagery pyramids (~483 MB) or treepoints.bin (~19 MB) —
 * those are hosted on Cloudflare R2 (see DEPLOY.md). Without them the app renders
 * nothing useful from localhost, because local dev resolves tiles to ./terrain/public.
 *
 * The pyramid is very top-heavy: z7 alone is roughly two-thirds of the bytes. So a
 * truncated pyramid buys a fully explorable world for a fraction of the download:
 *
 *   z0-z5   ~44 MB   whole park, coarse ground detail   (default)
 *   z0-z6  ~151 MB   near-production
 *   z0-z7  ~483 MB   production
 *
 * IMPORTANT — why this script rewrites the manifests. TerrainStreamer derives the
 * world extent from the manifest (TerrainStreamer.js, `rootSpan`):
 *
 *   rootSpan = tileSize * 2^maxZoom * nativePixelSize     = 512 * 2^7 * 1.25 = 81920 m
 *
 * maxZoom and nativePixelSize jointly encode that extent, so lowering maxZoom alone
 * shrinks the world by 4x per dropped level (81920 m -> 20480 m at z5) and silently
 * misaligns every landmark, road and building. There is no error — just a wrong world
 * that looks like a rendering bug. So the two move together:
 *
 *   maxZoom -= N ;  nativePixelSize *= 2^N        (rootSpan unchanged)
 *
 * which is also simply true: a z5 tile really does cover 4x the ground per pixel.
 *
 * Because every tile request is clamped by Math.min(node.z, maxZoom), a correctly
 * truncated manifest requests nothing that is absent — no 404s, no retry churn.
 *
 * Usage:
 *   node scripts/dev-setup.mjs                     # z0-z5 (~44 MB)
 *   node scripts/dev-setup.mjs --max-zoom 7        # full production pyramid
 *   node scripts/dev-setup.mjs --treepoints        # also fetch treepoints.bin (~19 MB)
 *   node scripts/dev-setup.mjs --restore           # put the manifests back, keep the tiles
 *   node scripts/dev-setup.mjs --base <url>        # fetch from somewhere other than R2
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const publicDir = resolve(root, 'terrain/public');

// Same public bucket the deployed build streams from (see DEPLOY.md and the tile-source
// IIFE in grand-teton-3d.html). Best-effort and rate-limited; override with --base.
const DEFAULT_BASE = 'https://pub-7e6650521824431097870dcf01f3e4e2.r2.dev/';

const LAYERS = [
  { manifest: 'tiles.json', label: 'height' },
  { manifest: 'imagery.json', label: 'imagery' },
];

const CONCURRENCY = 16;

function parseArgs(argv) {
  const opts = { maxZoom: 5, treepoints: false, restore: false, base: DEFAULT_BASE, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--max-zoom') opts.maxZoom = Number(argv[++i]);
    else if (arg === '--treepoints') opts.treepoints = true;
    else if (arg === '--restore') opts.restore = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--base') opts.base = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else die(`unknown argument: ${arg} (try --help)`);
  }
  if (!opts.base.endsWith('/')) opts.base += '/';
  return opts;
}

function die(message) {
  console.error(`dev-setup: ${message}`);
  process.exit(1);
}

function git(...args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

/* The pristine manifest as committed. Read from git rather than from disk so that
 * re-running with a different --max-zoom recomputes from the ORIGINAL maxZoom and
 * nativePixelSize instead of compounding a previous truncation. */
async function pristineManifest(name) {
  const path = `terrain/public/${name}`;
  const show = git('show', `HEAD:${path}`);
  if (!show.error && show.status === 0) return JSON.parse(show.stdout);
  console.warn(`dev-setup: no git checkout, reading ${name} from disk (re-runs may compound)`);
  return JSON.parse(await readFile(resolve(root, path), 'utf8'));
}

function gridAt(manifest, z) {
  const cols = Math.ceil(manifest.width / manifest.tileSize);
  const rows = Math.ceil(manifest.height / manifest.tileSize);
  const step = 2 ** (manifest.maxZoom - z);
  return { cols: Math.ceil(cols / step), rows: Math.ceil(rows / step) };
}

function tileUrls(manifest, maxZoom) {
  const out = [];
  for (let z = manifest.minZoom ?? 0; z <= maxZoom; z++) {
    const { cols, rows } = gridAt(manifest, z);
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) {
        out.push(manifest.url.replace('{z}', z).replace('{x}', x).replace('{y}', y));
      }
    }
  }
  return out;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fetchAll(relPaths, base, label) {
  const pending = relPaths.slice();
  const stats = { downloaded: 0, skipped: 0, missing: 0, bytes: 0 };
  const total = pending.length;
  let done = 0;
  let failed = null;

  async function worker() {
    while (pending.length && !failed) {
      const rel = pending.pop();
      const dest = resolve(publicDir, rel);
      done++;
      if (await exists(dest)) {
        stats.skipped++;
        continue;
      }
      try {
        const response = await fetch(base + rel);
        if (response.status === 404) {
          stats.missing++;
          continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = Buffer.from(await response.arrayBuffer());
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, body);
        stats.downloaded++;
        stats.bytes += body.length;
      } catch (error) {
        failed = `${rel}: ${error.message}`;
        return;
      }
      if (stats.downloaded % 100 === 0) {
        process.stdout.write(`\r  ${label}: ${done}/${total} (${mb(stats.bytes)} MB)   `);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (failed) die(`fetch failed at ${failed}\n  (re-run to resume — existing files are skipped)`);
  process.stdout.write(`\r  ${label}: ${total} tiles — ${stats.downloaded} fetched, ${stats.skipped} already present`);
  if (stats.missing) process.stdout.write(`, ${stats.missing} absent upstream`);
  process.stdout.write(`  (${mb(stats.bytes)} MB)\n`);
  return stats;
}

const mb = (bytes) => (bytes / 1e6).toFixed(1);

async function restore() {
  const paths = LAYERS.map((layer) => `terrain/public/${layer.manifest}`);
  const checkout = git('checkout', '--', ...paths);
  if (checkout.error || checkout.status !== 0) {
    die(`could not restore manifests: ${checkout.stderr?.trim() || 'git checkout failed'}`);
  }
  console.log(`dev-setup: restored ${paths.join(', ')} to their committed values.`);
  console.log('The downloaded tiles are untouched; the app will now request the full pyramid.');
}

/* Refuse to clobber manifest edits that are not ours. The truncated maxZoom /
 * nativePixelSize pair is a LOCAL DEV state and must never be committed — it would
 * ship a 16x-too-small world to everyone. */
function assertManifestsClean(force) {
  const paths = LAYERS.map((layer) => `terrain/public/${layer.manifest}`);
  const status = git('status', '--porcelain', '--', ...paths);
  if (status.error || status.status !== 0) return; // no git — nothing to protect
  const dirty = status.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (dirty.length && !force) {
    die(
      `these manifests already have uncommitted changes:\n${dirty.map((l) => `  ${l}`).join('\n')}\n` +
        '  This script rewrites maxZoom/nativePixelSize, so it will not overwrite them blindly.\n' +
        '  Run "node scripts/dev-setup.mjs --restore" first, or pass --force to overwrite.',
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(await readFile(import.meta.filename, 'utf8').then((src) => src.slice(src.indexOf('/*'), src.indexOf('*/') + 2)));
    return;
  }
  if (opts.restore) return restore();

  const pristine = {};
  for (const layer of LAYERS) pristine[layer.manifest] = await pristineManifest(layer.manifest);

  const hardMax = Math.min(...LAYERS.map((layer) => pristine[layer.manifest].maxZoom));
  if (!Number.isInteger(opts.maxZoom) || opts.maxZoom < 0 || opts.maxZoom > hardMax) {
    die(`--max-zoom must be an integer between 0 and ${hardMax} (the deepest baked level)`);
  }
  assertManifestsClean(opts.force);

  const dropped = hardMax - opts.maxZoom;
  console.log(`dev-setup: fetching z0-z${opts.maxZoom} from ${opts.base}`);
  if (dropped) console.log(`  (${dropped} level(s) below the baked maximum of z${hardMax} — coarser ground detail)`);

  for (const layer of LAYERS) {
    const manifest = pristine[layer.manifest];
    await fetchAll(tileUrls(manifest, opts.maxZoom), opts.base, layer.label);
  }

  if (opts.treepoints) {
    await fetchAll(['treepoints.bin'], opts.base, 'treepoints');
  }

  // Rewrite the manifests so the streamer never asks for a level we did not fetch,
  // holding rootSpan constant. See the header comment for why both fields must move.
  for (const layer of LAYERS) {
    const manifest = { ...pristine[layer.manifest] };
    const before = manifest.tileSize * 2 ** manifest.maxZoom * manifest.nativePixelSize;
    manifest.maxZoom = opts.maxZoom;
    manifest.nativePixelSize = pristine[layer.manifest].nativePixelSize * 2 ** dropped;
    const after = manifest.tileSize * 2 ** manifest.maxZoom * manifest.nativePixelSize;
    if (Math.abs(before - after) > 1e-6) {
      die(`internal error: ${layer.manifest} rootSpan changed ${before} -> ${after}; refusing to write`);
    }
    await writeFile(resolve(publicDir, layer.manifest), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`  ${layer.manifest}: maxZoom ${hardMax} -> ${manifest.maxZoom}, ` +
                `nativePixelSize ${pristine[layer.manifest].nativePixelSize} -> ${manifest.nativePixelSize} ` +
                `(rootSpan held at ${after} m)`);
  }

  console.log('\nDone. Start the app with:');
  console.log('  npm run dev -- --port 8130');
  if (dropped) {
    console.log('\nNOTE: tiles.json/imagery.json are tracked files and now differ from HEAD.');
    console.log('Do NOT commit them — a truncated maxZoom would ship a smaller world to everyone.');
    console.log('Undo with: node scripts/dev-setup.mjs --restore');
  }
}

await main();
