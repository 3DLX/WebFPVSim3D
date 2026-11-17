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
 * HOW. The whole post chain (normals and depth prepass, colour, ink
 * outlines, grade) is rendered once per eye, so each eye gets exactly the
 * picture the sim draws in mono, just from its own position and into its own
 * half of the canvas:
 *
 *   - the composer is resized to half the width while stereo is on, so the
 *     ink outline keeps its pixel width and no pass reads a stretched buffer;
 *   - the camera is moved half the eye separation along its own x axis and
 *     its frustum is shifted toward the middle (an off-axis, converging
 *     projection, the same maths as three.js StereoCamera) so the eyes meet
 *     at `focus` without toeing in, which would tilt the horizon;
 *   - the vertical field of view is the pilot's own, the horizontal one per
 *     eye is half the screen's, which is what a viewer's lens expects;
 *   - shadows are drawn for the first eye only and reused for the second.
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
const savedPos = new THREE.Vector3();
const baseProj = new THREE.Matrix4();
let halfSized = false;

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

/**
 * Draws one frame as two eyes side by side. post is the view's composer
 * wrapper from src/render/post.js (render, setSize, composer).
 */
export function renderStereo(post, camera, renderer, req) {
  renderer.getSize(size);
  const fullW = size.x;
  const h = size.y;
  const halfW = Math.max(1, Math.floor(fullW / 2));
  /* Half width composer. Checked every frame against what the composer
   * holds, so a resize or a render scale change made while stereo is on is
   * picked up on the next frame. */
  if (!halfSized || (post.composer && post.composer._width !== halfW) || (post.composer && post.composer._height !== h)) {
    post.setSize(halfW, h);
    halfSized = true;
  }

  const aspect = camera.aspect;
  savedPos.copy(camera.position);
  camera.aspect = halfW / h;
  camera.updateProjectionMatrix();
  baseProj.copy(camera.projectionMatrix);

  const shadowAuto = renderer.shadowMap.autoUpdate;
  const half = req.eyeSep / 2;
  try {
    renderer.setScissorTest(true);
    for (let eye = 0; eye < 2; eye += 1) {
      const side = eye === 0 ? -1 : 1;
      camera.position.copy(savedPos);
      camera.translateX(side * half);
      camera.updateMatrixWorld(true);
      /* Off-axis frustum: shift the window toward the middle so both
       * frusta meet at req.focus. elements[8] is (r + l) / (r - l). */
      camera.projectionMatrix.copy(baseProj);
      camera.projectionMatrix.elements[8] += -side * half * baseProj.elements[0] / req.focus;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

      renderer.setViewport(eye * halfW, 0, halfW, h);
      renderer.setScissor(eye * halfW, 0, halfW, h);
      if (eye === 1) {
        renderer.shadowMap.autoUpdate = false;
        renderer.shadowMap.needsUpdate = false;
      }
      post.render();
    }
  } finally {
    renderer.shadowMap.autoUpdate = shadowAuto;
    /* The first eye's render consumed any pending shadow update. */
    renderer.shadowMap.needsUpdate = false;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, fullW, h);
    renderer.setScissor(0, 0, fullW, h);
    camera.position.copy(savedPos);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }
  if (typeof window !== 'undefined') {
    window.__fpvrStereoLast = performance.now();
  }
}

/** Back to a full width composer after stereo, once. */
export function endStereo(post, renderer) {
  if (!halfSized) {
    return;
  }
  halfSized = false;
  renderer.getSize(size);
  post.setSize(size.x, size.y);
}
