// main.js — scene/physics/throwing, ported from the original R777 bundle parameters
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { createDie, DICE_ORDER, GREEN } from './dice.js';

const MAX_DICE = 300;          // original cap
const GROUND_Y = -5;           // original ground height

// ---------------------------------------------------------------- three

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
document.getElementById('container').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(GREEN);

const camera = new THREE.PerspectiveCamera(20, 1, 0.1, 1000);
camera.position.set(0, 40, 0);
camera.lookAt(0, 0, -5);

// lights — enable3d warpSpeed defaults the original relied on
scene.add(new THREE.HemisphereLight(0xffffff, 0x000000, 0.4));
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.4);
dirLight.position.set(100, 200, 50);
dirLight.castShadow = true;
dirLight.shadow.camera.top = 20;
dirLight.shadow.camera.bottom = -20;
dirLight.shadow.camera.left = -20;
dirLight.shadow.camera.right = 20;
dirLight.shadow.mapSize.set(2048, 2048);
scene.add(dirLight);

// three r155+ / r160 uses physically-correct lights; restore legacy intensity feel
THREE.ColorManagement.enabled = true;
renderer.useLegacyLights = true;

const groundMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(500, 500),
  new THREE.MeshLambertMaterial({ color: '#019047' })
);
groundMesh.rotation.x = -Math.PI / 2;
groundMesh.position.y = GROUND_Y;
groundMesh.receiveShadow = true;
scene.add(groundMesh);

// ---------------------------------------------------------------- cannon

const world = new CANNON.World({ gravity: new CANNON.Vec3(0, 10 * -9.81, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = true;
world.defaultContactMaterial.friction = 0.8;     // original setFriction(.8)
world.defaultContactMaterial.restitution = 0.6;  // original setBounciness(.6)

const groundBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
groundBody.position.y = GROUND_Y;
world.addBody(groundBody);

// invisible walls at the edge of the visible field so dice settle in view
let wallBodies = [];
let arena = { minX: -14, maxX: 14, minZ: -13, maxZ: 3 };

function groundPointAtNDC(x, y) {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(x, y), camera);
  const t = (GROUND_Y - ray.ray.origin.y) / ray.ray.direction.y;
  return ray.ray.origin.clone().addScaledVector(ray.ray.direction, t);
}

function rebuildArena() {
  camera.updateMatrixWorld(); // raycast may run before the first render
  const pts = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y]) => groundPointAtNDC(x, y));
  const margin = 0.6;
  arena = {
    minX: Math.min(...pts.map(p => p.x)) - margin,
    maxX: Math.max(...pts.map(p => p.x)) + margin,
    minZ: Math.min(...pts.map(p => p.z)) - margin,
    maxZ: Math.max(...pts.map(p => p.z)) + margin,
  };
  wallBodies.forEach(b => world.removeBody(b));
  wallBodies = [];
  const H = 40, T = 1;
  const w = arena.maxX - arena.minX, d = arena.maxZ - arena.minZ;
  const cx = (arena.minX + arena.maxX) / 2, cz = (arena.minZ + arena.maxZ) / 2;
  const make = (sx, sy, sz, x, y, z) => {
    const b = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(sx / 2, sy / 2, sz / 2)) });
    b.position.set(x, y, z);
    world.addBody(b);
    wallBodies.push(b);
  };
  make(T, H, d, arena.minX - T / 2, GROUND_Y + H / 2, cz);
  make(T, H, d, arena.maxX + T / 2, GROUND_Y + H / 2, cz);
  make(w, H, T, cx, GROUND_Y + H / 2, arena.minZ - T / 2);
  make(w, H, T, cx, GROUND_Y + H / 2, arena.maxZ + T / 2);
}

// ---------------------------------------------------------------- dice state

const diceMat = new CANNON.Material('dice');
const allDice = [];   // every die on the field
let batch = [];       // most recent throw: { die, labelEl, result }
let batchSeq = 0;
let simTime = 0;
let batchDeadline = Infinity;

const labelLayer = document.getElementById('labels');
const hudRoll = document.getElementById('roll');
const hudField = document.getElementById('field');

let curType = 'd6';
let curCount = 5;     // original threw 5 per click

function spawnDie(type, corner) {
  const die = createDie(type, diceMat);
  const inset = 2.5;
  const sx = corner.x > 0 ? arena.maxX - inset : arena.minX + inset;
  const sz = corner.z > 0 ? arena.maxZ - inset : arena.minZ + inset;
  const px = sx + (Math.random() * 6 - 3);
  const pz = sz + (Math.random() * 6 - 3);
  const py = GROUND_Y + 8 + Math.random() * 6;
  die.body.position.set(px, py, pz);
  die.body.quaternion.setFromEuler(
    Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2);

  // aim at field center, original-feel speeds scaled to the arena
  const cx = (arena.minX + arena.maxX) / 2, cz = (arena.minZ + arena.maxZ) / 2;
  const dir = new THREE.Vector2(cx - px, cz - pz).normalize();
  const jitter = (Math.random() - 0.5) * 0.5;
  const cos = Math.cos(jitter), sin = Math.sin(jitter);
  const dx = dir.x * cos - dir.y * sin, dz = dir.x * sin + dir.y * cos;
  const speed = 21 + Math.random() * 9;
  die.body.velocity.set(dx * speed, 12 + Math.random() * 8, dz * speed);
  die.body.angularVelocity.set(
    25 * Math.random() - 10, 25 * Math.random() - 10, 25 * Math.random() - 10); // original

  scene.add(die.mesh);
  world.addBody(die.body);
  allDice.push(die);
  return die;
}

function throwBatch(corner) {
  if (allDice.length + curCount > MAX_DICE) {
    hudField.textContent = `max ${MAX_DICE} dice — clear the field`;
    return;
  }
  // retire previous batch labels
  batch.forEach(e => e.labelEl.remove());
  batch = [];
  const seq = ++batchSeq;

  for (let i = 0; i < curCount; i++) {
    const die = spawnDie(curType, corner);
    const labelEl = document.createElement('div');
    labelEl.className = 'die-label';
    labelLayer.appendChild(labelEl);
    const entry = { die, labelEl, result: null };
    batch.push(entry);

    die.body.addEventListener('sleep', () => {
      if (seq !== batchSeq) return;
      entry.result = die.read();
      labelEl.textContent = entry.result.label;
      labelEl.classList.toggle('unsure', !entry.result.sure);
      updateHUD();
    });
    die.body.addEventListener('wakeup', () => {
      if (seq !== batchSeq) return;
      entry.result = null;
      labelEl.textContent = '';
      updateHUD();
    });
  }
  batchDeadline = simTime + 7; // sim-time, not wall-clock: survives throttled tabs
  updateHUD();
}

// force-read stragglers that never fall asleep (leaning dice, micro-jitter)
function forceReadBatch() {
  batch.forEach(e => {
    if (!e.result) {
      e.result = e.die.read();
      e.labelEl.textContent = e.result.label;
      e.labelEl.classList.add('unsure');
    }
  });
  updateHUD();
}

function updateHUD() {
  const done = batch.filter(e => e.result);
  if (batch.length) {
    const parts = done.map(e => e.result.label);
    const sum = done.reduce((s, e) => s + e.result.value, 0);
    const rolling = batch.length - done.length;
    hudRoll.textContent =
      `${curTypeOf(batch)} ×${batch.length}  ${parts.join(' + ')}` +
      (rolling ? `  · rolling ${rolling}…` : `  =  ${sum}`);
  } else {
    hudRoll.textContent = '';
  }
  hudField.textContent = allDice.length ? `field ${allDice.length}` : '';
}
const curTypeOf = b => b[0]?.die.type ?? '';

function clearField() {
  allDice.forEach(d => { scene.remove(d.mesh); world.removeBody(d.body); });
  allDice.length = 0;
  batch.forEach(e => e.labelEl.remove());
  batch = [];
  batchSeq++;
  updateHUD();
}

// ---------------------------------------------------------------- input / UI

renderer.domElement.addEventListener('pointerdown', ev => {
  const nx = (ev.clientX / window.innerWidth) * 2 - 1;
  const ny = -(ev.clientY / window.innerHeight) * 2 + 1;
  // click quadrant -> throw in from that corner (original behaviour)
  throwBatch({ x: nx >= 0 ? 1 : -1, z: ny >= 0 ? -1 : 1 }); // screen top = -z
});

const typeBar = document.getElementById('types');
DICE_ORDER.forEach(t => {
  const b = document.createElement('button');
  b.textContent = t;
  b.className = 'chip' + (t === curType ? ' on' : '');
  b.addEventListener('click', () => {
    curType = t;
    typeBar.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.textContent === t));
  });
  typeBar.appendChild(b);
});

const countBar = document.getElementById('counts');
[1, 3, 5].forEach(n => {
  const b = document.createElement('button');
  b.textContent = `×${n}`;
  b.className = 'chip' + (n === curCount ? ' on' : '');
  b.addEventListener('click', () => {
    curCount = n;
    countBar.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.textContent === `×${n}`));
  });
  countBar.appendChild(b);
});

document.getElementById('clear').addEventListener('click', clearField);

// viewport can be 0×0 at module load (embeds, pre-layout) — defer setup until it has size
let viewW = 0, viewH = 0, booted = false;
function ensureViewport() {
  const w = window.innerWidth, h = window.innerHeight;
  if (!w || !h || (w === viewW && h === viewH)) return;
  viewW = w; viewH = h;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  rebuildArena();
  if (!booted) {
    booted = true;
    throwBatch({ x: -1, z: -1 }); // original opened with a throw already in motion
  }
}

// ---------------------------------------------------------------- loop

const clock = new THREE.Clock();
const proj = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  ensureViewport();
  if (!booted) return;
  const dt = Math.min(clock.getDelta(), 0.1);
  world.step(1 / 60, dt, 3);
  simTime += dt;
  if (simTime > batchDeadline) {
    batchDeadline = Infinity;
    forceReadBatch();
  }

  for (const d of allDice) {
    d.mesh.position.copy(d.body.position);
    d.mesh.quaternion.copy(d.body.quaternion);
  }
  for (const e of batch) {
    if (!e.labelEl.textContent) continue;
    proj.copy(e.die.body.position);
    proj.y += e.die.R + 0.8;
    proj.project(camera);
    e.labelEl.style.left = `${(proj.x * 0.5 + 0.5) * window.innerWidth}px`;
    e.labelEl.style.top = `${(-proj.y * 0.5 + 0.5) * window.innerHeight}px`;
  }
  renderer.render(scene, camera);
}
animate();

// console playground: __dice.world / __dice.allDice[n].read() ...
window.__dice = { scene, camera, world, allDice, get arena() { return arena; } };
