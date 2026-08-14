#!/usr/bin/env python3
"""API locale minimale pour agents IA — catalogue, validation, assemblage et export GLB."""

import json
import os
import subprocess
import sys
import tempfile
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
CATALOG_PATH = os.path.join(ROOT, "catalog.json")
PRESETS_PATH = os.path.join(ROOT, "presets.json")
EXPORT_SCRIPT = os.path.join(ROOT, "tools", "export-glb.mjs")


def load_presets():
    with open(PRESETS_PATH, encoding="utf-8") as f:
        return json.load(f)


def load_catalog():
    with open(CATALOG_PATH, encoding="utf-8") as f:
        return json.load(f)


def get_catalog_summary(catalog):
    base = catalog["bases"]["bike_base"]
    return {
        "version": catalog["version"],
        "base": {
            "id": base["id"],
            "name": base["name"],
            "sockets": list(base["sockets"].keys()),
            "exportAnchors": list(base.get("exportAnchors", {}).keys()),
        },
        "parts": [
            {
                "id": p["id"],
                "name": p["name"],
                "compatibleTags": p["compatibleTags"],
                "defaultSocket": p["defaultSocket"],
                "allowedOffset": p["allowedOffset"],
                "allowedScale": p["allowedScale"],
                "defaultColor": p["defaultColor"],
                "emissive": p["emissive"],
            }
            for p in catalog["parts"].values()
        ],
        "colors": list(catalog["colors"].keys()),
        "materialZones": catalog["materialZones"],
        "sockets": [
            {"id": sid, "tags": s["tags"]}
            for sid, s in base["sockets"].items()
        ],
    }


def tags_compatible(socket_tags, part_tags):
    return any(t in socket_tags for t in part_tags)


def derive_part_size_class(part):
    if part.get("sizeClass") is not None:
        return part["sizeClass"]
    section = part.get("section", "")
    pid = part.get("id", "")
    if section == "ailes":
        return 4
    if section == "formes":
        if any(x in pid for x in ("Xl", "Delta", "Pyramide", "Biplan", "Albatros", "Aigle", "ChauveSouris")):
            return 5
        return 3
    if section in ("eclairage", "details"):
        return 2
    return 3


def derive_socket_max_size_class(socket):
    if socket.get("maxSizeClass") is not None:
        return socket["maxSizeClass"]
    tags = socket.get("tags", [])
    if any(t in tags for t in ("headlight", "antenna", "mirror", "turnsignal")):
        return 2
    if "wing" in tags and "top" in tags:
        return 4
    if "wing" in tags:
        return 5
    if "deco" in tags and "free" in tags:
        return 5
    if "neon" in tags:
        return 2
    return 4


def validate_config(config, catalog):
    errors = []
    warnings = []
    base_id = config.get("base", "bike_base")
    base = catalog["bases"].get(base_id)
    if not base:
        return {"success": False, "errors": [f"Base inconnue: {base_id}"], "warnings": warnings}

    used_sockets = set()
    for i, entry in enumerate(config.get("parts", [])):
        part_id = entry.get("object") or entry.get("part")
        socket_id = entry.get("socket")
        part = catalog["parts"].get(part_id)
        if not part:
            errors.append(f"Pièce inconnue: {part_id} (index {i})")
            continue
        socket = base["sockets"].get(socket_id)
        if not socket:
            errors.append(f"Socket inconnu: {socket_id} pour {part_id}")
            continue
        if not tags_compatible(socket["tags"], part["compatibleTags"]):
            compat = [
                sid
                for sid, s in base["sockets"].items()
                if tags_compatible(s["tags"], part["compatibleTags"])
            ]
            errors.append(f"{part_id} incompatible avec socket {socket_id}")
            warnings.append({"part": part_id, "availableSockets": compat})
            continue
        if socket_id in used_sockets and not entry.get("allowStack"):
            warnings.append(f"Socket {socket_id} déjà utilisé")
        used_sockets.add(socket_id)

        scale = entry.get("scale", 1)
        s_min, s_max = part["allowedScale"]
        if not (s_min <= scale <= s_max):
            errors.append(f"{part_id}: scale={scale} hors plage [{s_min}, {s_max}]")

        part_size = derive_part_size_class(part) * scale
        socket_max = derive_socket_max_size_class(socket)
        if part_size > socket_max + 0.25:
            warnings.append({
                "type": "size_mismatch",
                "part": part_id,
                "socket": socket_id,
                "message": f"{part.get('name', part_id)} trop grande pour le socket {socket_id} "
                f"(taille {part_size:.1f} > max {socket_max})",
                "effectiveSize": round(part_size, 1),
                "maxSize": socket_max,
            })

        offset = entry.get("offset") or {}
        for axis in ("x", "y", "z"):
            if axis not in offset:
                continue
            plage = part["allowedOffset"].get(axis)
            if plage and not (plage[0] <= offset[axis] <= plage[1]):
                errors.append(f"{part_id}: offset.{axis} hors plage {plage}")

    return {"success": len(errors) == 0, "errors": errors, "warnings": warnings}


def socket_position(socket, bounds):
    size = {k: bounds["max"][k] - bounds["min"][k] for k in ("x", "y", "z")}
    a = socket["anchor"]
    return {
        "x": bounds["min"]["x"] + size["x"] * a["x"],
        "y": bounds["min"]["y"] + size["y"] * a["y"],
        "z": bounds["min"]["z"] + size["z"] * a["z"],
    }


def assemble_config(config, catalog, bounds):
    validation = validate_config(config, catalog)
    if not validation["success"]:
        return {**validation, "success": False}

    base = catalog["bases"][config.get("base", "bike_base")]
    parts = []
    for entry in config.get("parts", []):
        part_id = entry.get("object") or entry.get("part")
        socket_id = entry["socket"]
        part = catalog["parts"][part_id]
        socket = base["sockets"][socket_id]
        offset = entry.get("offset") or {}
        scale = entry.get("scale", 1)
        pos = socket_position(socket, bounds)
        rot = socket.get("rotation", [0, 0, 0])
        mount = part.get("mountPoint", {"position": [0, 0, 0], "rotation": [0, 0, 0]})
        color_key = entry.get("color") or part["defaultColor"]
        parts.append({
            "id": part_id,
            "socket": socket_id,
            "enabled": True,
            "position": {
                "x": pos["x"] + offset.get("x", 0) - mount["position"][0],
                "y": pos["y"] + offset.get("y", 0) - mount["position"][1],
                "z": pos["z"] + offset.get("z", 0) - mount["position"][2],
            },
            "rotation": {
                "x": rot[0] + mount["rotation"][0],
                "y": rot[1] + mount["rotation"][1],
                "z": rot[2] + mount["rotation"][2],
            },
            "scale": scale,
            "color": catalog["colors"].get(color_key, color_key),
            "emissive": part["emissive"],
            "colle": entry.get("colle", True),
        })

    materials = {}
    for zone, color_key in (config.get("materials") or {}).items():
        materials[zone] = catalog["colors"].get(color_key, color_key)

    return {
        "success": True,
        "assetId": config.get("assetId", "asset_local"),
        "base": config.get("base", "bike_base"),
        "parts": parts,
        "materialColors": materials,
        "warnings": validation["warnings"],
    }


def default_bounds(catalog, base_id="bike_base"):
    base = catalog["bases"].get(base_id, {})
    return base.get("defaultBounds")


def resolve_bounds(body, catalog, config):
    bounds = body.get("bounds")
    if bounds:
        return bounds
    base_id = config.get("base", "bike_base")
    return default_bounds(catalog, base_id)


def run_export_glb(config, port):
    if not os.path.isfile(EXPORT_SCRIPT):
        return None, "Script tools/export-glb.mjs introuvable"
    node_modules = os.path.join(ROOT, "node_modules", "puppeteer")
    if not os.path.isdir(node_modules):
        return None, "Puppeteer non installé — exécutez: npm install"

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as tmp:
        json.dump(config, tmp)
        cfg_path = tmp.name

    out_fd, out_path = tempfile.mkstemp(suffix=".glb")
    os.close(out_fd)

    try:
        env = os.environ.copy()
        env["PORT"] = str(port)
        proc = subprocess.run(
            ["node", EXPORT_SCRIPT, "--config", cfg_path, "--out", out_path, "--port", str(port)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            env=env,
            timeout=180,
        )
        if proc.returncode != 0:
            err = proc.stderr.strip() or proc.stdout.strip() or "export échoué"
            return None, err
        with open(out_path, "rb") as f:
            return f.read(), None
    finally:
        for p in (cfg_path, out_path):
            try:
                os.unlink(p)
            except OSError:
                pass


class APIHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def _binary(self, code, data, content_type="model/gltf-binary", extra_headers=None):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/catalog":
            catalog = load_catalog()
            return self._json(200, get_catalog_summary(catalog))
        if path == "/api/presets":
            return self._json(200, load_presets())
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return self._json(400, {"success": False, "error": "JSON invalide"})

        catalog = load_catalog()

        if path == "/api/validate":
            config = body.get("config", body)
            return self._json(200, validate_config(config, catalog))

        if path == "/api/assemble":
            config = body.get("config", body)
            bounds = resolve_bounds(body, catalog, config)
            if not bounds:
                return self._json(400, {
                    "success": False,
                    "error": "bounds requis ou defaultBounds manquant dans le catalogue",
                })
            return self._json(200, assemble_config(config, catalog, bounds))

        if path == "/api/export-glb":
            config = body.get("config", body)
            validation = validate_config(config, catalog)
            if not validation["success"]:
                return self._json(400, {**validation, "success": False})

            port = int(os.environ.get("PORT", self.server.server_address[1]))
            glb_data, err = run_export_glb(config, port)
            if err:
                return self._json(503, {"success": False, "error": err})
            filename = body.get("filename") or config.get("assetId", "export") + ".glb"
            if not filename.endswith(".glb"):
                filename += ".glb"
            return self._binary(200, glb_data, extra_headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
            })

        return self._json(404, {"success": False, "error": "Route inconnue"})


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def main():
    port = int(os.environ.get("PORT", 8765))
    server = ThreadedHTTPServer(("0.0.0.0", port), APIHandler)
    print(f"API assembleur sur http://localhost:{port}")
    print("  GET  /api/catalog")
    print("  GET  /api/presets")
    print("  POST /api/validate")
    print("  POST /api/assemble")
    print("  POST /api/export-glb  → fichier .glb (nécessite npm install)")
    server.serve_forever()


if __name__ == "__main__":
    main()
