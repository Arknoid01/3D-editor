#!/usr/bin/env node
/**
 * Export GLB headless via Puppeteer + AssembleurAPI.
 * Usage:
 *   node tools/export-glb.mjs --config config.json --out bike.glb
 *   echo '{"base":"bike_base","parts":[...]}' | node tools/export-glb.mjs --out bike.glb
 *
 * Le serveur statique doit tourner (python3 api-server.py).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const opts = { config: null, out: null, port: process.env.PORT || '8765', url: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) opts.config = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) opts.out = argv[++i];
    else if (argv[i] === '--port' && argv[i + 1]) opts.port = argv[++i];
    else if (argv[i] === '--url' && argv[i + 1]) opts.url = argv[++i];
  }
  return opts;
}

async function readConfig(opts) {
  if (opts.config) {
    return JSON.parse(fs.readFileSync(path.resolve(opts.config), 'utf8'));
  }
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw) return JSON.parse(raw);
  }
  return null;
}

const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader-webgl',
];

export async function exportGlbFromConfig(config, options = {}) {
  const port = options.port || process.env.PORT || '8765';
  const pageUrl = options.url || `http://127.0.0.1:${port}/moto-assembleur-v3.html`;

  const browser = await puppeteer.launch({
    headless: true,
    args: PUPPETEER_ARGS,
    defaultViewport: { width: 1280, height: 720 },
  });

  try {
    const page = await browser.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('[page]', msg.text());
    });

    await page.goto(pageUrl, { waitUntil: 'networkidle0', timeout: 120000 });
    await page.waitForFunction(
      () => window.AssembleurAPI && window.AssembleurAPI.isReady(),
      { timeout: 120000 }
    );

    const result = await page.evaluate(async (cfg) => {
      const asm = await window.AssembleurAPI.assembleAndExport(cfg);
      if (!asm.success) return asm;
      const buf = await asm.blob.arrayBuffer();
      return {
        success: true,
        assetId: asm.assetId,
        glb: Array.from(new Uint8Array(buf)),
        warnings: asm.warnings || [],
      };
    }, config);

    if (!result.success) {
      const err = new Error(result.errors?.join('; ') || 'Export échoué');
      err.details = result;
      throw err;
    }

    return {
      assetId: result.assetId,
      warnings: result.warnings,
      buffer: Buffer.from(result.glb),
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const config = await readConfig(opts);
  if (!config) {
    console.error('Config requise: --config fichier.json ou stdin JSON');
    process.exit(1);
  }

  const { assetId, buffer, warnings } = await exportGlbFromConfig(config, {
    port: opts.port,
    url: opts.url,
  });

  const outPath = opts.out
    ? path.resolve(opts.out)
    : path.join(ROOT, 'exports', `${assetId || 'export'}.glb`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);

  if (warnings.length) console.warn('Avertissements:', warnings);
  console.log(outPath);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message || err);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    process.exit(1);
  });
}
