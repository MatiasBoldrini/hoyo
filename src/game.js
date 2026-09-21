import * as THREE from "three";
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

const holeXZR = Array.from({ length: 10 }, () => new THREE.Vector3());
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

function enableHoleClip(material, disc = 0) {
  material.customProgramCacheKey = () => "hole-clip-v2";
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
uniform float uDisc;`,
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
    if (hd < hr - 0.06) discard;
    float rim = smoothstep(hr + 0.28, hr, hd);
    holeShade = min(holeShade, mix(1.0, 0.72, rim));
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

function enablePitClip(material) {
  const pitKey = `pit-clip-v5-${pitClipSerial++}`;
  material.transparent = true;
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
uniform vec3 uCam;`,
      )
      .replace(
        "#include <tonemapping_fragment>",
        `
float sink = 1.0;
float depthScale = 1.0;
bool nearHole = false;
bool inMouth = false;
bool seen = false;
float viewS = 1.0;
vec2 ground = vWorldHole.xz;
if (vWorldHole.y < -0.04) {
  viewS = uCam.y / max(0.35, uCam.y - vWorldHole.y);
  ground = uCam.xz + viewS * (vWorldHole.xz - uCam.xz);
}
for (int i = 0; i < 10; i++) {
  float hr = uHoleXZR[i].z;
  if (hr <= 0.0) continue;
  if (distance(vWorldHole.xz, uHoleXZR[i].xy) < hr + 2.4) nearHole = true;
  seen = vWorldHole.y < -0.04 && distance(ground, uHoleXZR[i].xy) < hr * 0.98;
  if (seen) inMouth = true;
  if (seen || (vWorldHole.y < 0.15 && distance(vWorldHole.xz, uHoleXZR[i].xy) < hr - 0.02)) {
    float fall = clamp((-vWorldHole.y - 0.02) / 0.9, 0.0, 1.0);
    sink = min(sink, mix(1.0, 0.05, fall * fall));
    depthScale = min(depthScale, mix(1.0, 0.25, clamp(fall + 0.35, 0.0, 1.0)));
    if (vWorldHole.y < -2.4) discard;
  }
}
if (vWorldHole.y < -0.04 && nearHole && !inMouth) discard;
gl_FragDepth = gl_FragCoord.z * depthScale;
gl_FragColor.rgb *= sink;
gl_FragColor.a *= vFade;
#include <tonemapping_fragment>
`,
      );
  };
  return material;
}

function nameSprite(text, color) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const g = c.getContext("2d");
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
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 10;
  return sprite;
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

function rimMaterial(color) {
  const tint = new THREE.Color(color);
  return new THREE.MeshStandardMaterial({
    color: tint,
    roughness: 0.28,
    metalness: 0.06,
    emissive: tint.clone().multiplyScalar(0.28),
    transparent: true,
  });
}

function mouthMaterial(color) {
  return new THREE.ShaderMaterial({
    depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color(color) } },
    vertexShader: `
      varying vec2 vLocal;
      void main() {
        vLocal = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying vec2 vLocal;
      void main() {
        float r = length(vLocal);
        float vignette = smoothstep(0.12, 0.96, r);
        vec3 col = mix(vec3(0.0), uColor * 0.28 + vec3(0.02), vignette);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

export async function mountGame(canvas, hooks) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
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
  scene.add(sun, sun.target);

  const rand = mulberry32(20260921);
  const objects = [];
  const holes = [];
  let phase = "menu";
  let timeLeft = ROUND;
  let toast = "";
  let toastUntil = 0;
  let camOrbit = 0.4;
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

  await loadProps();
  for (const material of propMaterials()) enablePitClip(material);
  const mapPlan = buildCity(scene, objects, rand);
  buildSky(scene);
  followSun(true);

  const particles = [];
  const crumbGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16);
  for (let i = 0; i < 28; i++) {
    const mesh = new THREE.Mesh(
      crumbGeo,
      new THREE.MeshLambertMaterial({ color: 0xfff4d6, flatShading: true }),
    );
    mesh.visible = false;
    scene.add(mesh);
    particles.push({ mesh, alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0 });
  }

  function start(name, color) {
    for (const hole of holes) disposeHole(hole);
    holes.length = 0;
    for (const obj of objects) resetObj(obj);
    const used = new Set([color]);
    player = createHole(name, color, true);
    const spots = spawnSpots(BOTS.length + 1);
    placeHole(player, spots.pop());
    BOTS.slice(0, 7).forEach(([botName, botColor], index) => {
      const hole = createHole(botName, botColor, false);
      hole.skill = 0.72 + rand() * 0.38;
      hole.speedMul = 0.84 + (index % 3) * 0.07;
      placeHole(hole, spots.pop());
      used.add(botColor);
    });
    phase = "play";
    timeLeft = ROUND;
    toast = "";
    sfx.resume();
    sfx.begin();
    followCamera(0, true);
    followSun(true);
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
    eatHoles(dt);
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
      if (!obj.batch) continue;
      const blocks =
        obj.state !== "gone" && player.radius < obj.eatR * 0.9 && coversHole(obj, holeBox, holeReach);
      const target = blocks ? 0.28 : 1;
      if (obj.fade == null) obj.fade = 1;
      const next = THREE.MathUtils.damp(obj.fade, target, 10, dt);
      if (Math.abs(next - obj.fade) < 0.01) continue;
      obj.fade = next;
      const attr = obj.batch.geometry.getAttribute("aFade");
      attr.setX(obj.batchIndex, next);
      attr.needsUpdate = true;
    }
  }

  function steerHoles(dt) {
    for (const hole of holes) {
      if (!hole.alive) {
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
      if (hole.radius < obj.eatR * 0.9) continue;
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

  function bestMouth(obj) {
    const x = obj.state === "lip" ? obj.anchorX : obj.x;
    const z = obj.state === "lip" ? obj.anchorZ : obj.z;
    let best = null;
    let bestDist = Infinity;
    for (const hole of holes) {
      if (!hole.alive || hole.radius < obj.eatR * 0.9) continue;
      const dist = Math.hypot(x - hole.x, z - hole.z);
      if (dist > hole.radius + obj.solidR * 0.95) continue;
      if (dist < bestDist) {
        bestDist = dist;
        best = hole;
      }
    }
    return best;
  }

  function settleObjects(dt) {
    for (const obj of objects) {
      if (obj.state === "gone" || obj.state === "falling") continue;
      const hole = bestMouth(obj);
      if (!hole) {
        if (obj.state === "lip") relax(obj, dt);
        continue;
      }
      if (obj.state !== "lip") {
        obj.state = "lip";
        obj.tiltVel = 0;
        obj.anchorX = obj.x;
        obj.anchorZ = obj.z;
        obj.lipHoleX = hole.x;
        obj.lipHoleZ = hole.z;
      }
      const wasHeld = Math.hypot(obj.anchorX - obj.lipHoleX, obj.anchorZ - obj.lipHoleZ) < hole.radius * 0.92;
      if (wasHeld) {
        obj.anchorX += hole.x - obj.lipHoleX;
        obj.anchorZ += hole.z - obj.lipHoleZ;
      }
      obj.lipHoleX = hole.x;
      obj.lipHoleZ = hole.z;
      obj.eater = hole;
      const dx = obj.anchorX - hole.x;
      const dz = obj.anchorZ - hole.z;
      const dist = Math.hypot(dx, dz) || 0.0001;
      const outX = dx / dist;
      const outZ = dz / dist;
      const inside = hole.radius - dist;
      const inertia = 0.2 + obj.mass * 0.006;
      const lever = inside / Math.max(0.3, obj.solidR);
      const tau = lever * 9.5 - obj.tilt * 0.35;
      obj.tiltVel += (tau / inertia) * dt;
      const maxSpin = obj.heavy ? 1.6 : 2.8;
      obj.tiltVel = THREE.MathUtils.clamp(obj.tiltVel, -maxSpin, maxSpin);
      obj.tilt = Math.max(0, obj.tilt + obj.tiltVel * dt);
      const covered = dist < hole.radius * 0.82;
      if (obj.tilt > 0.72 || (covered && obj.tilt > 0.22)) {
        releaseFall(obj, hole, outX, outZ);
        continue;
      }
      leanOnRim(obj, hole, outX, outZ, dist);
    }
  }

  function leanOnRim(obj, hole, outX, outZ, dist) {
    obj.axisX = -outZ;
    obj.axisZ = outX;
    const drop = Math.sin(obj.tilt) * (0.18 + Math.min(obj.solidR, hole.radius) * 0.72);
    const slide = Math.sin(obj.tilt) * Math.max(0, dist - hole.radius * 0.35);
    obj.y = -drop;
    placeInPit(obj, obj.anchorX - outX * slide, obj.anchorZ - outZ * slide);
    applyLean(obj, obj.tilt);
    syncBatch(obj);
  }

  // Mantiene el punto de apoyo en la boca del hoyo. Si el mesh solo baja en Y,
  // la cámara lo proyecta hacia adelante y se ve caer sobre el piso de afuera.
  function placeInPit(obj, groundX, groundZ) {
    obj.pitX = groundX;
    obj.pitZ = groundZ;
    const depth = Math.max(0, -obj.y);
    const camY = Math.max(0.35, camera.position.y);
    const shift = depth / camY;
    obj.x = groundX + shift * (groundX - camera.position.x);
    obj.z = groundZ + shift * (groundZ - camera.position.z);
    obj.mesh.position.set(obj.x, obj.y, obj.z);
  }

  function releaseFall(obj, hole, outX, outZ) {
    const dropRate = Math.cos(obj.tilt) * (0.18 + Math.min(obj.solidR, hole.radius) * 0.72);
    obj.vy = -Math.max(0.55, dropRate * Math.max(obj.tiltVel, 0.8) * 0.55);
    obj.vx = 0;
    obj.vz = 0;
    obj.fallX = (obj.pitX ?? obj.x) - hole.x;
    obj.fallZ = (obj.pitZ ?? obj.z) - hole.z;
    const mouth = hole.radius * 0.48;
    const from = Math.hypot(obj.fallX, obj.fallZ) || 0.0001;
    if (from > mouth) {
      obj.fallX *= mouth / from;
      obj.fallZ *= mouth / from;
    }
    obj.tilt = Math.max(obj.tilt, 0.28);
    obj.tiltVel = Math.max(obj.tiltVel, obj.heavy ? 1.1 : 2.1);
    obj.axisX = -outZ;
    obj.axisZ = outX;
    obj.state = "falling";
    obj.eater = hole;
    obj.mesh.scale.setScalar(1);
    obj.mesh.castShadow = false;
    if (hole.player) {
      sfx.swallow(obj.kind, obj.mass, hole.radius);
      if (navigator.vibrate) navigator.vibrate(obj.heavy ? 16 : 8);
    }
  }

  function relax(obj, dt) {
    if (obj.pitX != null) {
      obj.x = obj.pitX;
      obj.z = obj.pitZ;
      obj.pitX = null;
      obj.pitZ = null;
    }
    obj.tiltVel += -obj.tilt * 10 * dt;
    obj.tiltVel *= Math.max(0, 1 - dt * 2.5);
    obj.tilt = Math.max(0, obj.tilt + obj.tiltVel * dt);
    obj.x = THREE.MathUtils.damp(obj.x, obj.anchorX, 7, dt);
    obj.z = THREE.MathUtils.damp(obj.z, obj.anchorZ, 7, dt);
    obj.y = THREE.MathUtils.damp(obj.y, 0, 8, dt);
    if (obj.tilt < 0.03) {
      obj.state = "idle";
      obj.tilt = 0;
      obj.tiltVel = 0;
      obj.y = 0;
      obj.x = obj.anchorX;
      obj.z = obj.anchorZ;
      obj.mesh.position.set(obj.x, 0, obj.z);
      obj.mesh.rotation.set(0, obj.yaw, 0);
      syncBatch(obj);
      return;
    }
    obj.mesh.position.set(obj.x, obj.y, obj.z);
    applyLean(obj, obj.tilt);
    syncBatch(obj);
  }

  function stepIdle(obj, dt) {
    if (obj.state !== "idle") return;
    if (obj.motion) {
      const { axis, speed } = obj.motion;
      obj.motion.dir = obj.motion.dir || 1;
      const delta = speed * obj.motion.dir * dt;
      if (axis === "x") obj.x += delta;
      else obj.z += delta;
      const along = axis === "x" ? obj.x : obj.z;
      if (along < obj.motion.min || along > obj.motion.max) obj.motion.dir *= -1;
      if (!onIsland(obj.x, obj.z, 3)) {
        obj.motion.dir *= -1;
        const keep = ISLAND - 3.5;
        const d = Math.hypot(obj.x, obj.z) || 1;
        obj.x *= keep / d;
        obj.z *= keep / d;
      }
      obj.yaw = Math.atan2(axis === "x" ? obj.motion.dir : 0, axis === "z" ? obj.motion.dir : 0);
      if (obj.kind === "person") obj.bob = Math.abs(Math.sin(timeU.value * 7 + obj.phase));
    }
    obj.anchorX = obj.x;
    obj.anchorZ = obj.z;
    obj.y = 0;
    obj.mesh.position.set(obj.x, obj.bob * 0.07, obj.z);
    obj.mesh.rotation.set(0, obj.yaw, 0);
    if (obj.motion || obj.kind === "person") syncBatch(obj);
  }

  function stepFall(obj, dt) {
    if (obj.state !== "falling") return;
    const hole = obj.eater;
    obj.vy -= (obj.heavy ? 4.2 : 5.4) * dt;
    obj.y += obj.vy * dt;
    obj.mesh.scale.setScalar(1);
    if (hole && hole.alive) {
      const toCamX = camera.position.x - hole.x;
      const toCamZ = camera.position.z - hole.z;
      const near = obj.fallX * toCamX + obj.fallZ * toCamZ > 0;
      const pull = near ? 28 : 12;
      obj.fallX = THREE.MathUtils.damp(obj.fallX, 0, pull, dt);
      obj.fallZ = THREE.MathUtils.damp(obj.fallZ, 0, pull, dt);
      const mouth = hole.radius * 0.42;
      const from = Math.hypot(obj.fallX, obj.fallZ) || 1;
      if (from > mouth) {
        obj.fallX *= mouth / from;
        obj.fallZ *= mouth / from;
      }
      placeInPit(obj, hole.x + obj.fallX, hole.z + obj.fallZ);
    }
    obj.tiltVel = Math.min(obj.heavy ? 1.4 : 2.2, obj.tiltVel + dt * 0.35);
    obj.tilt += obj.tiltVel * dt;
    obj.spin += dt * (obj.heavy ? 0.2 : 0.55);
    if (!hole || !hole.alive) obj.mesh.position.set(obj.x, obj.y, obj.z);
    applyLean(obj, obj.tilt);
    syncBatch(obj);
    const limit = 0.85 + (hole ? hole.radius : 1) * 0.16;
    if (obj.y < -limit && hole) consume(obj, hole);
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

  function consume(obj, hole) {
    obj.state = "gone";
    obj.mesh.visible = false;
    syncBatch(obj);
    if (hole.alive) {
      hole.mass += obj.mass;
      hole.score = Math.round(hole.mass);
      hole.radius = radiusFromMass(hole.mass);
      hole.punch = Math.min(0.28, hole.punch + Math.min(0.16, obj.mass * 0.004));
      shake = Math.min(0.45, shake + obj.mass * 0.003);
      if (hole.player) {
        popText(`+${obj.mass}`, hole.x, 1.15, hole.z);
      }
      burst(hole.x, hole.z, hole.color);
    }
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
        hunter.radius = radiusFromMass(hunter.mass);
        hunter.punch = Math.min(0.34, hunter.punch + 0.12);
        if (prey.player) {
          toast = "¡Te tragaron!";
          toastUntil = performance.now() + 1600;
          sfx.eaten();
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
    if (!hole.alive) {
      hole.sink += 0.016;
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
    hole.rim.scale.set(visual, visual, visual);
    hole.rim.position.y = 0.03 + 0.12 * visual;
    hole.lip.scale.set(visual, visual, visual);
    hole.lip.position.y = 0.02 + 0.045 * visual;
    hole.pit.visible = false;
    hole.cap.scale.set(visual * 0.84, visual * 0.84, 1);
    hole.cap.position.y = -0.04;
    const blink = hole.invuln > 0 && Math.sin(timeU.value * 18) > 0;
    const rimOpacity = blink ? 0.25 : 1;
    hole.rim.material.opacity = rimOpacity;
    hole.lip.material.opacity = rimOpacity;
    hole.label.position.y = 1.35 + visual * 0.22;
    const dist = camera.position.distanceTo(hole.group.position);
    const labelW = Math.max(1.45, dist * 0.082);
    hole.label.scale.set(labelW, labelW * 0.25, 1);
  }

  function followCamera(dt, snap = false) {
    const radius = player ? player.radius : START_R;
    const focus = player || { x: 0, z: 0, radius };
    const back = 9.2 + radius * 1.85;
    const height = 12.4 + radius * 2.15;
    shake *= 0.92;
    desired.set(focus.x + Math.sin(timeU.value * 30) * shake, height, focus.z + back);
    if (snap) camera.position.copy(desired);
    else camera.position.lerp(desired, 1 - Math.pow(0.0015, dt));
    look.set(focus.x, 0, focus.z - (2.8 + radius * 0.42));
    camera.lookAt(look);
    pitCam.value.copy(camera.position);
    scene.fog.near = 70 + radius * 4.5;
    scene.fog.far = 190 + radius * 11;
  }

  function followSun(force = false) {
    const x = player ? player.x : 0;
    const z = player ? player.z : 0;
    if (!force && Math.hypot(x - shadowX, z - shadowZ) < 9) return;
    shadowX = x;
    shadowZ = z;
    const span = 36 + (player ? player.radius * 2.1 : 10);
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

  function burst(x, z) {
    let spawned = 0;
    for (const p of particles) {
      if (p.alive) continue;
      p.alive = true;
      p.mesh.visible = true;
      p.x = x + (Math.random() - 0.5) * 0.8;
      p.z = z + (Math.random() - 0.5) * 0.8;
      p.y = 0.3;
      p.vx = (Math.random() - 0.5) * 3;
      p.vz = (Math.random() - 0.5) * 3;
      p.vy = 2 + Math.random() * 2;
      p.life = 0.45;
      spawned += 1;
      if (spawned === 6) break;
    }
  }

  function updateParticles(dt) {
    for (const p of particles) {
      if (!p.alive) continue;
      p.life -= dt;
      p.vy -= 12 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.mesh.position.set(p.x, p.y, p.z);
      if (p.life <= 0 || p.y < -1) {
        p.alive = false;
        p.mesh.visible = false;
      }
    }
  }

  function createHole(name, color, isPlayer) {
    const group = new THREE.Group();
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.12, 18, 72),
      rimMaterial(color),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.14;
    rim.renderOrder = 3;
    const lipTint = new THREE.Color(color).multiplyScalar(0.32);
    const lip = new THREE.Mesh(
      new THREE.TorusGeometry(0.9, 0.05, 12, 56),
      new THREE.MeshStandardMaterial({
        color: lipTint,
        roughness: 0.55,
        metalness: 0,
        emissive: lipTint.clone().multiplyScalar(0.2),
        transparent: true,
      }),
    );
    lip.rotation.x = Math.PI / 2;
    lip.position.y = 0.05;
    lip.renderOrder = 3;
    const pit = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.72, 1, 28, 1, true), mouthMaterial(color));
    pit.visible = false;
    const capMat = mouthMaterial(color);
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

  function frameWrapped() {
    const dt = Math.min(0.033, clock.getDelta());
    timeU.value += dt;
    if (phase === "menu") {
      camOrbit += dt * 0.07;
      camera.position.set(Math.sin(camOrbit) * 52, 34, Math.cos(camOrbit) * 52);
      camera.lookAt(0, 0, 0);
      driftCity(dt);
    } else if (phase === "play") {
      timeLeft -= dt;
      if (timeLeft <= 0) finish();
      else simulate(dt);
    }
    flushBatches();
    renderer.render(scene, camera);
    if (phase === "play") {
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
    setPointer(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      pointerReady = true;
    },
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

function resetObj(obj) {
  obj.x = obj.homeX;
  obj.y = 0;
  obj.z = obj.homeZ;
  obj.vx = 0;
  obj.vy = 0;
  obj.vz = 0;
  obj.tilt = 0;
  obj.tiltVel = 0;
  obj.spin = 0;
  obj.arm = 0;
  obj.axisX = 1;
  obj.axisZ = 0;
  obj.anchorX = obj.homeX;
  obj.anchorZ = obj.homeZ;
  obj.yaw = obj.homeYaw;
  obj.bob = 0;
  obj.state = "idle";
  obj.eater = null;
  obj.mesh.visible = true;
  obj.mesh.castShadow = obj.mass >= 8;
  obj.mesh.scale.setScalar(1);
  obj.mesh.position.set(obj.x, 0, obj.z);
  obj.mesh.rotation.set(0, obj.homeYaw, 0);
  if (obj.motion) obj.motion.dir = obj.homeDir;
  syncBatch(obj);
}

const SHADOW_KINDS = new Set(["house", "building", "tower"]);
const dirtyBatches = new Set();
const _hide = new THREE.Object3D();

function syncBatch(obj) {
  if (!obj.batch) return;
  if (obj.state === "gone") {
    _hide.position.set(0, -50, 0);
    _hide.scale.set(0, 0, 0);
    _hide.rotation.set(0, 0, 0);
    _hide.updateMatrix();
    obj.batch.setMatrixAt(obj.batchIndex, _hide.matrix);
  } else {
    obj.mesh.updateMatrix();
    obj.batch.setMatrixAt(obj.batchIndex, obj.mesh.matrix);
  }
  dirtyBatches.add(obj.batch);
}

function flushBatches() {
  for (const batch of dirtyBatches) batch.instanceMatrix.needsUpdate = true;
  dirtyBatches.clear();
}

function buildBatches(scene, objects) {
  const groups = new Map();
  for (const obj of objects) {
    const key = `${obj.mesh.geometry.uuid}:${obj.mesh.material.uuid}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(obj);
  }
  for (const list of groups.values()) {
    const batch = new THREE.InstancedMesh(list[0].mesh.geometry.clone(), list[0].mesh.material, list.length);
    batch.castShadow = SHADOW_KINDS.has(list[0].kind);
    batch.receiveShadow = false;
    batch.frustumCulled = false;
    list.forEach((obj, index) => {
      obj.batch = batch;
      obj.batchIndex = index;
      obj.mesh.updateMatrix();
      batch.setMatrixAt(index, obj.mesh.matrix);
    });
    batch.instanceMatrix.needsUpdate = true;
    const fade = new THREE.InstancedBufferAttribute(new Float32Array(list.length).fill(1), 1);
    fade.setUsage(THREE.DynamicDrawUsage);
    batch.geometry.setAttribute("aFade", fade);
    scene.add(batch);
  }
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
    vx: 0,
    vy: 0,
    vz: 0,
    tilt: 0,
    tiltVel: 0,
    tiltDir: 0,
    spin: 0,
    arm: 0,
    axisX: 1,
    axisZ: 0,
    anchorX: x,
    anchorZ: z,
    yaw,
    bob: 0,
    phase: Math.random() * 6,
    state: "idle",
    eater: null,
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
      varying vec3 vWorld;
      void main() {
        float r = length(vWorld.xz);
        float shore = smoothstep(uIsland + 2.0, uShore + 18.0, r);
        vec3 col = mix(uDeep, uShallow, shore);
        float foam = smoothstep(2.2, 0.0, abs(r - uShore));
        col = mix(col, vec3(0.9, 0.97, 1.0), foam * 0.7);
        float fade = smoothstep(uShore + 58.0, uOuter, r);
        col = mix(col, uSky, fade);
        gl_FragColor = vec4(col, 1.0);
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

  const parks = [];
  for (let gx = G0; gx < G1; gx++) {
    for (let gz = G0; gz < G1; gz++) {
      const cx = (gx + 0.5) * BLOCK;
      const cz = (gz + 0.5) * BLOCK;
      const plaza = gx === -1 && gz === -1;
      const downtown = !plaza && Math.hypot(cx, cz) < 78;
      const parkSize = BLOCK - ROAD - 3;
      const ringGrass = ISLAND - ROAD - 2.6;
      let park = plaza || (!downtown && mod(gx * 2 + gz * 3, 7) === 0);
      if (park && !cornersInside(cx, cz, parkSize / 2, ringGrass - 1.2)) park = false;
      if (park && onIsland(cx, cz, 8)) {
        parks.push([cx, cz]);
        const pad = new THREE.Mesh(new THREE.PlaneGeometry(parkSize, parkSize), parkMat);
        pad.rotation.x = -Math.PI / 2;
        pad.position.set(cx, 0.025, cz);
        pad.receiveShadow = true;
        scene.add(pad);
        rect("#a4e056", cx, cz, parkSize, parkSize);
      }
      if (onIsland(cx, cz, 1)) {
        const kind = plaza ? "plaza" : park ? "park" : downtown ? "down" : "home";
        blocks.push({ x: cx, z: cz, kind });
      }
      fillBlock(scene, objects, rand, cx, cz, downtown, park, plaza);
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
      if (rand() > 0.35) {
        const side = rand() > 0.5 ? 1 : -1;
        addObj(
          scene,
          objects,
          makeProp("person", rand),
          k * BLOCK + side * (ROAD / 2 + 1.35),
          s + (rand() - 0.5) * 3,
          rand() * Math.PI * 2,
          {
            axis: "z",
            dir: rand() > 0.5 ? 1 : -1,
            speed: 0.85 + rand() * 0.45,
            min: s - 7,
            max: s + 7,
          },
        );
      }
      if (rand() > 0.78) {
        for (let n = 0; n < 4; n++) {
          addStreet(scene, objects, rand, "cone", k * BLOCK + ROAD / 2 + 1.15, s + n * 0.72, 0);
        }
      }
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

function fillBlock(scene, objects, rand, cx, cz, downtown, park, plaza) {
  if (!onIsland(cx, cz, 12)) return;
  const sides = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  if (park) {
    for (let i = 0; i < (plaza ? 4 : 7); i++) {
      const kind = i % 4 === 0 ? "bush" : "tree";
      placeProp(
        scene,
        objects,
        rand,
        kind,
        cx + (rand() - 0.5) * 16,
        cz + (rand() - 0.5) * 16,
        rand() * Math.PI,
      );
    }
    for (let i = 0; i < (plaza ? 6 : 3); i++) {
      placeProp(
        scene,
        objects,
        rand,
        "flower",
        cx + (rand() - 0.5) * 14,
        cz + (rand() - 0.5) * 14,
        rand() * Math.PI,
      );
    }
    const edge = (BLOCK - ROAD - 8) / 2;
    for (let i = -2; i <= 2; i++) {
      placeProp(scene, objects, rand, "fence", cx + i * 2.5, cz - edge, 0);
      placeProp(scene, objects, rand, "bench", cx + edge, cz + i * 2.2, Math.PI / 2);
    }
    return;
  }
  const pattern = mod(Math.round(cx / BLOCK) + Math.round(cz / BLOCK) * 3, 4);
  const skip = pattern === 1 ? 2 : pattern === 2 ? 1 : -1;
  sides.forEach(([dirx, dirz], index) => {
    if (downtown) {
      if (index > (Math.hypot(cx, cz) < 42 ? 2 : 1)) return;
      const push = 8.1;
      const kind = index === 0 && Math.hypot(cx, cz) < 42 ? "tower" : "building";
      const along = index === 0 ? 0 : (rand() - 0.5) * 2.4;
      placeProp(
        scene,
        objects,
        rand,
        kind,
        cx + dirx * push + dirz * along,
        cz + dirz * push + dirx * along,
        Math.atan2(dirx, dirz),
      );
      return;
    }
    if (index === skip || (pattern === 2 && index === 3)) {
      placeProp(scene, objects, rand, "tree", cx + dirx * 6.2, cz + dirz * 6.2, rand() * Math.PI);
      placeProp(scene, objects, rand, "flower", cx + dirx * 4.4, cz + dirz * 5.2, rand() * Math.PI);
      return;
    }
    const push = 7.8;
    const slide = (rand() - 0.5) * 1.6;
    placeProp(
      scene,
      objects,
      rand,
      "house",
      cx + dirx * push + dirz * slide,
      cz + dirz * push + dirx * slide,
      Math.atan2(dirx, dirz),
    );
  });
  if (!downtown) {
    placeProp(scene, objects, rand, pattern === 3 ? "bush" : "tree", cx, cz, rand() * Math.PI);
    for (const [sx, sz] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      placeProp(scene, objects, rand, rand() > 0.4 ? "bush" : "flower", cx + sx * 9.1, cz + sz * 9.1, rand() * Math.PI);
      if (rand() > 0.55) continue;
      placeProp(scene, objects, rand, "flower", cx + sx * 4.1, cz + sz * 4.1, rand() * Math.PI);
    }
  } else if (rand() > 0.35) {
    placeProp(scene, objects, rand, "flower", cx + (rand() - 0.5) * 3, cz + (rand() - 0.5) * 3, rand());
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
  const kinds = ["person", "person", "person", "cone", "bin", "lamp", "flower", "bench"];
  for (let i = 0; i < 480; i++) {
    const x = (rand() - 0.5) * ISLAND * 2;
    const z = (rand() - 0.5) * ISLAND * 2;
    const dx = distToGrid(x);
    const dz = distToGrid(z);
    const onSide = (dx > ROAD / 2 && dx < ROAD / 2 + 2.7) || (dz > ROAD / 2 && dz < ROAD / 2 + 2.7);
    const onRoad = dx < ROAD / 2 || dz < ROAD / 2;
    if (!onSide || onRoad || !onIsland(x, z, 4)) continue;
    const kind = kinds[Math.floor(rand() * kinds.length)];
    const walkZ = dx < dz;
    const motion =
      kind === "person"
        ? {
            axis: walkZ ? "z" : "x",
            dir: rand() > 0.5 ? 1 : -1,
            speed: 0.8 + rand() * 0.6,
            min: (walkZ ? z : x) - 8,
            max: (walkZ ? z : x) + 8,
          }
        : null;
    addObj(scene, objects, makeProp(kind, rand), x, z, rand() * Math.PI * 2, motion);
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

function buildSky(scene) {
  for (let i = 0; i < 7; i++) {
    const cloud = new THREE.Mesh(
      new THREE.SphereGeometry(1, 8, 6),
      new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
    );
    cloud.scale.set(6 + i, 2.2, 3.4);
    cloud.position.set(-80 + i * 28, 28 + (i % 3) * 4, -40 - (i % 2) * 30);
    scene.add(cloud);
  }
}
