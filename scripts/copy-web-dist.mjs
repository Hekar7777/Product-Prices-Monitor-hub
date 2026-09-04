// Copies the already-built web/dist output to a root-level dist/ directory.
//
// Why this exists: Vercel's dashboard "Output Directory" project setting can
// override the outputDirectory value in vercel.json (dashboard-configured
// Build & Development Settings take precedence over repo config when they
// have been explicitly set, rather than left as "inherited"). That override
// cannot be fixed from this repository, so instead this script makes the
// build produce output at the conventional root-level "dist" path Vercel
// falls back to, while leaving the Vite build itself untouched - it still
// outputs to web/dist (see web/vite.config.ts), which is what local dev,
// `npm run build`, and every other consumer of this repo expect.
//
// Implemented as a small Node script (not a shell `cp -r`) so it runs
// identically on Vercel's Linux build image and on any contributor's
// machine, and so it can safely remove a stale dist/ from a previous build
// before copying - a plain `cp -r web/dist dist` would nest into
// dist/dist if dist/ already existed from a prior run.
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(repoRoot, 'web', 'dist');
const destination = path.join(repoRoot, 'dist');

if (!existsSync(source)) {
  console.error(`copy-web-dist: expected build output at ${source}, but it does not exist.`);
  console.error('Run "npm run build" first.');
  process.exit(1);
}

if (existsSync(destination)) {
  rmSync(destination, { recursive: true, force: true });
}

cpSync(source, destination, { recursive: true });
console.log(`copy-web-dist: copied ${source} -> ${destination}`);
