# 3D-editor — Assembleur Moto

Éditeur 3D web (Three.js) pour customiser une moto et exporter en `.glb`.

## Fichiers

| Fichier | Rôle |
|---------|------|
| `moto-assembleur-v3.html` | Interface + rendu 3D |
| `catalog.json` | Bases, sockets, pièces, mounts, couleurs, **exportAnchors** |
| `presets.json` | Presets prédéfinis (néon, ailes, aigle…) |
| `assembler-engine.js` | Moteur d'assemblage (validation + placement) |
| `api-server.py` | API locale pour agents IA |
| `openapi.yaml` | Spécification OpenAPI des endpoints |
| `docker-compose.yml` | Lancement API + export GLB en conteneur |

## Lancer l'assembleur

```bash
python3 api-server.py
# → http://localhost:8765/moto-assembleur-v3.html
```

## API agent IA (navigateur)

Une fois la page chargée :

```js
// Catalogue simplifié pour l'agent
AssembleurAPI.getCatalog()

// Valider une config (sans appliquer)
AssembleurAPI.validate({ base: 'bike_base', parts: [...] })

// Assembler sur la scène
AssembleurAPI.assemble({
  base: 'bike_base',
  parts: [
    { object: 'spoiler', socket: 'rearCenter' },
    { object: 'aileronG', socket: 'leftSideRear', color: 'cyan' }
  ],
  materials: { rouge: 'red', noir: 'black' }
})

// Exemple prêt à l'emploi
AssembleurAPI.assemble(AssembleurAPI.exemple())

// Export GLB de la scène courante (Promise<Blob>)
AssembleurAPI.exportGlb()

// Assembler puis exporter en une étape (Promise<{ blob, ... }>)
AssembleurAPI.assembleAndExport(AssembleurAPI.exemple())
```

L'agent choisit des **sockets sémantiques** (`rearCenter`, `leftSide`…) — jamais de coordonnées 3D brutes.

## API HTTP

```bash
GET  /api/catalog       # catalogue pour l'agent (inclut exportAnchors)
GET  /api/presets       # configs prédéfinies (néon, ailes, aigle…)
POST /api/validate      # { "config": { ... } }
POST /api/assemble      # { "config": { ... }, "bounds": { ... } }  (bounds optionnels)
POST /api/export-glb    # { "config": { ... } }  → fichier .glb binaire
```

Spécification complète : `openapi.yaml`

### Export GLB — intégration jeu

Le GLB exporté contient :

- **Nœuds sémantiques** : `trail_anchor`, `wing_root_L`, `wing_root_R`, `seat`, `exhaust`, `cockpit`, `front` (groupe `export_anchors`)
- **Config embarquée** : JSON dans `extras.assembleurConfig` du nœud racine `assemblage`

Exemple preset moto-ailes :

```bash
curl -X POST http://localhost:8765/api/export-glb \
  -H 'Content-Type: application/json' \
  -d '{"config":{"base":"bike_base","assetId":"preset_ailes","parts":[{"object":"aileAvionG","socket":"wingRootLeft","color":"white"},{"object":"aileAvionD","socket":"wingRootRight","color":"white"},{"object":"empennageAvion","socket":"empennageRear","color":"white"}],"materials":{"rouge":"red","blanc":"white","noir":"black","chrome":"chrome"}}}' \
  --output moto-ailes.glb
```

### Docker

```bash
docker compose up
# → http://localhost:8765/moto-assembleur-v3.html
```

### Export GLB headless (sans navigateur manuel)

L'export GLB passe par Puppeteer + Three.js (WebGL headless). Prérequis :

```bash
npm install
python3 api-server.py   # dans un terminal
npm run export-glb -- --config config.json --out bike.glb
```

Ou via l'API HTTP (le serveur lance `tools/export-glb.mjs` en sous-processus) :

```bash
curl -X POST http://localhost:8765/api/export-glb \
  -H 'Content-Type: application/json' \
  -d '{"config":{"base":"bike_base","parts":[{"object":"spoiler","socket":"rearCenter"}]}}' \
  --output bike.glb
```

Flags WebGL utilisés par Puppeteer : `--enable-unsafe-swiftshader`, `--use-gl=angle`, `--use-angle=swiftshader-webgl`.

## Principe sockets / mounts

```
Agent → socket "rearCenter" + pièce "spoiler"
              ↓
       Assembleur aligne mount ↔ socket
              ↓
         position réelle + export GLB
```

Voir `workflow_assembleur_3d_ia.md` pour la vision complète.
