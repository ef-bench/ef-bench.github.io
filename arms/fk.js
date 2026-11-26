// Forward kinematics of an exported MuJoCo kinematic tree (same order of operations as MuJoCo mj_kinematics).
// Quaternions are [w, x, y, z] (MuJoCo order). No three.js dependency, so node can test it against MuJoCo.

export function qmul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

export function qrot(q, v) {
  // v' = q v q*
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

export function qnorm(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

function axisAngle(a, ang) {
  const s = Math.sin(ang / 2);
  return [Math.cos(ang / 2), a[0] * s, a[1] * s, a[2] * s];
}

// scene.bodies[i] = {parent, pos, quat, joints: [{type, qadr, axis, pos, qpos0}]}; bodies are in MuJoCo order
// (parent index < child index). Returns body world poses plus each joint's world anchor and axis.
export function forward(scene, qpos) {
  const B = scene.bodies;
  const xpos = new Array(B.length);
  const xquat = new Array(B.length);
  const joints = {};
  xpos[0] = [0, 0, 0];
  xquat[0] = [1, 0, 0, 0];
  for (let i = 1; i < B.length; i++) {
    const b = B[i];
    const pp = xpos[b.parent], pq = xquat[b.parent];
    const r = qrot(pq, b.pos);
    let p = [pp[0] + r[0], pp[1] + r[1], pp[2] + r[2]];
    let q = qmul(pq, b.quat);
    for (const j of b.joints) {
      const a = j.qadr;
      if (j.type === "free") {
        p = [qpos[a], qpos[a + 1], qpos[a + 2]];
        q = qnorm([qpos[a + 3], qpos[a + 4], qpos[a + 5], qpos[a + 6]]);
        continue;
      }
      if (j.type === "ball") {
        const ra = qrot(q, j.pos);
        const anchor = [p[0] + ra[0], p[1] + ra[1], p[2] + ra[2]];
        joints[j.name] = { anchor, axis: null };
        q = qmul(q, qnorm([qpos[a], qpos[a + 1], qpos[a + 2], qpos[a + 3]]));
        const rb = qrot(q, j.pos);
        p = [anchor[0] - rb[0], anchor[1] - rb[1], anchor[2] - rb[2]];
        continue;
      }
      const ra = qrot(q, j.pos);
      const anchor = [p[0] + ra[0], p[1] + ra[1], p[2] + ra[2]];
      const axis = qrot(q, j.axis);
      joints[j.name] = { anchor, axis };
      const v = qpos[a] - j.qpos0[0];
      if (j.type === "slide") {
        p = [p[0] + axis[0] * v, p[1] + axis[1] * v, p[2] + axis[2] * v];
      } else {
        q = qmul(q, axisAngle(j.axis, v));
        const rb = qrot(q, j.pos);
        p = [anchor[0] - rb[0], anchor[1] - rb[1], anchor[2] - rb[2]];
      }
    }
    xpos[i] = p;
    xquat[i] = qnorm(q);
  }
  return { xpos, xquat, joints };
}
