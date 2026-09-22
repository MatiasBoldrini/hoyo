import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Modelos CC0 de Kenney (kenney.nl): árboles, autos y mobiliario.
// Casas, negocios, edificios, fuentes, kioscos, juegos, etc. se arman con cajas
// y cilindros pintados por vértice (ver COMPOSITES). La gente no se usa.
const CATALOG = [
  {
    kind: "tree",
    dir: "suburb",
    files: ["tree-large.glb"],
    fit: { height: 6.4 },
    mass: 14,
    heavy: false,
    variations: ["variation-a.png", "variation-b.png"],
  },
  {
    kind: "bush",
    dir: "suburb",
    files: ["tree-small.glb"],
    fit: { height: 3.8 },
    mass: 4,
    heavy: false,
    variations: ["variation-a.png"],
  },
  {
    kind: "fence",
    dir: "suburb",
    files: ["fence.glb", "fence-low.glb"],
    fit: { footprint: 2.8 },
    mass: 4,
    heavy: false,
    variations: ["variation-a.png"],
  },
  {
    kind: "flower",
    dir: "suburb",
    files: ["planter.glb"],
    fit: { footprint: 1.15 },
    mass: 1,
    heavy: false,
    variations: ["variation-a.png", "variation-b.png", "variation-c.png"],
  },
  {
    kind: "flower",
    dir: "commercial",
    files: ["detail-parasol-a.glb", "detail-parasol-b.glb"],
    fit: { footprint: 1.8 },
    mass: 2,
    heavy: false,
    variations: ["variation-a.png"],
  },
  {
    kind: "car",
    dir: "cars",
    files: ["sedan.glb", "sedan-sports.glb", "hatchback-sports.glb", "suv.glb", "suv-luxury.glb", "taxi.glb", "police.glb", "ambulance.glb"],
    fit: { footprint: 2.55 },
    mass: 16,
    heavy: false,
  },
  {
    kind: "van",
    dir: "cars",
    files: ["van.glb", "delivery.glb"],
    fit: { footprint: 3.05 },
    mass: 28,
    heavy: false,
  },
  {
    kind: "bus",
    dir: "cars",
    files: ["truck.glb", "garbage-truck.glb", "firetruck.glb"],
    fit: { footprint: 3.7 },
    mass: 46,
    heavy: true,
  },
  {
    kind: "cone",
    dir: "street",
    files: ["construction-cone.glb"],
    fit: { height: 0.72 },
    mass: 2,
    heavy: false,
    variations: ["variation-a.png"],
  },
  {
    kind: "bench",
    dir: "street",
    files: ["construction-barrier.glb"],
    fit: { footprint: 2.1 },
    mass: 6,
    heavy: false,
    variations: ["variation-a.png"],
  },
  {
    kind: "bin",
    dir: "street",
    files: ["dumpster.glb"],
    fit: { footprint: 1.9 },
    mass: 8,
    heavy: false,
    variations: ["variation-a.png"],
  },
  {
    kind: "lamp",
    dir: "street",
    files: ["light-curved.glb", "light-square.glb", "light-curved-double.glb"],
    fit: { height: 3.5 },
    mass: 6,
    heavy: false,
    variations: ["variation-a.png"],
  },
  {
    kind: "lamp",
    dir: "street",
    files: ["traffic-light.glb"],
    fit: { height: 3.1 },
    mass: 6,
    heavy: false,
    variations: ["variation-a.png"],
  },
  {
    kind: "lamp",
    dir: "street",
    files: ["road-sign-stop.glb", "road-sign-warning.glb", "road-sign-street.glb"],
    fit: { height: 2.15 },
    mass: 3,
    heavy: false,
    variations: ["variation-a.png"],
  },
];

const pools = new Map();
const materials = [];
const matByMap = new Map();
const texByUrl = new Map();
const loader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();

function loadGltf(url) {
  return loader.loadAsync(url);
}

function loadTexture(url) {
  if (texByUrl.has(url)) return texByUrl.get(url);
  const pending = new Promise((resolve, reject) => {
    texLoader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = false;
        tex.anisotropy = 8;
        resolve(tex);
      },
      undefined,
      reject,
    );
  });
  texByUrl.set(url, pending);
  return pending;
}

// Props armados con cajas y cilindros pintados por vértice: un solo material
// compartido, así cada variante entra en un InstancedMesh propio.
let paintMat = null;
function paint() {
  if (paintMat) return paintMat;
  paintMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  materials.push(paintMat);
  return paintMat;
}

const _tint = new THREE.Color();
function tint(geo, hex) {
  _tint.set(hex);
  const count = geo.getAttribute("position").count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = _tint.r;
    arr[i * 3 + 1] = _tint.g;
    arr[i * 3 + 2] = _tint.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

function box(w, h, d, color, x = 0, y = 0, z = 0) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y + h / 2, z);
  return tint(geo, color);
}

function cyl(rTop, rBottom, h, color, x = 0, y = 0, z = 0, seg = 12) {
  const geo = new THREE.CylinderGeometry(rTop, rBottom, h, seg);
  geo.translate(x, y + h / 2, z);
  return tint(geo, color);
}

function pyramid(r, h, color, x = 0, y = 0, z = 0) {
  const geo = new THREE.CylinderGeometry(0, r, h, 4, 1);
  geo.rotateY(Math.PI / 4);
  geo.translate(x, y + h / 2, z);
  return tint(geo, color);
}

function gable(w, h, d, color, x = 0, y = 0, z = 0) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(0, h);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  geo.translate(x, y, z - d / 2);
  return tint(geo, color);
}

function slab(w, h, d, color, tiltX, x, y, z) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.rotateX(tiltX);
  geo.translate(x, y, z);
  return tint(geo, color);
}

function assemble(parts, mass, heavy) {
  // ExtrudeGeometry no tiene índice; se unifica todo sin índice para poder mergear.
  const flat = parts.map((part) => (part.index ? part.toNonIndexed() : part));
  const merged = mergeGeometries(flat, false);
  for (const part of parts) part.dispose();
  for (const part of flat) if (!parts.includes(part)) part.dispose();
  merged.computeBoundingBox();
  const b = merged.boundingBox;
  const hx = Math.max(Math.abs(b.min.x), Math.abs(b.max.x));
  const hz = Math.max(Math.abs(b.min.z), Math.abs(b.max.z));
  return {
    geo: merged,
    eatR: Math.max(0.28, Math.max(hx, hz)),
    solidR: Math.max(0.16, Math.min(hx, hz)),
    halfX: hx,
    halfZ: hz,
    height: Math.max(0.1, b.max.y),
    material: paint(),
    mass,
    heavy,
  };
}

const WALLS = [0xf6efe2, 0xe9d5b5, 0xd9b99a, 0xcfd8cc, 0xf2c9b8, 0xbfd6e6, 0xe6e0c8, 0xf5dba0];
const ROOFS = [0xc9553f, 0x5d6b7a, 0x4f7a5a, 0x8a5a44, 0xd8a15c, 0x9c4b5c];
const FACADES = [0x8ea4ae, 0x7d9388, 0xb9a08a, 0xa86b52, 0x6f848c, 0xc8c2b4, 0x9aa6a2];
const GLASS = 0x7fb4d4;
const WOOD = 0x8a5a3c;
const STONE = 0xd9d4c7;
const METAL = 0x9aa3a8;
const BRIGHT = [0xff5a5f, 0xffc93c, 0x3fa7d6, 0x59c26b, 0xff8c42];

function houseSpec(i) {
  const w = [5.2, 4.6, 5.8, 4.8][i % 4];
  const d = [4.4, 5.0, 4.2, 4.6][i % 4];
  const h = [3.0, 3.6, 2.8, 4.2][i % 4];
  const wall = WALLS[i % WALLS.length];
  const roof = ROOFS[(i * 5 + 1) % ROOFS.length];
  const parts = [box(w, h, d, wall)];
  if (i % 3 === 0) parts.push(gable(w + 0.6, 1.9, d + 0.6, roof, 0, h));
  else parts.push(pyramid(Math.hypot(w, d) * 0.56, 1.7, roof, 0, h));
  parts.push(box(0.9, 1.7, 0.12, WOOD, (i % 2 ? 1 : -1) * 0.9, 0, d / 2 + 0.02));
  parts.push(box(1.0, 0.9, 0.1, GLASS, (i % 2 ? -1 : 1) * 1.1, 1.3, d / 2 + 0.02));
  parts.push(box(0.1, 0.9, 1.0, GLASS, w / 2 + 0.02, 1.3, 0.4));
  if (i % 4 === 1) parts.push(box(0.6, h + 2.2, 0.6, 0x7a6a62, -w * 0.3, 0, -d * 0.2));
  return assemble(parts, 48, true);
}

function shopSpec(i) {
  const w = [7.2, 6.4, 8.0][i % 3];
  const d = [5.0, 5.4, 4.6][i % 3];
  const h = [3.6, 4.2, 3.4][i % 3];
  const wall = FACADES[(i * 3 + 2) % FACADES.length];
  const stripe = BRIGHT[i % BRIGHT.length];
  const parts = [box(w, h, d, wall)];
  parts.push(box(w + 0.2, 0.3, d + 0.2, 0x5a5f66, 0, h));
  parts.push(box(w * 0.7, 1.4, 0.12, GLASS, 0, 0.6, d / 2 + 0.02));
  parts.push(box(w * 0.8, 0.5, 0.14, 0xffffff, 0, h - 1.0, d / 2 + 0.03));
  const stripes = 6;
  const sw = (w * 0.86) / stripes;
  for (let s = 0; s < stripes; s++) {
    parts.push(slab(sw, 0.1, 1.4, s % 2 ? stripe : 0xf8f4ea, 0.42, -w * 0.43 + sw * (s + 0.5), 2.45, d / 2 + 0.55));
  }
  return assemble(parts, 44, true);
}

function buildingSpec(i) {
  const w = [6.0, 5.4, 6.4, 5.2][i % 4];
  const d = [5.4, 5.6, 5.2, 5.2][i % 4];
  const h = [8.0, 11.0, 9.2, 14.0][i % 4];
  const wall = FACADES[i % FACADES.length];
  const parts = [box(w, h, d, wall)];
  for (let y = 1.6; y < h - 1.2; y += 3.0) parts.push(box(w + 0.08, 0.9, d + 0.08, GLASS, 0, y));
  parts.push(box(w * 0.9, 0.35, d * 0.9, 0x525a60, 0, h));
  parts.push(box(1.2, 0.8, 1.0, METAL, w * 0.2, h + 0.35, -d * 0.15));
  parts.push(box(1.6, 2.2, 0.1, WOOD, 0, 0, d / 2 + 0.02));
  return assemble(parts, 72, true);
}

function towerSpec(i) {
  const w = [6.2, 5.6, 6.8][i % 3];
  const h = [16, 20, 24][i % 3];
  const wall = [0x667b86, 0x73848a, 0x5e727c][i % 3];
  const parts = [box(w, h, w, wall)];
  for (let y = 1.8; y < h - 1.5; y += 2.6) parts.push(box(w + 0.08, 1.1, w + 0.08, 0x9fcbe3, 0, y));
  parts.push(box(w * 0.7, 1.2, w * 0.7, 0x4b5960, 0, h));
  parts.push(cyl(0.08, 0.12, 3.2, METAL, 0, h + 1.2, 0, 6));
  parts.push(box(w * 1.15, 0.5, w * 1.15, 0x4b5960, 0, 0));
  return assemble(parts, 110, true);
}

function fountainSpec(i) {
  const water = [0x5cc8f0, 0x4fb8e8][i % 2];
  const parts = [
    cyl(2.3, 2.4, 0.6, STONE, 0, 0, 0, 20),
    cyl(2.05, 2.05, 0.1, water, 0, 0.5, 0, 20),
    cyl(0.32, 0.4, 1.5, STONE, 0, 0.5, 0, 10),
    cyl(0.95, 0.55, 0.35, STONE, 0, 1.95, 0, 14),
    cyl(0.8, 0.8, 0.08, water, 0, 2.28, 0, 14),
    cyl(0.12, 0.16, 0.7, STONE, 0, 2.3, 0, 8),
  ];
  return assemble(parts, 26, true);
}

function statueSpec(i) {
  const bronze = [0x7c6a4e, 0x6f7a6c][i % 2];
  const parts = [
    box(1.8, 1.0, 1.8, 0xbfb8ad),
    box(1.2, 0.5, 1.2, 0xd0cac0, 0, 1.0),
    cyl(0.32, 0.4, 2.0, bronze, 0, 1.5, 0, 10),
    box(1.1, 0.35, 0.5, bronze, 0, 3.0, 0),
    cyl(0.36, 0.36, 0.5, bronze, 0, 3.35, 0, 10),
  ];
  return assemble(parts, 30, true);
}

function kioskSpec(i) {
  const body = WALLS[(i * 3) % WALLS.length];
  const roof = BRIGHT[i % BRIGHT.length];
  const parts = [
    box(2.2, 2.1, 2.0, body),
    box(2.4, 0.12, 0.6, WOOD, 0, 1.0, 1.2),
    box(1.8, 0.9, 0.1, GLASS, 0, 1.1, 1.02),
    pyramid(1.9, 0.9, roof, 0, 2.1),
    box(2.6, 0.12, 2.4, roof, 0, 2.05),
  ];
  return assemble(parts, 10, false);
}

function busStopSpec(i) {
  const color = [0x3a4750, 0x2f6b8a][i % 2];
  const parts = [
    cyl(0.07, 0.07, 2.5, METAL, -1.4, 0, -0.5, 6),
    cyl(0.07, 0.07, 2.5, METAL, 1.4, 0, -0.5, 6),
    box(3.2, 0.14, 1.5, color, 0, 2.5, 0),
    box(3.0, 1.5, 0.08, GLASS, 0, 0.9, -0.6),
    box(2.6, 0.12, 0.5, WOOD, 0, 0.5, -0.1),
    box(0.1, 0.5, 0.4, METAL, -1.1, 0, -0.1),
    box(0.1, 0.5, 0.4, METAL, 1.1, 0, -0.1),
  ];
  return assemble(parts, 8, false);
}

function hydrantSpec() {
  const parts = [
    cyl(0.17, 0.19, 0.62, 0xe03c3c, 0, 0, 0, 8),
    cyl(0.1, 0.16, 0.16, 0xe03c3c, 0, 0.62, 0, 8),
    box(0.5, 0.14, 0.14, 0xe03c3c, 0, 0.36, 0),
    box(0.14, 0.14, 0.3, 0xe03c3c, 0, 0.36, 0.1),
  ];
  return assemble(parts, 2, false);
}

function mailboxSpec(i) {
  const color = [0x3f7ad8, 0xd84545, 0x3aa457][i % 3];
  const parts = [box(0.12, 1.0, 0.12, METAL), box(0.55, 0.38, 0.36, color, 0, 1.0)];
  return assemble(parts, 2, false);
}

function shedSpec(i) {
  const wall = [0x9c7a5a, 0x7f8a94, 0xb4a48a][i % 3];
  const parts = [box(2.4, 2.1, 2.0, wall), gable(2.8, 1.0, 2.4, ROOFS[(i + 2) % ROOFS.length], 0, 2.1), box(0.7, 1.5, 0.08, 0x5a4232, 0, 0, 1.02)];
  return assemble(parts, 12, false);
}

function poolSpec(i) {
  const w = [4.4, 3.6][i % 2];
  const d = [3.0, 3.4][i % 2];
  const parts = [box(w, 0.26, d, 0xf1f1ee), box(w - 0.5, 0.3, d - 0.5, 0x4fc3f7, 0, 0.02)];
  return assemble(parts, 6, false);
}

function hedgeSpec(i) {
  const w = [2.6, 2.0, 3.2][i % 3];
  return assemble([box(w, 0.9, 0.7, [0x4f9a3f, 0x5fae4a, 0x3f8a3a][i % 3])], 3, false);
}

function picnicSpec() {
  const parts = [
    box(1.8, 0.1, 0.8, WOOD, 0, 0.72),
    box(1.8, 0.08, 0.32, WOOD, 0, 0.42, 0.72),
    box(1.8, 0.08, 0.32, WOOD, 0, 0.42, -0.72),
    box(0.1, 0.72, 1.7, 0x6b4630, -0.7, 0, 0),
    box(0.1, 0.72, 1.7, 0x6b4630, 0.7, 0, 0),
  ];
  return assemble(parts, 5, false);
}

function playsetSpec(i) {
  const a = BRIGHT[i % BRIGHT.length];
  const b = BRIGHT[(i + 2) % BRIGHT.length];
  const parts = [box(2.0, 0.16, 2.0, a, 0, 1.3)];
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    parts.push(cyl(0.08, 0.08, 2.9, METAL, sx * 0.9, 0, sz * 0.9, 6));
  }
  parts.push(pyramid(1.7, 0.9, b, 0, 2.9));
  parts.push(slab(0.8, 0.1, 3.0, b, 0.42, 0, 0.72, 2.25));
  parts.push(box(0.1, 0.9, 2.0, a, 0.95, 1.46, 0));
  return assemble(parts, 14, false);
}

function swingSpec(i) {
  const color = BRIGHT[(i + 1) % BRIGHT.length];
  const parts = [box(3.2, 0.14, 0.14, color, 0, 2.3)];
  for (const sx of [-1.5, 1.5]) {
    parts.push(cyl(0.07, 0.07, 2.35, color, sx, 0, -0.55, 6));
    parts.push(cyl(0.07, 0.07, 2.35, color, sx, 0, 0.55, 6));
  }
  for (const sx of [-0.7, 0.7]) {
    parts.push(box(0.5, 0.06, 0.26, WOOD, sx, 0.62));
    parts.push(box(0.03, 1.65, 0.03, METAL, sx - 0.22, 0.68));
    parts.push(box(0.03, 1.65, 0.03, METAL, sx + 0.22, 0.68));
  }
  return assemble(parts, 8, false);
}

const COMPOSITES = [
  ["house", 8, houseSpec],
  ["shop", 6, shopSpec],
  ["building", 8, buildingSpec],
  ["tower", 3, towerSpec],
  ["fountain", 2, fountainSpec],
  ["statue", 2, statueSpec],
  ["kiosk", 5, kioskSpec],
  ["busstop", 2, busStopSpec],
  ["hydrant", 1, hydrantSpec],
  ["mailbox", 3, mailboxSpec],
  ["shed", 3, shedSpec],
  ["pool", 2, poolSpec],
  ["hedge", 3, hedgeSpec],
  ["picnic", 1, picnicSpec],
  ["playset", 3, playsetSpec],
  ["swing", 2, swingSpec],
];

function seedBlocks() {
  for (const [kind, count, build] of COMPOSITES) {
    const list = [];
    for (let i = 0; i < count; i++) list.push(build(i));
    pools.set(kind, list);
  }
}

function lambert(map) {
  const cached = matByMap.get(map);
  if (cached) return cached;
  const mat = new THREE.MeshLambertMaterial({
    map,
    color: 0xffffff,
    side: THREE.DoubleSide,
  });
  if (map) {
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 8;
  }
  matByMap.set(map, mat);
  materials.push(mat);
  return mat;
}

const _skinVertex = new THREE.Vector3();

function bakeMesh(obj) {
  const geo = obj.geometry.clone();
  if (obj.isSkinnedMesh) {
    obj.skeleton.update();
    const pos = geo.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      _skinVertex.fromBufferAttribute(pos, i);
      obj.applyBoneTransform(i, _skinVertex);
      _skinVertex.applyMatrix4(obj.matrixWorld);
      pos.setXYZ(i, _skinVertex.x, _skinVertex.y, _skinVertex.z);
    }
    geo.deleteAttribute("skinIndex");
    geo.deleteAttribute("skinWeight");
    geo.computeVertexNormals();
    return geo;
  }
  geo.applyMatrix4(obj.matrixWorld);
  return geo;
}

const _wheelBox = new THREE.Box3();
const _wheelSize = new THREE.Vector3();
const _wheelMid = new THREE.Vector3();

// Las ruedas de Kenney traen ~330-430 triángulos cada una y desde la cámara casi
// no se ven: se reemplazan por un cilindro de 8 lados pintado con el color de la goma.
function lowWheel(mesh) {
  const src = mesh.geometry;
  const pos = src.getAttribute("position");
  const uv = src.getAttribute("uv");
  if (!uv) return null;
  _wheelBox.setFromBufferAttribute(pos);
  _wheelBox.getSize(_wheelSize);
  _wheelBox.getCenter(_wheelMid);
  const axle = _wheelSize.x <= _wheelSize.y && _wheelSize.x <= _wheelSize.z ? "x" : _wheelSize.z <= _wheelSize.y ? "z" : "y";
  const radius = axle === "x" ? Math.max(_wheelSize.y, _wheelSize.z) / 2 : axle === "z" ? Math.max(_wheelSize.x, _wheelSize.y) / 2 : Math.max(_wheelSize.x, _wheelSize.z) / 2;
  let tread = 0;
  let farthest = -1;
  for (let i = 0; i < pos.count; i++) {
    const dx = axle === "x" ? 0 : pos.getX(i) - _wheelMid.x;
    const dy = axle === "y" ? 0 : pos.getY(i) - _wheelMid.y;
    const dz = axle === "z" ? 0 : pos.getZ(i) - _wheelMid.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > farthest) {
      farthest = d;
      tread = i;
    }
  }
  const geo = new THREE.CylinderGeometry(radius, radius, _wheelSize[axle], 8);
  if (axle === "x") geo.rotateZ(Math.PI / 2);
  else if (axle === "z") geo.rotateX(Math.PI / 2);
  geo.translate(_wheelMid.x, _wheelMid.y, _wheelMid.z);
  const uvs = geo.getAttribute("uv");
  for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uv.getX(tread), uv.getY(tread));
  geo.applyMatrix4(mesh.matrixWorld);
  return geo;
}

function bake(root, lightWheels = false) {
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    if (obj.isSkinnedMesh) obj.skeleton.update();
    const wheel = lightWheels && /wheel/i.test(`${obj.name} ${obj.parent?.name || ""}`);
    const geo = (wheel && lowWheel(obj)) || bakeMesh(obj);
    // Sin mapas de normales el tangente no se usa, y así todas las piezas mergean igual.
    geo.deleteAttribute("tangent");
    parts.push(geo);
  });
  const geo = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (!geo) throw new Error("sin geometría");
  for (const part of parts) {
    if (part !== geo) part.dispose();
  }
  return geo;
}

function sit(geo, fit) {
  geo.computeBoundingBox();
  const box = geo.boundingBox;
  geo.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  geo.computeBoundingBox();
  const fitted = geo.boundingBox;
  const wide = Math.max(fitted.max.x - fitted.min.x, fitted.max.z - fitted.min.z, 0.001);
  const tall = Math.max(fitted.max.y - fitted.min.y, 0.001);
  const scale = fit.footprint ? fit.footprint / wide : fit.height / tall;
  geo.scale(scale, scale, scale);
  geo.computeBoundingBox();
  const finalBox = geo.boundingBox;
  const hx = Math.max(Math.abs(finalBox.min.x), Math.abs(finalBox.max.x));
  const hz = Math.max(Math.abs(finalBox.min.z), Math.abs(finalBox.max.z));
  return {
    geo,
    eatR: Math.max(0.28, Math.max(hx, hz)),
    solidR: Math.max(0.16, Math.min(hx, hz)),
    halfX: hx,
    halfZ: hz,
    height: Math.max(0, finalBox.max.y),
  };
}

async function posedGeometry(gltf, pose, index, lightWheels) {
  const root = gltf.scene;
  let poseTime = 0;
  if (pose) {
    const clip = gltf.animations.find((item) => item.name === pose) || gltf.animations[0];
    if (clip) {
      const mixer = new THREE.AnimationMixer(root);
      const action = mixer.clipAction(clip);
      action.play();
      poseTime = (index * 0.13) % Math.max(0.2, clip.duration);
      mixer.update(poseTime);
      root.updateMatrixWorld(true);
    }
  }
  return bake(root, lightWheels);
}

async function loadEntry(entry) {
  const base = `/models/${entry.dir}`;
  const atlas = await loadTexture(`${base}/Textures/colormap.png`);
  const extraMaps = entry.variations?.length
    ? await Promise.all(entry.variations.map((name) => loadTexture(`${base}/Textures/${name}`)))
    : [];
  const loaded = await Promise.all(
    entry.files.map(async (file, index) => {
      const gltf = await loadGltf(`${base}/${file}`);
      const geo = await posedGeometry(gltf, entry.pose, index, entry.dir === "cars");
      let map = atlas;
      if (!map) {
        gltf.scene.traverse((obj) => {
          if (!map && obj.isMesh && obj.material?.map) map = obj.material.map;
        });
      }
      return { geo, map };
    }),
  );
  const shared = new Map();
  for (const item of loaded) {
    const shaped = sit(item.geo, entry.fit);
    const maps = [item.map, ...extraMaps].filter(Boolean);
    for (const map of maps) {
      if (!shared.has(map)) shared.set(map, lambert(map));
      let list = pools.get(entry.kind);
      if (!list) pools.set(entry.kind, (list = []));
      list.push({
        geo: shaped.geo,
        eatR: shaped.eatR,
        solidR: shaped.solidR,
        halfX: shaped.halfX,
        halfZ: shaped.halfZ,
        height: shaped.height,
        material: shared.get(map),
        mass: entry.mass,
        heavy: entry.heavy,
      });
    }
  }
}

export async function loadProps() {
  seedBlocks();
  await Promise.all(CATALOG.map((entry) => loadEntry(entry)));
}

export function propMaterials() {
  return materials;
}

export function makeProp(kind, rng) {
  const pool = pools.get(kind);
  const built = pool[Math.floor(rng() * pool.length)];
  const mesh = new THREE.Mesh(built.geo, built.material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  return {
    mesh,
    eatR: built.eatR,
    solidR: built.solidR,
    halfX: built.halfX,
    halfZ: built.halfZ,
    mass: built.mass,
    heavy: built.heavy,
    height: built.height,
    kind,
  };
}
