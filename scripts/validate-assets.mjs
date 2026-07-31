import { access, lstat, readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { extname, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifestPath = resolve(root, 'terrain/public/assets-manifest.json');
const publicRoot = resolve(root, 'terrain/public');
const acceptedLicenses = new Set([
  'CC0-1.0',
  'CC-BY-4.0',
  'ODbL-1.0',
]);

// Licenses that impose an attribution obligation, and the string an entry's
// attribution must name so the obligation is visible where it is relied on.
const ATTRIBUTION_REQUIRED = new Map([
  ['CC-BY-4.0', /CC BY 4\.0/i],
  ['ODbL-1.0', /ODbL/i],
]);

// Runtime asset file types the manifest is expected to cover.
const ASSET_EXTENSIONS = new Set(['.glb', '.png', '.jpg', '.jpeg', '.webp', '.bin']);

// File types under terrain/public/ that are deliberately NOT runtime assets
// (manifests, docs, build scripts). Anything whose extension appears in neither
// this set nor ASSET_EXTENSIONS is a hard failure rather than a silent skip:
// a new asset type (.ktx2, .hdr, .exr, .mp3, .gltf, ...) must be classified
// on purpose, or coverage would quietly stop meaning what it claims.
const NON_ASSET_EXTENSIONS = new Set(['.json', '.md', '.py', '.gitignore']);

// Directories under terrain/public/ to skip entirely when walking for coverage.
// Keep this in sync with .gitignore - each entry below names the .gitignore
// line it corresponds to.
const EXCLUDED_DIRS = new Set([
  'tiles',            // .gitignore:21 - bulk height+imagery tile pyramid (~483 MB), hosted on Cloudflare R2, not in git
  'imagery',          // .gitignore:22 - bulk imagery pyramid, hosted on Cloudflare R2, not in git
  'atlas-candidates', // .gitignore:17 - raw CC0 tree-cutout bake inputs for veg-atlas.png; never shipped themselves
]);

// Individual files under terrain/public/ to skip when walking for coverage.
const EXCLUDED_FILES = new Set([
  'treepoints.bin', // .gitignore:47 - tree-dot point set (~20 MB), hosted on Cloudflare R2, not in git
]);

// "Shipped" means tracked, plus untracked-and-not-ignored - i.e. everything that
// ships or would ship on the next commit. Deriving the set from git rather than
// from a raw filesystem walk keeps gitignored local clutter (.wrangler/ miniflare
// state, editor leftovers) out of coverage without an exclusion rule per kind of
// junk, while still catching a brand-new asset dropped in without a manifest
// entry - the case that actually happens.
function trackedPublicFiles() {
  const args = ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '--', 'terrain/public'];
  const git = spawnSync('git', args, { encoding: 'utf8' });
  if (git.error || git.status !== 0) return null;
  return git.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(sep).join('/'));
}

// Fallback for a non-git context (extracted tarball): walk the filesystem and
// hope local clutter is absent. Less precise than the git path, so it skips
// dotfiles and dot-directories, which are never shipped assets.
async function walkPublicFiles(dir) {
  const found = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absPath = resolve(dir, entry.name);
    const relPath = relative(publicRoot, absPath).split(sep).join('/');
    // A symlink reports false for both isDirectory() and isFile(), so it would
    // otherwise be skipped silently - exactly the blind spot this walk exists to
    // close. Refuse it instead: nothing in the asset tree needs to be a link.
    if (entry.isSymbolicLink()) {
      fail(`terrain/public/${relPath} is a symlink; asset coverage does not follow links`);
      continue;
    }
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(relPath)) continue;
      found.push(...(await walkPublicFiles(absPath)));
      continue;
    }
    if (!entry.isFile()) continue;
    found.push(`terrain/public/${relPath}`);
  }
  return found;
}

// Reduce a shipped-file list to the runtime assets that need a manifest entry.
// An extension in neither classification set is a hard failure rather than a
// silent skip: a new asset type (.ktx2, .hdr, .exr, .mp3, .gltf, ...) must be
// classified on purpose, or coverage quietly stops meaning what it claims.
async function selectAssets(files) {
  const assets = [];
  for (const file of files) {
    const relPath = file.slice('terrain/public/'.length);
    if (EXCLUDED_FILES.has(relPath)) continue;
    if ([...EXCLUDED_DIRS].some((dir) => relPath.startsWith(`${dir}/`))) continue;
    // git lists deleted-but-unstaged paths, so confirm the file is really here.
    try {
      await lstat(resolve(root, file));
    } catch {
      continue;
    }
    const name = relPath.split('/').pop();
    const ext = extname(name).toLowerCase() || name.toLowerCase();
    if (NON_ASSET_EXTENSIONS.has(ext)) continue;
    if (!ASSET_EXTENSIONS.has(ext)) {
      fail(
        `${file} has unclassified file type "${ext}" - add it to ` +
          `ASSET_EXTENSIONS (needs a manifest entry) or NON_ASSET_EXTENSIONS (not an asset)`,
      );
      continue;
    }
    assets.push(file);
  }
  return assets;
}

// EXCLUDED_DIRS/EXCLUDED_FILES are matched against the filesystem, which says
// nothing about whether the bulk content they cover is still untracked. If a
// real asset were ever committed inside one (git add -f, or a narrowed
// .gitignore), it would be excluded from coverage forever and silently. Assert
// the .gitignore comments above are still true. Skipped, with a note, outside a
// git checkout so the validator still works from an extracted tarball.
async function checkExclusionsAreUntracked() {
  const paths = [
    ...[...EXCLUDED_DIRS].map((dir) => `terrain/public/${dir}`),
    ...[...EXCLUDED_FILES].map((file) => `terrain/public/${file}`),
  ];
  const git = spawnSync('git', ['-C', root, 'ls-files', '--', ...paths], { encoding: 'utf8' });
  if (git.error || git.status !== 0) {
    console.log('asset manifest: skipped excluded-path tracking check (no usable git checkout)');
    return;
  }
  // A path whose deletion is staged-or-pending is still listed by ls-files but
  // is not shipping, so judge by what is actually on disk.
  const listed = git.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const tracked = [];
  for (const file of listed) {
    try {
      await lstat(resolve(root, file));
      tracked.push(file);
    } catch { /* pending deletion - not shipped */ }
  }
  if (tracked.length) {
    fail(
      `${tracked.length} file(s) are git-tracked inside a coverage-excluded path, so they ship ` +
        `without ever needing a manifest entry - either untrack them or narrow EXCLUDED_DIRS/EXCLUDED_FILES:\n` +
        tracked.map((file) => `  ${file}`).join('\n'),
    );
  }
}

function fail(message) {
  console.error(`asset manifest: ${message}`);
  process.exitCode = 1;
}

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
  fail(`cannot read ${manifestPath}: ${error.message}`);
  process.exit();
}

if (manifest.schema !== 'grand-teton-assets/v1') fail('unsupported schema');
if (!Array.isArray(manifest.assets) || !manifest.assets.length) fail('assets must be a non-empty array');

const ids = new Set();
const claimedBy = new Map(); // repo-root-relative file path -> id of the entry that claims it
for (const asset of manifest.assets || []) {
  const label = asset.id || '(missing id)';
  if (!asset.id || ids.has(asset.id)) fail(`${label} has a missing or duplicate id`);
  ids.add(asset.id);
  for (const field of ['title', 'author', 'source', 'license', 'attribution', 'recipe']) {
    if (typeof asset[field] !== 'string' || !asset[field].trim()) fail(`${label} is missing ${field}`);
  }
  if (!acceptedLicenses.has(asset.license)) fail(`${label} uses unreviewed license ${asset.license}`);
  const mustName = ATTRIBUTION_REQUIRED.get(asset.license);
  if (mustName && !mustName.test(String(asset.attribution))) {
    fail(`${label} is ${asset.license}, so its attribution must name the obligation`);
  }
  if (!Array.isArray(asset.files) || !asset.files.length) {
    fail(`${label} has no runtime files`);
    continue;
  }
  for (const file of asset.files) {
    if (typeof file !== 'string' || file.startsWith('/') || file.includes('..')) {
      fail(`${label} has unsafe file path ${String(file)}`);
      continue;
    }
    if (claimedBy.has(file)) {
      fail(`${file} is claimed by both ${claimedBy.get(file)} and ${label}`);
    } else {
      claimedBy.set(file, label);
    }
    try {
      await access(resolve(root, file));
    } catch {
      fail(`${label} runtime file is missing: ${file}`);
    }
  }
}

// Every shipped runtime asset must be claimed by exactly one manifest entry -
// otherwise the licensing documentation rests on an unenforced promise.
await checkExclusionsAreUntracked();
const tracked = trackedPublicFiles();
if (!tracked) console.log('asset manifest: no usable git checkout, falling back to a filesystem walk');
const shipped = await selectAssets(tracked ?? (await walkPublicFiles(publicRoot)));
const unclaimed = shipped.filter((file) => !claimedBy.has(file)).sort();
if (unclaimed.length) {
  fail(
    `${unclaimed.length} shipped asset file(s) have no manifest entry:\n` +
      unclaimed.map((file) => `  ${file}`).join('\n'),
  );
}

if (!process.exitCode) {
  const covered = shipped.length;
  console.log(`asset manifest: ${manifest.assets.length} entries valid, ${covered} asset files covered`);
}
