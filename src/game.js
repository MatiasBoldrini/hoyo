import * as THREE from "three";
import { ConvexGeometry } from "three/addons/geometries/ConvexGeometry.js";
import marketCatalog from "./market-catalog.json";
import { loadProps, makeProp, propMaterials } from "./props.js";
import { createSfx } from "./audio.js";

export const PLAYER_COLORS = [0x2f6bff, 0xff3b5c, 0x22c55e, 0xf5b301, 0xa855f7, 0x14b8a6, 0xf97316, 0xec4899];

const BLOCK = 36;
const ROAD = 7.4;
const G0 = -4;
const G1 = 4;
const ISLAND = 148;
const SHORE = 154;
const SEA = 268;
const SKY = 0x8ec8f8;
const ROUND = 120;
const START_R = 0.82;
const EXPLORE_HEIGHT = 20;
// Conserva la inclinación de la cámara del juego sin convertir exploración
// en una cámara de vuelo libre.
const EXPLORE_PITCH = -0.78;
// Lo que cae tiene que estar sobre el vacío: el aro cubre hasta ~0.82R y el embudo
// va de 0.88R arriba a 0.5R en el fondo (ver syncHole y createHole).
const MOUTH = 0.84;
const PIT_TOP = 0.88;
const PIT_BOTTOM = 0.5;
const BOTS = [
  ["Luna", 0xff4d6d],
  ["Nico", 0x4dabf7],
  ["Sol", 0xffd43b],
  ["Mía", 0x69db7c],
  ["Teo", 0x9775fa],
  ["Zoe", 0xff922b],
  ["Leo", 0x20c997],
  ["Ari", 0xf06595],
  ["Kai", 0x748ffc],
];

const MAX_HOLES = 10;
const holeXZR = Array.from({ length: MAX_HOLES }, () => new THREE.Vector3());
const timeU = { value: 0 };

function radiusFromMass(mass) {
  return Math.min(20, START_R * Math.sqrt(1 + mass / 18));
}

function moveSpeed(radius) {
  const grown = Math.max(0, radius - START_R);
  return Math.max(4.42, 6.46 - grown * 0.2125);
}

function mod(a, b) {
  return ((a % b) + b) % b;
}

function distToGrid(v) {
  const m = mod(v, BLOCK);
  return Math.min(m, BLOCK - m);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function grassTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d");
  g.fillStyle = "#8ed44a";
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 2200; i++) {
    g.fillStyle = Math.random() > 0.5 ? "rgba(255,255,255,0.045)" : "rgba(0,0,0,0.05)";
    const s = 2 + Math.random() * 4;
    g.fillRect(Math.random() * 512, Math.random() * 512, s, s);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(22, 22);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Requiere uHoleXZR declarado antes. Un hoyo dentro del radio exterior de otro mayor
// queda tapado: no se dibuja ni abre el piso, así no queda un agujero al cielo.
const COVER_GLSL = `
bool coveredBy(vec2 p, float selfR) {
  for (int j = 0; j < 10; j++) {
    float hj = uHoleXZR[j].z;
    if (hj > selfR * 1.04 && distance(p, uHoleXZR[j].xy) < hj * 1.06) return true;
  }
  return false;
}
`;

function enableHoleClip(material, disc = 0) {
  material.customProgramCacheKey = () => "hole-clip-v3";
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHoleXZR = { value: holeXZR };
    shader.uniforms.uDisc = { value: disc };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorldHole;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWorldHole = worldPosition.xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vWorldHole;
uniform vec3 uHoleXZR[10];
uniform float uDisc;
${COVER_GLSL}`,
      )
      .replace(
        "#include <tonemapping_fragment>",
        `
if (uDisc > 0.0 && dot(vWorldHole.xz, vWorldHole.xz) > uDisc * uDisc) discard;
float holeShade = 1.0;
for (int i = 0; i < 10; i++) {
  float hr = uHoleXZR[i].z;
  if (hr > 0.0) {
    float hd = distance(vWorldHole.xz, uHoleXZR[i].xy);
    if (hd < hr * 1.45 + 0.3 && !coveredBy(vWorldHole.xz, hr)) {
      if (hd < hr * 0.9) discard;
      float rim = smoothstep(hr * 1.45 + 0.3, hr * 1.02, hd);
      holeShade = min(holeShade, mix(1.0, 0.58, rim * rim));
    }
  }
}
gl_FragColor.rgb *= holeShade;
#include <tonemapping_fragment>
`,
      );
  };
  return material;
}

function onIsland(x, z, margin = 0) {
  const reach = ISLAND - margin;
  return x * x + z * z < reach * reach;
}

function cornersInside(cx, cz, half, radius) {
  const limit = radius * radius;
  const xs = [cx - half, cx + half];
  const zs = [cz - half, cz + half];
  return xs.every((x) => zs.every((z) => x * x + z * z <= limit));
}

function axisReach(fixed, margin = 8) {
  const room = (ISLAND - margin) * (ISLAND - margin) - fixed * fixed;
  if (room <= 16) return null;
  const reach = Math.sqrt(room);
  return { min: -reach, max: reach };
}

let pitClipSerial = 0;
const pitCam = { value: new THREE.Vector3() };

// Tramado Bayer 4x4 para desvanecer props opacos sin ordenar transparencias,
// y oscurecido cerca del piso como oclusión ambiental barata.
const PROP_GLSL = `
float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float groundAo(float y) { float k = clamp(y / 1.2, 0.0, 1.0); return mix(0.7, 1.0, k * (2.0 - k)); }
`;

function enablePitClip(material) {
  const pitKey = `pit-clip-v7-${pitClipSerial++}`;
  material.transparent = false;
  material.depthWrite = true;
  material.customProgramCacheKey = () => pitKey;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHoleXZR = { value: holeXZR };
    shader.uniforms.uCam = pitCam;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute float aFade;
varying float vFade;
varying vec3 vWorldHole;`,
      )
      .replace("#include <project_vertex>", "vFade = aFade;\n#include <project_vertex>")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWorldHole = worldPosition.xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying float vFade;
varying vec3 vWorldHole;
uniform vec3 uHoleXZR[10];
uniform vec3 uCam;
${PROP_GLSL}`,
      )
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
if (vFade < 0.999 && vFade <= bayer4(gl_FragCoord.xy)) discard;
if (vWorldHole.y < -0.02) {
  bool nearHole = false;
  bool inMouth = false;
  float viewS = uCam.y / max(0.35, uCam.y - vWorldHole.y);
  vec2 ground = uCam.xz + viewS * (vWorldHole.xz - uCam.xz);
  for (int i = 0; i < 10; i++) {
    float hr = uHoleXZR[i].z;
    if (hr <= 0.0) continue;
    if (distance(vWorldHole.xz, uHoleXZR[i].xy) < hr + 2.4) nearHole = true;
    if (distance(ground, uHoleXZR[i].xy) < hr * 0.96) inMouth = true;
  }
  if (nearHole && !inMouth) discard;
}`,
      )
      .replace(
        "#include <tonemapping_fragment>",
        `gl_FragColor.rgb *= groundAo(vWorldHole.y);
#include <tonemapping_fragment>`,
      );
  };
  return material;
}

const fallMatCache = new WeakMap();

function fallingMaterial(source) {
  const cached = fallMatCache.get(source);
  if (cached) return cached;
  const mat = source.clone();
  mat.transparent = false;
  mat.depthWrite = true;
  mat.depthTest = true;
  mat.customProgramCacheKey = () => "fall-mask-v5";
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uHoleXZR = { value: holeXZR };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorldHole;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWorldHole = worldPosition.xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vWorldHole;
uniform vec3 uHoleXZR[10];
${PROP_GLSL}`,
      )
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
float mouthR = 0.0;
if (vWorldHole.y < -0.02) {
  for (int i = 0; i < 10; i++) {
    float hr = uHoleXZR[i].z;
    if (hr > 0.0 && distance(vWorldHole.xz, uHoleXZR[i].xy) < hr * 0.9) mouthR = max(mouthR, hr);
  }
  if (mouthR == 0.0) discard;
}`,
      )
      .replace(
        "#include <tonemapping_fragment>",
        `// Se funde en negro a la misma profundidad que las paredes del hoyo (fallBlack en JS).
gl_FragColor.rgb *= vWorldHole.y < 0.0 ? clamp(1.0 + vWorldHole.y / (0.12 + mouthR * 0.42), 0.0, 1.0) : groundAo(vWorldHole.y);
#include <tonemapping_fragment>`,
      );
  };
  fallMatCache.set(source, mat);
  return mat;
}

function nameSprite(text, color) {
  // Dos píxeles de textura por píxel CSS alcanzan para texto nítido sin crear
  // una textura de 1 MB por cada jugador y bot.
  const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const c = document.createElement("canvas");
  c.width = Math.round(256 * scale);
  c.height = Math.round(64 * scale);
  const g = c.getContext("2d");
  g.scale(scale, scale);
  g.imageSmoothingQuality = "high";
  g.font = "800 32px Trebuchet MS, sans-serif";
  const width = Math.min(232, Math.ceil(g.measureText(text).width) + 36);
  const x = (256 - width) / 2;
  g.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  roundRect(g, x, 10, width, 44, 22);
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = "rgba(255,255,255,0.85)";
  g.stroke();
  g.fillStyle = "#ffffff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false });
  const sprite = new THREE.Sprite(mat);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 10;
  return sprite;
}

// Solo se ofrecen soportes donde una marca puede integrarse de forma creíble.
// El resto de los props sigue existiendo en la ciudad, pero no entra al inventario comercial.
const MARKET_BUILDINGS = new Set(["shop", "building", "tower"]);
const MARKET_LANDMARKS = new Set(["kiosk", "fountain"]);
const MARKET_KINDS = new Set([...MARKET_BUILDINGS, ...MARKET_LANDMARKS]);

function marketZone(x, z) {
  const dist = Math.hypot(x, z);
  if (dist < 48) return "Centro";
  if (dist < 92) return x < 0 ? "Distrito Oeste" : "Distrito Este";
  if (z < 0) return "Barrio Costero Sur";
  return "Barrio Costero Norte";
}

function marketPrice(category, x, z, kind = "") {
  const centrality = Math.max(0, 1 - Math.hypot(x, z) / ISLAND);
  const base = { building: 310, place: 160 }[category];
  const premium = kind === "tower" ? 260 : kind === "building" ? 140 : 0;
  return Math.round((base + centrality * base * 1.35 + premium) / 10) * 10;
}

function marketCoordinate(value) {
  const quantized = Math.round(value * 1000);
  return `${quantized < 0 ? "m" : "p"}${Math.abs(quantized)}`;
}

function stableMarketId(category, kind, x, z) {
  return `${category}-${kind}-${marketCoordinate(x)}-${marketCoordinate(z)}`;
}


function assetName(kind, index) {
  const serial = String(index + 1).padStart(2, "0");
  const names = {
    shop: "Local comercial",
    building: "Edificio urbano",
    tower: "Torre central",
    kiosk: "Kiosco de plaza",
    fountain: "Fuente pública",
  };
  return `${names[kind]} ${serial}`;
}

function buildMarketInventory(objects) {
  const items = [];
  const counts = { building: 0, place: 0 };
  const catalogNames = new Map(marketCatalog.items);
  objects.forEach((object, objectIndex) => {
    if (!MARKET_KINDS.has(object.kind)) return;
    const category = MARKET_BUILDINGS.has(object.kind) ? "building" : "place";
    const index = counts[category]++;
    const zone = marketZone(object.x, object.z);
    const medallion = object.kind === "fountain";
    const id = stableMarketId(category, object.kind, object.x, object.z);
    items.push({
      id,
      legacyId: `asset-${objectIndex}`,
      shortId: `${category === "building" ? "ED" : "EP"}-${String(index + 1).padStart(3, "0")}`,
      category,
      kind: object.kind,
      name: catalogNames.get(id) || assetName(object.kind, index),
      description:
        category === "building"
          ? "Tu identidad en la fachada de uno de los edificios que protagonizan la ciudad."
          : medallion
            ? "Una insignia integrada al frente de una fuente en un punto de encuentro de la ciudad."
            : "Una aplicación de marca integrada al frente de un kiosco urbano.",
      zone,
      reach: Math.hypot(object.x, object.z) < 72 ? "Alta" : "Media",
      price: marketPrice(category, object.x, object.z, object.kind),
      x: object.x,
      z: object.z,
      height: object.height,
      placement: medallion ? "medallion" : "facade",
      target: object,
    });
  });
  const actualCatalog = items.map(({ id, name }) => [id, name]);
  if (JSON.stringify(actualCatalog) !== JSON.stringify(marketCatalog.items)) {
    throw new Error("Catálogo de marketplace desincronizado con el inventario curado");
  }
  return items;
}

function drawContainedImage(ctx, image, x, y, width, height) {
  const scale = Math.min(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  ctx.drawImage(
    image,
    x + (width - drawWidth) / 2,
    y + (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function brandSurface(record, item) {
  const designWidth = 512;
  const designHeight = 256;
  const textureScale = 2;
  const design = {
    x: THREE.MathUtils.clamp(Number(record.design?.x ?? 0.5), 0.05, 0.95),
    y: THREE.MathUtils.clamp(Number(record.design?.y ?? 0.5), 0.05, 0.95),
    scale: THREE.MathUtils.clamp(Number(record.design?.scale ?? 0.46), 0.18, 0.82),
    rotation: THREE.MathUtils.clamp(Number(record.design?.rotation ?? 0), -45, 45),
  };
  const canvas = document.createElement("canvas");
  canvas.width = designWidth * textureScale;
  canvas.height = designHeight * textureScale;
  const ctx = canvas.getContext("2d");
  ctx.scale(textureScale, textureScale);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 16;

  const paint = (image = null) => {
    ctx.clearRect(0, 0, designWidth, designHeight);
    const color = record.color || "#2257e6";
    if (image) {
      drawContainedImage(ctx, image, 18, 18, designWidth - 36, designHeight - 36);
    } else {
      const label = record.company || "Tu empresa";
      const fontSize = Math.max(42, designWidth / Math.max(5.5, label.length * 0.58));
      ctx.font = `900 ${fontSize}px Avenir Next, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(10, fontSize * 0.14);
      ctx.strokeStyle = "rgba(255,255,255,.94)";
      ctx.strokeText(label, designWidth / 2, designHeight / 2, designWidth - 28);
      ctx.fillStyle = color;
      ctx.fillText(label, designWidth / 2, designHeight / 2, designWidth - 28);
    }
    texture.needsUpdate = true;
  };
  paint();
  if (record.logo) {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => paint(image);
    image.src = record.logo;
  }
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.015,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const geometry = new THREE.PlaneGeometry(1, 1);
  const surface = new THREE.Group();
  const target = item.target;
  const addPanel = (faceWidth, faceDepth, yaw) => {
    const width = faceWidth * design.scale;
    const height = width * (designHeight / designWidth);
    const horizontal = (design.x - 0.5) * Math.max(0, faceWidth - width);
    const y = height / 2 + (1 - design.y) * Math.max(0, target.height - height);
    const normalX = Math.sin(yaw);
    const normalZ = Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const panel = new THREE.Mesh(geometry, material);
    panel.position.set(
      normalX * (faceDepth + 0.08) + rightX * horizontal,
      y,
      normalZ * (faceDepth + 0.08) + rightZ * horizontal,
    );
    panel.rotation.y = yaw;
    panel.rotation.z = THREE.MathUtils.degToRad(-design.rotation);
    panel.scale.set(width, height, 1);
    panel.renderOrder = 8;
    surface.add(panel);
  };
  addPanel(target.halfX * 2, target.halfZ, 0);
  addPanel(target.halfX * 2, target.halfZ, Math.PI);
  addPanel(target.halfZ * 2, target.halfX, Math.PI / 2);
  addPanel(target.halfZ * 2, target.halfX, -Math.PI / 2);
  surface.userData.surfaceGeometry = geometry;
  surface.userData.surfaceMaterial = material;
  surface.userData.baseScale = new THREE.Vector3(1, 1, 1);
  return surface;
}

function disposeBrandSurface(surface) {
  surface.userData.surfaceGeometry.dispose();
  surface.userData.surfaceMaterial.map?.dispose();
  surface.userData.surfaceMaterial.dispose();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Un hoyo más grande tapa al chico: el fragmento se descarta si su línea de visión
// entra al hoyo dentro del radio exterior del mayor. Se proyecta al piso desde la cámara
// porque la pared del fondo, vista por la parte libre de la boca, puede quedar bajo el mayor.
const COVER_DECL = `
uniform vec3 uHoleXZR[10];
uniform float uSelfR;
uniform vec3 uCam;
${COVER_GLSL}
`;
const COVER_DISCARD = `
vec2 coverAt = vCoverWorld.xz;
if (vCoverWorld.y < -0.01) coverAt = uCam.xz + (uCam.y / max(0.35, uCam.y - vCoverWorld.y)) * (vCoverWorld.xz - uCam.xz);
if (coveredBy(coverAt, uSelfR)) discard;
`;

let rimCoverSerial = 0;

// Aro grueso y redondeado del color del jugador, con brillo arriba.
function rimMaterial(color) {
  const tint = new THREE.Color(color);
  const uSelfR = { value: START_R };
  const mat = new THREE.MeshStandardMaterial({
    color: tint,
    roughness: 0.3,
    metalness: 0.04,
    emissive: tint.clone().multiplyScalar(0.26),
    transparent: true,
  });
  const key = `rim-cover-v2-${rimCoverSerial++}`;
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uHoleXZR = { value: holeXZR };
    shader.uniforms.uSelfR = uSelfR;
    shader.uniforms.uCam = pitCam;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCoverWorld;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvCoverWorld = worldPosition.xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vCoverWorld;\n${COVER_DECL}`)
      .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>\n${COVER_DISCARD}`);
  };
  mat.userData.uSelfR = uSelfR;
  return mat;
}

// Bisel interior: embudo del mismo color pero oscuro, que se funde en negro.
function wallMaterial(color) {
  const tint = new THREE.Color(color);
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      uColor: { value: tint },
      uDepth: { value: 1 },
      uBand: { value: 0.3 },
      uSelfR: { value: START_R },
      uHoleXZR: { value: holeXZR },
      uCam: pitCam,
    },
    vertexShader: `
      varying float vH;
      varying vec3 vN;
      varying vec3 vCoverWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vCoverWorld = world.xyz;
        vH = position.y + 0.5;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uDepth;
      uniform float uBand;
      ${COVER_DECL}
      varying float vH;
      varying vec3 vN;
      varying vec3 vCoverWorld;
      void main() {
        ${COVER_DISCARD}
        vec3 inward = normalize(-vN);
        float face = clamp(dot(inward, normalize(vec3(0.0, 0.35, 1.0))), 0.0, 1.0);
        float down = (1.0 - vH) * uDepth;
        float k = clamp(down / uBand, 0.0, 1.0);
        float shade = mix(0.58, 0.16, k);
        float fade = 1.0 - smoothstep(0.75, 1.0, k);
        vec3 col = uColor * shade * fade * (0.55 + 0.45 * face);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

function mouthMaterial() {
  return new THREE.ShaderMaterial({
    depthWrite: false,
    uniforms: {
      uSelfR: { value: START_R },
      uHoleXZR: { value: holeXZR },
      uCam: pitCam,
    },
    vertexShader: `
      varying vec2 vLocal;
      varying vec3 vCoverWorld;
      void main() {
        vLocal = position.xy;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vCoverWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      ${COVER_DECL}
      varying vec2 vLocal;
      varying vec3 vCoverWorld;
      void main() {
        ${COVER_DISCARD}
        float r = length(vLocal);
        float edge = smoothstep(0.86, 1.0, r);
        vec3 col = mix(vec3(0.0), vec3(0.006), edge);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

export async function mountGame(canvas, hooks) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  const dpr = window.devicePixelRatio || 1;
  const res = {
    ratio: Math.min(dpr, 1.5),
    min: Math.min(dpr, 0.75),
    max: Math.min(dpr, 2),
    ceiling: Infinity,
    refresh: 1 / 60,
    calm: 0,
    samples: [],
  };
  renderer.setPixelRatio(res.ratio);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.setClearColor(SKY, 1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 70, 210);

  const camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.1, 800);
  camera.position.set(28, 24, 28);

  const hemi = new THREE.HemisphereLight(0xe7f6ff, 0x9ed45a, 1.05);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff6df, 1.35);
  sun.position.set(40, 70, 24);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 12;
  sun.shadow.camera.far = 220;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.position.set(48, 90, 28);
  sun.target.position.set(0, 0, 0);
  let shadowX = 0;
  let shadowZ = 0;
  let shadowSpan = 46;
  scene.add(sun, sun.target);

  const rand = mulberry32(20260921);
  const objects = [];
  const holes = [];
  const remoteHoles = new Map();
  let phase = "menu";
  let timeLeft = ROUND;
  let roundDuration = ROUND;
  let objectRefill = 0;
  let refillClock = 0;
  let networkId = "";
  let networkHost = false;
  let networkPublishAt = 0;
  let toast = "";
  let toastUntil = 0;
  let camOrbit = 0.4;
  let camYaw = 0;
  let camYawGoal = 0;
  let shake = 0;
  let player = null;
  const pointer = new THREE.Vector2();
  let pointerReady = false;
  const aimRay = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const aimPoint = new THREE.Vector3();
  const clock = new THREE.Clock();
  const sfx = createSfx();
  const v = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const look = new THREE.Vector3();
  const explorePosition = new THREE.Vector3(0, EXPLORE_HEIGHT, 112);
  const exploreVelocity = new THREE.Vector3();
  const exploreWish = new THREE.Vector3();
  const exploreReturnPosition = new THREE.Vector3();
  const exploreFocusCenter = new THREE.Vector3();
  const exploreFocusDirection = new THREE.Vector3();
  const exploreFocusGoal = new THREE.Vector3();
  const exploreFocusLook = new THREE.Vector3();
  const exploreFocusRight = new THREE.Vector3();
  const exploreFocusToward = new THREE.Vector3();
  const exploreKeys = new Set();
  let exploreYaw = 0;
  let explorePitch = EXPLORE_PITCH;
  let exploreReturnYaw = 0;
  let exploreReturnPitch = EXPLORE_PITCH;
  let exploreFocused = null;
  let exploreReturning = false;
  let exploreHasReturnPose = false;
  let exploreFocusDistance = 8;
  let exploreSelected = null;
  let exploreHovered = null;
  let hoverVisualItem = null;
  let hoverExitItem = null;
  let hoverStrength = 0;
  let hoverExitStrength = 0;

  await loadProps();
  for (const material of propMaterials()) enablePitClip(material);
  const mapPlan = buildCity(scene, objects, rand);
  const marketItems = buildMarketInventory(objects);
  const marketByTarget = new Map(marketItems.map((item) => [item.target, item]));
  const brandMarkers = new Map();
  const outlineHulls = new WeakMap();
  const outlineGeometry = new THREE.BufferGeometry();
  const outlineMaskMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    side: THREE.FrontSide,
  });
  const selectedOutlineMask = new THREE.Mesh(outlineGeometry, outlineMaskMaterial);
  const hoverOutlineMask = new THREE.Mesh(outlineGeometry, outlineMaskMaterial);
  const hoverExitOutlineMask = new THREE.Mesh(outlineGeometry, outlineMaskMaterial);
  const selectedOutline = new THREE.Mesh(
    outlineGeometry,
    new THREE.MeshBasicMaterial({
      color: 0xffe14a,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const hoverOutline = new THREE.Mesh(
    outlineGeometry,
    new THREE.MeshBasicMaterial({
      color: 0x5ee7ff,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const hoverExitOutline = new THREE.Mesh(
    outlineGeometry,
    new THREE.MeshBasicMaterial({
      color: 0x5ee7ff,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  selectedOutline.renderOrder = 13;
  hoverOutline.renderOrder = 12;
  hoverExitOutline.renderOrder = 12;
  selectedOutlineMask.renderOrder = 10;
  hoverOutlineMask.renderOrder = 10;
  hoverExitOutlineMask.renderOrder = 10;
  selectedOutline.visible = false;
  hoverOutline.visible = false;
  hoverExitOutline.visible = false;
  selectedOutlineMask.visible = false;
  hoverOutlineMask.visible = false;
  hoverExitOutlineMask.visible = false;
  scene.add(
    selectedOutlineMask,
    hoverOutlineMask,
    hoverExitOutlineMask,
    selectedOutline,
    hoverOutline,
    hoverExitOutline,
  );
  followSun(true);

  function resetExploreOutlines() {
    hoverVisualItem = null;
    hoverExitItem = null;
    hoverStrength = 0;
    hoverExitStrength = 0;
    for (const outline of [
      selectedOutline,
      hoverOutline,
      hoverExitOutline,
      selectedOutlineMask,
      hoverOutlineMask,
      hoverExitOutlineMask,
    ]) {
      outline.visible = false;
    }
  }

  function setBranding(record) {
    const item = marketItems.find((candidate) => candidate.id === record.itemId);
    if (!item) return;
    const previous = brandMarkers.get(item.id);
    if (previous) {
      scene.remove(previous);
      disposeBrandSurface(previous);
    }
    const marker = brandSurface(record, item);
    marker.userData.marketItem = item;
    marker.userData.url = record.url;
    marker.userData.company = record.company;
    marker.userData.animation = record.animation || "float";
    marker.userData.baseScale = marker.scale.clone();
    marker.traverse((child) => {
      child.userData.marketItem = item;
      child.userData.url = record.url;
    });
    brandMarkers.set(item.id, marker);
    scene.add(marker);
  }

  function setBrandings(records) {
    for (const marker of brandMarkers.values()) {
      scene.remove(marker);
      disposeBrandSurface(marker);
    }
    brandMarkers.clear();
    for (const record of records) setBranding(record);
    updateBrandMarkers();
  }

  function updateBrandMarkers() {
    for (const marker of brandMarkers.values()) {
      const item = marker.userData.marketItem;
      const target = item.target;
      const animation = marker.userData.animation;
      const wave = Math.sin(timeU.value * 2.2 + target.x * 0.08 + target.z * 0.05);
      const pulse = animation === "pulse" ? 1 + wave * 0.018 : 1;
      const yaw = target.yaw || 0;
      marker.position.set(target.x, target.y || 0, target.z);
      marker.rotation.set(0, yaw, 0);
      marker.scale.copy(marker.userData.baseScale).multiplyScalar(pulse);
      marker.userData.surfaceMaterial.opacity = animation === "float" ? 0.94 + wave * 0.06 : 1;
      marker.visible = !target.state || target.state === "idle";
    }
  }

  const particles = [];
  const CRUMBS = 72;
  const crumbs = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshLambertMaterial({ flatShading: true }),
    CRUMBS,
  );
  crumbs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  crumbs.frustumCulled = false;
  crumbs.count = 0;
  crumbs.visible = false;
  const crumbPose = new THREE.Object3D();
  const crumbTint = new THREE.Color();
  const white = new THREE.Color(0xffffff);
  for (let i = 0; i < CRUMBS; i++) {
    crumbs.setColorAt(i, white);
    particles.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, size: 0.2, spin: 0, color: new THREE.Color() });
  }
  crumbs.instanceColor.setUsage(THREE.DynamicDrawUsage);
  scene.add(crumbs);

  function start(name, color, options = {}) {
    for (const hole of holes) disposeHole(hole);
    holes.length = 0;
    remoteHoles.clear();
    for (const obj of objects) resetObj(obj);
    player = createHole(name, color, true);
    networkId = options.networkId || "";
    networkHost = Boolean(options.networkHost);
    player.networkId = networkId || "local-player";
    roundDuration = [60, 120, 180, 300].includes(options.duration) ? options.duration : ROUND;
    objectRefill = THREE.MathUtils.clamp(Math.round(options.objectRefill || 0), 0, 2);
    refillClock = 0;
    networkPublishAt = 0;
    const requestedBots = THREE.MathUtils.clamp(Math.round(options.botCount ?? 7), 0, 7);
    const botCount = networkId && !networkHost ? 0 : requestedBots;
    const spots = spawnSpots(botCount + 1);
    placeHole(player, spots.pop());
    BOTS.slice(0, botCount).forEach(([botName, botColor], index) => {
      const hole = createHole(botName, botColor, false);
      hole.networkId = `bot-${index}`;
      hole.skill = 0.72 + rand() * 0.38;
      hole.speedMul = 0.84 + (index % 3) * 0.07;
      placeHole(hole, spots.pop());
    });
    phase = "play";
    const elapsed = options.startedAt ? Math.max(0, (Date.now() - options.startedAt) / 1000) : 0;
    timeLeft = Math.max(0, roundDuration - elapsed);
    toast = "";
    sfx.resume();
    sfx.begin();
    camYaw = 0;
    camYawGoal = 0;
    followCamera(0, true);
    followSun(true);
  }

  function networkState() {
    const shared = networkHost ? holes.filter((hole) => !hole.remote) : [player];
    return {
      sentAt: Date.now(),
      players: shared
        .filter(Boolean)
        .map((hole) => ({
          id: hole.networkId,
          name: hole.name,
          color: hole.color,
          bot: !hole.player,
          x: hole.x,
          z: hole.z,
          vx: hole.vx,
          vz: hole.vz,
          mass: hole.mass,
          score: hole.score,
          radius: hole.radius,
          alive: hole.alive,
          invuln: hole.invuln,
        })),
    };
  }

  function syncNetworkState(message) {
    if (phase !== "play" || !networkId || !Array.isArray(message?.players)) return;
    const now = performance.now();
    for (const state of message.players.slice(0, MAX_HOLES - 1)) {
      if (!state || typeof state.id !== "string" || state.id === networkId) continue;
      if (!Number.isFinite(state.x) || !Number.isFinite(state.z) || !Number.isFinite(state.radius)) continue;
      let hole = remoteHoles.get(state.id);
      if (!hole) {
        if (holes.length >= MAX_HOLES) continue;
        const name = String(state.name || "Jugador").slice(0, 12);
        const color = Number.isInteger(state.color) ? state.color & 0xffffff : 0x748ffc;
        hole = createHole(name, color, false);
        hole.networkId = state.id;
        hole.remote = true;
        hole.x = state.x;
        hole.z = state.z;
        hole.group.position.set(hole.x, 0, hole.z);
        remoteHoles.set(state.id, hole);
      }
      hole.remoteSeenAt = now;
      hole.remoteGoal = {
        x: state.x,
        z: state.z,
        vx: Number.isFinite(state.vx) ? state.vx : 0,
        vz: Number.isFinite(state.vz) ? state.vz : 0,
      };
      hole.mass = Math.max(0, Number(state.mass) || 0);
      hole.score = Math.max(0, Math.round(Number(state.score) || 0));
      hole.radius = THREE.MathUtils.clamp(state.radius, START_R, 20);
      hole.alive = state.alive !== false && now >= (hole.eatenUntil || 0);
      hole.invuln = Math.max(0, Number(state.invuln) || 0);
      if (hole.alive) {
        hole.sink = 0;
        hole.group.visible = true;
      }
    }
  }

  function removeRemoteHole(id, hole) {
    remoteHoles.delete(id);
    const index = holes.indexOf(hole);
    if (index >= 0) holes.splice(index, 1);
    disposeHole(hole);
  }

  function returnToMenu() {
    if (phase !== "play") return;
    phase = "menu";
    for (const hole of holes) hole.group.visible = false;
    for (const value of holeXZR) value.set(0, 0, 0);
  }

  function beginExplore() {
    for (const hole of holes) disposeHole(hole);
    holes.length = 0;
    remoteHoles.clear();
    player = null;
    for (const obj of objects) resetObj(obj);
    for (const value of holeXZR) value.set(0, 0, 0);
    explorePosition.set(0, EXPLORE_HEIGHT, 112);
    exploreVelocity.set(0, 0, 0);
    exploreYaw = 0;
    explorePitch = EXPLORE_PITCH;
    exploreKeys.clear();
    exploreFocused = null;
    exploreReturning = false;
    exploreHasReturnPose = false;
    exploreSelected = null;
    exploreHovered = null;
    resetExploreOutlines();
    phase = "explore";
    viewStale = true;
    followSun(true);
  }

  function endExplore() {
    if (phase !== "explore") return;
    phase = "menu";
    exploreKeys.clear();
    exploreFocused = null;
    exploreReturning = false;
    exploreHasReturnPose = false;
    exploreSelected = null;
    exploreHovered = null;
    resetExploreOutlines();
  }

  function focusExploreItem(item) {
    const target = item?.target;
    if (!target?.mesh) return;
    if (!exploreHasReturnPose) {
      exploreReturnPosition.copy(explorePosition);
      exploreReturnYaw = exploreYaw;
      exploreReturnPitch = explorePitch;
      exploreHasReturnPose = true;
    }
    exploreFocusCenter.set(target.x, Math.max(0.8, target.height * 0.52), target.z);
    exploreFocusDirection.copy(explorePosition).sub(exploreFocusCenter);
    const horizontal = Math.hypot(exploreFocusDirection.x, exploreFocusDirection.z);
    if (horizontal < 0.001) {
      exploreFocusDirection.set(Math.sin(exploreYaw), 0, Math.cos(exploreYaw));
    } else {
      exploreFocusDirection.set(
        exploreFocusDirection.x / horizontal,
        0,
        exploreFocusDirection.z / horizontal,
      );
    }
    exploreFocusDirection
      .multiplyScalar(Math.cos(EXPLORE_PITCH))
      .setY(-Math.sin(EXPLORE_PITCH))
      .normalize();
    exploreFocusDistance = THREE.MathUtils.clamp(
      Math.max(target.eatR * 3.35, target.height * 1.6),
      6.5,
      29,
    );
    exploreFocused = item;
    exploreReturning = false;
    exploreVelocity.set(0, 0, 0);
    exploreKeys.clear();
  }

  function restoreExploreView() {
    if (!exploreHasReturnPose) return;
    exploreFocused = null;
    exploreReturning = true;
    exploreVelocity.set(0, 0, 0);
    exploreKeys.clear();
  }

  function dampExploreAngle(current, target, lambda, dt) {
    const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
    return current + delta * (1 - Math.exp(-lambda * dt));
  }

  function dampExploreCamera(goal, yaw, pitch, dt) {
    const lambda = 5.2;
    explorePosition.x = THREE.MathUtils.damp(explorePosition.x, goal.x, lambda, dt);
    explorePosition.y = THREE.MathUtils.damp(explorePosition.y, goal.y, lambda, dt);
    explorePosition.z = THREE.MathUtils.damp(explorePosition.z, goal.z, lambda, dt);
    exploreYaw = dampExploreAngle(exploreYaw, yaw, lambda, dt);
    explorePitch = THREE.MathUtils.damp(explorePitch, pitch, lambda, dt);
  }

  function updateExploreFocus(dt) {
    if (exploreFocused) {
      const target = exploreFocused.target;
      exploreFocusCenter.set(target.x, Math.max(0.8, target.height * 0.52), target.z);
      exploreFocusGoal
        .copy(exploreFocusDirection)
        .multiplyScalar(exploreFocusDistance)
        .add(exploreFocusCenter);

      exploreFocusLook.copy(exploreFocusCenter);
      exploreFocusToward.copy(exploreFocusCenter).sub(exploreFocusGoal).normalize();
      if (window.innerWidth > 620) {
        exploreFocusRight.crossVectors(exploreFocusToward, camera.up).normalize();
        // Corre cámara y objetivo juntos para dejar lugar al panel sin cambiar
        // la inclinación de la toma.
        const framingOffset = exploreFocusDistance * 0.09;
        exploreFocusGoal.addScaledVector(exploreFocusRight, framingOffset);
        exploreFocusLook.addScaledVector(exploreFocusRight, framingOffset);
      }
      exploreFocusToward.copy(exploreFocusLook).sub(exploreFocusGoal).normalize();
      const yaw = Math.atan2(-exploreFocusToward.x, -exploreFocusToward.z);
      const pitch = Math.asin(THREE.MathUtils.clamp(exploreFocusToward.y, -1, 1));
      dampExploreCamera(exploreFocusGoal, yaw, pitch, dt);
      return;
    }
    if (!exploreReturning) return;
    dampExploreCamera(exploreReturnPosition, exploreReturnYaw, exploreReturnPitch, dt);
    const yawDelta = Math.atan2(
      Math.sin(exploreReturnYaw - exploreYaw),
      Math.cos(exploreReturnYaw - exploreYaw),
    );
    if (
      explorePosition.distanceToSquared(exploreReturnPosition) < 0.0025 &&
      Math.abs(yawDelta) < 0.002 &&
      Math.abs(exploreReturnPitch - explorePitch) < 0.002
    ) {
      explorePosition.copy(exploreReturnPosition);
      exploreYaw = exploreReturnYaw;
      explorePitch = exploreReturnPitch;
      exploreReturning = false;
      exploreHasReturnPose = false;
    }
  }

  function updateExplore(dt) {
    let forward = 0;
    let side = 0;
    if (!exploreFocused && !exploreReturning) {
      if (exploreKeys.has("KeyW")) forward += 1;
      if (exploreKeys.has("KeyS")) forward -= 1;
      if (exploreKeys.has("KeyD")) side += 1;
      if (exploreKeys.has("KeyA")) side -= 1;
    }
    const sin = Math.sin(exploreYaw);
    const cos = Math.cos(exploreYaw);
    exploreWish.set(
      -sin * forward + cos * side,
      0,
      -cos * forward - sin * side,
    );
    if (exploreWish.lengthSq() > 1) exploreWish.normalize();
    const speed = 17;
    exploreVelocity.x = THREE.MathUtils.damp(exploreVelocity.x, exploreWish.x * speed, 7, dt);
    exploreVelocity.y = 0;
    exploreVelocity.z = THREE.MathUtils.damp(exploreVelocity.z, exploreWish.z * speed, 7, dt);
    if (!exploreFocused && !exploreReturning) {
      explorePosition.addScaledVector(exploreVelocity, dt);
      explorePosition.y = EXPLORE_HEIGHT;
      const reach = ISLAND + 8;
      const distance = Math.hypot(explorePosition.x, explorePosition.z);
      if (distance > reach) {
        explorePosition.x *= reach / distance;
        explorePosition.z *= reach / distance;
      }
    }
    driftCity(dt);
    updateExploreFocus(dt);
    camera.position.copy(explorePosition);
    camera.rotation.set(explorePitch, exploreYaw, 0, "YXZ");
    updateExploreSelection(dt);
    followSun();
  }

  function outlineHull(source) {
    let hull = outlineHulls.get(source);
    if (hull) return hull;

    const position = source.getAttribute("position");
    const points = [];
    const used = new Set();
    const addPoint = (index) => {
      const point = new THREE.Vector3().fromBufferAttribute(position, index);
      const key = `${Math.round(point.x * 1000)}:${Math.round(point.y * 1000)}:${Math.round(point.z * 1000)}`;
      if (used.has(key)) return;
      used.add(key);
      points.push(point);
    };

    // Los extremos conservan la silueta; el muestreo acotado evita trabar el primer hover
    // con los modelos de alta densidad.
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
          if (x === 0 && y === 0 && z === 0) continue;
          let best = 0;
          let bestDot = -Infinity;
          for (let index = 0; index < position.count; index++) {
            const dot = position.getX(index) * x + position.getY(index) * y + position.getZ(index) * z;
            if (dot > bestDot) {
              bestDot = dot;
              best = index;
            }
          }
          addPoint(best);
        }
      }
    }
    const sampleCount = Math.min(180, position.count);
    for (let index = 0; index < sampleCount; index++) {
      addPoint(Math.min(position.count - 1, Math.floor(((index + 0.5) * position.count) / sampleCount)));
    }

    if (points.length >= 4) {
      hull = new ConvexGeometry(points);
    } else {
      source.computeBoundingBox();
      const size = source.boundingBox.getSize(new THREE.Vector3());
      const center = source.boundingBox.getCenter(new THREE.Vector3());
      hull = new THREE.BoxGeometry(size.x, size.y, size.z).translate(center.x, center.y, center.z);
    }
    outlineHulls.set(source, hull);
    return hull;
  }

  function syncExploreOutline(outline, mask, item, pulse = 0, reveal = 1) {
    const target = item?.target;
    if (!target?.mesh || (target.state && target.state !== "idle")) {
      outline.visible = false;
      mask.visible = false;
      return;
    }
    const geometry = outlineHull(target.mesh.geometry);
    outline.geometry = geometry;
    outline.position.copy(target.mesh.position);
    outline.quaternion.copy(target.mesh.quaternion);
    const extent = Math.max(0.5, target.eatR, target.height * 0.35);
    const expansion = 1 + (0.025 + 0.055 * reveal) / extent + pulse;
    outline.scale.copy(target.mesh.scale).multiplyScalar(expansion);
    outline.visible = true;
    mask.geometry = geometry;
    mask.position.copy(target.mesh.position);
    mask.quaternion.copy(target.mesh.quaternion);
    mask.scale.copy(target.mesh.scale);
    mask.visible = true;
  }

  function updateExploreSelection(dt = 0) {
    const pulse = (Math.sin(timeU.value * 4) + 1) * 0.006;
    syncExploreOutline(selectedOutline, selectedOutlineMask, exploreSelected, pulse);
    selectedOutline.material.opacity = 0.78 + Math.sin(timeU.value * 4) * 0.14;

    if (exploreHovered !== hoverVisualItem) {
      if (hoverVisualItem && hoverStrength > 0.01) {
        hoverExitItem = hoverVisualItem;
        hoverExitStrength = hoverStrength;
      }
      hoverVisualItem = exploreHovered;
      hoverStrength = 0;
    }

    const showHover = Boolean(hoverVisualItem && hoverVisualItem !== exploreSelected);
    hoverStrength = THREE.MathUtils.damp(hoverStrength, showHover ? 1 : 0, 12, dt);
    hoverExitStrength = THREE.MathUtils.damp(hoverExitStrength, 0, 14, dt);
    const hoverEase = THREE.MathUtils.smoothstep(hoverStrength, 0, 1);
    const exitEase = THREE.MathUtils.smoothstep(hoverExitStrength, 0, 1);

    syncExploreOutline(hoverOutline, hoverOutlineMask, hoverVisualItem, 0, hoverEase);
    hoverOutline.material.opacity = 0.78 * hoverEase;
    if (!showHover && hoverStrength < 0.01) {
      hoverOutline.visible = false;
      hoverOutlineMask.visible = false;
    }

    syncExploreOutline(hoverExitOutline, hoverExitOutlineMask, hoverExitItem, 0, exitEase);
    hoverExitOutline.material.opacity = 0.78 * exitEase;
    if (hoverExitStrength < 0.01 || hoverExitItem === exploreSelected) {
      hoverExitItem = null;
      hoverExitStrength = 0;
      hoverExitOutline.visible = false;
      hoverExitOutlineMask.visible = false;
    }
  }

  function publicMarketItem(item) {
    if (!item) return null;
    const { target, ...value } = item;
    return { ...value };
  }

  function raycastExploreItem(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    aimRay.setFromCamera(pointer, camera);
    const markerHit = aimRay.intersectObjects([...brandMarkers.values()], true)[0];
    if (markerHit && markerHit.distance < 100) return markerHit.object.userData.marketItem;
    const hit = aimRay.intersectObjects(batchList.map((record) => record.mesh), false)[0];
    if (!hit || hit.distance > 100) return null;
    const record = batchList.find((candidate) => candidate.mesh === hit.object);
    const target = record?.packedItems[hit.instanceId];
    return marketByTarget.get(target) || null;
  }

  function pickExploreItem(clientX, clientY) {
    if (phase !== "explore") return null;
    exploreSelected = raycastExploreItem(clientX, clientY);
    if (exploreSelected) focusExploreItem(exploreSelected);
    else restoreExploreView();
    updateExploreSelection();
    return publicMarketItem(exploreSelected);
  }

  function selectExploreItem(itemId) {
    if (phase !== "explore") return null;
    exploreSelected = marketItems.find((item) => item.id === itemId) || null;
    if (exploreSelected) focusExploreItem(exploreSelected);
    else restoreExploreView();
    updateExploreSelection();
    return publicMarketItem(exploreSelected);
  }

  function hoverExploreItem(clientX, clientY) {
    if (phase !== "explore") return null;
    exploreHovered = raycastExploreItem(clientX, clientY);
    updateExploreSelection();
    return publicMarketItem(exploreHovered);
  }

  function finish() {
    phase = "end";
    timeLeft = 0;
    const rows = leaderboard();
    const me = rows.find((row) => row.me);
    sfx.finish(me?.rank === 1);
    const api = mountGame._api;
    api.onEnd?.({
      won: me?.rank === 1,
      rank: me?.rank || rows.length,
      score: me?.score || 0,
      rows,
    });
  }

  function simulate(dt) {
    steerHoles(dt);
    for (const obj of objects) stepIdle(obj, dt);
    settleObjects(dt);
    for (const obj of objects) stepFall(obj, dt);
    refillObjects(dt);
    eatHoles(dt);
    if (phase !== "play") return;
    for (const hole of holes) syncHole(hole, dt);
    updateParticles(dt);
    followCamera(dt);
    followSun();
    publishHoles();
    fadeBlockers(dt);
  }

  const _cover = new THREE.Vector3();

  function holeOnScreen() {
    const pad = 0.02;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const samples = [
      [player.x, 0.2, player.z],
      [player.x + player.radius, 0.12, player.z],
      [player.x - player.radius, 0.12, player.z],
      [player.x, 0.12, player.z + player.radius],
      [player.x, 0.12, player.z - player.radius],
    ];
    for (const [x, y, z] of samples) {
      _cover.set(x, y, z).project(camera);
      if (_cover.z < -1 || _cover.z > 1) continue;
      minX = Math.min(minX, _cover.x - pad);
      maxX = Math.max(maxX, _cover.x + pad);
      minY = Math.min(minY, _cover.y - pad);
      maxY = Math.max(maxY, _cover.y + pad);
    }
    return { minX, maxX, minY, maxY };
  }

  function coversHole(obj, holeBox, holeReach) {
    const cam = camera.position;
    const hx = player.x - cam.x;
    const hz = player.z - cam.z;
    const reach = Math.hypot(hx, hz) || 1;
    const ox = obj.x - cam.x;
    const oz = obj.z - cam.z;
    const along = (ox * hx + oz * hz) / reach;
    if (along < 0 || along > reach + obj.eatR) return false;
    const side = Math.abs(ox * hz - oz * hx) / reach;
    if (side > obj.eatR + player.radius + 8) return false;
    const r = obj.eatR;
    const top = obj.height || 1;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let closest = Infinity;
    let visible = false;
    for (const y of [0.05, top]) {
      for (const sx of [-r, r]) {
        for (const sz of [-r, r]) {
          const x = obj.x + sx;
          const z = obj.z + sz;
          const dist = Math.hypot(x - cam.x, z - cam.z);
          if (dist < closest) closest = dist;
          _cover.set(x, y, z).project(camera);
          if (_cover.z < -1 || _cover.z > 1) continue;
          visible = true;
          minX = Math.min(minX, _cover.x);
          maxX = Math.max(maxX, _cover.x);
          minY = Math.min(minY, _cover.y);
          maxY = Math.max(maxY, _cover.y);
        }
      }
    }
    if (!visible || closest > holeReach - player.radius * 0.25) return false;
    return minX <= holeBox.maxX && maxX >= holeBox.minX && minY <= holeBox.maxY && maxY >= holeBox.minY;
  }

  function fadeBlockers(dt) {
    if (!player || !player.alive) return;
    const holeBox = holeOnScreen();
    const holeReach = Math.hypot(player.x - camera.position.x, player.z - camera.position.z);
    for (const obj of objects) {
      if (!obj.batch || (!obj.inView && obj.fade === 1)) continue;
      const blocks =
        obj.state === "idle" && !fitsMouth(player, obj) && coversHole(obj, holeBox, holeReach);
      const target = blocks ? 0.3 : 1;
      let next = THREE.MathUtils.damp(obj.fade, target, 10, dt);
      if (Math.abs(next - target) < 0.01) next = target;
      if (next === obj.fade) continue;
      obj.fade = next;
      obj.batch.dirty = true;
    }
  }

  function refillObjects(dt) {
    if (objectRefill === 0) return;
    refillClock += dt;
    const interval = objectRefill === 2 ? 0.85 : 2.2;
    if (refillClock < interval) return;
    refillClock %= interval;
    const available = objects.filter(
      (obj) =>
        obj.state === "gone" &&
        holes.every((hole) => Math.hypot(obj.homeX - hole.x, obj.homeZ - hole.z) > hole.radius + obj.eatR + 3),
    );
    if (available.length === 0) return;
    resetObj(available[Math.floor(rand() * available.length)]);
  }

  function steerHoles(dt) {
    const now = performance.now();
    for (const [id, hole] of remoteHoles) {
      if (now - hole.remoteSeenAt > 3500) removeRemoteHole(id, hole);
    }
    for (const hole of holes) {
      if (hole.remote) {
        if (!hole.remoteGoal) continue;
        hole.x = THREE.MathUtils.damp(hole.x, hole.remoteGoal.x, 14, dt);
        hole.z = THREE.MathUtils.damp(hole.z, hole.remoteGoal.z, 14, dt);
        hole.vx = hole.remoteGoal.vx;
        hole.vz = hole.remoteGoal.vz;
        continue;
      }
      if (!hole.alive) {
        if (hole.player) continue;
        hole.respawn -= dt;
        if (hole.respawn <= 0) revive(hole);
        continue;
      }
      let ix = 0;
      let iz = 0;
      if (hole.player) {
        const aim = groundAim();
        if (aim) {
          const dx = aim.x - hole.x;
          const dz = aim.z - hole.z;
          const dist = Math.hypot(dx, dz);
          const stop = 0.4 + hole.radius * 0.12;
          const full = 3.1 + hole.radius * 0.65;
          const gain = THREE.MathUtils.smoothstep(dist, stop, full);
          if (dist > 0.001) {
            ix = (dx / dist) * gain;
            iz = (dz / dist) * gain;
          }
        }
      } else {
        const wish = botWish(hole);
        ix = wish.x;
        iz = wish.z;
      }
      const len = Math.hypot(ix, iz);
      if (len > 1) {
        ix /= len;
        iz /= len;
      }
      const drag = hole.drag ?? 1;
      const speed = moveSpeed(hole.radius) * (hole.player ? 1 : hole.speedMul) * drag;
      const follow = hole.player ? 4.6 : 7.5;
      hole.vx = THREE.MathUtils.damp(hole.vx, ix * speed, follow, dt);
      hole.vz = THREE.MathUtils.damp(hole.vz, iz * speed, follow, dt);
      hole.x += hole.vx * dt;
      hole.z += hole.vz * dt;
      const reach = ISLAND;
      const dist = Math.hypot(hole.x, hole.z);
      if (dist > reach) {
        const scale = reach / dist;
        hole.x *= scale;
        hole.z *= scale;
        const outward = (hole.vx * hole.x + hole.vz * hole.z) / reach;
        if (outward > 0) {
          hole.vx -= (hole.x / reach) * outward;
          hole.vz -= (hole.z / reach) * outward;
        }
      }
      hole.drag = 1;
    }
  }

  function groundAim() {
    if (!pointerReady) return null;
    aimRay.setFromCamera(pointer, camera);
    return aimRay.ray.intersectPlane(groundPlane, aimPoint);
  }

  function botWish(hole) {
    const now = performance.now();
    if (now > hole.think) {
      hole.think = now + 280 + hole.skill * 180;
      let flee = null;
      let chase = null;
      for (const other of holes) {
        if (other === hole || !other.alive) continue;
        const d = Math.hypot(other.x - hole.x, other.z - hole.z);
        if (other.radius > hole.radius * 1.08 && d < other.radius + 10) {
          if (!flee || d < flee.d) flee = { d, x: hole.x - (other.x - hole.x), z: hole.z - (other.z - hole.z) };
        } else if (hole.radius > other.radius * 1.22 && d < 22 && other.invuln <= 0) {
          if (!chase || d < chase.d) chase = { d, x: other.x, z: other.z };
        }
      }
      if (flee) hole.goal = flee;
      else if (chase) hole.goal = chase;
      else hole.goal = bestFood(hole) || { x: hole.x + (rand() - 0.5) * 30, z: hole.z + (rand() - 0.5) * 30 };
    }
    const g = hole.goal || { x: 0, z: 0 };
    const dx = g.x - hole.x;
    const dz = g.z - hole.z;
    const wobble = Math.sin(timeU.value * 1.7 + hole.radius) * 0.18;
    return { x: dx + wobble, z: dz - wobble };
  }

  function bestFood(hole) {
    let best = null;
    let bestScore = -Infinity;
    for (const obj of objects) {
      if (obj.state !== "idle") continue;
      if (!fitsMouth(hole, obj)) continue;
      const d = Math.hypot(obj.x - hole.x, obj.z - hole.z);
      if (d > 42) continue;
      const value = (obj.mass * hole.skill) / (d + 2);
      if (value > bestScore) {
        bestScore = value;
        best = { x: obj.x, z: obj.z };
      }
    }
    return best;
  }

  // Resultado de probeHoles: el hoyo que traga al objeto, o el que lo hace inclinarse.
  let probeEater = null;
  let probeForce = 0;
  let probeDirX = 0;
  let probeDirZ = 0;
  let probeEdible = false;

  // Entra si su huella cabe en el vacío negro, no en el aro de color.
  function fitsMouth(hole, obj) {
    return hole.radius * MOUTH >= obj.fitR;
  }

  function probeHoles(obj) {
    probeEater = null;
    probeForce = 0;
    let eaterDist = Infinity;
    for (const hole of holes) {
      if (!hole.alive) continue;
      const dx = hole.x - obj.x;
      const dz = hole.z - obj.z;
      const near = hole.radius + obj.eatR;
      if (dx > near || dx < -near || dz > near || dz < -near) continue;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const edible = fitsMouth(hole, obj);
      if (edible && dist <= hole.radius * MOUTH) {
        if (dist < eaterDist) {
          eaterDist = dist;
          probeEater = hole;
        }
        continue;
      }
      // Se inclina recién cuando su huella se asoma al vacío, no al tocar el aro.
      const mouth = hole.radius * MOUTH;
      const reach = mouth + obj.fitR * 0.8;
      if (dist >= reach) continue;
      const size = edible ? 1 : mouth / obj.fitR;
      if (size < 0.3) continue;
      const force = (1 - dist / reach) * size;
      if (force <= probeForce) continue;
      probeForce = force;
      probeDirX = dist > 1e-4 ? dx / dist : 1;
      probeDirZ = dist > 1e-4 ? dz / dist : 0;
      probeEdible = edible;
    }
  }

  function settleObjects(dt) {
    for (const obj of objects) {
      if (obj.state !== "idle") continue;
      probeHoles(obj);
      if (probeEater) releaseFall(obj, probeEater);
      else leanObject(obj, dt);
    }
  }

  // Lo que el hoyo casi alcanza se vence hacia la boca; lo que todavía es grande tiembla.
  function leanObject(obj, dt) {
    let target = 0;
    if (probeForce > 0) {
      const tall = THREE.MathUtils.clamp(3.5 / Math.max(1, obj.height), 0.18, 1);
      if (probeEdible) target = Math.min(0.42, probeForce * 0.55) * tall;
      else target = probeForce * 0.14 * tall * (1 + Math.sin(timeU.value * 23 + obj.phase * 7) * 0.6);
      obj.axisX = probeDirZ;
      obj.axisZ = -probeDirX;
    }
    if (target === 0 && obj.wob === 0 && obj.wobVel === 0) return;
    obj.wobVel += ((target - obj.wob) * 90 - obj.wobVel * 11) * dt;
    obj.wob += obj.wobVel * dt;
    if (target === 0 && Math.abs(obj.wob) < 0.002 && Math.abs(obj.wobVel) < 0.02) {
      obj.wob = 0;
      obj.wobVel = 0;
      obj.mesh.rotation.set(0, obj.yaw, 0);
      syncBatch(obj);
      return;
    }
    obj.mesh.position.set(obj.x, 0, obj.z);
    applyLean(obj, obj.wob);
    syncBatch(obj, false);
  }

  function showFallingMesh(obj) {
    syncBatch(obj);
    const geo = obj.mesh.geometry;
    if (!geo.getAttribute("aFade")) {
      const count = geo.getAttribute("position").count;
      geo.setAttribute("aFade", new THREE.BufferAttribute(new Float32Array(count).fill(1), 1));
    }
    if (!obj.mesh.userData.baseMat) obj.mesh.userData.baseMat = obj.mesh.material;
    obj.mesh.material = fallingMaterial(obj.mesh.userData.baseMat);
    obj.mesh.visible = true;
    obj.mesh.renderOrder = 2;
    obj.mesh.frustumCulled = false;
    obj.mesh.matrixAutoUpdate = true;
    obj.mesh.castShadow = false;
    if (!obj.mesh.parent) scene.add(obj.mesh);
  }

  function releaseFall(obj, hole) {
    obj.vy = obj.heavy ? -0.35 : -0.6;
    const offX = obj.x - hole.x;
    const offZ = obj.z - hole.z;
    const len = Math.hypot(offX, offZ);
    obj.vx = 0;
    obj.vz = 0;
    obj.onWall = false;
    obj.fallT = 0;
    // Se vuelca hacia el centro del hoyo: eje perpendicular a esa dirección.
    const dx = len > 1e-4 ? -offX / len : Math.cos(obj.yaw || 0);
    const dz = len > 1e-4 ? -offZ / len : Math.sin(obj.yaw || 0);
    obj.axisX = dz;
    obj.axisZ = -dx;
    obj.tilt = obj.wob;
    obj.tiltFrom = obj.wob;
    obj.wob = 0;
    obj.wobVel = 0;
    obj.spin = 0;
    obj.spinDir = Math.random() > 0.5 ? 1 : -1;
    obj.credited = false;
    obj.state = "falling";
    obj.eater = hole;
    obj.mesh.scale.setScalar(1);
    obj.mesh.position.set(obj.x, obj.y, obj.z);
    applyLean(obj, obj.tilt);
    showFallingMesh(obj);
    if (hole.player) {
      sfx.swallow(obj.kind, obj.mass, hole.radius);
      if (navigator.vibrate) navigator.vibrate(obj.heavy ? 16 : 8);
    }
  }

  function stepIdle(obj, dt) {
    if (obj.state !== "idle" || !obj.motion) return;
    const m = obj.motion;
    const alongX = m.axis === "x";
    if (!m.ready) {
      m.ready = true;
      m.cross = alongX ? obj.z : obj.x;
      m.road = Math.round(m.cross / BLOCK) * BLOCK;
      m.lane = m.cross - m.road;
      m.ramp = 1;
      obj.yaw = Math.atan2(alongX ? m.dir : 0, alongX ? 0 : m.dir);
    }
    // Frena al llegar al final, pega la vuelta cambiando de carril y vuelve a acelerar.
    const along = alongX ? obj.x : obj.z;
    const toEnd = m.dir > 0 ? m.max - along : along - m.min;
    m.ramp = Math.min(1, m.ramp + dt / 1.4);
    const pace = Math.min(m.ramp, THREE.MathUtils.clamp(toEnd / 6, 0.18, 1));
    const step = m.speed * m.dir * pace * dt;
    if (alongX) obj.x += step;
    else obj.z += step;
    const offIsland = !onIsland(obj.x, obj.z, 3);
    if (offIsland) {
      if (alongX) obj.x -= step;
      else obj.z -= step;
    }
    if (toEnd <= 0 || offIsland) {
      m.dir *= -1;
      m.lane = -m.lane;
      m.ramp = 0.12;
    }
    m.cross = THREE.MathUtils.damp(m.cross, m.road + m.lane, 1.8, dt);
    if (alongX) obj.z = m.cross;
    else obj.x = m.cross;
    obj.yaw = dampAngle(obj.yaw, Math.atan2(alongX ? m.dir : 0, alongX ? 0 : m.dir), 3.2, dt);
    obj.mesh.position.set(obj.x, 0, obj.z);
    obj.mesh.rotation.set(0, obj.yaw, 0);
    syncBatch(obj, false);
  }

  function stepFall(obj, dt) {
    if (obj.state !== "falling") return;
    const hole = obj.eater;
    const tall = obj.height || 0.4;
    obj.fallT += dt;
    // Objetos altos caen más rápido para que el tragado no dure segundos.
    obj.vy -= (obj.heavy ? 7 : 9) * (1 + tall * 0.06) * dt;
    obj.y += obj.vy * dt;
    if (hole && hole.alive) {
      obj.x += obj.vx * dt;
      obj.z += obj.vz * dt;
      const drag = Math.exp(-1.5 * dt);
      obj.vx *= drag;
      obj.vz *= drag;
      // La pared del embudo se angosta con la profundidad: lo que la toca se desliza
      // hacia adentro y, la primera vez que choca ya hundido, rebota hacia el otro lado.
      const depth = 0.7 + hole.radius * 1.7;
      const sunk = THREE.MathUtils.clamp(-obj.y, 0, depth);
      const wall = hole.radius * (PIT_TOP - (PIT_TOP - PIT_BOTTOM) * (sunk / depth));
      const allowed = Math.max(0, wall - obj.fitR);
      const offX = obj.x - hole.x;
      const offZ = obj.z - hole.z;
      const reach = Math.hypot(offX, offZ);
      if (reach > allowed && reach > 1e-4) {
        const nx = offX / reach;
        const nz = offZ / reach;
        const out = obj.vx * nx + obj.vz * nz;
        if (!obj.onWall && sunk > 0.05) {
          const kick = Math.max(0.35 * Math.max(0, out), -obj.vy * 0.28);
          obj.vx -= nx * (out + kick);
          obj.vz -= nz * (out + kick);
          obj.vy *= 0.85;
          obj.spinDir = -obj.spinDir;
          obj.onWall = true;
        } else if (out > 0) {
          obj.vx -= nx * out;
          obj.vz -= nz * out;
        }
        const slope = ((PIT_TOP - PIT_BOTTOM) * hole.radius) / depth;
        const slide = 2 + hole.radius * 0.35 + Math.hypot(hole.vx, hole.vz) - obj.vy * slope * 1.5;
        const next = Math.max(allowed, reach - slide * dt);
        obj.x = hole.x + nx * next;
        obj.z = hole.z + nz * next;
      } else {
        obj.onWall = false;
      }
    }
    // Lo alto no puede volcarse más de lo que entra en la boca.
    const room = hole ? Math.min(1, (hole.radius * 0.8) / Math.max(0.5, tall)) : 1;
    const sink = Math.max(0, -obj.y);
    const lean = sink * (obj.heavy ? 0.22 : 0.45) + obj.fallT * 0.18;
    obj.tilt = Math.min(0.62, Math.asin(room), Math.max(obj.tiltFrom, lean));
    obj.spin += obj.spinDir * dt * (obj.heavy ? 0.35 : 0.9);
    obj.mesh.position.set(obj.x, obj.y, obj.z);
    applyLean(obj, obj.tilt);
    if (!hole) return;
    if (!obj.credited && (obj.y + tall * 0.5 < 0 || obj.fallT > 0.45)) credit(obj, hole);
    const top = obj.y + tall;
    // Pasada esa profundidad el shader ya lo pintó de negro: ahí deja de dibujarse.
    const fallBlack = 0.12 + hole.radius * 0.42;
    if (top < -fallBlack || obj.y < -30) consume(obj, hole);
  }

  function applyLean(obj, angle) {
    _axis.set(obj.axisX || 1, 0, obj.axisZ || 0);
    if (_axis.lengthSq() < 1e-8) _axis.set(1, 0, 0);
    else _axis.normalize();
    _qt.setFromAxisAngle(_axis, angle);
    _qy.setFromAxisAngle(_up, obj.yaw || 0);
    _qs.setFromAxisAngle(_up, obj.spin || 0);
    obj.mesh.quaternion.copy(_qt).multiply(_qy).multiply(_qs);
  }

  // La masa se suma apenas el objeto se hunde; el radio la sigue con el resorte de syncHole.
  function credit(obj, hole) {
    obj.credited = true;
    if (!hole.alive) return;
    hole.mass += obj.mass;
    hole.score = Math.round(hole.mass);
    hole.punch = Math.min(0.28, hole.punch + Math.min(0.16, obj.mass * 0.004));
    const near = hole.player ? 1 : Math.max(0, 1 - Math.hypot(hole.x - camera.position.x, hole.z - camera.position.z) / 45);
    shake = Math.min(0.45, shake + obj.mass * 0.003 * near);
    if (hole.player) popText(`+${obj.mass}`, hole.x, 1.15, hole.z);
    if (near > 0 || hole.player) burst(hole, obj.mass);
  }

  function consume(obj, hole) {
    if (!obj.credited) credit(obj, hole);
    obj.state = "gone";
    if (obj.mesh.parent) obj.mesh.parent.remove(obj.mesh);
    obj.mesh.visible = false;
    syncBatch(obj);
  }

  function eatHoles(dt) {
    for (const hunter of holes) {
      if (!hunter.alive) continue;
      for (const prey of holes) {
        if (prey === hunter || !prey.alive || prey.invuln > 0) continue;
        if (hunter.radius < prey.radius * 1.14) continue;
        const d = Math.hypot(prey.x - hunter.x, prey.z - hunter.z);
        if (d > hunter.radius * 0.62) continue;
        prey.alive = false;
        prey.sink = 0;
        prey.respawn = 3.1;
        hunter.mass += prey.mass * 0.65 + 12;
        hunter.score = Math.round(hunter.mass);
        hunter.punch = Math.min(0.34, hunter.punch + 0.12);
        if (prey.player) {
          toast = "¡Te tragaron!";
          toastUntil = performance.now() + 1600;
          sfx.eaten();
          returnToMenu();
          mountGame._api.onPlayerDeath?.();
        } else if (hunter.player) {
          popText(`+${Math.round(prey.mass * 0.65 + 12)}`, prey.x, 1, prey.z);
          sfx.rival();
        }
      }
    }
    for (const hole of holes) {
      if (hole.alive) hole.invuln = Math.max(0, hole.invuln - dt);
    }
  }

  function revive(hole) {
    hole.alive = true;
    hole.mass = 0;
    hole.score = 0;
    hole.radius = START_R;
    hole.radiusVel = 0;
    hole.invuln = 2.3;
    hole.vx = 0;
    hole.vz = 0;
    hole.sink = 0;
    const spot = spawnSpots(1)[0];
    hole.x = spot.x;
    hole.z = spot.z;
    hole.group.visible = true;
    hole.group.scale.setScalar(1);
    hole.group.position.y = 0;
  }

  function syncHole(hole, dt = 0) {
    hole.rim.material.userData.uSelfR.value = hole.radius;
    hole.pit.material.uniforms.uSelfR.value = hole.radius;
    hole.cap.material.uniforms.uSelfR.value = hole.radius;
    if (!hole.alive) {
      hole.sink += dt;
      hole.group.position.set(hole.x, -hole.sink * 2.2, hole.z);
      const s = Math.max(0.001, 1 - hole.sink);
      hole.group.scale.setScalar(s);
      if (s < 0.05) hole.group.visible = false;
      return;
    }
    const target = radiusFromMass(hole.mass);
    if (!(dt > 0)) {
      hole.radius = target;
      hole.radiusVel = 0;
    } else {
      hole.radiusVel += (target - hole.radius) * 16 * dt;
      hole.radiusVel *= Math.max(0, 1 - 6.2 * dt);
      hole.radius += hole.radiusVel * dt;
      if (Math.abs(target - hole.radius) < 0.004 && Math.abs(hole.radiusVel) < 0.015) {
        hole.radius = target;
        hole.radiusVel = 0;
      }
    }
    const stretch = THREE.MathUtils.clamp(hole.radiusVel * 0.45, -0.06, 0.1);
    const visual = Math.max(0.2, hole.radius * (1 + stretch));
    hole.group.visible = true;
    hole.group.position.set(hole.x, 0, hole.z);
    hole.group.scale.setScalar(1);
    // Aro: radio mayor 0.94R con tubo 0.12R (borde exterior ~1.06R, interior ~0.82R),
    // achatado en vertical para que sea un labio redondeado y no un anillo alto.
    const rimLift = THREE.MathUtils.clamp(visual * 0.05, 0.035, 0.2);
    // Cada bocado hace latir el aro: se ensancha, engorda y brilla un instante.
    if (dt > 0) hole.punch = THREE.MathUtils.damp(hole.punch, 0, 7, dt);
    const pulse = 1 + hole.punch * 0.4;
    hole.rim.scale.set(visual * 0.94 * pulse, visual * 0.94 * pulse, (rimLift * (1 + hole.punch * 1.6)) / 0.12);
    hole.rim.material.emissiveIntensity = 1 + hole.punch * 3.5;
    hole.rim.position.y = -rimLift * 0.2;
    hole.lip.visible = false;
    const depth = 0.7 + visual * 1.7;
    hole.pit.visible = true;
    hole.pit.material.uniforms.uDepth.value = depth;
    hole.pit.material.uniforms.uBand.value = 0.12 + visual * 0.42;
    hole.pit.scale.set(visual, depth, visual);
    hole.pit.position.y = 0.012 - depth * 0.5;
    hole.cap.scale.set(visual * 0.54, visual * 0.54, 1);
    hole.cap.position.y = -depth + 0.02;
    const blink = hole.invuln > 0 && Math.sin(timeU.value * 18) > 0;
    const rimOpacity = blink ? 0.25 : 1;
    hole.rim.material.opacity = rimOpacity;
    hole.lip.material.opacity = rimOpacity;
    hole.label.position.y = 1.35 + visual * 0.22;
    const dist = camera.position.distanceTo(hole.group.position);
    const labelW = Math.max(2.1, dist * 0.11);
    hole.label.scale.set(labelW, labelW * 0.25, 1);
  }

  function followCamera(dt, snap = false) {
    const radius = player ? player.radius : START_R;
    const focus = player || { x: 0, z: 0, radius };
    const back = 9.2 + radius * 1.85;
    const height = 12.4 + radius * 2.15;
    const ahead = 2.8 + radius * 0.42;
    shake *= Math.pow(0.92, dt * 60);
    // Solo gira alrededor del hoyo: la altura y la inclinación no cambian.
    camYaw = snap ? camYawGoal : THREE.MathUtils.damp(camYaw, camYawGoal, 14, dt);
    const sx = Math.sin(camYaw);
    const cz = Math.cos(camYaw);
    desired.set(
      focus.x + sx * back + Math.sin(timeU.value * 31) * shake,
      height,
      focus.z + cz * back + Math.cos(timeU.value * 27) * shake * 0.6,
    );
    if (snap) camera.position.copy(desired);
    else camera.position.lerp(desired, 1 - Math.pow(0.0015, dt));
    look.set(focus.x - sx * ahead, 0, focus.z - cz * ahead);
    camera.lookAt(look);
    camera.updateMatrixWorld();
    pitCam.value.copy(camera.position);
    scene.fog.near = 70 + radius * 4.5;
    scene.fog.far = 190 + radius * 11;
  }

  function followSun(force = false) {
    const x = player ? player.x : 0;
    const z = player ? player.z : 0;
    const span = 36 + (player ? player.radius * 2.1 : 10);
    if (!force && Math.hypot(x - shadowX, z - shadowZ) < 9 && Math.abs(span - shadowSpan) < 4) return;
    shadowX = x;
    shadowZ = z;
    shadowSpan = span;
    sun.position.set(x + 48, 90, z + 28);
    sun.target.position.set(x, 0, z);
    sun.target.updateMatrixWorld();
    const cam = sun.shadow.camera;
    cam.left = -span;
    cam.right = span;
    cam.top = span;
    cam.bottom = -span;
    cam.updateProjectionMatrix();
    renderer.shadowMap.needsUpdate = true;
    shadowDirty = true;
  }

  function dangerLevel() {
    if (!player || !player.alive) return 0;
    let level = 0;
    for (const hole of holes) {
      if (hole === player || !hole.alive) continue;
      if (hole.radius <= player.radius * 1.05) continue;
      const d = Math.hypot(hole.x - player.x, hole.z - player.z);
      const near = hole.radius + 7 - d;
      if (near > 0) level = Math.max(level, Math.min(1, near / 8));
    }
    return level;
  }

  function leaderboard() {
    return holes
      .map((hole) => ({
        name: hole.name,
        score: hole.score,
        color: `#${hole.color.toString(16).padStart(6, "0")}`,
        me: hole.player,
      }))
      .sort((a, b) => b.score - a.score || (b.me ? 1 : 0) - (a.me ? 1 : 0))
      .map((row, index) => ({ ...row, rank: index + 1 }));
  }

  function playerMark() {
    if (!player || !player.alive) return null;
    return {
      x: player.x,
      z: player.z,
      color: `#${player.color.toString(16).padStart(6, "0")}`,
    };
  }

  function boardRows() {
    const rows = leaderboard();
    const top = rows.slice(0, 6);
    if (!top.some((row) => row.me)) {
      const me = rows.find((row) => row.me);
      if (me) {
        top[top.length - 1] = me;
      }
    }
    return top;
  }

  function popText(text, x, y, z) {
    v.set(x, y, z).project(camera);
    if (v.z > 1) return;
    hooks.onPopup(
      text,
      (v.x * 0.5 + 0.5) * window.innerWidth,
      (-v.y * 0.5 + 0.5) * window.innerHeight,
    );
  }

  // Escombros que saltan desde el borde, del color del hoyo y del tamaño de lo tragado.
  function burst(hole, mass) {
    const count = Math.min(10, 3 + Math.round(Math.sqrt(mass)));
    const size = 0.1 + Math.min(0.55, hole.radius * 0.07);
    crumbTint.set(hole.color);
    let spawned = 0;
    for (const p of particles) {
      if (p.alive) continue;
      const a = Math.random() * Math.PI * 2;
      const rim = hole.radius * (0.75 + Math.random() * 0.3);
      const out = 1.5 + Math.random() * 2 + hole.radius * 0.35;
      p.alive = true;
      p.x = hole.x + Math.cos(a) * rim;
      p.z = hole.z + Math.sin(a) * rim;
      p.y = 0.15;
      p.vx = Math.cos(a) * out + hole.vx * 0.5;
      p.vz = Math.sin(a) * out + hole.vz * 0.5;
      p.vy = 3 + Math.random() * 2.5 + hole.radius * 0.3;
      p.max = p.life = 0.5 + Math.random() * 0.25;
      p.size = size * (0.6 + Math.random() * 0.8);
      p.spin = Math.random() * Math.PI;
      p.color.copy(crumbTint).lerp(white, Math.random() * 0.55);
      spawned += 1;
      if (spawned === count) break;
    }
  }

  function updateParticles(dt) {
    let n = 0;
    for (const p of particles) {
      if (!p.alive) continue;
      p.life -= dt;
      p.vy -= 14 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.spin += dt * 9;
      if (p.life <= 0 || p.y < -1) {
        p.alive = false;
        continue;
      }
      crumbPose.position.set(p.x, p.y, p.z);
      crumbPose.rotation.set(p.spin, p.spin * 0.7, 0);
      crumbPose.scale.setScalar(p.size * Math.min(1, (p.life / p.max) * 2.2));
      crumbPose.updateMatrix();
      crumbs.setMatrixAt(n, crumbPose.matrix);
      crumbs.setColorAt(n, p.color);
      n += 1;
    }
    if (n === 0 && crumbs.count === 0) return;
    crumbs.count = n;
    crumbs.visible = n > 0;
    crumbs.instanceMatrix.needsUpdate = true;
    crumbs.instanceColor.needsUpdate = true;
  }

  function createHole(name, color, isPlayer) {
    const group = new THREE.Group();
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.12, 18, 96),
      rimMaterial(color),
    );
    rim.rotation.x = Math.PI / 2;
    rim.renderOrder = 3;
    const lip = new THREE.Mesh(
      new THREE.TorusGeometry(0.9, 0.05, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000 }),
    );
    lip.visible = false;
    const pit = new THREE.Mesh(new THREE.CylinderGeometry(PIT_TOP, PIT_BOTTOM, 1, 64, 1, true), wallMaterial(color));
    pit.renderOrder = 2;
    const capMat = mouthMaterial();
    capMat.depthWrite = false;
    capMat.depthTest = true;
    const cap = new THREE.Mesh(new THREE.CircleGeometry(1, 40), capMat);
    cap.rotation.x = -Math.PI / 2;
    cap.renderOrder = 1;
    const label = nameSprite(name, color);
    group.add(rim, lip, pit, cap, label);
    scene.add(group);
    const hole = {
      name,
      color,
      player: isPlayer,
      mass: 0,
      score: 0,
      radius: START_R,
      radiusVel: 0,
      x: 0,
      z: 0,
      vx: 0,
      vz: 0,
      alive: true,
      respawn: 0,
      invuln: 0,
      sink: 0,
      punch: 0,
      drag: 1,
      think: 0,
      goal: null,
      skill: 1,
      speedMul: 1,
      group,
      rim,
      lip,
      pit,
      cap,
      label,
    };
    holes.push(hole);
    return hole;
  }

  function disposeHole(hole) {
    scene.remove(hole.group);
    hole.rim.geometry.dispose();
    hole.rim.material.dispose();
    hole.lip.geometry.dispose();
    hole.lip.material.dispose();
    hole.pit.geometry.dispose();
    hole.pit.material.dispose();
    hole.cap.geometry.dispose();
    hole.cap.material.dispose();
    hole.label.material.map.dispose();
    hole.label.material.dispose();
  }

  function placeHole(hole, spot) {
    hole.x = spot.x;
    hole.z = spot.z;
    syncHole(hole);
  }

  function spawnSpots(count) {
    const spots = [];
    let guard = 0;
    while (spots.length < count && guard < 500) {
      guard += 1;
      const line = (G0 + Math.floor(rand() * (G1 - G0 + 1))) * BLOCK;
      const along = (G0 + rand() * (G1 - G0)) * BLOCK;
      const x = rand() > 0.5 ? line + 1.6 : along;
      const z = x === along ? line - 1.6 : along;
      if (!onIsland(x, z, 18)) continue;
      if (spots.some((spot) => Math.hypot(spot.x - x, spot.z - z) < 16)) continue;
      spots.push({ x, z });
    }
    while (spots.length < count) spots.push({ x: (rand() - 0.5) * 50, z: (rand() - 0.5) * 50 });
    return spots;
  }

  function driftCity(dt) {
    for (const obj of objects) {
      if (obj.state !== "idle" || !obj.motion) continue;
      stepIdle(obj, dt);
    }
  }

  function publishHoles() {
    for (let i = 0; i < 10; i++) {
      const hole = holes[i];
      if (!hole) {
        holeXZR[i].set(0, 0, 0);
        continue;
      }
      const radius = hole.alive ? hole.radius : hole.radius * Math.max(0, 1 - hole.sink);
      holeXZR[i].set(hole.x, hole.z, radius);
    }
  }

  function setRatio(ratio) {
    res.ratio = ratio;
    renderer.setPixelRatio(ratio);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  // Resolución dinámica: baja si se pierden frames contra el refresco de la pantalla,
  // y sube de a poco cuando sobra margen, sin pasar del último nivel que falló.
  function tuneResolution(raw) {
    if (raw > 0.25) {
      res.samples.length = 0;
      return;
    }
    res.samples.push(raw);
    if (res.samples.length < 90) return;
    res.samples.sort((a, b) => a - b);
    const fast = res.samples[9];
    const mid = res.samples[45];
    res.samples.length = 0;
    res.refresh = Math.min(fast, res.refresh * 1.01);
    if (mid > res.refresh * 1.3) {
      res.calm = 0;
      if (res.ratio > res.min) {
        res.ceiling = res.ratio - 0.125;
        setRatio(Math.max(res.min, res.ratio - 0.25));
      }
    } else if (mid < res.refresh * 1.1) {
      res.calm += 1;
      const top = Math.min(res.max, res.ceiling);
      if (res.calm >= 4 && res.ratio < top) {
        res.calm = 0;
        setRatio(Math.min(top, res.ratio + 0.125));
      }
    } else {
      res.calm = 0;
    }
  }

  function frameWrapped() {
    const raw = clock.getDelta();
    const dt = Math.min(0.033, raw);
    tuneResolution(raw);
    timeU.value += dt;
    if (phase === "menu") {
      camOrbit += dt * 0.07;
      camera.position.set(Math.sin(camOrbit) * 52, 34, Math.cos(camOrbit) * 52);
      camera.lookAt(0, 0, 0);
      driftCity(dt);
    } else if (phase === "explore") {
      updateExplore(dt);
    } else if (phase === "play") {
      timeLeft -= dt;
      if (timeLeft <= 0) finish();
      else simulate(dt);
    }
    updateBrandMarkers();
    flushBatches(camera, scene.fog.far);
    flushShadowCasters(renderer, shadowX, shadowZ, shadowSpan);
    renderer.render(scene, camera);
    if (phase === "play") {
      const now = performance.now();
      if (networkId && hooks.onNetworkFrame && now >= networkPublishAt) {
        networkPublishAt = now + 80;
        hooks.onNetworkFrame(networkState());
      }
      hooks.onFrame({
        phase,
        timeLeft,
        danger: dangerLevel(),
        toast: performance.now() < toastUntil ? toast : "",
        rows: boardRows(),
        map: mapPlan,
        me: playerMark(),
      });
    }
    requestAnimationFrame(frameWrapped);
  }

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
  window.addEventListener("resize", onResize);

  const api = {
    start,
    returnToMenu,
    getCityItems() {
      return marketItems.map(({ target, ...item }) => ({ ...item }));
    },
    beginExplore,
    endExplore,
    setExploreKey(code, pressed) {
      if (pressed) exploreKeys.add(code);
      else exploreKeys.delete(code);
    },
    rotateExplore(deltaX) {
      if (exploreFocused || exploreReturning) return;
      exploreYaw -= deltaX * 0.0024;
      explorePitch = EXPLORE_PITCH;
    },
    orbitExplore(deltaX) {
      if (!exploreFocused || exploreReturning) return;
      const angle = -deltaX * 0.0036;
      const horizontal = Math.cos(EXPLORE_PITCH);
      const x = exploreFocusDirection.x;
      const z = exploreFocusDirection.z;
      exploreFocusDirection.x = x * Math.cos(angle) - z * Math.sin(angle);
      exploreFocusDirection.z = x * Math.sin(angle) + z * Math.cos(angle);
      const length = Math.hypot(exploreFocusDirection.x, exploreFocusDirection.z) || 1;
      exploreFocusDirection.x *= horizontal / length;
      exploreFocusDirection.z *= horizontal / length;
      exploreFocusDirection.y = -Math.sin(EXPLORE_PITCH);
    },
    pickExploreItem,
    selectExploreItem,
    hoverExploreItem,
    clearExploreHover() {
      exploreHovered = null;
    },
    clearExploreSelection() {
      exploreSelected = null;
      restoreExploreView();
      selectedOutline.visible = false;
      selectedOutlineMask.visible = false;
    },
    previewBranding(record) {
      setBranding(record);
      updateBrandMarkers();
    },
    setBrandings,
    visitBrandAt(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      aimRay.setFromCamera(pointer, camera);
      const hit = aimRay.intersectObjects([...brandMarkers.values()], true)[0];
      const url = hit?.object.userData.url;
      if (!url) return false;
      window.open(url, "_blank", "noopener,noreferrer");
      return true;
    },
    setPointer(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      pointerReady = true;
    },
    rotateCamera(radians) {
      camYawGoal += radians;
    },
    syncNetworkState,
    onPlayerDeath: null,
    onEnd: null,
    destroy() {
      window.removeEventListener("resize", onResize);
    },
  };
  mountGame._api = api;
  requestAnimationFrame(() => {
    hooks.onReady();
    frameWrapped();
  });
  return api;
}

const _up = new THREE.Vector3(0, 1, 0);
const _axis = new THREE.Vector3(1, 0, 0);
const _qy = new THREE.Quaternion();
const _qt = new THREE.Quaternion();
const _qs = new THREE.Quaternion();

function dampAngle(from, to, lambda, dt) {
  const diff = mod(to - from + Math.PI, Math.PI * 2) - Math.PI;
  return from + diff * (1 - Math.exp(-lambda * dt));
}

function resetObj(obj) {
  obj.x = obj.homeX;
  obj.y = 0;
  obj.z = obj.homeZ;
  obj.vy = 0;
  obj.tilt = 0;
  obj.tiltFrom = 0;
  obj.wob = 0;
  obj.wobVel = 0;
  obj.spin = 0;
  obj.axisX = 1;
  obj.axisZ = 0;
  obj.yaw = obj.homeYaw;
  obj.state = "idle";
  obj.eater = null;
  obj.credited = false;
  obj.fade = 1;
  if (obj.mesh.parent) obj.mesh.parent.remove(obj.mesh);
  obj.mesh.visible = true;
  obj.mesh.scale.setScalar(1);
  obj.mesh.position.set(obj.x, 0, obj.z);
  obj.mesh.rotation.set(0, obj.homeYaw, 0);
  if (obj.motion) {
    obj.motion.dir = obj.homeDir;
    obj.motion.ready = false;
  }
  syncBatch(obj);
}

const SHADOW_KINDS = new Set(["house", "building", "tower", "shop", "statue", "fountain", "kiosk", "shed"]);
const BLOB_SKIP = new Set(["pool"]);
// Dirección en el piso hacia donde cae la sombra del sol (que está en +x, +z).
const SHADOW_DIR_X = -48 / Math.hypot(48, 28);
const SHADOW_DIR_Z = -28 / Math.hypot(48, 28);
const CULL_PAD = 8;
const batchList = [];
const shadowGroups = [];
let shadowDirty = false;
let blobs = null;
let blobsDirty = false;
let viewStale = true;
let cullFog = Infinity;
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _cullSphere = new THREE.Sphere();
const _cullPos = new THREE.Vector3(Infinity, 0, 0);
const _cullQuat = new THREE.Quaternion();
let _cullAspect = 0;
const shadowOnlyMat = new THREE.MeshLambertMaterial({
  vertexColors: true,
  flatShading: true,
  colorWrite: false,
  depthWrite: false,
  depthTest: false,
});

function syncBatch(obj, shadows = true) {
  if (!obj.batch) return;
  if (obj.state !== "gone") obj.mesh.updateMatrix();
  obj.batch.dirty = true;
  blobsDirty = true;
  if (shadows && SHADOW_KINDS.has(obj.kind)) shadowDirty = true;
}

function inView(obj, eye) {
  const r = Math.max(obj.eatR, obj.height * 0.5) + CULL_PAD;
  _cullSphere.center.set(obj.x, obj.height * 0.5, obj.z);
  _cullSphere.radius = r;
  if (!_frustum.intersectsSphere(_cullSphere)) return false;
  return _cullSphere.center.distanceTo(eye) - r < cullFog;
}

// Cada lote se compacta con las instancias visibles: lo que queda fuera de cámara,
// cayendo o tragado no se dibuja. Se recalcula al mover la cámara unos metros.
function flushBatches(camera, fogFar) {
  camera.updateMatrixWorld();
  const moved =
    viewStale ||
    camera.position.distanceToSquared(_cullPos) > 6.25 ||
    Math.abs(camera.quaternion.dot(_cullQuat)) < 0.9995 ||
    camera.aspect !== _cullAspect;
  if (moved) {
    viewStale = false;
    _cullPos.copy(camera.position);
    _cullQuat.copy(camera.quaternion);
    _cullAspect = camera.aspect;
    cullFog = fogFar;
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    for (const rec of batchList) {
      for (const obj of rec.items) obj.inView = inView(obj, camera.position);
      rec.dirty = true;
    }
    blobsDirty = true;
  }
  for (const rec of batchList) {
    if (rec.dirty || rec.moving) packBatch(rec, camera.position);
  }
  if (blobsDirty) packBlobs();
}

function packBatch(rec, eye) {
  rec.dirty = false;
  const { mesh, items, fade, packedItems } = rec;
  packedItems.length = 0;
  let n = 0;
  for (const obj of items) {
    if (obj.state === "falling" || obj.state === "gone") continue;
    if (obj.motion) obj.inView = inView(obj, eye);
    if (!obj.inView) continue;
    mesh.setMatrixAt(n, obj.mesh.matrix);
    fade.array[n] = obj.fade;
    packedItems[n] = obj;
    n += 1;
  }
  mesh.count = n;
  mesh.visible = n > 0;
  if (n === 0) return;
  mesh.instanceMatrix.clearUpdateRanges();
  mesh.instanceMatrix.addUpdateRange(0, n * 16);
  mesh.instanceMatrix.needsUpdate = true;
  fade.clearUpdateRanges();
  fade.addUpdateRange(0, n);
  fade.needsUpdate = true;
}

function packBlobs() {
  blobsDirty = false;
  const { mesh, items, shade } = blobs;
  const m = mesh.instanceMatrix.array;
  let n = 0;
  for (const obj of items) {
    if (!obj.inView || obj.state === "falling" || obj.state === "gone") continue;
    const reach = Math.min(obj.height * 0.22, 1.6);
    const sx = obj.halfX * 2.9 + obj.blobPad;
    const sz = obj.halfZ * 2.9 + obj.blobPad;
    const c = Math.cos(obj.yaw);
    const s = Math.sin(obj.yaw);
    const o = n * 16;
    m[o] = c * sx;
    m[o + 1] = 0;
    m[o + 2] = -s * sx;
    m[o + 3] = 0;
    m[o + 4] = 0;
    m[o + 5] = 1;
    m[o + 6] = 0;
    m[o + 7] = 0;
    m[o + 8] = s * sz;
    m[o + 9] = 0;
    m[o + 10] = c * sz;
    m[o + 11] = 0;
    m[o + 12] = obj.x + SHADOW_DIR_X * reach;
    m[o + 13] = 0.05;
    m[o + 14] = obj.z + SHADOW_DIR_Z * reach;
    m[o + 15] = 1;
    shade.array[n] = obj.blobShade;
    n += 1;
  }
  mesh.count = n;
  mesh.visible = n > 0;
  if (n === 0) return;
  mesh.instanceMatrix.clearUpdateRanges();
  mesh.instanceMatrix.addUpdateRange(0, n * 16);
  mesh.instanceMatrix.needsUpdate = true;
  shade.clearUpdateRanges();
  shade.addUpdateRange(0, n);
  shade.needsUpdate = true;
}

// Sombra de contacto: mancha radial suave bajo cada prop, del lado opuesto al sol.
function blobMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uHoleXZR: { value: holeXZR } }]),
    vertexShader: `
      #include <common>
      #include <fog_pars_vertex>
      attribute float aShade;
      varying vec2 vDisc;
      varying float vShade;
      varying vec3 vWorld;
      void main() {
        vDisc = uv * 2.0 - 1.0;
        vShade = aShade;
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      #include <common>
      #include <fog_pars_fragment>
      uniform vec3 uHoleXZR[10];
      ${COVER_GLSL}
      varying vec2 vDisc;
      varying float vShade;
      varying vec3 vWorld;
      void main() {
        for (int i = 0; i < 10; i++) {
          float hr = uHoleXZR[i].z;
          if (hr > 0.0 && distance(vWorld.xz, uHoleXZR[i].xy) < hr && !coveredBy(vWorld.xz, hr)) discard;
        }
        float r = dot(vDisc, vDisc);
        float a = (1.0 - smoothstep(0.12, 1.0, r)) * vShade;
        #ifdef USE_FOG
          a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
        #endif
        gl_FragColor = vec4(0.0, 0.0, 0.0, a);
      }
    `,
  });
}

function buildBlobs(scene, objects) {
  if (blobs) {
    scene.remove(blobs.mesh);
    blobs.mesh.dispose();
  }
  const items = objects.filter((obj) => !BLOB_SKIP.has(obj.kind));
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const shade = new THREE.InstancedBufferAttribute(new Float32Array(items.length), 1);
  shade.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aShade", shade);
  const mesh = new THREE.InstancedMesh(geo, blobMaterial(), items.length);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  scene.add(mesh);
  for (const obj of items) {
    const big = SHADOW_KINDS.has(obj.kind);
    obj.blobShade = big ? 0.24 : 0.4;
    obj.blobPad = big ? 1.4 : 0.3;
  }
  blobs = { mesh, items, shade };
  blobsDirty = true;
}

function flushShadowCasters(renderer, x, z, span) {
  if (!shadowDirty) return;
  shadowDirty = false;
  const reach = span * 1.35 + 16;
  const reachSq = reach * reach;
  for (const group of shadowGroups) {
    const mesh = group.mesh;
    let n = 0;
    for (const obj of group.items) {
      if (obj.state !== "idle") continue;
      const dx = obj.x - x;
      const dz = obj.z - z;
      if (dx * dx + dz * dz > reachSq) continue;
      obj.mesh.updateMatrix();
      mesh.setMatrixAt(n, obj.mesh.matrix);
      n += 1;
    }
    mesh.userData.count = n;
    mesh.count = n;
    mesh.visible = n > 0;
    mesh.castShadow = n > 0;
    if (n > 0) mesh.instanceMatrix.needsUpdate = true;
  }
  renderer.shadowMap.needsUpdate = true;
}

function buildBatches(scene, objects) {
  for (const group of shadowGroups) {
    scene.remove(group.mesh);
    group.mesh.dispose();
  }
  shadowGroups.length = 0;
  for (const rec of batchList) {
    scene.remove(rec.mesh);
    rec.mesh.dispose();
  }
  batchList.length = 0;
  const groups = new Map();
  for (const obj of objects) {
    const key = `${obj.mesh.geometry.uuid}:${obj.mesh.material.uuid}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(obj);
  }
  for (const list of groups.values()) {
    const batch = new THREE.InstancedMesh(list[0].mesh.geometry.clone(), list[0].mesh.material, list.length);
    batch.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    batch.castShadow = false;
    batch.receiveShadow = false;
    batch.frustumCulled = false;
    batch.count = 0;
    const fade = new THREE.InstancedBufferAttribute(new Float32Array(list.length).fill(1), 1);
    fade.setUsage(THREE.DynamicDrawUsage);
    batch.geometry.setAttribute("aFade", fade);
    const rec = {
      mesh: batch,
      items: list,
      packedItems: [],
      fade,
      dirty: true,
      moving: list.some((obj) => obj.motion),
    };
    for (const obj of list) {
      obj.batch = rec;
      obj.mesh.updateMatrix();
    }
    batchList.push(rec);
    scene.add(batch);
    if (!SHADOW_KINDS.has(list[0].kind)) continue;
    // Solo proyecta sombra: en el pase principal queda con 0 instancias y no se dibuja.
    const mesh = new THREE.InstancedMesh(list[0].mesh.geometry, shadowOnlyMat, list.length);
    mesh.count = 0;
    mesh.userData.count = 0;
    mesh.visible = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.onBeforeShadow = () => {
      mesh.count = mesh.userData.count;
    };
    mesh.onAfterShadow = () => {
      mesh.count = 0;
    };
    scene.add(mesh);
    shadowGroups.push({ mesh, items: list });
  }
  buildBlobs(scene, objects);
  shadowDirty = true;
  viewStale = true;
}

function addObj(scene, objects, prop, x, z, yaw, motion = null) {
  if (!onIsland(x, z, 1)) return;
  prop.mesh.position.set(x, 0, z);
  prop.mesh.rotation.y = yaw;
  objects.push({
    ...prop,
    x,
    y: 0,
    z,
    vy: 0,
    tilt: 0,
    tiltFrom: 0,
    wob: 0,
    wobVel: 0,
    spin: 0,
    spinDir: 1,
    axisX: 1,
    axisZ: 0,
    yaw,
    phase: Math.random() * 6,
    state: "idle",
    eater: null,
    credited: false,
    fade: 1,
    inView: true,
    // Radio de huella: promedio entre el semieje largo y el corto, así un auto
    // alargado entra antes que una casa cuadrada del mismo largo.
    fitR: (prop.eatR + prop.solidR) * 0.5,
    homeX: x,
    homeZ: z,
    homeYaw: yaw,
    homeDir: motion?.dir || 1,
    motion,
  });
}

function seaMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSky: { value: new THREE.Color(SKY) },
      uDeep: { value: new THREE.Color(0x147fbe) },
      uShallow: { value: new THREE.Color(0x1eb6e6) },
      uIsland: { value: ISLAND },
      uShore: { value: SHORE },
      uOuter: { value: SEA },
      uHoleXZR: { value: holeXZR },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform vec3 uSky;
      uniform vec3 uDeep;
      uniform vec3 uShallow;
      uniform float uIsland;
      uniform float uShore;
      uniform float uOuter;
      uniform vec3 uHoleXZR[10];
      ${COVER_GLSL}
      varying vec3 vWorld;
      void main() {
        for (int i = 0; i < 10; i++) {
          float hr = uHoleXZR[i].z;
          if (hr > 0.0 && distance(vWorld.xz, uHoleXZR[i].xy) < hr * 0.96 && !coveredBy(vWorld.xz, hr)) discard;
        }
        float r = length(vWorld.xz);
        float shore = smoothstep(uIsland + 2.0, uShore + 18.0, r);
        vec3 col = mix(uDeep, uShallow, shore);
        float foam = smoothstep(2.2, 0.0, abs(r - uShore));
        col = mix(col, vec3(0.9, 0.97, 1.0), foam * 0.7);
        float fade = smoothstep(uShore + 58.0, uOuter, r);
        col = mix(col, uSky, fade);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}

function buildCity(scene, objects, rand) {
  const patches = [];
  const blocks = [];
  const disc = (color, r, clip = false) => patches.push({ t: "disc", color, r, clip });
  const rect = (color, x, z, w, h) => patches.push({ t: "rect", color, x, z, w, h });
  const grass = enableHoleClip(
    new THREE.MeshLambertMaterial({ map: grassTexture(), color: 0xffffff }),
  );
  const ground = new THREE.Mesh(new THREE.CircleGeometry(ISLAND, 96), grass);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const sand = enableHoleClip(new THREE.MeshLambertMaterial({ color: 0xe6d2a4 }));
  const sandMesh = new THREE.Mesh(new THREE.CircleGeometry(SHORE, 80), sand);
  sandMesh.rotation.x = -Math.PI / 2;
  sandMesh.position.y = -0.04;
  scene.add(sandMesh);

  const water = new THREE.Mesh(new THREE.CircleGeometry(SEA, 72), seaMaterial());
  water.rotation.x = -Math.PI / 2;
  water.position.y = -0.12;
  scene.add(water);
  disc("#1eb6e6", SEA);
  disc("#e6d2a4", SHORE);
  disc("#8ed44a", ISLAND, true);

  const sidewalkMat = enableHoleClip(new THREE.MeshLambertMaterial({ color: 0xe6ebf0 }), ISLAND);
  const roadMat = enableHoleClip(new THREE.MeshLambertMaterial({ color: 0x8b939c }), ISLAND);
  const parkMat = enableHoleClip(new THREE.MeshLambertMaterial({ color: 0xa4e056 }), ISLAND - ROAD - 2.6);

  for (let k = G0; k <= G1; k++) {
    const at = k * BLOCK;
    const reach = Math.sqrt(Math.max(0, ISLAND * ISLAND - at * at));
    if (reach < 8) continue;
    const len = reach * 2;
    const sidewalkV = new THREE.Mesh(new THREE.PlaneGeometry(ROAD + 5.2, len), sidewalkMat);
    sidewalkV.rotation.x = -Math.PI / 2;
    sidewalkV.position.set(at, 0.012, 0);
    sidewalkV.receiveShadow = true;
    scene.add(sidewalkV);
    rect("#e6ebf0", at, 0, ROAD + 5.2, len);
    const roadV = new THREE.Mesh(new THREE.PlaneGeometry(ROAD, len), roadMat);
    roadV.rotation.x = -Math.PI / 2;
    roadV.position.set(at, 0.02, 0);
    roadV.receiveShadow = true;
    scene.add(roadV);
    rect("#8b939c", at, 0, ROAD, len);

    const sidewalkH = new THREE.Mesh(new THREE.PlaneGeometry(len, ROAD + 5.2), sidewalkMat);
    sidewalkH.rotation.x = -Math.PI / 2;
    sidewalkH.position.set(0, 0.012, at);
    sidewalkH.receiveShadow = true;
    scene.add(sidewalkH);
    rect("#e6ebf0", 0, at, len, ROAD + 5.2);
    const roadH = new THREE.Mesh(new THREE.PlaneGeometry(len, ROAD), roadMat);
    roadH.rotation.x = -Math.PI / 2;
    roadH.position.set(0, 0.02, at);
    roadH.receiveShadow = true;
    scene.add(roadH);
    rect("#8b939c", 0, at, len, ROAD);
  }

  const rimOuter = ISLAND;
  const rimInner = rimOuter - ROAD;
  const rimRoad = new THREE.Mesh(
    new THREE.RingGeometry(rimInner, rimOuter, 128),
    enableHoleClip(new THREE.MeshLambertMaterial({ color: 0x8b939c })),
  );
  rimRoad.rotation.x = -Math.PI / 2;
  rimRoad.position.y = 0.022;
  rimRoad.receiveShadow = true;
  scene.add(rimRoad);
  const walkInner = rimInner - 2.6;
  const rimWalk = new THREE.Mesh(
    new THREE.RingGeometry(walkInner, rimInner, 128),
    enableHoleClip(new THREE.MeshLambertMaterial({ color: 0xe6ebf0 })),
  );
  rimWalk.rotation.x = -Math.PI / 2;
  rimWalk.position.y = 0.016;
  rimWalk.receiveShadow = true;
  scene.add(rimWalk);
  patches.push({ t: "ring", color: "#e6ebf0", inner: walkInner, outer: rimInner });
  patches.push({ t: "ring", color: "#8b939c", inner: rimInner, outer: rimOuter });

  const dashGeo = new THREE.PlaneGeometry(1.5, 0.16);
  dashGeo.rotateX(-Math.PI / 2);
  const dashes = [];
  for (let k = G0; k <= G1; k++) {
    for (let s = G0 * BLOCK + 8; s < G1 * BLOCK - 4; s += 4.2) {
      if (distToGrid(s) < ROAD) continue;
      if (onIsland(k * BLOCK, s)) dashes.push([k * BLOCK, 0.035, s, Math.PI / 2]);
      if (onIsland(s, k * BLOCK)) dashes.push([s, 0.035, k * BLOCK, 0]);
    }
  }
  const dashMat = enableHoleClip(new THREE.MeshBasicMaterial({ color: 0xf4f1e4 }), ISLAND);
  const dashMesh = new THREE.InstancedMesh(dashGeo, dashMat, dashes.length);
  const dummy = new THREE.Object3D();
  dashes.forEach(([x, y, z, rot], index) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rot, 0);
    dummy.updateMatrix();
    dashMesh.setMatrixAt(index, dummy.matrix);
  });
  scene.add(dashMesh);

  // Cruces peatonales en cada esquina.
  const zebraGeo = new THREE.PlaneGeometry(0.55, 2.2);
  zebraGeo.rotateX(-Math.PI / 2);
  const zebras = [];
  for (let i = G0; i <= G1; i++) {
    for (let k = G0; k <= G1; k++) {
      const ix = i * BLOCK;
      const iz = k * BLOCK;
      if (!onIsland(ix, iz, 6)) continue;
      const off = ROAD / 2 + 1.6;
      for (let s = -3; s <= 3; s++) {
        const lane = s * 1.05;
        zebras.push([ix + lane, iz + off, 0]);
        zebras.push([ix + lane, iz - off, 0]);
        zebras.push([ix + off, iz + lane, Math.PI / 2]);
        zebras.push([ix - off, iz + lane, Math.PI / 2]);
      }
    }
  }
  const zebraMesh = new THREE.InstancedMesh(zebraGeo, dashMat, zebras.length);
  zebras.forEach(([x, z, rot], index) => {
    dummy.position.set(x, 0.036, z);
    dummy.rotation.set(0, rot, 0);
    dummy.updateMatrix();
    zebraMesh.setMatrixAt(index, dummy.matrix);
  });
  scene.add(zebraMesh);

  const asphaltMat = enableHoleClip(new THREE.MeshLambertMaterial({ color: 0x777e86 }), ISLAND);
  const stoneMat = enableHoleClip(new THREE.MeshLambertMaterial({ color: 0xd8d2c4 }), ISLAND);
  const pondMat = enableHoleClip(new THREE.MeshLambertMaterial({ color: 0x4fb8e0 }), ISLAND);
  const sandPatchMat = enableHoleClip(new THREE.MeshLambertMaterial({ color: 0xead9b2 }), ISLAND);
  const ctx = {
    scene,
    objects,
    rand,
    rect,
    pad(mat, x, z, w, h, y = 0.03) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, y, z);
      mesh.receiveShadow = true;
      scene.add(mesh);
    },
    round(mat, x, z, r, y = 0.03) {
      const mesh = new THREE.Mesh(new THREE.CircleGeometry(r, 32), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, y, z);
      mesh.receiveShadow = true;
      scene.add(mesh);
    },
    mats: { parkMat, asphaltMat, stoneMat, pondMat, sandPatchMat },
  };

  for (let gx = G0; gx < G1; gx++) {
    for (let gz = G0; gz < G1; gz++) {
      const cx = (gx + 0.5) * BLOCK;
      const cz = (gz + 0.5) * BLOCK;
      const dist = Math.hypot(cx, cz);
      const plaza = gx === -1 && gz === -1;
      const downtown = !plaza && dist < 78;
      const parkSize = BLOCK - ROAD - 3;
      const ringGrass = ISLAND - ROAD - 2.6;
      let park = plaza || (!downtown && mod(gx * 2 + gz * 3, 7) === 0);
      if (park && !cornersInside(cx, cz, parkSize / 2, ringGrass - 1.2)) park = false;
      let flavor = plaza ? "plaza" : park ? "park" : downtown ? "down" : "home";
      if (flavor === "home" && mod(gx * 5 + gz * 2, 9) === 0) flavor = "market";
      else if (flavor === "home" && mod(gx * 3 + gz * 7, 11) === 0) flavor = "lot";
      else if (flavor === "down" && dist > 48 && mod(gx + gz * 4, 6) === 0) flavor = "lot";
      if (park && onIsland(cx, cz, 8)) {
        ctx.pad(parkMat, cx, cz, parkSize, parkSize, 0.025);
        rect("#a4e056", cx, cz, parkSize, parkSize);
      }
      if (onIsland(cx, cz, 1)) {
        const kind = plaza ? "plaza" : park ? "park" : downtown ? "down" : "home";
        blocks.push({ x: cx, z: cz, kind });
      }
      fillBlock(ctx, cx, cz, flavor);
    }
  }

  for (let k = G0; k <= G1; k++) {
    for (let s = G0 * BLOCK + 10; s < G1 * BLOCK - 6; s += 20) {
      if (distToGrid(s) < 9) continue;
      const lane = rand() > 0.5 ? 1.7 : -1.7;
      const moving = rand() > 0.82;
      addCar(scene, objects, rand, k * BLOCK + lane, s, 0, "z", moving);
      addCar(scene, objects, rand, s, k * BLOCK + lane, Math.PI / 2, "x", moving && rand() > 0.5);
      addStreet(scene, objects, rand, "lamp", k * BLOCK + (ROAD / 2 + 1.5), s, 0);
      addStreet(scene, objects, rand, "lamp", s, k * BLOCK - (ROAD / 2 + 1.5), Math.PI / 2);
      if (rand() > 0.78) {
        for (let n = 0; n < 4; n++) {
          addStreet(scene, objects, rand, "cone", k * BLOCK + ROAD / 2 + 1.15, s + n * 0.72, 0);
        }
      }
    }
    // Veredas arboladas: un árbol o arbusto cada 10 m entre los faroles.
    for (let s = G0 * BLOCK + 20; s < G1 * BLOCK - 6; s += 20) {
      if (distToGrid(s) < 9) continue;
      const kind = rand() > 0.4 ? "tree" : "bush";
      addStreet(scene, objects, rand, kind, k * BLOCK - (ROAD / 2 + 2.0), s, rand() * Math.PI);
      addStreet(scene, objects, rand, rand() > 0.4 ? "tree" : "bush", s, k * BLOCK + (ROAD / 2 + 2.0), rand() * Math.PI);
      if (rand() > 0.5) addStreet(scene, objects, rand, "hydrant", k * BLOCK + (ROAD / 2 + 1.2), s + 4, 0);
    }
  }

  scatterSidewalks(scene, objects, rand);
  scatterFlowers(scene, objects, rand);
  buildBatches(scene, objects);
  return { span: SHORE + 18, patches, blocks };
}

function placeProp(scene, objects, rand, kind, x, z, yaw) {
  if (!onIsland(x, z, 6)) return;
  addObj(scene, objects, makeProp(kind, rand), x, z, yaw);
}

const SIDES = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
const CORNERS = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

// Cada manzana tiene ~11.5 m libres desde el centro hasta la vereda.
function fillBlock(ctx, cx, cz, flavor) {
  if (!onIsland(cx, cz, 12)) return;
  const { scene, objects, rand } = ctx;
  const put = (kind, x, z, yaw = rand() * Math.PI * 2) => placeProp(scene, objects, rand, kind, x, z, yaw);
  // Ubica algo mirando a la calle del lado `dir`, a `push` metros del centro.
  const facing = (kind, [dirx, dirz], push, along = 0) =>
    put(kind, cx + dirx * push + dirz * along, cz + dirz * push + dirx * along, Math.atan2(dirx, dirz));

  if (flavor === "plaza") {
    ctx.round(ctx.mats.stoneMat, cx, cz, 9.5, 0.03);
    ctx.rect("#d8d2c4", cx, cz, 19, 19);
    put("fountain", cx, cz, 0);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.2;
      put("bench", cx + Math.cos(a) * 5.2, cz + Math.sin(a) * 5.2, -a + Math.PI / 2);
    }
    for (const [sx, sz] of CORNERS) {
      put("kiosk", cx + sx * 8.6, cz + sz * 8.6, Math.atan2(-sx, -sz));
      put("flower", cx + sx * 6.4, cz + sz * 9.4);
      put("tree", cx + sx * 10.4, cz + sz * 4.2);
      put("tree", cx + sx * 4.2, cz + sz * 10.4);
    }
    SIDES.forEach((side, index) => facing(index % 2 ? "statue" : "hedge", side, 10.2));
    return;
  }

  if (flavor === "park") {
    const pondX = cx + (rand() > 0.5 ? 4.6 : -4.6);
    const pondZ = cz - 3.8;
    ctx.round(ctx.mats.sandPatchMat, pondX, pondZ, 4.4, 0.03);
    ctx.round(ctx.mats.pondMat, pondX, pondZ, 3.6, 0.034);
    ctx.pad(ctx.mats.stoneMat, cx, cz, 2.2, BLOCK - ROAD - 5, 0.032);
    for (let i = 0; i < 5; i++) {
      const a = rand() * Math.PI * 2;
      put(i % 2 ? "bush" : "flower", pondX + Math.cos(a) * 4.9, pondZ + Math.sin(a) * 4.9);
    }
    const playX = cx - Math.sign(pondX - cx) * 5.4;
    put("playset", playX, cz + 4.4, rand() > 0.5 ? 0 : Math.PI / 2);
    put("swing", playX + 3.4, cz + 8.2, Math.PI / 2);
    put("picnic", cx + Math.sign(pondX - cx) * 4.6, cz + 6.4, rand() * 0.6);
    put("picnic", cx + Math.sign(pondX - cx) * 8.2, cz + 3.2, rand() * 0.6);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + rand() * 0.4;
      const r = 9.4 + rand() * 1.4;
      put(rand() > 0.3 ? "tree" : "bush", cx + Math.cos(a) * r, cz + Math.sin(a) * r);
    }
    const edge = (BLOCK - ROAD - 8) / 2;
    for (let i = -2; i <= 2; i++) {
      put("fence", cx + i * 2.5, cz - edge, 0);
      put("bench", cx + edge, cz + i * 2.2, Math.PI / 2);
    }
    put("hydrant", cx - edge - 1.4, cz + edge, 0);
    return;
  }

  if (flavor === "market") {
    ctx.pad(ctx.mats.stoneMat, cx, cz, 20, 20, 0.03);
    ctx.rect("#d8d2c4", cx, cz, 20, 20);
    for (let i = -1; i <= 1; i++) {
      for (let k = -1; k <= 1; k++) {
        if (i === 0 && k === 0) {
          put("statue", cx, cz, 0);
          continue;
        }
        put("kiosk", cx + i * 6.2, cz + k * 6.2, Math.atan2(-i, -k));
        put("flower", cx + i * 6.2 + 2.2, cz + k * 6.2 - 2.0);
      }
    }
    for (const [sx, sz] of CORNERS) {
      put("hedge", cx + sx * 10.6, cz + sz * 6.0, Math.PI / 2);
      put("hedge", cx + sx * 6.0, cz + sz * 10.6, 0);
      put("bin", cx + sx * 9.6, cz + sz * 9.6);
    }
    return;
  }

  if (flavor === "lot") {
    ctx.pad(ctx.mats.asphaltMat, cx, cz, 21, 21, 0.03);
    ctx.rect("#777e86", cx, cz, 21, 21);
    for (let row = -1; row <= 1; row += 2) {
      for (let i = -2; i <= 2; i++) {
        if (rand() > 0.72) continue;
        const kind = rand() > 0.8 ? "van" : "car";
        put(kind, cx + i * 3.6, cz + row * 4.8, row > 0 ? Math.PI : 0);
      }
    }
    for (const [sx, sz] of CORNERS) put("lamp", cx + sx * 9.6, cz + sz * 9.6, 0);
    for (let i = -2; i <= 2; i++) put("hedge", cx + i * 3.4, cz - 10.6, 0);
    put("busstop", cx + 9.2, cz + 10.9, Math.PI);
    put("bin", cx - 9.6, cz + 10.4);
    return;
  }

  if (flavor === "down") {
    const dist = Math.hypot(cx, cz);
    const core = dist < 42;
    SIDES.forEach((side, index) => {
      const tall = index <= (core ? 2 : 1);
      if (tall) {
        const kind = index === 0 && core ? "tower" : "building";
        facing(kind, side, 8.1, index === 0 ? 0 : (rand() - 0.5) * 2.4);
        return;
      }
      facing("shop", side, 8.4, (rand() - 0.5) * 3);
      if (rand() > 0.5) facing("busstop", side, 11.6, 6.4);
    });
    if (rand() > 0.45) {
      ctx.round(ctx.mats.stoneMat, cx, cz, 4.6, 0.03);
      put("fountain", cx, cz, 0);
      for (const [sx, sz] of CORNERS) put("bench", cx + sx * 3.6, cz + sz * 3.6, Math.atan2(sx, sz) + Math.PI);
    } else {
      put("kiosk", cx, cz, rand() * Math.PI);
      put("flower", cx + 2.6, cz - 1.4);
      put("flower", cx - 2.4, cz + 2.0);
    }
    for (const [sx, sz] of CORNERS) {
      put(rand() > 0.5 ? "tree" : "hedge", cx + sx * 4.4, cz + sz * 4.6);
      if (rand() > 0.6) put("bin", cx + sx * 10.8, cz + sz * 10.8);
    }
    return;
  }

  // Barrio: casas a la calle, cerco y buzón al frente, patio en el medio.
  const pattern = mod(Math.round(cx / BLOCK) + Math.round(cz / BLOCK) * 3, 4);
  const skip = pattern === 1 ? 2 : pattern === 2 ? 1 : -1;
  SIDES.forEach((side, index) => {
    const [dirx, dirz] = side;
    if (index === skip || (pattern === 2 && index === 3)) {
      put("tree", cx + dirx * 6.2, cz + dirz * 6.2);
      put("flower", cx + dirx * 4.4, cz + dirz * 5.2);
      put("hedge", cx + dirx * 10.6, cz + dirz * 10.6, Math.atan2(dirx, dirz));
      return;
    }
    const slide = (rand() - 0.5) * 1.6;
    facing("house", side, 7.8, slide);
    facing("hedge", side, 10.7, slide + 2.6);
    facing("mailbox", side, 10.9, slide - 1.9);
    if (rand() > 0.6) facing(rand() > 0.5 ? "car" : "bush", side, 10.2, slide + (rand() > 0.5 ? 4.6 : -4.6));
  });
  const yard = mod(Math.round(cx / 7) + Math.round(cz / 11), 5);
  if (yard === 0) put("pool", cx, cz, rand() > 0.5 ? 0 : Math.PI / 2);
  else if (yard === 1) put("shed", cx + 1.4, cz - 1.2, rand() * Math.PI);
  else if (yard === 2) put("picnic", cx, cz, rand() * Math.PI);
  else if (yard === 3) put("swing", cx, cz, rand() * Math.PI);
  else put(pattern === 3 ? "bush" : "tree", cx, cz);
  for (const [sx, sz] of CORNERS) {
    put(rand() > 0.4 ? "bush" : "flower", cx + sx * 9.1, cz + sz * 9.1);
    if (rand() > 0.55) continue;
    put(rand() > 0.5 ? "tree" : "flower", cx + sx * 4.1, cz + sz * 4.1);
  }
}

function addCar(scene, objects, rand, x, z, yaw, axis, moving) {
  const kind = rand() > 0.86 ? "bus" : rand() > 0.72 ? "van" : "car";
  const prop = makeProp(kind, rand);
  const span = axisReach(axis === "z" ? x : z, 6);
  const motion =
    moving && span
      ? { axis, dir: rand() > 0.5 ? 1 : -1, speed: 2.4 + rand() * 2.2, min: span.min, max: span.max }
      : null;
  if (moving && !span) {
    rand();
    rand();
  }
  addObj(scene, objects, prop, x, z, yaw, motion);
}

function addStreet(scene, objects, rand, kind, x, z, yaw) {
  addObj(scene, objects, makeProp(kind, rand), x, z, yaw);
}

function scatterSidewalks(scene, objects, rand) {
  const kinds = ["cone", "bin", "lamp", "flower", "bench", "hydrant", "mailbox", "bush"];
  for (let i = 0; i < 480; i++) {
    const x = (rand() - 0.5) * ISLAND * 2;
    const z = (rand() - 0.5) * ISLAND * 2;
    const dx = distToGrid(x);
    const dz = distToGrid(z);
    const onSide = (dx > ROAD / 2 && dx < ROAD / 2 + 2.7) || (dz > ROAD / 2 && dz < ROAD / 2 + 2.7);
    const onRoad = dx < ROAD / 2 || dz < ROAD / 2;
    if (!onSide || onRoad || !onIsland(x, z, 4)) continue;
    const kind = kinds[Math.floor(rand() * kinds.length)];
    addObj(scene, objects, makeProp(kind, rand), x, z, rand() * Math.PI * 2);
  }
}

function scatterFlowers(scene, objects, rand) {
  for (let i = 0; i < 90; i++) {
    const x = (rand() - 0.5) * ISLAND * 1.7;
    const z = (rand() - 0.5) * ISLAND * 1.7;
    if (!onIsland(x, z, 8)) continue;
    if (distToGrid(x) < ROAD / 2 + 3.2 || distToGrid(z) < ROAD / 2 + 3.2) continue;
    const kind = rand() > 0.55 ? "bush" : "flower";
    addObj(scene, objects, makeProp(kind, rand), x, z, rand() * Math.PI);
  }
}
