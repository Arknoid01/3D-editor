/**
 * Moteur d'assemblage 3D — logique déterministe pour agents IA.
 * Pas de dépendance Three.js : positions/rotations en données pures.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AssemblerEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  function getCatalog(catalog) {
    const base = catalog.bases.bike_base;
    return {
      version: catalog.version,
      base: {
        id: base.id,
        name: base.name,
        sockets: Object.keys(base.sockets)
      },
      parts: Object.values(catalog.parts).map(p => ({
        id: p.id,
        name: p.name,
        compatibleTags: p.compatibleTags,
        defaultSocket: p.defaultSocket,
        allowedOffset: p.allowedOffset,
        allowedScale: p.allowedScale,
        defaultColor: p.defaultColor,
        emissive: p.emissive
      })),
      colors: Object.keys(catalog.colors),
      materialZones: catalog.materialZones,
      sockets: Object.entries(base.sockets).map(([id, s]) => ({
        id,
        tags: s.tags
      }))
    };
  }

  function tagsCompatibles(socketTags, partTags) {
    return partTags.some(t => socketTags.includes(t));
  }

  function dansPlage(val, min, max) {
    return val >= min && val <= max;
  }

  function validerOffset(offset, allowed) {
    if (!offset) return { ok: true };
    const axes = ['x', 'y', 'z'];
    for (const axe of axes) {
      if (offset[axe] === undefined) continue;
      const plage = allowed[axe];
      if (!plage) continue;
      if (!dansPlage(offset[axe], plage[0], plage[1])) {
        return { ok: false, error: `offset.${axe}=${offset[axe]} hors plage [${plage}]` };
      }
    }
    return { ok: true };
  }

  function socketPosition(socket, bounds) {
    const size = {
      x: bounds.max.x - bounds.min.x,
      y: bounds.max.y - bounds.min.y,
      z: bounds.max.z - bounds.min.z
    };
    const a = socket.anchor;
    return {
      x: bounds.min.x + size.x * a.x,
      y: bounds.min.y + size.y * a.y,
      z: bounds.min.z + size.z * a.z
    };
  }

  function computePlacement(partDef, socketDef, bounds, options) {
    const offset = options.offset || { x: 0, y: 0, z: 0 };
    const scale = options.scale !== undefined ? options.scale : 1;
    const pos = socketPosition(socketDef, bounds);
    const rot = socketDef.rotation || [0, 0, 0];
    const mount = partDef.mountPoint || { position: [0, 0, 0], rotation: [0, 0, 0] };
    return {
      position: {
        x: pos.x + offset.x - (mount.position[0] || 0),
        y: pos.y + offset.y - (mount.position[1] || 0),
        z: pos.z + offset.z - (mount.position[2] || 0)
      },
      rotation: {
        x: rot[0] + (mount.rotation[0] || 0),
        y: rot[1] + (mount.rotation[1] || 0),
        z: rot[2] + (mount.rotation[2] || 0)
      },
      scale
    };
  }

  function validateConfig(config, catalog) {
    const errors = [];
    const warnings = [];
    const baseId = config.base || 'bike_base';
    const base = catalog.bases[baseId];
    if (!base) {
      return { success: false, errors: [`Base inconnue: ${baseId}`], warnings };
    }

    const socketsUtilises = new Set();
    const placements = [];

    (config.parts || []).forEach((entry, index) => {
      const partId = entry.object || entry.part;
      const socketId = entry.socket;
      const part = catalog.parts[partId];
      if (!part) {
        errors.push(`Pièce inconnue: ${partId} (index ${index})`);
        return;
      }
      const socket = base.sockets[socketId];
      if (!socket) {
        errors.push(`Socket inconnu: ${socketId} pour ${partId}`);
        return;
      }
      if (!tagsCompatibles(socket.tags, part.compatibleTags)) {
        const compatibles = Object.entries(base.sockets)
          .filter(([, s]) => tagsCompatibles(s.tags, part.compatibleTags))
          .map(([id]) => id);
        errors.push(`${partId} incompatible avec socket ${socketId}`);
        warnings.push({ part: partId, availableSockets: compatibles });
        return;
      }
      if (socketsUtilises.has(socketId) && !entry.allowStack) {
        warnings.push(`Socket ${socketId} déjà utilisé`);
      }
      socketsUtilises.add(socketId);

      const offsetCheck = validerOffset(entry.offset, part.allowedOffset);
      if (!offsetCheck.ok) errors.push(`${partId}: ${offsetCheck.error}`);

      const scale = entry.scale !== undefined ? entry.scale : 1;
      const [sMin, sMax] = part.allowedScale;
      if (!dansPlage(scale, sMin, sMax)) {
        errors.push(`${partId}: scale=${scale} hors plage [${sMin}, ${sMax}]`);
      }

      if (entry.color && !catalog.colors[entry.color]) {
        errors.push(`Couleur inconnue: ${entry.color} pour ${partId}`);
      }
    });

    const materials = config.materials || {};
    Object.keys(materials).forEach(zone => {
      if (!catalog.materialZones.includes(zone) && !catalog.colors[materials[zone]]) {
        errors.push(`Zone matériau ou couleur invalide: ${zone}=${materials[zone]}`);
      }
    });

    return {
      success: errors.length === 0,
      errors,
      warnings,
      placements
    };
  }

  function assembleAsset(config, catalog, bounds) {
    const validation = validateConfig(config, catalog);
    if (!validation.success) {
      return { success: false, errors: validation.errors, warnings: validation.warnings };
    }

    const baseId = config.base || 'bike_base';
    const base = catalog.bases[baseId];
    const parts = [];
    const colors = {};
    const materialColors = {};

    (config.parts || []).forEach(entry => {
      const partId = entry.object || entry.part;
      const socketId = entry.socket;
      const part = catalog.parts[partId];
      const socket = base.sockets[socketId];
      const placement = computePlacement(part, socket, bounds, {
        offset: entry.offset,
        scale: entry.scale
      });
      const colorKey = entry.color || part.defaultColor;
      parts.push({
        id: partId,
        socket: socketId,
        enabled: true,
        position: placement.position,
        rotation: placement.rotation,
        scale: placement.scale,
        color: catalog.colors[colorKey] || colorKey,
        emissive: part.emissive,
        colle: entry.colle !== false
      });
      colors[partId] = catalog.colors[colorKey] || colorKey;
    });

    Object.entries(config.materials || {}).forEach(([zone, colorKey]) => {
      materialColors[zone] = catalog.colors[colorKey] || colorKey;
    });

    return {
      success: true,
      assetId: config.assetId || ('asset_' + Date.now()),
      base: baseId,
      parts,
      materialColors,
      warnings: validation.warnings
    };
  }

  function resolveColor(catalog, key) {
    return catalog.colors[key] || key;
  }

  return {
    getCatalog,
    validateConfig,
    assembleAsset,
    computePlacement,
    socketPosition,
    tagsCompatibles,
    resolveColor
  };
});
