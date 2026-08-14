#!/usr/bin/env node
/**
 * Suite CI locale / GitHub Actions :
 * - validation de tous les presets (engine + HTTP)
 * - export GLB preset ailes + vérification ancres/config
 * - screenshot visuel Puppeteer
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { exportGlbFromConfig } from './export-glb.mjs';
import { verifyGlbBuffer } from './verify-glb.mjs';
import { capturePresetScreenshot } from './visual-test.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || '8765';
const BASE = `http://127.0.0.1:${PORT}`;

function loadAssemblerEngine() {
  const code = fs.readFileSync(path.join(ROOT, 'assembler-engine.js'), 'utf8');
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(code, sandbox, { filename: 'assembler-engine.js' });
  return sandbox.module.exports;
}

const AssemblerEngine = loadAssemblerEngine();

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForServer(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error(`Serveur inaccessible: ${url}`);
}

function startServer() {
  const proc = spawn('python3', ['api-server.py'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => process.stdout.write(`[api] ${d}`));
  proc.stderr.on('data', d => process.stderr.write(`[api] ${d}`));
  return proc;
}

async function testPresetsEngine(catalog, presets) {
  console.log('\n=== Validation presets (AssemblerEngine) ===');
  for (const preset of presets.presets) {
    const result = AssemblerEngine.validateConfig(preset.config, catalog);
    if (!result.success) {
      throw new Error(`Preset "${preset.id}" invalide: ${result.errors.join('; ')}`);
    }
    console.log(`  ✓ ${preset.id} — ${result.warnings.length} warning(s)`);
  }
}

async function testSizeWarnings(catalog) {
  console.log('\n=== Validation enrichie (size_mismatch) ===');
  const config = {
    base: 'bike_base',
    parts: [{ object: 'aileAlbatrosG', socket: 'wingTopLeft', scale: 1.2 }],
  };
  const result = AssemblerEngine.validateConfig(config, catalog);
  const sizeWarn = result.warnings.find(w => w.type === 'size_mismatch');
  if (!sizeWarn) {
    throw new Error('Warning size_mismatch attendu pour aileAlbatrosG sur wingTopLeft');
  }
  console.log(`  ✓ ${sizeWarn.message}`);
}

async function testPresetsHttp(presets) {
  console.log('\n=== Validation presets (HTTP POST /api/validate) ===');
  for (const preset of presets.presets) {
    const res = await fetch(`${BASE}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: preset.config }),
    });
    const body = await res.json();
    if (!res.ok || !body.success) {
      throw new Error(`HTTP preset "${preset.id}": ${JSON.stringify(body)}`);
    }
    console.log(`  ✓ ${preset.id}`);
  }
}

async function testExportGlb(ailesConfig) {
  console.log('\n=== Export GLB preset ailes ===');
  const outPath = path.join(ROOT, 'exports', 'ci-moto-ailes.glb');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const { buffer, warnings } = await exportGlbFromConfig(ailesConfig, {
    port: PORT,
    url: `${BASE}/moto-assembleur-v3.html`,
  });
  fs.writeFileSync(outPath, buffer);
  if (warnings?.length) console.warn('  warnings:', warnings);

  const check = verifyGlbBuffer(buffer);
  if (!check.ok) {
    throw new Error(`GLB invalide:\n  ${check.errors.join('\n  ')}`);
  }
  console.log(`  ✓ ${outPath} (${buffer.length} octets, ${check.partCount} pièces, ${check.anchorsFound.length} ancres)`);
  return outPath;
}

async function testVisual(ailesConfig) {
  console.log('\n=== Test visuel Puppeteer ===');
  const result = await capturePresetScreenshot(ailesConfig, { port: PORT });
  console.log(`  ✓ ${result.outPath} (${result.size} octets)`);
}

async function main() {
  const catalog = loadJson('catalog.json');
  const presets = loadJson('presets.json');
  const ailes = presets.presets.find(p => p.id === 'ailes');
  if (!ailes) throw new Error('Preset ailes manquant');

  await testPresetsEngine(catalog, presets);
  await testSizeWarnings(catalog);

  const server = startServer();
  try {
    await waitForServer(`${BASE}/api/catalog`);
    await testPresetsHttp(presets);
    await testExportGlb(ailes.config);
    await testVisual(ailes.config);
  } finally {
    server.kill('SIGTERM');
  }

  console.log('\n✅ Tous les tests CI passés');
}

main().catch(err => {
  console.error('\n❌ CI échoué:', err.message || err);
  process.exit(1);
});
