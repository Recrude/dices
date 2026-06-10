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
world.defaultContactMaterial.contactEquationRelaxation = 4; // calmer resting contacts
world.solver.iterations = 20; // strong gravity needs more passes to kill micro-buzz

const groundBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
groundBody.position.y = GROUND_Y;
world.addBody(groundBody);

// invisible walls at the edge of the visible field so dice settle in view
let wallBodies = [];
let arena = { minX: -14, maxX: 14, minZ: -13, maxZ: 3 };
const wallMat = new CANNON.Material('wall');

function groundPointAtNDC(x, y) {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(x, y), camera);
  const t = (GROUND_Y - ray.ray.origin.y) / ray.ray.direction.y;
  return ray.ray.origin.clone().addScaledVector(ray.ray.direction, t);
}

function rebuildArena() {
  camera.updateMatrixWorld(); // raycast may run before the first render
  const pts = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y]) => groundPointAtNDC(x, y));
  // margin 0: the window edge IS the wall — dice live fully inside the frame
  arena = {
    minX: Math.min(...pts.map(p => p.x)),
    maxX: Math.max(...pts.map(p => p.x)),
    minZ: Math.min(...pts.map(p => p.z)),
    maxZ: Math.max(...pts.map(p => p.z)),
  };
  wallBodies.forEach(b => world.removeBody(b));
  wallBodies = [];
  // effectively infinite thickness: a fast die can never cross the wall's
  // mid-plane, so contact resolution always ejects it back onto the field
  const H = 40, T = 20;
  const w = arena.maxX - arena.minX, d = arena.maxZ - arena.minZ;
  const cx = (arena.minX + arena.maxX) / 2, cz = (arena.minZ + arena.maxZ) / 2;
  const make = (sx, sy, sz, x, y, z) => {
    const b = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(new CANNON.Vec3(sx / 2, sy / 2, sz / 2)),
      material: wallMat,
    });
    b.position.set(x, y, z);
    world.addBody(b);
    wallBodies.push(b);
  };
  // lengths extended by 2T so the corners are sealed
  make(T, H, d + 2 * T, arena.minX - T / 2, GROUND_Y + H / 2, cz);
  make(T, H, d + 2 * T, arena.maxX + T / 2, GROUND_Y + H / 2, cz);
  make(w + 2 * T, H, T, cx, GROUND_Y + H / 2, arena.minZ - T / 2);
  make(w + 2 * T, H, T, cx, GROUND_Y + H / 2, arena.maxZ + T / 2);

  recoverOutsiders();
}

// toss any die stranded outside the field (window resize, rare tunneling) back in
function recoverOutsiders() {
  const cx = (arena.minX + arena.maxX) / 2, cz = (arena.minZ + arena.maxZ) / 2;
  for (const die of allDice) {
    const p = die.body.position;
    if (p.x < arena.minX || p.x > arena.maxX || p.z < arena.minZ || p.z > arena.maxZ) {
      const dx = cx - p.x, dz = cz - p.z;
      const l = Math.hypot(dx, dz) || 1;
      die.body.wakeUp();
      die.body.velocity.set((dx / l) * 14, 9, (dz / l) * 14);
    }
  }
}

// ---------------------------------------------------------------- dice state

const diceMat = new CANNON.Material('dice');
// stiff, fast-correcting wall contact so flicked dice never embed in the walls
world.addContactMaterial(new CANNON.ContactMaterial(diceMat, wallMat, {
  friction: 0.1,
  restitution: 0.5,
  contactEquationStiffness: 1e8,
  contactEquationRelaxation: 2,
}));
const allDice = [];   // every die on the field
let batch = [];       // most recent throw: { die, labelEl }
let simTime = 0;
let batchDeadline = Infinity;
let nextPatrol = 0;
let pollTick = 0;

const labelLayer = document.getElementById('labels');
const hudRoll = document.getElementById('roll');
const hudField = document.getElementById('field');

let curType = 'd6';
let curCount = 5;     // original threw 5 per click

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function spawnDieAt(type, pos, vel, spinScale = 1) {
  const die = createDie(type, diceMat);
  die.body.position.set(pos.x, pos.y, pos.z);
  die.body.quaternion.setFromEuler(
    Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2);
  die.body.velocity.set(vel.x, vel.y, vel.z);
  die.body.angularVelocity.set(
    (25 * Math.random() - 10) * spinScale,
    (25 * Math.random() - 10) * spinScale,
    (25 * Math.random() - 10) * spinScale); // original spin range
  scene.add(die.mesh);
  world.addBody(die.body);
  allDice.push(die);
  return die;
}

let noticeUntil = 0;

function fieldFull() {
  if (allDice.length + curCount > MAX_DICE) {
    hudField.textContent = `max ${MAX_DICE} dice — clear the field`;
    noticeUntil = simTime + 2.5; // keep the message up against HUD refreshes
    return true;
  }
  return false;
}

function beginBatch() {
  batch.forEach(e => e.labelEl.remove());
  batch = [];
  batchDeadline = simTime + 7; // sim-time, not wall-clock: survives throttled tabs
}

function trackDie(die) {
  const labelEl = document.createElement('div');
  labelEl.className = 'die-label';
  labelLayer.appendChild(labelEl);
  batch.push({ die, labelEl });
}

// authoritative value pass — no events to miss: asleep dice are read (and cached),
// awake dice are invalidated. Runs a few times a second from the loop.
function pollValues() {
  let fieldSum = 0, fieldRead = 0;
  for (const die of allDice) {
    if (die.body.sleepState === 2) {
      die.cached = die.read(); // always fresh — a bump between polls can't leave a stale value
    } else if (die.cached && !die.cached.forced) {
      die.cached = null; // mid-roll — no value yet
    }
    if (die.cached) { fieldSum += die.cached.value; fieldRead++; }
  }
  for (const e of batch) {
    const c = e.die.cached;
    e.labelEl.textContent = c ? c.label : '';
    e.labelEl.classList.toggle('unsure', !!c && (!c.sure || !!c.forced));
  }
  updateHUD(fieldSum, fieldRead);
}

// tap mode (original): dice fly in from the tapped screen corner toward the center
function throwBatch(corner) {
  if (fieldFull()) return;
  beginBatch();
  const inset = 2.5;
  const cx = (arena.minX + arena.maxX) / 2, cz = (arena.minZ + arena.maxZ) / 2;
  for (let i = 0; i < curCount; i++) {
    const sx = (corner.x > 0 ? arena.maxX - inset : arena.minX + inset) + (Math.random() * 6 - 3);
    const sz = (corner.z > 0 ? arena.maxZ - inset : arena.minZ + inset) + (Math.random() * 6 - 3);
    const dir = new THREE.Vector2(cx - sx, cz - sz)
      .normalize()
      .rotateAround(new THREE.Vector2(), (Math.random() - 0.5) * 0.5);
    const speed = 21 + Math.random() * 9;
    const die = spawnDieAt(curType,
      { x: sx, y: GROUND_Y + 8 + Math.random() * 6, z: sz },
      { x: dir.x * speed, y: 12 + Math.random() * 8, z: dir.y * speed });
    trackDie(die);
  }
  updateHUD();
}

// drag/shake mode: dice leave a point along a direction with the gesture's force
function throwDirected(origin, dir, speed) {
  if (fieldFull()) return;
  beginBatch();
  const pad = 2;
  const ox = clamp(origin.x, arena.minX + pad, arena.maxX - pad);
  const oz = clamp(origin.z, arena.minZ + pad, arena.maxZ - pad);
  for (let i = 0; i < curCount; i++) {
    const a = (Math.random() - 0.5) * 0.35;
    const cos = Math.cos(a), sin = Math.sin(a);
    const dx = dir.x * cos - dir.z * sin, dz = dir.x * sin + dir.z * cos;
    const v = speed * (0.85 + Math.random() * 0.3);
    const die = spawnDieAt(curType,
      { x: ox + Math.random() * 3 - 1.5, y: GROUND_Y + 3.2 + Math.random() * 2.5, z: oz + Math.random() * 3 - 1.5 },
      { x: dx * v, y: Math.min(7 + v * 0.28, 22), z: dz * v },
      0.8 + v / 30);
    trackDie(die);
  }
  updateHUD();
}

// deadline fallback for dice that never fall asleep (leaning, micro-drift):
// read them as-is, marked forced — the poll replaces this once they truly settle
function forceReadBatch() {
  for (const e of batch) {
    if (!e.die.cached && e.die.body.sleepState !== 2) {
      e.die.cached = { ...e.die.read(), forced: true };
    }
  }
  pollValues();
}

function updateHUD(fieldSum = null, fieldRead = 0) {
  const done = batch.filter(e => e.die.cached);
  if (batch.length) {
    const parts = done.map(e => e.die.cached.label);
    const sum = done.reduce((s, e) => s + e.die.cached.value, 0);
    const rolling = batch.length - done.length;
    hudRoll.textContent =
      `${curTypeOf(batch)} ×${batch.length}  ${parts.join(' + ')}` +
      (rolling ? `  · rolling ${rolling}…` : `  =  ${sum}`);
  } else {
    hudRoll.textContent = '';
  }
  if (simTime < noticeUntil) return; // keep the max-dice notice visible
  if (!allDice.length) { hudField.textContent = ''; return; }
  let text = `field ${allDice.length}`;
  if (fieldSum !== null && fieldRead > 0) {
    text += fieldRead === allDice.length ? ` · Σ ${fieldSum}` : ` · Σ ${fieldSum}…`;
  }
  hudField.textContent = text;
}
const curTypeOf = b => b[0]?.die.type ?? '';

function clearField() {
  allDice.forEach(d => { scene.remove(d.mesh); world.removeBody(d.body); });
  allDice.length = 0;
  batch.forEach(e => e.labelEl.remove());
  batch = [];
  updateHUD();
}

// ---------------------------------------------------------------- input / UI

// ---- gestures: tap = corner throw (original) · drag = flick with direction + force
const cv = renderer.domElement;
const gesture = { id: null, samples: [] };

cv.addEventListener('pointerdown', ev => {
  ensureMotionPermission(); // iOS needs a user gesture to unlock devicemotion
  if (gesture.id !== null) return;
  gesture.id = ev.pointerId;
  gesture.samples = [{ x: ev.clientX, y: ev.clientY, t: performance.now() }];
  try { cv.setPointerCapture(ev.pointerId); } catch { /* synthetic pointers */ }
});

cv.addEventListener('pointermove', ev => {
  if (ev.pointerId !== gesture.id) return;
  gesture.samples.push({ x: ev.clientX, y: ev.clientY, t: performance.now() });
  if (gesture.samples.length > 32) gesture.samples.shift();
});

cv.addEventListener('pointerup', ev => {
  if (ev.pointerId !== gesture.id) return;
  gesture.id = null;
  const first = gesture.samples[0];
  const last = { x: ev.clientX, y: ev.clientY, t: performance.now() };
  gesture.samples.push(last);

  if (Math.hypot(last.x - first.x, last.y - first.y) < 10) {
    // tap → original corner throw (screen top = -z)
    const nx = (ev.clientX / window.innerWidth) * 2 - 1;
    const ny = -(ev.clientY / window.innerHeight) * 2 + 1;
    throwBatch({ x: nx >= 0 ? 1 : -1, z: ny >= 0 ? -1 : 1 });
    return;
  }

  // release velocity from the last ~130ms of the gesture
  let ref = first;
  for (const p of gesture.samples) if (last.t - p.t <= 130) { ref = p; break; }
  const dt = Math.max((last.t - ref.t) / 1000, 1 / 240);
  const vx = (last.x - ref.x) / dt, vy = (last.y - ref.y) / dt;
  const pxSpeed = Math.hypot(vx, vy);

  let dirX, dirZ, speed;
  const worldPerPx = (arena.maxX - arena.minX) / window.innerWidth;
  if (pxSpeed >= 60) {
    dirX = vx / pxSpeed;
    dirZ = vy / pxSpeed; // screen down = +z
    speed = clamp(pxSpeed * worldPerPx * 0.9, 9, 36);
  } else {
    // gesture ended at rest: gentle toss along the overall drag
    const dx = last.x - first.x, dy = last.y - first.y;
    const d = Math.hypot(dx, dy);
    dirX = dx / d;
    dirZ = dy / d;
    speed = 10;
  }
  const origin = groundPointAtNDC(
    (first.x / window.innerWidth) * 2 - 1,
    -(first.y / window.innerHeight) * 2 + 1);
  throwDirected(origin, { x: dirX, z: dirZ }, speed);
});

cv.addEventListener('pointercancel', ev => {
  if (ev.pointerId === gesture.id) gesture.id = null;
});

// ---- device motion (mobile): flick the phone, dice fly that way
let motionAsked = false, lastShake = 0;

function ensureMotionPermission() {
  if (motionAsked) return;
  motionAsked = true;
  const D = window.DeviceMotionEvent;
  if (!D) return;
  if (typeof D.requestPermission === 'function') {
    D.requestPermission()
      .then(state => { if (state === 'granted') window.addEventListener('devicemotion', onMotion); })
      .catch(() => {});
  } else {
    window.addEventListener('devicemotion', onMotion);
  }
}

function onMotion(e) {
  const a = e.acceleration;
  if (!a || a.x === null) return;
  const mag = Math.hypot(a.x, a.y);
  const now = performance.now();
  if (mag < 12 || now - lastShake < 900) return; // m/s² threshold + cooldown
  lastShake = now;

  // device axes → screen axes (respect orientation), device top = screen top = world -z
  const ang = ((screen.orientation?.angle ?? 0) * Math.PI) / 180;
  const sx = a.x * Math.cos(ang) + a.y * Math.sin(ang);
  const sy = a.y * Math.cos(ang) - a.x * Math.sin(ang);
  const len = Math.hypot(sx, sy) || 1;
  const dir = { x: sx / len, z: -sy / len };

  // enter from the edge opposite the flick so dice sweep across the field
  const cx = (arena.minX + arena.maxX) / 2, cz = (arena.minZ + arena.maxZ) / 2;
  const hw = (arena.maxX - arena.minX) / 2 - 2.2, hd = (arena.maxZ - arena.minZ) / 2 - 2.2;
  const t = Math.min(hw / Math.max(Math.abs(dir.x), 1e-6), hd / Math.max(Math.abs(dir.z), 1e-6));
  throwDirected({ x: cx - dir.x * t, z: cz - dir.z * t }, dir, clamp(mag * 2.2, 14, 36));
}

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
  if (w < 50 || h < 50 || (w === viewW && h === viewH)) return; // ignore degenerate embeds
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
  if (simTime > nextPatrol) {
    nextPatrol = simTime + 2;
    recoverOutsiders();
  }
  if (++pollTick >= 10) { // ~6×/s: read settled dice, refresh labels and sums
    pollTick = 0;
    pollValues();
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
window.__dice = { scene, camera, world, allDice, recoverOutsiders, pollValues, get arena() { return arena; } };
