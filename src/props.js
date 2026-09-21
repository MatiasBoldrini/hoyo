import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Modelos CC0 de Kenney (kenney.nl): City Kit Suburban, Commercial y Roads,
// Car Kit, y Blocky Characters. No están modelados en el juego.
const CATALOG = [
  {
    kind: "house",
    dir: "suburb",
    files: letters("a", "u").map((ch) => `building-type-${ch}.glb`),
    fit: { footprint: 5.4 },
    mass: 48,
    heavy: true,
    variations: ["variation-a.png", "variation-b.png", "variation-c.png"],
  },
  {
    kind: "building",
    dir: "commercial",
    files: letters("a", "n").map((ch) => `building-${ch}.glb`),
    fit: { footprint: 6.2 },
    mass: 72,
    heavy: true,
    variations: ["variation-a.png", "variation-b.png"],
  },
  {
    kind: "tower",
    dir: "commercial",
    files: letters("a", "e").map((ch) => `building-skyscraper-${ch}.glb`),
    fit: { footprint: 7.2 },
    mass: 110,
    heavy: true,
    variations: ["variation-a.png", "variation-b.png"],
  },
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
    kind: "person",
    dir: "people",
    files: ["female", "male"].flatMap((gender) => letters("a", "f").map((ch) => `character-${gender}-${ch}.glb`)),
    fit: { height: 1.65 },
    mass: 4,
    heavy: false,
    pose: "idle",
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

function letters(from, to) {
  const out = [];
  for (let code = from.charCodeAt(0); code <= to.charCodeAt(0); code++) out.push(String.fromCharCode(code));
  return out;
}

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

function bake(root) {
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    if (obj.isSkinnedMesh) obj.skeleton.update();
    parts.push(bakeMesh(obj));
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
    height: Math.max(0, finalBox.max.y),
  };
}

async function posedGeometry(gltf, pose, index) {
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
  return bake(root);
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
      const geo = await posedGeometry(gltf, entry.pose, index);
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
        height: shaped.height,
        material: shared.get(map),
        mass: entry.mass,
        heavy: entry.heavy,
      });
    }
  }
}

export async function loadProps() {
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
    mass: built.mass,
    heavy: built.heavy,
    height: built.height,
    kind,
  };
}
