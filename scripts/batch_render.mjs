// Batch render PNG schedules for all regions and all GPV groups using Playwright renderer
// Usage:
//   node scripts/batch_render.mjs                     # render all data/*.json, light theme, scale=1
//   node scripts/batch_render.mjs --theme dark        # dark theme
//   node scripts/batch_render.mjs --scale 2           # HiDPI export
//   node scripts/batch_render.mjs --region kyiv-region  # only one region (by regionId or by file stem)
//
// Requirements: Node.js 18+, Playwright installed (chromium).

import { readdir, readFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    args[k] = v;
  }
  return args;
}

const args = parseArgs(process.argv);
const theme = (args.theme === 'dark') ? 'dark' : 'light';
// Accept explicit --scale; otherwise rely on single renderer's high-DPI default (DPR=4). Support --max passthrough.
const scale = Number(args.scale || NaN);
const onlyRegion = args.region || null; // regionId or file stem

const dataDir = path.join(projectRoot, 'data');
const imagesDir = path.join(projectRoot, 'images');
const templateHtml = path.join(projectRoot, 'scripts', 'full-template.html');
const rendererScript = path.join(projectRoot, 'scripts', 'render_png.mjs');

function normalizeRegionId(json, fileStem) {
  return (json && typeof json.regionId === 'string' && json.regionId.trim()) || fileStem;
}

function gpvToFileName(gpvKey) {
  // GPV1.2 -> gpv-1-2.png
  const m = String(gpvKey).match(/^GPV(\d+)\.(\d+)$/i);
  if (!m) {
    // fallback: sanitize
    return `gpv-${String(gpvKey).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
  }
  return `gpv-${m[1]}-${m[2]}.png`;
}

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function runRenderer({ jsonPath, gpvKey, outPath }) {
  await mkdir(path.dirname(outPath), { recursive: true });
  return new Promise((resolve) => {
    const args = [rendererScript, '--html', templateHtml, '--json', jsonPath, '--gpv', gpvKey, '--out', outPath];
    if (theme === 'dark') { args.push('--theme', 'dark'); }
    if (Number.isFinite(scale) && scale > 0) {
      args.push('--scale', String(scale));
    } else {
      // No explicit scale provided for batch — allow explicit max-quality passthrough
      if (args.max === true || String(args.quality || '').toLowerCase() === 'max') {
        args.push('--max');
      }
    }

    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', (code) => {
      resolve({ code });
    });
  });
}

(async () => {
  if (!(await fileExists(templateHtml))) {
    console.error(`[ERROR] HTML template not found: ${templateHtml}`);
    process.exit(1);
  }
  if (!(await fileExists(rendererScript))) {
    console.error(`[ERROR] Renderer script not found: ${rendererScript}`);
    process.exit(1);
  }
  await mkdir(imagesDir, { recursive: true });

  const entries = await readdir(dataDir, { withFileTypes: true });
  const jsonFiles = entries.filter(e => e.isFile() && e.name.endsWith('.json')).map(e => path.join(dataDir, e.name));
  if (jsonFiles.length === 0) {
    console.warn('[WARN] No JSON files found in data/');
    process.exit(0);
  }

  let total = 0, ok = 0, failed = 0;

  for (const jf of jsonFiles) {
    const fileStem = path.basename(jf, '.json');
    try {
      const buf = await readFile(jf, 'utf8');
      const json = JSON.parse(buf);
      if (!json || typeof json !== 'object' || !json.preset || !json.fact) {
        // Skip files that do not contain both preset and fact
        continue;
      }
      const regionId = normalizeRegionId(json, fileStem);
      if (onlyRegion && onlyRegion !== regionId && onlyRegion !== fileStem) {
        continue; // filtered out
      }

      const presetData = json?.preset?.data || {};
      const gpvKeys = Object.keys(presetData).filter(k => /^GPV\d+\.\d+$/i.test(k)).sort((a, b) => {
        // sort by numeric major/minor
        const pa = a.match(/\d+|\./g)?.join('') || '';
        const pb = b.match(/\d+|\./g)?.join('') || '';
        return pa.localeCompare(pb, 'en', { numeric: true });
      });
      if (gpvKeys.length === 0) {
        console.warn(`[WARN] No GPV groups in ${jf} — skipping`);
        continue;
      }

      for (const gpv of gpvKeys) {
        total++;
        const outDir = path.join(imagesDir, regionId);
        const outPath = path.join(outDir, gpvToFileName(gpv));
        console.log(`[INFO] Rendering region='${regionId}' group='${gpv}' -> ${path.relative(projectRoot, outPath)}`);
        const { code } = await runRenderer({ jsonPath: jf, gpvKey: gpv, outPath });
        if (code === 0) ok++; else failed++;
      }
    } catch (e) {
      console.warn(`[WARN] Failed to process ${jf}: ${e?.message || e}`);
    }
  }

  console.log(`[SUMMARY] Rendered: ${ok}/${total} succeeded, ${failed} failed. Theme=${theme} Scale=${scale}`);
  process.exit(failed > 0 ? 1 : 0);
})();
