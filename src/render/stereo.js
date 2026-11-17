/*
 * stereo.js: side-by-side stereo for phone VR viewers (Cardboard and the
 * like), driven by a host page such as the FPVR Android app.
 *
 * OFF UNLESS ASKED. Nothing changes for anyone who has not set
 *
 *   window.__fpvrStereo = { on: true, eyeSep: 0.064, focus: 10 }
 *
 * eyeSep is the distance between the two eye cameras in metres of the world,
 * focus the distance in metres at which both eyes see the same point (zero
 * parallax): nearer things stand out of the screen, farther things sit
 * behind it.
 *
 * HOW. Each eye is drawn by the map's own post pipeline, exactly as the sim
 * draws its mono frame, at the full canvas size, and the result is then
 * copied out and squeezed into that eye's half of the canvas:
 *
 *   - nothing is resized. An earlier version resized the post chain to half
 *     the width, which is wrong for the built and city pipelines: their
 *     setSize also sizes the renderer, so the canvas halved again on every
 *     frame and the picture fell apart (walls missing, wrong overlap) on
 *     the indoor maps. The pipelines are treated as black boxes that draw a
 *     full frame to the screen, which every one of them already does;
 *   - the camera's aspect is set to half the screen's for the eye, so the
 *     full size frame holds a picture stretched by two across, and the
 *     squeeze back into half the width puts the proportions right;
 *   - the camera is moved half the eye separation along its own x axis and
 *     its frustum is shifted toward the middle (an off-axis, converging
 *     projection, the same maths as three.js StereoCamera) so the eyes meet
 *     at `focus` without toeing in, which would tilt the horizon;
 *   - shadows are drawn for the first eye only and reused for the second.
 *
 * It costs two full frames and two framebuffer copies. A half width frame
 * per eye would be cheaper, but only with the pipelines' cooperation.
 *
 * The host does the lens correction and shows each half to its eye; the
 * sim's own fisheye is left off while stereo is on (main.js), because a
 * second bend on top of the viewer's lens correction would be wrong.
 *
 * window.__fpvrStereoNative tells a host that this exists, so it does not
 * try anything of its own. window.__fpvrStereoLast is the time of the last
 * stereo frame, so a host knows the canvas currently holds two eyes (menus
 * and the intro stay mono).
 *
 * This file is part of WebFPVSimulator.
 *
 * WebFPVSimulator is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 *
 * WebFPVSimulator is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY, without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with WebFPVSimulator. If not, see <https://www.gnu.org/licenses/>.
 */

import * as THREE from 'three';

if (typeof window !== 'undefined') {
  window.__fpvrStereoNative = true;
}

/* Reused, never allocated per frame (P8). */
const size = new THREE.Vector2();
const buf = new THREE.Vector2();
const origin = new THREE.Vector2(0, 0);
const savedPos = new THREE.Vector3();
const baseProj = new THREE.Matrix4();
let eyes = null;

/** The host's request, or null when stereo is off. */
export function stereoRequest() {
  const s = typeof window !== 'undefined' ? window.__fpvrStereo : null;
  if (!s || !s.on) {
    return null;
  }
  const eyeSep = Number(s.eyeSep);
  const focus = Number(s.focus);
  return {
    eyeSep: Number.isFinite(eyeSep) && eyeSep >= 0 ? eyeSep : 0.064,
    focus: Number.isFinite(focus) && focus > 0.1 ? focus : 10,
  };
}

function eyeTexture(w, h) {
  const t = new THREE.FramebufferTexture(w, h);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
}

/* The two eye copies and the quad that lays them side by side. The
 * material writes the copied pixels back unchanged: they are already the
 * pipeline's finished, display encoded output. */
function eyesFor(w, h) {
  if (eyes && eyes.w === w && eyes.h === h) {
    return eyes;
  }
  if (eyes) {
    eyes.left.dispose();
    eyes.right.dispose();
  }
  const left = eyeTexture(w, h);
  const right = eyeTexture(w, h);
  if (!eyes) {
    const material = new THREE.ShaderMaterial({
      uniforms: { tLeft: { value: left }, tRight: { value: right } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D tLeft; uniform sampler2D tRight; varying vec2 vUv;'
        + ' void main() { vec2 uv = vec2(fract(vUv.x * 2.0), vUv.y);'
        + ' gl_FragColor = vUv.x < 0.5 ? texture2D(tLeft, uv) : texture2D(tRight, uv); }',
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    eyes = { material, scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
  }
  eyes.material.uniforms.tLeft.value = left;
  eyes.material.uniforms.tRight.value = right;
  eyes.left = left;
  eyes.right = right;
  eyes.w = w;
  eyes.h = h;
  return eyes;
}

/**
 * Draw one stereo frame through `post` (the map's pipeline, anything with a
 * render() that ends on the screen).
 */
export function renderStereo(post, camera, renderer, req) {
  renderer.getSize(size);
  renderer.getDrawingBufferSize(buf);
  const e = eyesFor(Math.max(1, buf.x), Math.max(1, buf.y));

  const aspect = camera.aspect;
  savedPos.copy(camera.position);
  camera.aspect = (size.x / 2) / size.y;
  camera.updateProjectionMatrix();
  baseProj.copy(camera.projectionMatrix);

  const shadowAuto = renderer.shadowMap.autoUpdate;
  const half = req.eyeSep / 2;
  try {
    for (let eye = 0; eye < 2; eye += 1) {
      const side = eye === 0 ? -1 : 1;
      camera.position.copy(savedPos);
      camera.translateX(side * half);
      camera.updateMatrixWorld(true);
      /* Off-axis frustum: shift the projection toward the middle so the two
       * frusta cross at `focus`. Column major, elements[8] is m[0][2]. */
      camera.projectionMatrix.copy(baseProj);
      camera.projectionMatrix.elements[8] += -side * half * baseProj.elements[0] / req.focus;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      if (eye === 1) {
        renderer.shadowMap.autoUpdate = false;
        renderer.shadowMap.needsUpdate = false;
      }
      post.render();
      renderer.setRenderTarget(null);
      renderer.copyFramebufferToTexture(origin, eye === 0 ? e.left : e.right);
    }
  } finally {
    renderer.shadowMap.autoUpdate = shadowAuto;
    renderer.shadowMap.needsUpdate = false;
    camera.position.copy(savedPos);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.setRenderTarget(null);
  renderer.setViewport(0, 0, size.x, size.y);
  renderer.setScissorTest(false);
  renderer.render(e.scene, e.camera);
  renderer.autoClear = autoClear;

  if (typeof window !== 'undefined') {
    window.__fpvrStereoLast = performance.now();
  }
}

/* Kept for the draw site in main.js: nothing is resized any more, so there
 * is nothing to put back when stereo goes off. */
export function endStereo() {}
