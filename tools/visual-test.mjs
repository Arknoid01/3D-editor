#!/usr/bin/env node
/**
 * Test visuel Puppeteer — assemble un preset et capture un screenshot.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader-webgl',
];

export async function capturePresetScreenshot(config, options = {}) {
  const port = options.port || process.env.PORT || '8765';
  const pageUrl = options.url || `http://127.0.0.1:${port}/moto-assembleur-v3.html`;
  const outDir = options.outDir || path.join(ROOT, 'artifacts', 'screenshots');
  const assetId = config.assetId || 'visual-test';
  const outPath = path.join(outDir, `${assetId}.png`);

  fs.mkdirSync(outDir, { recursive: true });

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

    const asm = await page.evaluate(async (cfg) => {
      return window.AssembleurAPI.assemble(cfg);
    }, config);

    if (!asm.success) {
      throw new Error(asm.errors?.join('; ') || 'Assemblage échoué');
    }

    await new Promise(r => setTimeout(r, 500));
    const viewport = await page.$('#viewport');
    if (!viewport) throw new Error('#viewport introuvable');
    await viewport.screenshot({ path: outPath, type: 'png' });

    const stats = fs.statSync(outPath);
    if (stats.size < 5000) {
      throw new Error(`Screenshot suspect (${stats.size} octets) — rendu WebGL vide ?`);
    }

    return { outPath, size: stats.size, assetId, warnings: asm.warnings || [] };
  } finally {
    await browser.close();
  }
}

async function main() {
  const presets = JSON.parse(fs.readFileSync(path.join(ROOT, 'presets.json'), 'utf8'));
  const ailes = presets.presets.find(p => p.id === 'ailes');
  if (!ailes) throw new Error('Preset ailes introuvable');

  const port = process.env.PORT || '8765';
  const result = await capturePresetScreenshot(ailes.config, { port });
  console.log('Screenshot:', result.outPath, `(${result.size} octets)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
  });
}
