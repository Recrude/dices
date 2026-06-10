// dice.js — procedural polyhedral dice: geometry, number atlas, physics hull, value reading
import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export const GREEN = '#00A651';
export const DICE_ORDER = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd%'];

// Neue Haas Grotesk when installed, otherwise the Helvetica family
const FONT = "'Neue Haas Grotesk Display Pro', 'Neue Haas Grotesk Text Pro', 'Neue Haas Grotesk', 'Helvetica Neue', Helvetica, Arial, sans-serif";

// circumradius per type (visual balance — tetra reads small for its circumsphere)
const RADIUS = { d4: 2.1, d6: 1.7, d8: 1.8, d10: 1.75, d12: 1.65, d20: 1.75 };
RADIUS['d%'] = RADIUS.d10;

const TILE = 256;
const EPS = 1e-4;

// ---------------------------------------------------------------- face extraction

// triangle soup -> unique verts + logical coplanar polygon faces (CCW from outside)
function extractPolyhedron(geo) {
  if (geo.index) geo = geo.toNonIndexed();
  const pos = geo.getAttribute('position');
  const verts = [];
  const vmap = new Map();
  const idxOf = (x, y, z) => {
    const k = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    if (!vmap.has(k)) { vmap.set(k, verts.length); verts.push(new THREE.Vector3(x, y, z)); }
    return vmap.get(k);
  };
  const groups = new Map(); // plane key -> Set of vert indices
  for (let i = 0; i < pos.count; i += 3) {
    const tri = [0, 1, 2].map(j => idxOf(pos.getX(i + j), pos.getY(i + j), pos.getZ(i + j)));
    const [a, b, c] = tri.map(t => verts[t]);
    const n = new THREE.Vector3().subVectors(b, a)
      .cross(new THREE.Vector3().subVectors(c, a)).normalize();
    const d = n.dot(a);
    const k = `${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)},${d.toFixed(3)}`;
    if (!groups.has(k)) groups.set(k, new Set());
    tri.forEach(t => groups.get(k).add(t));
  }
  const faces = [...groups.values()].map(set => orderFace(verts, [...set]));
  return { verts, faces };
}

// order polygon verts CCW viewed from outside (solid centered at origin)
function orderFace(verts, ids) {
  const c = ids.reduce((s, i) => s.add(verts[i]), new THREE.Vector3()).divideScalar(ids.length);
  let n = faceNormal(verts, ids, c);
  if (n.dot(c) < 0) n.negate();
  const u = new THREE.Vector3().subVectors(verts[ids[0]], c).normalize();
  const w = new THREE.Vector3().crossVectors(n, u);
  return ids.slice().sort((i, j) => angleOf(verts[i]) - angleOf(verts[j]));
  function angleOf(p) {
    const r = new THREE.Vector3().subVectors(p, c);
    return Math.atan2(r.dot(w), r.dot(u));
  }
}

function faceNormal(verts, ids, c) {
  // unordered ids: pick a vertex pair whose cross product is non-degenerate
  // (e.g. diagonal corners of a square face are collinear through the centroid)
  const a = new THREE.Vector3().subVectors(verts[ids[0]], c);
  for (let i = 1; i < ids.length; i++) {
    const n = a.clone().cross(new THREE.Vector3().subVectors(verts[ids[i]], c));
    if (n.lengthSq() > 1e-8) return n.normalize();
  }
  return new THREE.Vector3(0, 1, 0);
}

// outward normal of an ordered face
function outwardNormal(verts, face) {
  const c = face.reduce((s, i) => s.add(verts[i]), new THREE.Vector3()).divideScalar(face.length);
  const n = new THREE.Vector3()
    .subVectors(verts[face[1]], verts[face[0]])
    .cross(new THREE.Vector3().subVectors(verts[face[2]], verts[face[0]])).normalize();
  if (n.dot(c) < 0) n.negate();
  return n;
}

// ensure stored winding matches outward normal (cannon expects CCW from outside)
function ensureOutwardWinding(verts, faces) {
  return faces.map(face => {
    const c = face.reduce((s, i) => s.add(verts[i]), new THREE.Vector3()).divideScalar(face.length);
    const n = new THREE.Vector3()
      .subVectors(verts[face[1]], verts[face[0]])
      .cross(new THREE.Vector3().subVectors(verts[face[2]], verts[face[0]]));
    return n.dot(c) < 0 ? face.slice().reverse() : face;
  });
}

// ---------------------------------------------------------------- d10 (pentagonal trapezohedron)

function buildD10() {
  const h = 0.10557280900008409; // zigzag height for planar kites, poles at ±1
  const verts = [];
  for (let k = 0; k < 10; k++) {
    verts.push(new THREE.Vector3(Math.cos(Math.PI * k / 5), (k % 2 === 0 ? h : -h), Math.sin(Math.PI * k / 5)));
  }
  verts.push(new THREE.Vector3(0, 1, 0));  // 10: top pole
  verts.push(new THREE.Vector3(0, -1, 0)); // 11: bottom pole
  const faces = [];
  for (let k = 0; k < 10; k += 2) faces.push([10, k, (k + 1) % 10, (k + 2) % 10]); // top kites
  for (let k = 1; k < 10; k += 2) faces.push([11, (k + 2) % 10, (k + 1) % 10, k]); // bottom kites
  return { verts, faces: ensureOutwardWinding(verts, faces) };
}

// ---------------------------------------------------------------- value assignment

// pair opposite faces, assign values so opposite faces sum to F+1
function assignFaceValues(verts, faces) {
  const F = faces.length;
  const normals = faces.map(f => outwardNormal(verts, f));
  const values = new Array(F).fill(0);
  const used = new Array(F).fill(false);
  let v = 1;
  for (let i = 0; i < F; i++) {
    if (used[i]) continue;
    let opp = -1;
    for (let j = i + 1; j < F; j++) {
      if (!used[j] && normals[i].dot(normals[j]) < -0.999) { opp = j; break; }
    }
    used[i] = true;
    values[i] = v;
    if (opp >= 0) { used[opp] = true; values[opp] = F + 1 - v; }
    v++;
  }
  return values;
}

// ---------------------------------------------------------------- atlas + geometry

// min distance from centroid (origin) to an edge — digit sizing reference
function polygonInradius(pts) {
  let m = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    const ex = bx - ax, ey = by - ay;
    m = Math.min(m, Math.abs(ex * ay - ey * ax) / Math.hypot(ex, ey));
  }
  return m;
}

function face2D(verts, face, upVert) {
  const c = face.reduce((s, i) => s.add(verts[i]), new THREE.Vector3()).divideScalar(face.length);
  const n = outwardNormal(verts, face);
  let u, w;
  if (upVert !== undefined && face.includes(upVert)) {
    // digit-up axis points at a reference vertex (d10/d% kites: the pole tip)
    w = new THREE.Vector3().subVectors(verts[upVert], c);
    w.addScaledVector(n, -w.dot(n)).normalize();
    u = new THREE.Vector3().crossVectors(w, n);
  } else {
    u = new THREE.Vector3().subVectors(verts[face[0]], c).normalize();
    w = new THREE.Vector3().crossVectors(n, u);
  }
  const pts = face.map(i => {
    const r = new THREE.Vector3().subVectors(verts[i], c);
    return [r.dot(u), r.dot(w)];
  });
  return { pts, normal: n };
}

function buildDie(type) {
  let poly, faceValues = null, vertValues = null, labels;
  const R = RADIUS[type];

  if (type === 'd4') {
    poly = extractPolyhedron(new THREE.TetrahedronGeometry(1));
    vertValues = [1, 2, 3, 4];
  } else if (type === 'd6') {
    const e = 2 / Math.sqrt(3); // edge for unit circumradius
    poly = extractPolyhedron(new THREE.BoxGeometry(e, e, e));
  } else if (type === 'd8') {
    poly = extractPolyhedron(new THREE.OctahedronGeometry(1));
  } else if (type === 'd10' || type === 'd%') {
    poly = buildD10();
  } else if (type === 'd12') {
    poly = extractPolyhedron(new THREE.DodecahedronGeometry(1));
  } else if (type === 'd20') {
    poly = extractPolyhedron(new THREE.IcosahedronGeometry(1));
  } else {
    throw new Error(`unknown die type ${type}`);
  }

  poly.faces = ensureOutwardWinding(poly.verts, poly.faces);
  poly.verts.forEach(v => v.multiplyScalar(R));

  if (!vertValues) faceValues = assignFaceValues(poly.verts, poly.faces);
  if (type === 'd%') {
    labels = faceValues.map(v => String((v - 1) * 10).padStart(2, '0'));
  } else if (faceValues) {
    labels = faceValues.map(v => String(v));
  }

  // d10/d% kites: orient digits toward the pole the face touches (vert 10 top / 11 bottom)
  const upVertOf = (type === 'd10' || type === 'd%')
    ? f => (f.includes(10) ? 10 : 11)
    : () => undefined;
  const projected = poly.faces.map(f => face2D(poly.verts, f, upVertOf(f)));
  const { texture, uvRects } = drawAtlas(type, poly, projected, labels, vertValues);
  const geometry = buildGeometry(poly, projected, uvRects);
  const material = new THREE.MeshPhongMaterial({
    map: texture, specular: 0x050505, shininess: 100,
  });

  const shape = new CANNON.ConvexPolyhedron({
    vertices: poly.verts.map(v => new CANNON.Vec3(v.x, v.y, v.z)),
    faces: poly.faces.map(f => f.slice()),
  });

  const faceNormals = poly.faces.map(f => outwardNormal(poly.verts, f));
  const vertDirs = poly.verts.map(v => v.clone().normalize());

  return { type, R, geometry, material, shape, faceNormals, vertDirs, faceValues, vertValues, labels };
}

function drawAtlas(type, poly, projected, labels, vertValues) {
  const F = poly.faces.length;
  const cols = Math.ceil(Math.sqrt(F));
  const rows = Math.ceil(F / cols);
  const canvas = document.createElement('canvas');
  canvas.width = cols * TILE;
  canvas.height = rows * TILE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = GREEN;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const uvRects = [];
  for (let f = 0; f < F; f++) {
    const col = f % cols, row = Math.floor(f / cols);
    const cx = col * TILE + TILE / 2, cy = row * TILE + TILE / 2;
    const { pts } = projected[f];
    const maxR = Math.max(...pts.map(([x, y]) => Math.hypot(x, y)));
    const s = (TILE / 2 - 16) / maxR;
    uvRects.push({ cx, cy, s, W: canvas.width, H: canvas.height });

    ctx.fillStyle = '#ffffff';
    const inr = polygonInradius(pts) * s; // face inradius in atlas px
    if (type === 'd4') {
      // three numbers per face, one near each corner, top of digit pointing at the corner
      const face = poly.faces[f];
      for (let k = 0; k < 3; k++) {
        const [x, y] = pts[k];
        const px = cx + x * s * 0.58, py = cy - y * s * 0.58;
        const dx = x * s, dy = -y * s; // corner dir in canvas coords
        const len = Math.hypot(dx, dy);
        const ang = Math.atan2(dx / len, -dy / len);
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(ang);
        ctx.font = `bold ${Math.round(inr * 0.95)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(vertValues[face[k]]), 0, 0);
        ctx.restore();
      }
    } else {
      const label = labels[f];
      let factor = pts.length === 3 ? 1.45 : 1.1;
      if (label.length > 1) factor *= 0.78; // two digits need width
      const size = Math.round(inr * factor);
      ctx.font = `bold ${size}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cx, cy);
      if (['6', '9', '60', '90'].includes(label)) {
        const w = ctx.measureText(label).width;
        ctx.fillRect(cx - w / 2, cy + size * 0.46, w, size * 0.07);
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return { texture, uvRects };
}

function buildGeometry(poly, projected, uvRects) {
  const positions = [], normals = [], uvs = [];
  poly.faces.forEach((face, f) => {
    const n = projected[f].normal;
    const { pts } = projected[f];
    const { cx, cy, s, W, H } = uvRects[f];
    const uvOf = k => {
      const px = cx + pts[k][0] * s, py = cy - pts[k][1] * s;
      return [px / W, 1 - py / H];
    };
    for (let k = 1; k < face.length - 1; k++) {
      for (const idx of [0, k, k + 1]) {
        const v = poly.verts[face[idx]];
        positions.push(v.x, v.y, v.z);
        normals.push(n.x, n.y, n.z);
        uvs.push(...uvOf(idx));
      }
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geo;
}

// ---------------------------------------------------------------- public API

const cache = new Map();
const UP = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

export function createDie(type, physicsMaterial) {
  if (!cache.has(type)) cache.set(type, buildDie(type));
  const def = cache.get(type);

  const mesh = new THREE.Mesh(def.geometry, def.material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const body = new CANNON.Body({ mass: 1, shape: def.shape, material: physicsMaterial });
  body.allowSleep = true;
  body.sleepSpeedLimit = 0.8;  // catch low-speed contact buzz early
  body.sleepTimeLimit = 0.3;
  body.angularDamping = 0.05;  // settle tumbling sooner without dulling flight

  const read = () => {
    tmpQ.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    let best = -Infinity, bi = 0;
    if (def.vertValues) {
      // d4: value of the vertex pointing up
      for (let i = 0; i < def.vertDirs.length; i++) {
        const d = tmp.copy(def.vertDirs[i]).applyQuaternion(tmpQ).dot(UP);
        if (d > best) { best = d; bi = i; }
      }
      return { value: def.vertValues[bi], label: String(def.vertValues[bi]), sure: best > 0.8 };
    }
    for (let i = 0; i < def.faceNormals.length; i++) {
      const d = tmp.copy(def.faceNormals[i]).applyQuaternion(tmpQ).dot(UP);
      if (d > best) { best = d; bi = i; }
    }
    const numeric = type === 'd%' ? (def.faceValues[bi] - 1) * 10 : def.faceValues[bi];
    return { value: numeric, label: def.labels[bi], sure: best > 0.85 };
  };

  return { type, R: def.R, mesh, body, read };
}
