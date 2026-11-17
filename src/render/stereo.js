/*
 * stereo.js: side-by-side stereo for phone VR viewers (Cardboard and the
 * like), driven by a host page such as the FPVR Android app.
 *
 * OFF UNLESS ASKED. Nothing changes for anyone who has not set
 *
 *   window.__fpvrStereo = { on: true, eyeSep: 0.064, focus: 10 }
 *
 * eyeSep is the distance between the two eye cameras and focus the distance
 * at which both eyes see the same point, both in metres AT THE AIRCRAFT'S
 * SCALE, converted through simLenToWorld like the camera mount: a map built
 * larger or smaller than the aircraft (WORLD_SCALE, frame.js) would
 * otherwise give the same setting a different depth on every map. At focus
 * the parallax is zero: nearer things stand out of the screen, farther
 * things sit behind it.
 *
 * HOW. Each eye is drawn by the map's own post pipeline, exactly as the sim
 * draws its mono frame, at the full canvas size, and the result is then
 * blitted, squeezed, into that eye's half of the canvas:
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
 * It costs two full frames and three framebuffer blits. A half width frame
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
import { simLenToWorld } from './frame.js';

if (typeof window !== 'undefined') {
  window.__fpvrStereoNative = true;
}

/* Reused, never allocated per frame (P8). */
const size = new THREE.Vector2();
const buf = new THREE.Vector2();
const savedPos = new THREE.Vector3();
const baseProj = new THREE.Matrix4();
/* An RGBA8 renderbuffer the two eyes are blitted into side by side. Raw
 * WebGL2, not a three.js texture copy: the sim's canvas is opaque (RGB), and
 * copyTexSubImage2D refuses to copy an RGB framebuffer into an RGBA texture
 * (that is what left the first version of this black), while
 * blitFramebuffer converts between the two and scales on the way. */
let sbs = null;

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

function sbsFor(gl, w, h) {
  if (sbs && sbs.w === w && sbs.h === h) {
    return sbs;
  }
  if (sbs) {
    gl.deleteFramebuffer(sbs.fb);
    gl.deleteRenderbuffer(sbs.rb);
  }
  const rb = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
  gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  sbs = { fb, rb, w, h };
  return sbs;
}

/**
 * Draw one stereo frame through `post` (the map's pipeline, anything with a
 * render() that ends on the screen). Without WebGL2 it draws the mono frame.
 */
export function renderStereo(post, camera, renderer, req) {
  if (!renderer.capabilities.isWebGL2) {
    post.render();
    return;
  }
  const gl = renderer.getContext();
  renderer.getSize(size);
  renderer.getDrawingBufferSize(buf);
  const w = Math.max(1, Math.floor(buf.x));
  const h = Math.max(1, Math.floor(buf.y));
  const half = Math.floor(w / 2);
  renderer.setRenderTarget(null);
  const target = sbsFor(gl, w, h);

  const aspect = camera.aspect;
  savedPos.copy(camera.position);
  camera.aspect = (size.x / 2) / size.y;
  camera.updateProjectionMatrix();
  baseProj.copy(camera.projectionMatrix);

  const shadowAuto = renderer.shadowMap.autoUpdate;
  const sep = simLenToWorld(req.eyeSep) / 2;
  const focus = simLenToWorld(req.focus);
  try {
    for (let eye = 0; eye < 2; eye += 1) {
      const side = eye === 0 ? -1 : 1;
      camera.position.copy(savedPos);
      camera.translateX(side * sep);
      camera.updateMatrixWorld(true);
      /* Off-axis frustum: shift the projection toward the middle so the two
       * frusta cross at `focus`. Column major, elements[8] is m[0][2]. */
      camera.projectionMatrix.copy(baseProj);
      camera.projectionMatrix.elements[8] += -side * sep * baseProj.elements[0] / focus;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      if (eye === 1) {
        renderer.shadowMap.autoUpdate = false;
        renderer.shadowMap.needsUpdate = false;
      }
      post.render();
      /* The eye's full frame, squeezed into its half of the side by side
       * buffer. Blits ignore the viewport but not the scissor test. */
      renderer.setRenderTarget(null);
      renderer.setScissorTest(false);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.fb);
      gl.blitFramebuffer(0, 0, w, h, eye * half, 0, eye === 0 ? half : w, h,
        gl.COLOR_BUFFER_BIT, gl.LINEAR);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    /* Both eyes back onto the screen. */
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  } finally {
    /* Three.js caches the bound framebuffer; leave it on the screen, which
     * is what setRenderTarget(null) above told it. */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    renderer.shadowMap.autoUpdate = shadowAuto;
    renderer.shadowMap.needsUpdate = false;
    camera.position.copy(savedPos);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  if (typeof window !== 'undefined') {
    window.__fpvrStereoLast = performance.now();
  }
}

/* Kept for the draw site in main.js: nothing is resized any more, so there
 * is nothing to put back when stereo goes off. */
export function endStereo() {}
