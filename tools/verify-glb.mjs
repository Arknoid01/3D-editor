#!/usr/bin/env node
/**
 * Vérifie qu'un GLB exporté contient les ancres jeu et la config embarquée.
 */
import fs from 'fs';

const REQUIRED_ANCHORS = [
  'trail_anchor',
  'wing_root_L',
  'wing_root_R',
  'seat',
  'exhaust',
  'cockpit',
  'front',
];

export function verifyGlbBuffer(buffer) {
  const view = buffer instanceof Buffer ? buffer : Buffer.from(buffer);
  if (view.length < 12) {
    return { ok: false, errors: ['Fichier trop petit pour être un GLB'] };
  }

  const magic = view.toString('ascii', 0, 4);
  if (magic !== 'glTF') {
    return { ok: false, errors: [`Magic invalide: ${magic}`] };
  }

  let offset = 12;
  const chunkLen = view.readUInt32LE(offset);
  offset += 8;
  const jsonChunk = view.subarray(offset, offset + chunkLen);
  offset += chunkLen;

  let gltf;
  try {
    gltf = JSON.parse(jsonChunk.toString('utf8'));
  } catch (err) {
    return { ok: false, errors: [`JSON GLB invalide: ${err.message}`] };
  }

  const nodeNames = new Set(
    (gltf.nodes || []).map(n => n.name).filter(Boolean)
  );
  const errors = [];
  const missingAnchors = REQUIRED_ANCHORS.filter(a => !nodeNames.has(a));
  if (missingAnchors.length) {
    errors.push(`Ancres manquantes: ${missingAnchors.join(', ')}`);
  }
  if (!nodeNames.has('export_anchors')) {
    errors.push('Groupe export_anchors manquant');
  }
  if (!nodeNames.has('assemblage')) {
    errors.push('Nœud racine assemblage manquant');
  }

  const root = (gltf.nodes || []).find(n => n.name === 'assemblage');
  const extras = root?.extras || {};
  if (!extras.assembleurConfig) {
    errors.push('extras.assembleurConfig manquant sur assemblage');
  } else {
    const cfg = extras.assembleurConfig;
    if (!cfg.parts || !Array.isArray(cfg.parts)) {
      errors.push('assembleurConfig.parts invalide');
    }
    if (!cfg.exportAnchors || !cfg.exportAnchors.length) {
      errors.push('assembleurConfig.exportAnchors manquant');
    }
  }
  if (extras.generator !== '3D-editor-assembleur-v3') {
    errors.push(`generator inattendu: ${extras.generator}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    nodeCount: nodeNames.size,
    partCount: extras.assembleurConfig?.parts?.length ?? 0,
    anchorsFound: REQUIRED_ANCHORS.filter(a => nodeNames.has(a)),
  };
}

export function verifyGlbFile(filePath) {
  return verifyGlbBuffer(fs.readFileSync(filePath));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node tools/verify-glb.mjs <fichier.glb>');
    process.exit(1);
  }
  const result = verifyGlbFile(file);
  if (!result.ok) {
    console.error('Échec vérification GLB:');
    result.errors.forEach(e => console.error(' -', e));
    process.exit(1);
  }
  console.log('GLB OK —', result.partCount, 'pièces,', result.anchorsFound.length, 'ancres');
}
