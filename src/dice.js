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
  return { pts, normal: n, c, u, w };
}

// inset a convex CCW polygon by distance b (each edge moved inward, lines re-intersected)
function insetPolygon(pts, b) {
  const m = pts.length;
  const lines = pts.map((p, i) => {
    const q = pts[(i + 1) % m];
    const ex = q[0] - p[0], ey = q[1] - p[1];
    const len = Math.hypot(ex, ey);
    const nx = -ey / len, ny = ex / len; // interior is left of a CCW edge
    return { px: p[0] + nx * b, py: p[1] + ny * b, dx: ex, dy: ey };
  });
  return pts.map((_, i) => {
    const a = lines[(i - 1 + m) % m], c = lines[i];
    const det = a.dx * c.dy - a.dy * c.dx;
    if (Math.abs(det) < 1e-9) return [c.px, c.py];
    const t = ((c.px - a.px) * c.dy - (c.py - a.py) * c.dx) / det;
    return [a.px + a.dx * t, a.py + a.dy * t];
  });
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

  // visual-only bevel: ~8% of the circumradius, capped so small faces survive
  const minInr = Math.min(...projected.map(pr => polygonInradius(pr.pts)));
  const bevel = Math.min(R * 0.08, minInr * 0.4);
  const inset2 = projected.map(pr => insetPolygon(pr.pts, bevel));
  const inset3 = inset2.map((pts2, fi) => {
    const { c, u, w } = projected[fi];
    return pts2.map(([x, y]) =>
      c.clone().addScaledVector(u, x).addScaledVector(w, y));
  });

  const { texture, uvRects, greenUV } = drawAtlas(type, poly, projected, labels, vertValues);
  const geometry = buildGeometry(poly, projected, uvRects, inset2, inset3, greenUV);
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
  const cols = Math.ceil(Math.sqrt(F + 1)); // one spare tile of plain green for the bevels
  const rows = Math.ceil((F + 1) / cols);
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
        const px = cx + x * s * 0.52, py = cy - y * s * 0.52;
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
  const greenUV = [
    (((F % cols) * TILE) + TILE / 2) / canvas.width,
    1 - (((Math.floor(F / cols)) * TILE) + TILE / 2) / canvas.height,
  ];
  return { texture, uvRects, greenUV };
}

// beveled render geometry: faces are inset, the freed border becomes bevel strips
// (normals blend the two adjacent faces) and corner patches — physics stays sharp
function buildGeometry(poly, projected, uvRects, inset2, inset3, greenUV) {
  const positions = [], normals = [], uvs = [];

  const emitTri = (pa, na, ua, pb, nb, ub, pc, nc, uc) => {
    const cross = new THREE.Vector3().subVectors(pb, pa)
      .cross(new THREE.Vector3().subVectors(pc, pa));
    const center = new THREE.Vector3().add(pa).add(pb).add(pc);
    if (cross.dot(center) < 0) { [pb, pc] = [pc, pb]; [nb, nc] = [nc, nb]; [ub, uc] = [uc, ub]; }
    for (const [p, n, uv] of [[pa, na, ua], [pb, nb, ub], [pc, nc, uc]]) {
      positions.push(p.x, p.y, p.z);
      normals.push(n.x, n.y, n.z);
      uvs.push(uv[0], uv[1]);
    }
  };

  // ① flat number faces (inset polygons, original atlas mapping)
  poly.faces.forEach((face, f) => {
    const n = projected[f].normal;
    const { cx, cy, s, W, H } = uvRects[f];
    const uvOf = ([x, y]) => [(cx + x * s) / W, 1 - (cy - y * s) / H];
    const p2 = inset2[f], p3 = inset3[f];
    for (let k = 1; k < face.length - 1; k++) {
      emitTri(p3[0], n, uvOf(p2[0]), p3[k], n, uvOf(p2[k]), p3[k + 1], n, uvOf(p2[k + 1]));
    }
  });

  // adjacency from the face loops
  const edgeMap = new Map(); // edge -> [{f, j}] both sides
  const vertMap = new Map(); // vertex -> [{f, j}] all touching corners
  poly.faces.forEach((face, f) => {
    face.forEach((vi, j) => {
      const vj = face[(j + 1) % face.length];
      const key = vi < vj ? `${vi}_${vj}` : `${vj}_${vi}`;
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push({ f, j });
      if (!vertMap.has(vi)) vertMap.set(vi, []);
      vertMap.get(vi).push({ f, j });
    });
  });

  // ② bevel strips: one quad per original edge, shading blends face A into face B
  for (const sides of edgeMap.values()) {
    if (sides.length !== 2) continue;
    const [A, B] = sides;
    const nA = projected[A.f].normal, nB = projected[B.f].normal;
    const lenA = poly.faces[A.f].length, lenB = poly.faces[B.f].length;
    const aVa = inset3[A.f][A.j], aVb = inset3[A.f][(A.j + 1) % lenA];
    const bVb = inset3[B.f][B.j], bVa = inset3[B.f][(B.j + 1) % lenB]; // B runs the edge reversed
    emitTri(aVa, nA, greenUV, aVb, nA, greenUV, bVb, nB, greenUV);
    emitTri(aVa, nA, greenUV, bVb, nB, greenUV, bVa, nB, greenUV);
  }

  // ③ corner patches: fan over each original vertex's inset corners
  for (const [vi, corners] of vertMap) {
    if (corners.length < 3) continue;
    const v = poly.verts[vi];
    const vhat = v.clone().normalize();
    const ref = Math.abs(vhat.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const t1 = new THREE.Vector3().crossVectors(vhat, ref).normalize();
    const t2 = new THREE.Vector3().crossVectors(vhat, t1);
    const angleOf = p => {
      const r = new THREE.Vector3().subVectors(p, v);
      return Math.atan2(r.dot(t2), r.dot(t1));
    };
    const pts = corners
      .map(({ f, j }) => ({ p: inset3[f][j], n: projected[f].normal }))
      .sort((a, b) => angleOf(a.p) - angleOf(b.p));
    const m = pts.reduce((s, e) => s.add(e.p), new THREE.Vector3()).divideScalar(pts.length);
    const nm = pts.reduce((s, e) => s.add(e.n), new THREE.Vector3()).normalize();
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      emitTri(m, nm, greenUV, a.p, a.n, greenUV, b.p, b.n, greenUV);
    }
  }

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
