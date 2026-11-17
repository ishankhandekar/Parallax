/* ════════════════════════════════════════════════════════════════════════
   PARALLAX — a gravity-shift runner
   Three.js + UnrealBloomPass + Web Audio. No external assets.

   Sections
     01  Constants & utilities
     02  Audio engine (fully synthesised)
     03  Renderer, post-processing, light, sky, materials
     04  Geometry buffers & world builder
     05  Hand-crafted stages 01–03
     06  Infinite procedural generator
     07  Physics simulation (deterministic, cloneable)
     08  Autopilot (level verification + demo)
     09  Player visuals & effects (trail, shards, rings, dust)
     10  Game state, input, HUD
     11  Frame loop
   ════════════════════════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ═══ 01  CONSTANTS & UTILITIES ═════════════════════════════════════════ */

const TAU = Math.PI * 2, HP = Math.PI / 2;
const R = 0.5;            // player radius
const TUBE = 4;           // distance from the travel axis to every running surface
const G = 38;             // gravity
const LAT = 10.5;         // max lateral speed
const VT = 46;            // terminal fall speed
const H = 1 / 120;        // physics step
const INF0 = 1290;        // distance at which the procedural continuum begins
const PAPER = 0xF4F1EA, INK = 0x111114;
const PALETTE = [0xFF4D00, 0x0A5CFF, 0x00B38A, 0xE5007D, 0xFFB000];
const HORIZON = 0xE8DDC9;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const smooth = t => t * t * (3 - 2 * t);
const mod4 = n => ((n % 4) + 4) % 4;
const $ = id => document.getElementById(id);
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Gravity frames. Index = which surface is "floor".
   d = down vector, r = screen-right (lateral) vector, both in world XY.   */
const FR = [
  { dx: 0, dy: -1, rx: 1, ry: 0 },   // 0 floor
  { dx: 1, dy: 0, rx: 0, ry: 1 },    // 1 east wall
  { dx: 0, dy: 1, rx: -1, ry: 0 },   // 2 ceiling
  { dx: -1, dy: 0, rx: 0, ry: -1 },  // 3 west wall
];
const SIDE_NAMES = ['FLOOR', 'EAST WALL', 'CEILING', 'WEST WALL'];

/* ═══ 02  AUDIO ENGINE ══════════════════════════════════════════════════ */

const AU = (() => {
  let ctx = null, bus, tone, master, revIn, padF, bassG, windF, windG, noiseBuf;
  let muted = false, rate = 1, nextT = 0, step = 0, chord = 0, bassLvl = 0.2, playing = false;
  const tuned = [], voices = [], bassO = [];
  // D dorian-ish ring of warm ninth chords. b = bass note, n = pad voicing (MIDI).
  const CH = [
    { b: 38, n: [53, 57, 60, 64] },  // Dm9
    { b: 34, n: [50, 53, 57, 60] },  // B♭maj9
    { b: 41, n: [52, 55, 57, 60] },  // Fmaj9
    { b: 36, n: [52, 55, 57, 62] },  // C6/9
    { b: 43, n: [53, 57, 58, 62] },  // Gm9
    { b: 33, n: [52, 55, 60, 64] },  // Am7
  ];
  const PAT = [1, .5, .72, .5, .9, .5, .72, .62];
  const hz = m => 440 * Math.pow(2, (m - 69) / 12);

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    const now = ctx.currentTime;
    master = ctx.createGain(); master.gain.value = muted ? 0 : 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -15; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.22;
    tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 18000; tone.Q.value = 0.4;
    bus = ctx.createGain();
    bus.connect(tone); tone.connect(comp); comp.connect(master); master.connect(ctx.destination);

    // shared noise
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    // generated reverb
    const len = (ctx.sampleRate * 2.8) | 0, ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.8);
    }
    const conv = ctx.createConvolver(); conv.buffer = ir;
    revIn = ctx.createGain();
    const revOut = ctx.createGain(); revOut.gain.value = 0.42;
    revIn.connect(conv); conv.connect(revOut); revOut.connect(bus);

    // ambient pad: 4 voices × 2 detuned saws → breathing low-pass → reverb
    padF = ctx.createBiquadFilter(); padF.type = 'lowpass'; padF.frequency.value = 620; padF.Q.value = 0.9;
    const padG = ctx.createGain(); padG.gain.value = 0; padG.gain.setTargetAtTime(0.85, now, 1.6);
    const send = ctx.createGain(); send.gain.value = 0.8;
    padF.connect(padG); padG.connect(bus); padG.connect(send); send.connect(revIn);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.08;
    const lfoG = ctx.createGain(); lfoG.gain.value = 210;
    lfo.connect(lfoG); lfoG.connect(padF.frequency); lfo.start();
    CH[0].n.forEach((m, i) => {
      const g = ctx.createGain(); g.gain.value = 0.05;
      const pan = ctx.createStereoPanner(); pan.pan.value = (i - 1.5) * 0.42;
      g.connect(pan); pan.connect(padF);
      const os = [-8, 7].map(dt => {
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        o.frequency.value = hz(m); o.detune.value = dt; o.connect(g); o.start();
        tuned.push({ p: o.detune, b: dt });
        return o;
      });
      voices.push(os);
    });

    // pulsing sub-bass
    bassG = ctx.createGain(); bassG.gain.value = 0.0001;
    const bl = ctx.createBiquadFilter(); bl.type = 'lowpass'; bl.frequency.value = 240;
    bassG.connect(bl); bl.connect(bus);
    [['sine', 1, 1], ['triangle', 2, 0.2]].forEach(([type, mul, gv]) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = hz(CH[0].b) * mul;
      const g = ctx.createGain(); g.gain.value = gv;
      o.connect(g); g.connect(bassG); o.start();
      bassO.push({ o, mul }); tuned.push({ p: o.detune, b: 0 });
    });

    // wind
    const ws = ctx.createBufferSource(); ws.buffer = noiseBuf; ws.loop = true;
    windF = ctx.createBiquadFilter(); windF.type = 'bandpass'; windF.frequency.value = 380; windF.Q.value = 0.65;
    windG = ctx.createGain(); windG.gain.value = 0;
    ws.connect(windF); windF.connect(windG); windG.connect(bus); ws.start();

    nextT = now + 0.1;
    setInterval(schedule, 25);
  }

  function schedule() {
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (nextT < now) nextT = now + 0.02;
    while (nextT < now + 0.13) {
      const r = Math.max(0.4, rate), a = PAT[step % 8], lv = bassLvl * a, g = bassG.gain;
      g.cancelScheduledValues(nextT);
      g.setValueAtTime(Math.max(0.0001, lv * 0.14), nextT);
      g.linearRampToValueAtTime(lv, nextT + 0.02);
      g.exponentialRampToValueAtTime(Math.max(0.0001, lv * 0.18), nextT + 0.25 / r);
      if (playing && step % 2 === 1) burst(nextT, 0.045, 0.013, 'highpass', 7200, 0.5);
      step++;
      nextT += 0.288 / r;
    }
  }

  function osc(type, f0, f1, t, dur, peak, dest, att = 0.004) {
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + att);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest || bus);
    o.start(t); o.stop(t + dur + 0.05);
    return g;
  }
  function burst(t, dur, peak, type, f0, q, dest, f1, att) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    const fl = ctx.createBiquadFilter(); fl.type = type; fl.Q.value = q;
    fl.frequency.setValueAtTime(f0, t);
    if (f1) fl.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + (att || Math.min(0.012, dur * 0.3)));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(fl); fl.connect(g); g.connect(dest || bus);
    s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
    return g;
  }

  function setChord(i) {
    chord = ((i % CH.length) + CH.length) % CH.length;
    const c = CH[chord], t = ctx.currentTime;
    voices.forEach((os, k) => os.forEach(o => o.frequency.setTargetAtTime(hz(c.n[k]), t, 0.07)));
    bassO.forEach(b => b.o.frequency.setTargetAtTime(hz(c.b) * b.mul, t, 0.04));
    padF.frequency.cancelScheduledValues(t);
    padF.frequency.setTargetAtTime(2100, t, 0.03);
    padF.frequency.setTargetAtTime(620, t + 0.22, 0.7);
  }

  return {
    init,
    get ready() { return !!ctx; },
    get muted() { return muted; },
    toggleMute() {
      muted = !muted;
      if (ctx) master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.03);
      return muted;
    },
    suspend(on) { if (ctx) on ? ctx.suspend() : ctx.resume(); },
    setPlaying(on) { playing = on; bassLvl = on ? 0.6 : 0.2; },
    click() {
      if (!ctx) return; const t = ctx.currentTime;
      osc('sine', 2300, 1500, t, 0.05, 0.13);
      burst(t, 0.012, 0.09, 'highpass', 5000, 0.5);
    },
    hover() { if (!ctx) return; osc('sine', 3100, 2900, ctx.currentTime, 0.03, 0.035); },
    // gravity shift: air sweep + a plucked chord tone, and the harmony moves
    flip(dir) {
      if (!ctx) return; const t = ctx.currentTime;
      setChord(chord + dir);
      const c = CH[chord];
      burst(t, 0.42, 0.2, 'bandpass', dir > 0 ? 320 : 2600, 1.1, null, dir > 0 ? 2600 : 320, 0.09);
      const top = hz(c.n[3] + 12), fifth = hz(c.n[1] + 12);
      osc('triangle', top, top, t, 0.7, 0.085, revIn);
      osc('sine', fifth, fifth, t + 0.045, 0.6, 0.06, revIn);
      osc('sine', hz(c.b + 12) * 2, hz(c.b + 12), t, 0.16, 0.16);
    },
    land(v) {
      if (!ctx) return; const t = ctx.currentTime, k = clamp(v / 22, 0.15, 1);
      osc('sine', 130 + 50 * k, 42, t, 0.24, 0.6 * k);
      burst(t, 0.09, 0.22 * k, 'lowpass', 1300, 0.6);
      burst(t, 0.03, 0.06 * k, 'highpass', 3800, 0.5);
    },
    hit() {
      if (!ctx) return; const t = ctx.currentTime;
      osc('square', 190, 60, t, 0.09, 0.2);
      burst(t, 0.05, 0.3, 'highpass', 2400, 0.5);
    },
    shatter() {
      if (!ctx) return; const t = ctx.currentTime;
      osc('sine', 110, 34, t, 0.42, 0.7);
      burst(t, 0.4, 0.34, 'highpass', 2100, 0.4);
      burst(t, 0.5, 0.12, 'bandpass', 900, 0.8, revIn);
      for (let i = 0; i < 9; i++) {
        const f = 1700 + Math.random() * 4200, tt = t + Math.random() * 0.13;
        osc('sine', f, f * 0.985, tt, 0.1 + Math.random() * 0.24, 0.05, i % 2 ? revIn : bus);
      }
    },
    respawn() {
      if (!ctx) return; const t = ctx.currentTime;
      osc('sine', 300, 900, t, 0.16, 0.09);
      burst(t, 0.2, 0.07, 'bandpass', 600, 1.2, null, 3000, 0.08);
    },
    checkpoint() {
      if (!ctx) return; const t = ctx.currentTime, c = CH[chord];
      osc('triangle', hz(c.n[1] + 12), hz(c.n[1] + 12), t, 0.5, 0.09, revIn);
      osc('triangle', hz(c.n[3] + 12), hz(c.n[3] + 12), t + 0.09, 0.7, 0.09, revIn);
    },
    stage() {
      if (!ctx) return; const t = ctx.currentTime, c = CH[chord];
      osc('sine', 82, 38, t, 0.9, 0.55);
      burst(t, 1.1, 0.1, 'bandpass', 300, 0.9, revIn, 4200, 0.6);
      c.n.forEach((m, i) => osc('triangle', hz(m + 12), hz(m + 12), t + i * 0.07, 1.1, 0.05, revIn));
    },
    // bullet-time: the whole mix sinks in pitch and brightness
    setRate(r) {
      if (!ctx || Math.abs(r - rate) < 0.004) return;
      rate = r;
      const t = ctx.currentTime, k = clamp((r - 0.3) / 0.7, 0, 1);
      tone.frequency.setTargetAtTime(620 * Math.pow(29, k), t, 0.03);
      const cents = 1200 * Math.log2(lerp(0.74, 1, k));
      for (const u of tuned) u.p.setTargetAtTime(u.b + cents, t, 0.03);
    },
    focus(on) {
      if (!ctx) return; const t = ctx.currentTime;
      on ? osc('sine', 760, 190, t, 0.3, 0.1) : osc('sine', 240, 820, t, 0.2, 0.07);
    },
    wind(speedN, air) {
      if (!ctx) return; const t = ctx.currentTime;
      windF.frequency.setTargetAtTime(280 + speedN * 1300 + air * 520, t, 0.12);
      windG.gain.setTargetAtTime(speedN * (0.05 + speedN * 0.085) + air * 0.045, t, 0.12);
    },
  };
})();

/* ═══ 03  RENDERER · POST · LIGHT · SKY · MATERIALS ═════════════════════ */

const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
let PR = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(PR);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NoToneMapping;        // exact, poster-flat palette
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(HORIZON, 70, 310);
const camera = new THREE.PerspectiveCamera(64, innerWidth / innerHeight, 0.1, 1400);

const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth * PR, innerHeight * PR, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.42, 0.88);
// Chroma-keyed high-pass: only saturated light (the sphere, the trims) blooms,
// so sunlit travertine stays crisp instead of hazing out.
bloom.materialHighPassFilter.fragmentShader = /* glsl */`
  uniform sampler2D tDiffuse; uniform vec3 defaultColor; uniform float defaultOpacity;
  uniform float luminosityThreshold; uniform float smoothWidth; varying vec2 vUv;
  void main() {
    vec4 texel = texture2D(tDiffuse, vUv);
    float hi = max(texel.r, max(texel.g, texel.b)), lo = min(texel.r, min(texel.g, texel.b));
    float v = hi - lo * 0.9;
    float a = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, v);
    gl_FragColor = mix(vec4(defaultColor, defaultOpacity), texel, a);
  }`;
bloom.materialHighPassFilter.needsUpdate = true;
bloom.highPassUniforms.smoothWidth.value = 0.12;
composer.addPass(bloom);
composer.addPass(new OutputPass());

/* light — the sun rides the gravity frame, so shadows sweep when the world turns */
const SUN_BASE = new THREE.Vector3(-0.55, 0.75, 0.4).normalize();
const sun = new THREE.DirectionalLight(0xFFF1DE, 2.25);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const SHADOW_HALF = 58;
Object.assign(sun.shadow.camera, { left: -SHADOW_HALF, right: SHADOW_HALF, top: SHADOW_HALF, bottom: -SHADOW_HALF, near: 1, far: 260 });
sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.045;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xE3ECF4, 0xD2C2A8, 1.5);
scene.add(hemi);

/* sky dome — rolls with the camera so the horizon never tilts */
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(1000, 32, 20),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(0xA4BCCF) }, mid: { value: new THREE.Color(HORIZON) },
      low: { value: new THREE.Color(0xD3C4AD) }, sunDir: { value: SUN_BASE }, sunCol: { value: new THREE.Color(0xFFF4E2) },
    },
    vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 top, mid, low, sunDir, sunCol; varying vec3 vD;
      void main(){
        vec3 d = normalize(vD);
        vec3 c = mix(mid, top, smoothstep(0.02, 0.75, d.y));
        c = mix(c, low, smoothstep(-0.02, -0.7, d.y));
        float s = max(dot(d, sunDir), 0.0);
        c += sunCol * (pow(s, 240.0) * 0.6 + pow(s, 10.0) * 0.1);
        gl_FragColor = vec4(c, 1.0);
      }`,
  }));
sky.renderOrder = -10; sky.frustumCulled = false;
scene.add(sky);

/* procedural textures */
function makeTravertine() {
  const S = 1024, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), r = rng(7);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 28; i++) {                       // tonal clouds, wrapped
    const x = r() * S, y = r() * S, rad = 90 + r() * 230, a = 0.03 + r() * 0.05, tint = r() > 0.5 ? '150,128,98' : '122,118,110';
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      const cx = x + ox, cy = y + oy;
      if (cx + rad < 0 || cx - rad > S || cy + rad < 0 || cy - rad > S) continue;
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
      gr.addColorStop(0, `rgba(${tint},${a})`); gr.addColorStop(1, `rgba(${tint},0)`);
      g.fillStyle = gr; g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    }
  }
  for (let i = 0; i < 170; i++) {                      // sedimentary striations
    const y = r() * S, h = 0.6 + r() * 2.6, amp = r() * 5, per = 1 + ((r() * 3) | 0), ph = r() * TAU;
    g.fillStyle = `rgba(${(128 + r() * 40) | 0},${(108 + r() * 36) | 0},${(80 + r() * 30) | 0},${0.025 + r() * 0.075})`;
    g.beginPath();
    for (let x = 0; x <= S; x += 16) { const yy = y + Math.sin(x / S * TAU * per + ph) * amp; x ? g.lineTo(x, yy) : g.moveTo(x, yy); }
    for (let x = S; x >= 0; x -= 16) g.lineTo(x, y + h + Math.sin(x / S * TAU * per + ph) * amp);
    g.closePath(); g.fill();
  }
  for (let i = 0; i < 1700; i++) {                     // pores
    const x = 10 + r() * (S - 20), y = 10 + r() * (S - 20);
    g.fillStyle = `rgba(96,82,62,${0.1 + r() * 0.36})`;
    g.beginPath(); g.ellipse(x, y, 1 + r() * r() * 9, 0.6 + r() * 1.7, 0, 0, TAU); g.fill();
  }
  const id = g.getImageData(0, 0, S, S), d = id.data;  // grain
  for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 10; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(id, 0, 0);
  for (const y of [0, S / 2]) {                        // formwork joints + tie holes
    g.fillStyle = 'rgba(58,50,40,.30)'; g.fillRect(0, y, S, 2.5);
    g.fillStyle = 'rgba(255,255,255,.5)'; g.fillRect(0, y + 2.5, S, 1.5);
    for (const x of [S * 0.125, S * 0.375, S * 0.625, S * 0.875]) {
      g.fillStyle = 'rgba(58,50,40,.34)'; g.beginPath(); g.arc(x, y + S * 0.07, 6, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255,255,255,.4)'; g.beginPath(); g.arc(x, y + S * 0.07 + 2.5, 6, 0.25, Math.PI - 0.25); g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
function makeBallTex() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 512, 256);
  g.fillStyle = '#4a4a4a';
  g.fillRect(0, 122, 512, 12); g.fillRect(0, 0, 6, 256); g.fillRect(506, 0, 6, 256); g.fillRect(250, 0, 12, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
function makeGlowTex() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,.55)');
  gr.addColorStop(0.6, 'rgba(255,255,255,.12)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

const UVS = 1 / 8;                                    // one texture tile = 8 m
const travTex = makeTravertine(), ballTex = makeBallTex(), glowTex = makeGlowTex();
const accent = new THREE.Color(PALETTE[0]), accentT = new THREE.Color(PALETTE[0]);
const MAT = {
  trav: new THREE.MeshStandardMaterial({ color: PAPER, map: travTex, bumpMap: travTex, bumpScale: 0.5, roughness: 0.94, metalness: 0 }),
  obs: new THREE.MeshStandardMaterial({ color: INK, roughness: 0.5, metalness: 0.05 }),
  acc: new THREE.MeshBasicMaterial({ color: PALETTE[0], polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  far: new THREE.MeshStandardMaterial({ color: PAPER, roughness: 0.96, metalness: 0 }),
};

/* ═══ 04  GEOMETRY BUFFERS & WORLD BUILDER ══════════════════════════════ */

class GeoBuf {
  constructor() { this.p = []; this.n = []; this.u = []; this.i = []; this.c = 0; }
  vert(q, n) {
    const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
    let u, v;                                          // world-space UVs: seamless across abutting solids
    if (az >= ax && az >= ay) { u = q[0] * UVS; v = q[1] * UVS; }
    else if (ax >= ay) { u = q[1] * UVS + 0.5; v = q[2] * UVS; }
    else { u = q[0] * UVS + 0.5; v = q[2] * UVS; }
    this.p.push(q[0], q[1], q[2]); this.n.push(n[0], n[1], n[2]); this.u.push(u, v);
    return this.c++;
  }
  tri(a, b, c, n) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const f = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2] < 0;
    const i0 = this.vert(a, n), i1 = this.vert(b, n), i2 = this.vert(c, n);
    f ? this.i.push(i0, i2, i1) : this.i.push(i0, i1, i2);
  }
  quad(a, b, c, d, n) { this.tri(a, b, c, n); this.tri(a, c, d, n); }
  box(x0, x1, y0, y1, z0, z1) {
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]);
    this.quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [-1, 0, 0]);
    this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0]);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1]);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

const W = { chunks: [], boxes: [], hints: [], cps: [], stages: [], gen: null, rnd: null };
let C = null;                                          // chunk under construction

function beginChunk() {
  C = { trav: new GeoBuf(), obs: new GeoBuf(), acc: new GeoBuf(), boxes: [], movers: [], group: new THREE.Group(), d1: -1e9 };
}
function endChunk() {
  const add = (buf, mat, shadow) => {
    if (!buf.c) return;
    const m = new THREE.Mesh(buf.build(), mat);
    m.castShadow = m.receiveShadow = shadow;
    C.group.add(m);
  };
  add(C.trav, MAT.trav, true); add(C.obs, MAT.obs, true); add(C.acc, MAT.acc, false);
  scene.add(C.group);
  W.chunks.push(C);
  for (const b of C.boxes) W.boxes.push(b);
  C = null;
}
function removeChunk(c) {
  scene.remove(c.group);
  c.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
}
function clearWorld() {
  for (const c of W.chunks) removeChunk(c);
  W.chunks = []; W.boxes = []; W.hints = []; W.cps = []; W.stages = [];
}

/* Frame space: side s, lateral a, height h above the running surface, distance d. */
function P(s, a, h, d) { const f = FR[s]; return [f.rx * a + f.dx * (TUBE - h), f.ry * a + f.dy * (TUBE - h), -d]; }
function fbox(s, a0, a1, h0, h1, d0, d1) {
  const A = P(s, a0, h0, d0), B = P(s, a1, h1, d1);
  return { x0: Math.min(A[0], B[0]), x1: Math.max(A[0], B[0]), y0: Math.min(A[1], B[1]), y1: Math.max(A[1], B[1]), z0: Math.min(A[2], B[2]), z1: Math.max(A[2], B[2]), haz: false, mv: null };
}
function solid(s, a0, a1, h0, h1, d0, d1, o = {}) {
  const b = fbox(s, a0, a1, h0, h1, d0, d1);
  b.haz = !!o.haz;
  (o.haz ? C.obs : C.trav).box(b.x0, b.x1, b.y0, b.y1, b.z0, b.z1);
  if (o.collide !== false) { C.boxes.push(b); C.d1 = Math.max(C.d1, d1); }
  return b;
}
const collider = (s, a0, a1, h0, h1, d0, d1) => C.boxes.push(fbox(s, a0, a1, h0, h1, d0, d1));
const slab = (s, d0, d1, a0 = -4, a1 = 4) => solid(s, a0, a1, -1, 0, d0, d1);
const haz = (s, d0, d1, a0, a1, h = 2.6) => solid(s, a0, a1, 0, h, d0, d1, { haz: true });
const catcher = (s, a0, a1, d0, d1) => solid(s, a0, a1, -11, -8.6, d0, d1, { collide: false });

function accBox(s, a0, a1, h0, h1, d0, d1) { const b = fbox(s, a0, a1, h0, h1, d0, d1); C.acc.box(b.x0, b.x1, b.y0, b.y1, b.z0, b.z1); }
function flatPoly(s, pts, h = 0.035) {
  const f = FR[s], n = [-f.dx, -f.dy, 0], q = pts.map(p => P(s, p[0], h, p[1]));
  for (let i = 1; i < q.length - 1; i++) C.acc.tri(q[0], q[i], q[i + 1], n);
}
const flatRect = (s, a0, a1, d0, d1) => flatPoly(s, [[a0, d0], [a1, d0], [a1, d1], [a0, d1]]);
const edgeTrim = (s, d, a0 = -4, a1 = 4) => flatRect(s, a0, a1, d - 0.34, d - 0.1);

/* convex prism in frame space (travertine), used for arrow heads */
function prism(s, pts, h0, h1) {
  const f = FR[s], up = [-f.dx, -f.dy, 0], dn = [f.dx, f.dy, 0];
  const top = pts.map(p => P(s, p[0], h1, p[1])), bot = pts.map(p => P(s, p[0], h0, p[1]));
  let ca = 0, cd = 0; for (const p of pts) { ca += p[0] / pts.length; cd += p[1] / pts.length; }
  for (let i = 1; i < pts.length - 1; i++) { C.trav.tri(top[0], top[i], top[i + 1], up); C.trav.tri(bot[0], bot[i], bot[i + 1], dn); }
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    let na = pts[j][1] - pts[i][1], nd = -(pts[j][0] - pts[i][0]);
    if (na * ((pts[i][0] + pts[j][0]) / 2 - ca) + nd * ((pts[i][1] + pts[j][1]) / 2 - cd) < 0) { na = -na; nd = -nd; }
    const l = Math.hypot(na, nd);
    C.trav.quad(bot[i], bot[j], top[j], top[i], [f.rx * na / l, f.ry * na / l, -nd / l]);
  }
}

/* moving architectural block */
function mover(s, a0, a1, h0, h1, d0, d1, o) {
  const b = fbox(s, a0, a1, h0, h1, d0, d1), f = FR[s];
  b.haz = !!o.haz;
  b.mv = { ux: f.rx, uy: f.ry, amp: o.amp, w: TAU / o.per, ph: o.ph * TAU };
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, cz = (b.z0 + b.z1) / 2;
  const g = new GeoBuf(); g.box(b.x0 - cx, b.x1 - cx, b.y0 - cy, b.y1 - cy, b.z0 - cz, b.z1 - cz);
  const mesh = new THREE.Mesh(g.build(), o.haz ? MAT.obs : MAT.trav);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.position.set(cx, cy, cz);
  const t = new GeoBuf();
  const tb = (q) => t.box(q.x0 - cx, q.x1 - cx, q.y0 - cy, q.y1 - cy, q.z0 - cz, q.z1 - cz);
  if (o.haz) tb(fbox(s, a0 - 0.03, a1 + 0.03, h1 - 0.5, h1 - 0.36, d0 - 0.03, d1 + 0.03));   // signal band
  else { tb(fbox(s, a0, a0 + 0.14, h1, h1 + 0.03, d0, d1)); tb(fbox(s, a1 - 0.14, a1, h1, h1 + 0.03, d0, d1)); }
  mesh.add(new THREE.Mesh(t.build(), MAT.acc));
  mesh.userData = { b, cx, cy };
  C.group.add(mesh); C.movers.push(mesh); C.boxes.push(b);
  C.d1 = Math.max(C.d1, d1);
}

/* typography — numerals are built from solid strokes on a 3×5 module grid */
const GLYPH = {
  0: [[0, 0, 1, 5], [2, 0, 1, 5], [1, 0, 1, 1], [1, 4, 1, 1]],
  1: [[1, 0, 1, 5], [0, 3, 1, 1]],
  2: [[0, 4, 3, 1], [2, 3, 1, 1], [0, 2, 3, 1], [0, 1, 1, 1], [0, 0, 3, 1]],
  3: [[2, 0, 1, 5], [0, 4, 2, 1], [0, 2, 2, 1], [0, 0, 2, 1]],
  4: [[2, 0, 1, 5], [0, 2, 1, 3], [1, 2, 1, 1]],
  5: [[0, 4, 3, 1], [0, 3, 1, 1], [0, 2, 3, 1], [2, 1, 1, 1], [0, 0, 3, 1]],
  6: [[0, 0, 1, 5], [1, 4, 2, 1], [1, 2, 2, 1], [1, 0, 2, 1], [2, 1, 1, 1]],
  7: [[2, 0, 1, 5], [0, 4, 2, 1]],
  8: [[0, 0, 1, 5], [2, 0, 1, 5], [1, 0, 1, 1], [1, 2, 1, 1], [1, 4, 1, 1]],
  9: [[2, 0, 1, 5], [0, 4, 2, 1], [0, 3, 1, 1], [0, 2, 2, 1], [0, 0, 2, 1]],
};
const FULL_COL = { 0: 2, 1: 1, 3: 2, 4: 2, 6: 0, 7: 2, 8: 2, 9: 2 };   // a stroke that spans the glyph = a straight bridge
const CW = 2.4, CL = 5.5;                              // flat numerals are stretched like runway markings

/* numerals lying flat: every stroke is a runnable bridge */
function digitsFlat(s, str, d0, aL) {
  [...str].forEach((ch, i) => {
    const ox = aL + i * 4 * CW;
    for (const [x, y, w, h] of GLYPH[ch]) solid(s, ox + x * CW, ox + (x + w) * CW, -1, 0, d0 + y * CL, d0 + (y + h) * CL);
  });
  return d0 + 5 * CL;
}
/* numerals standing in relief on a monolith face, purely architectural */
function digitsStanding(s, str, aL, hB, d, cell, depth) {
  [...str].forEach((ch, i) => {
    const ox = aL + i * 4 * cell;
    for (const [x, y, w, h] of GLYPH[ch]) solid(s, ox + x * cell, ox + (x + w) * cell, hB + y * cell, hB + (y + h) * cell, d - depth, d, { collide: false });
  });
}
function monolith(s, str, d) {
  solid(s, -37, -11, -46, 27, d, d + 5, { collide: false });
  digitsStanding(s, str, -34.5, 5.5, d, 3, 1.3);
  accBox(s, -12.5, -12.25, -46, 27, d - 0.05, d);
  accBox(s, -34.5, -13.5, 3.6, 3.78, d - 0.05, d);
}
/* square gate around the whole tube — reads the same from every gravity */
function portal(d, inner = 10, outer = 12.5, depth = 2.4) {
  const z1 = -d, z0 = -d - depth, T = C.trav;
  T.box(-outer, outer, inner, outer, z0, z1); T.box(-outer, outer, -outer, -inner, z0, z1);
  T.box(-outer, -inner, -inner, inner, z0, z1); T.box(inner, outer, -inner, inner, z0, z1);
  const e = inner + 0.5, w = 0.12, A = C.acc, za = z1, zb = z1 + 0.05;
  A.box(-e, e, e - w, e, za, zb); A.box(-e, e, -e, -e + w, za, zb); A.box(-e, -e + w, -e, e, za, zb); A.box(e - w, e, -e, e, za, zb);
}
function checkpoint(s, d, a = 0) {
  W.cps.push({ d, side: s, a });
  flatRect(s, -4, 4, d - 0.14, d + 0.14);
  flatRect(s, -4, -3.2, d + 0.5, d + 0.7); flatRect(s, 3.2, 4, d + 0.5, d + 0.7);
}

/* inlaid directional arrows; also registered as the "solution" for the autopilot */
function arrowInlay(s, dc, ac, dir, k) {
  const L = 1.6 * k;
  flatPoly(s, [[ac - L * dir, dc - 0.5 * k], [ac + 0.25 * L * dir, dc - 0.5 * k], [ac + 0.25 * L * dir, dc + 0.5 * k], [ac - L * dir, dc + 0.5 * k]]);
  flatPoly(s, [[ac + 0.25 * L * dir, dc - 1.6 * k], [ac + L * dir, dc], [ac + 0.25 * L * dir, dc + 1.6 * k]]);
}
function hint(s, d, dir, n = 1) {
  W.hints.push({ d, dir, n });
  if (n === 1) arrowInlay(s, d - 5, 0, dir, 1);
  else { arrowInlay(s, d - 5, -1.8, dir, 0.85); arrowInlay(s, d - 5, 1.8, dir, 0.85); }
}
/* extruded arrow jutting from the track edge: "the world turns this way" */
function pointer(s, dEdge, dir) {
  prism(s, [[dir * 4, dEdge - 9], [dir * 4, dEdge - 1], [dir * 8, dEdge - 5]], -1, 0);
  for (let i = 0; i < 4; i++) {
    const hw = 4 * (1 - (i + 0.5) / 4), a0 = dir * (4 + i), a1 = dir * (5 + i);
    collider(s, Math.min(a0, a1), Math.max(a0, a1), -1, 0, dEdge - 5 - hw, dEdge - 5 + hw);
  }
}
/* extruded forward arrow spanning a gap: follow the shaft, leave by the tip */
function arrowBridge(s, d0, d1, ac) {
  const dh = d1 - 7.5, N = 6;
  solid(s, ac - 1.2, ac + 1.2, -1, 0, d0, dh);
  prism(s, [[ac - 3.3, dh], [ac + 3.3, dh], [ac, d1]], -1, 0);
  for (let i = 0; i < N; i++) {
    const hw = Math.max(0.6, 3.3 * (1 - (i + 0.5) / N));
    collider(s, ac - hw, ac + hw, -1, 0, dh + (d1 - dh) * i / N, dh + (d1 - dh) * (i + 1) / N);
  }
  flatRect(s, ac - 0.07, ac + 0.07, d0 + 0.6, d1 - 1.5);
}

/* ═══ 05  HAND-CRAFTED STAGES ═══════════════════════════════════════════ */

const SWEEP = (s, d, per, ph, amp = 2.5) => mover(s, -1.5, 1.5, 0, 2.6, d, d + 2, { haz: true, amp, per, ph });
const SLIDER = (s, d0, d1, per, ph) => mover(s, -2.4, 2.4, -1, 0, d0, d1, { haz: false, amp: 1.6, per, ph });

/* 01 — THRESHOLD: steering, then wall-running with long overlaps, ending in a full barrel roll */
function buildStage1() {
  beginChunk();
  slab(0, -14, 20, -14.4, 4.8);
  digitsFlat(0, '01', 20, -13.2);                      // the stem of the 1 is the centre line
  catcher(0, -15, 14, 18, 57);
  slab(0, 47.5, 66, -14.4, 4.8);
  slab(0, 66, 112);
  portal(72); monolith(0, '01', 86);
  haz(0, 88, 90, -4, 0.4); haz(0, 102, 104, -0.4, 4);
  arrowBridge(0, 112, 130, 0); catcher(0, -6, 12, 110, 139);
  slab(0, 130, 176); portal(134); checkpoint(0, 136);
  slab(1, 152, 224, -5, 4); hint(0, 166, 1);
  haz(1, 196, 198, -5, -0.6);
  slab(0, 206, 272, -4, 5); hint(1, 214, -1);
  portal(230); checkpoint(0, 232);
  haz(0, 250, 252, -4, -1.7); haz(0, 250, 252, 1.7, 5);
  slab(3, 256, 312, -4, 5); hint(0, 262, -1);
  slab(2, 296, 346, -4, 5); hint(3, 302, -1);
  slab(1, 330, 380, -4, 5); hint(2, 336, -1);
  slab(0, 364, 398, -4, 5); hint(1, 370, -1);
  endChunk();
}

/* 02 — FREEFALL: the surfaces stop overlapping; every shift happens in the air */
function buildStage2() {
  beginChunk();
  portal(390); checkpoint(0, 392);
  slab(0, 398, 418, -7.2, 12);
  digitsFlat(0, '02', 418, -6);                        // right stroke of the 0 is the centre line; the 2 is the scenic route
  catcher(0, -8, 20, 416, 455);
  slab(0, 445.5, 462, -7.2, 12);
  slab(0, 462, 500);
  portal(466); checkpoint(0, 468); monolith(0, '02', 482);
  pointer(0, 500, 1); hint(0, 499.5, 1); edgeTrim(0, 500);
  slab(1, 502, 556, -8, 4);
  pointer(1, 556, 1); hint(1, 555.5, 1); edgeTrim(1, 556);
  slab(2, 558, 612, -8, 4); portal(570); checkpoint(2, 572);
  hint(2, 610.5, 1, 2); edgeTrim(2, 612);
  slab(0, 617, 676); haz(0, 650, 652, -1.5, 1.5, 4.2);
  pointer(0, 676, -1); hint(0, 675.5, -1); edgeTrim(0, 676);
  slab(3, 678, 736, -4, 8); portal(690); checkpoint(3, 692, -1.5);
  haz(3, 716, 718, 1.4, 8);
  hint(3, 734.5, -1, 2); edgeTrim(3, 736);
  slab(1, 741, 800);
  haz(1, 772, 774, -4, -1.7); haz(1, 772, 774, 1.7, 4);
  hint(1, 796, -1);
  endChunk();
}

/* 03 — KINETIC: the architecture itself starts to move */
function buildStage3() {
  beginChunk();
  slab(0, 790, 850, -4, 5);
  portal(832); checkpoint(0, 834);
  slab(0, 850, 868, -9.6, 9.6);
  digitsFlat(0, '03', 868, -8.4);                      // no centre line: commit left (0) or right (3)
  catcher(0, -10, 18, 866, 905);
  slab(0, 895.5, 914, -9.6, 9.6);
  slab(0, 914, 990);
  portal(920); checkpoint(0, 922); monolith(0, '03', 936);
  SWEEP(0, 948, 2.6, 0); SWEEP(0, 968, 2.2, 0.4);
  edgeTrim(0, 990); SLIDER(0, 990, 1010, 3.2, 0.1); catcher(0, -6, 12, 988, 1019);
  slab(0, 1010, 1050); portal(1014); checkpoint(0, 1016);
  pointer(0, 1050, 1); hint(0, 1049.5, 1); edgeTrim(0, 1050);
  slab(1, 1052, 1120, -8, 4);
  SWEEP(1, 1084, 2.4, 0.2);
  haz(1, 1104, 1106, -8, -1.7); haz(1, 1104, 1106, 1.7, 4);
  pointer(1, 1120, 1); hint(1, 1119.5, 1); edgeTrim(1, 1120);
  slab(2, 1122, 1150, -8, 4); portal(1132); checkpoint(2, 1134);
  edgeTrim(2, 1150); SLIDER(2, 1150, 1170, 2.8, 0.6);
  slab(2, 1170, 1202);
  hint(2, 1200.5, 1, 2); edgeTrim(2, 1202);
  slab(0, 1207.5, INF0); portal(1214); checkpoint(0, 1216);
  SWEEP(0, 1236, 2.4, 0); SWEEP(0, 1254, 2.4, 0.33); SWEEP(0, 1272, 2.4, 0.66);
  endChunk();
}

const STAGES = [
  { d: -1e9, num: '01', name: 'THRESHOLD', sub: 'WALL-RUNNING', speed: 15, accent: 0 },
  { d: 390, num: '02', name: 'FREEFALL', sub: 'MID-AIR SHIFTS', speed: 17, accent: 0 },
  { d: 830, num: '03', name: 'KINETIC', sub: 'MOVING ARCHITECTURE', speed: 19, accent: 0 },
];
const PROMPTS = [
  [2, 44, '<b>A</b> / <b>D</b> &nbsp;·&nbsp; STEER'],
  [140, 176, '<b>E</b> &nbsp;·&nbsp; SHIFT GRAVITY RIGHT'],
  [200, 222, '<b>Q</b> &nbsp;·&nbsp; SHIFT GRAVITY LEFT'],
  [282, 326, 'HOLD <b>SHIFT</b> &nbsp;·&nbsp; FOCUS'],
  [484, 502, 'SHIFT IN <b>MID-AIR</b>'],
  [596, 613, '<b>E E</b> &nbsp;·&nbsp; DOUBLE SHIFT'],
];

function stageAt(d) { const S = W.stages; for (let i = S.length - 1; i > 0; i--) if (d >= S[i].d) return S[i]; return S[0]; }
const speedAt = d => stageAt(d).speed;

function buildWorld() {
  clearWorld();
  W.rnd = rng(20261116);
  W.cps.push({ d: 0, side: 0, a: 0 });
  W.stages = STAGES.slice();
  buildStage1(); buildStage2(); buildStage3();
  W.gen = { d: INF0, side: 0, zone: 3, lastCp: 1216, last: '' };
}

/* ═══ 06  INFINITE PROCEDURAL GENERATOR ═════════════════════════════════
   Every pattern is built from the same vocabulary as the hand-made stages,
   with gaps scaled to the zone speed so reaction windows stay constant.   */

const zoneSpeed = z => Math.min(33, 21 + 2 * (z - 4));

function genZoneGate(g, z) {
  const s = g.side, v = zoneSpeed(z), str = String(z).padStart(2, '0');
  let d = g.d;
  W.stages.push({ d, num: str, name: 'CONTINUUM', sub: `ZONE ${str} · ${v} M/S`, speed: v, accent: (z - 3) % PALETTE.length });
  let idx = [...str].findIndex(ch => ch in FULL_COL);
  const lead = Math.round(v * 0.9), land = Math.round(v * 0.9), tail = Math.round(v * 1.6);
  if (idx < 0) {                                       // e.g. "22": no straight stroke, bridge with an arrow instead
    slab(s, d, d + lead); arrowBridge(s, d + lead, d + lead + 26, 0); catcher(s, -6, 12, d + lead - 2, d + lead + 34);
    d += lead + 26;
  } else {
    const aL = -(idx * 4 * CW + (FULL_COL[str[idx]] + 0.5) * CW), wide = str.length * 3 * CW + (str.length - 1) * CW;
    const a0 = Math.min(-4, aL - 1.2), a1 = Math.max(4, aL + wide + 1.2);
    slab(s, d, d + lead, a0, a1); d += lead;
    const de = digitsFlat(s, str, d, aL);
    catcher(s, a0 - 1, a1 + 8, d - 2, de + 9);
    slab(s, de, de + land, a0, a1); d = de + land;
  }
  slab(s, d, d + tail);
  portal(d + 4); checkpoint(s, d + 6); monolith(s, str, d + 20);
  g.lastCp = d + 6; g.d = d + tail; g.last = 'zone';
}

function genRun(g, v, r) {
  const s = g.side, d = g.d, len = Math.round(v * (2.3 + r() * 0.8));
  slab(s, d, d + len);
  let od = d + v * 0.95;
  if (d - g.lastCp > 115) { portal(d + 3); checkpoint(s, d + 5); g.lastCp = d + 5; od = d + 5 + v * 1.15; }
  while (od < d + len - v * 0.55) {
    const t = (r() * 4) | 0, dep = 1.6 + r() * 1.2, hh = 2.2 + r() * 2.4;
    if (t === 0) haz(s, od, od + dep, -4, -0.5, hh);
    else if (t === 1) haz(s, od, od + dep, 0.5, 4, hh);
    else if (t === 2) haz(s, od, od + dep, -1.5, 1.5, hh + 1.5);
    else { haz(s, od, od + dep, -4, -1.7, hh); haz(s, od, od + dep, 1.7, 4, hh); }
    od += v * (1.0 + r() * 0.5);
  }
  g.d = d + len; g.last = 'run';
}
function genSweep(g, v, r) {
  const s = g.side, d = g.d, len = Math.round(v * 2.7);
  slab(s, d, d + len);
  SWEEP(s, d + v * 1.0, 2.1 + r() * 0.9, r());
  if (r() > 0.35) SWEEP(s, d + v * 1.95, 2.1 + r() * 0.9, r());
  g.d = d + len; g.last = 'sweep';
}
function genTurn(g, v, r) {
  const s = g.side, d = g.d, dir = r() > 0.5 ? 1 : -1, edge = d + Math.round(v * 0.9);
  slab(s, d, edge);
  pointer(s, edge, dir); hint(s, edge - 0.5, dir); edgeTrim(s, edge);
  const s2 = mod4(s + dir), st = edge, len = Math.round(v * 2.0);
  slab(s2, st, st + len, dir > 0 ? -8 : -4, dir > 0 ? 4 : 8);
  g.side = s2; g.d = st + len; g.last = 'turn';
}
function genFlip(g, v, r) {
  const s = g.side, d = g.d, dir = r() > 0.5 ? 1 : -1, edge = d + Math.round(v * 0.9);
  slab(s, d, edge);
  hint(s, edge - 1.5, dir, 2); edgeTrim(s, edge);
  const s2 = mod4(s + 2), st = edge + v * 0.3, len = Math.round(v * 2.6);
  slab(s2, st, st + len);
  g.side = s2; g.d = st + len; g.last = 'flip';
}
function genBridge(g, v, r) {
  const s = g.side, d = g.d, e = d + Math.round(v * 0.7), gap = Math.round(v * 0.9) + 8, k = r();
  slab(s, d, e); edgeTrim(s, e);
  if (k < 0.4) arrowBridge(s, e, e + gap, [-2, 0, 2][(r() * 3) | 0]);
  else if (k < 0.7) { solid(s, -3.5, -1.3, -1, 0, e, e + gap); solid(s, 1.3, 3.5, -1, 0, e, e + gap); }
  else mover(s, -2.3, 2.3, -1, 0, e, e + gap, { haz: false, amp: 1.7, per: 2.8 + r(), ph: r() });
  catcher(s, -6, 12, e - 2, e + gap + 9);
  slab(s, e + gap, e + gap + Math.round(v * 0.8));
  g.d = e + gap + Math.round(v * 0.8); g.last = 'bridge';
}

function genNext() {
  const g = W.gen, r = W.rnd, z = 4 + Math.floor((g.d - INF0) / 1000);
  beginChunk();
  if (z > g.zone) { g.zone = z; genZoneGate(g, z); }
  else {
    const v = zoneSpeed(g.zone), aerial = g.last === 'turn' || g.last === 'flip';
    const opts = [[genRun, 3], [genSweep, 2], [genTurn, aerial ? 1.6 : 3], [genFlip, aerial ? 0.8 : 1.6], [genBridge, g.last === 'bridge' ? 0 : 1.6]];
    let pick = r() * opts.reduce((a, o) => a + o[1], 0), fn = genRun;
    for (const o of opts) { if ((pick -= o[1]) < 0) { fn = o[0]; break; } }
    fn(g, v, r);
  }
  endChunk();
}
function ensureGen(d, keepD) {
  while (W.gen.d < d + 360) genNext();
  const cut = keepD - 70;
  if (W.chunks.length && W.chunks[0].d1 < cut) {
    W.chunks = W.chunks.filter(c => { if (c.d1 < cut) { removeChunk(c); return false; } return true; });
    W.boxes = W.chunks.flatMap(c => c.boxes);
  }
}

/* ═══ 07  PHYSICS ═══════════════════════════════════════════════════════
   Sphere vs. axis-aligned boxes. State is a flat bag of numbers so the
   autopilot can clone it and roll futures forward.                        */

class Sim {
  constructor() {
    this.x = 0; this.y = 0; this.z = 0; this.vx = 0; this.vy = 0; this.vz = 0;
    this.gi = 0; this.t = 0; this.grounded = false; this.gb = null; this.air = 0;
    this.dead = null; this.land = 0; this.nx = 0; this.ny = 1; this.nz = 0;
    this.pad = 0;                                      // extra hazard clearance (autopilot look-ahead only)
  }
  clone() { return Object.assign(new Sim(), this); }
  get d() { return -this.z; }
  place(cp, speedK = 0.6) {
    const q = P(cp.side, cp.a, R, cp.d + 0.5);
    this.x = q[0]; this.y = q[1]; this.z = q[2];
    this.vx = this.vy = 0; this.vz = -speedAt(cp.d) * speedK;
    this.gi = cp.side; this.grounded = true; this.gb = null; this.air = 0; this.dead = null; this.land = 0;
  }
  flip(dir) { this.gi += dir; this.grounded = false; this.gb = null; }
  step(dt, ax, boxes) {
    this.land = 0;
    const f = FR[mod4(this.gi)];
    // forward: automatic, eased toward the stage speed
    this.vz += (-speedAt(-this.z) - this.vz) * (1 - Math.exp(-2.4 * dt));
    // lateral: snappy on the ground, softer in the air
    const vl = this.vx * f.rx + this.vy * f.ry;
    const dv = (ax * LAT - vl) * (1 - Math.exp(-(this.grounded ? 14 : 5.5) * dt));
    this.vx += f.rx * dv; this.vy += f.ry * dv;
    // gravity
    this.vx += f.dx * G * dt; this.vy += f.dy * G * dt;
    const vd = this.vx * f.dx + this.vy * f.dy;
    if (vd > VT) { this.vx -= f.dx * (vd - VT); this.vy -= f.dy * (vd - VT); }
    // ride moving platforms
    const t0 = this.t; this.t += dt;
    if (this.gb && this.gb.mv) {
      const m = this.gb.mv, o = m.amp * (Math.sin(m.w * this.t + m.ph) - Math.sin(m.w * t0 + m.ph));
      this.x += m.ux * o; this.y += m.uy * o;
    }
    this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;

    let grounded = false, gb = null, impact = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.z1 < this.z - R || b.z0 > this.z + R) continue;
        let ox = 0, oy = 0;
        if (b.mv) { const o = b.mv.amp * Math.sin(b.mv.w * this.t + b.mv.ph); ox = b.mv.ux * o; oy = b.mv.uy * o; }
        const x0 = b.x0 + ox, x1 = b.x1 + ox, y0 = b.y0 + oy, y1 = b.y1 + oy;
        const cx = clamp(this.x, x0, x1), cy = clamp(this.y, y0, y1), cz = clamp(this.z, b.z0, b.z1);
        const dx = this.x - cx, dy = this.y - cy, dz = this.z - cz, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= R * R) { if (b.haz && this.pad && d2 < (R + this.pad) * (R + this.pad)) { this.dead = 'hit'; return; } continue; }
        let nx, ny, nz, pen;
        if (d2 > 1e-10) { const dd = Math.sqrt(d2); nx = dx / dd; ny = dy / dd; nz = dz / dd; pen = R - dd; }
        else {                                         // centre inside the box: leave by the nearest face
          const e = [this.x - x0, x1 - this.x, this.y - y0, y1 - this.y, this.z - b.z0, b.z1 - this.z];
          let k = 0; for (let j = 1; j < 6; j++) if (e[j] < e[k]) k = j;
          nx = k === 0 ? -1 : k === 1 ? 1 : 0; ny = k === 2 ? -1 : k === 3 ? 1 : 0; nz = k === 4 ? -1 : k === 5 ? 1 : 0;
          pen = e[k] + R;
        }
        const vn = this.vx * nx + this.vy * ny + this.vz * nz;
        if (b.haz) { this.dead = 'hit'; this.nx = nx; this.ny = ny; this.nz = nz; return; }
        if (nz > 0.8 && vn < -7) { this.dead = 'front'; this.nx = nx; this.ny = ny; this.nz = nz; return; }
        this.x += nx * pen; this.y += ny * pen; this.z += nz * pen;
        if (vn < 0) { this.vx -= nx * vn; this.vy -= ny * vn; this.vz -= nz * vn; }
        if (-(nx * f.dx + ny * f.dy) > 0.5) {
          grounded = true; gb = b;
          if (-vn > impact) { impact = -vn; this.nx = nx; this.ny = ny; this.nz = nz; }
        }
      }
    }
    if (grounded) { if (this.air > 0.09 && impact > 3) this.land = impact; this.air = 0; }
    else this.air += dt;
    this.grounded = grounded; this.gb = gb;
    if (this.x * f.dx + this.y * f.dy > TUBE + 6.5 || Math.abs(this.x) > 26 || Math.abs(this.y) > 26) {
      this.dead = 'void'; this.nx = -f.dx; this.ny = -f.dy; this.nz = 0;
    }
  }
}

/* ═══ 08  AUTOPILOT ═════════════════════════════════════════════════════
   Receding-horizon search over steering targets; gravity shifts come from
   the level's own arrow hints. Used to prove every stage (and the endless
   generator) is completable, and as a hands-off demo: PARALLAX.demo().    */

const CANDS = [0, -0.6, 0.6, -1.2, 1.2, -1.8, 1.8, -2.4, 2.4, -3, 3, -3.6, 3.6];
class Pilot {
  constructor() { this.hi = 0; this.target = 0; this.n = 0; }
  reset(d) { this.hi = W.hints.findIndex(h => h.d >= d); if (this.hi < 0) this.hi = W.hints.length; this.target = 0; this.n = 0; }
  static steer(s, t) {
    const f = FR[mod4(s.gi)], a = s.x * f.rx + s.y * f.ry, vl = s.vx * f.rx + s.vy * f.ry;
    return clamp((t - a) * 1.5 - vl * 0.1, -1, 1);
  }
  roll(s0, target, boxes) {
    const s = s0.clone(); let hi = this.hi; s.pad = 0.2;
    for (let i = 0; i < 115; i++) {
      while (hi < W.hints.length && s.d >= W.hints[hi].d) { const h = W.hints[hi++]; for (let k = 0; k < h.n; k++) s.flip(h.dir); }
      s.step(H * 2, Pilot.steer(s, target), boxes);
      if (s.dead) return i;
    }
    return 120;
  }
  update(sim, flip) {
    if (this.n++ % 6 === 0) {
      const reach = Math.abs(sim.vz) * 2 + 14, boxes = W.boxes.filter(b => b.z0 < sim.z + 3 && b.z1 > sim.z - reach);
      let best = -1e9, bt = this.target;
      for (const c of CANDS) {
        const sc = this.roll(sim, c, boxes) - Math.abs(c - this.target) * 0.03 - Math.abs(c) * 0.012;
        if (sc > best) { best = sc; bt = c; }
      }
      this.target = bt;
    }
    while (this.hi < W.hints.length && sim.d >= W.hints[this.hi].d) { const h = W.hints[this.hi++]; for (let k = 0; k < h.n; k++) flip(h.dir); }
    return Pilot.steer(sim, this.target);
  }
}

/* ═══ 09  PLAYER VISUALS & EFFECTS ══════════════════════════════════════ */

const ballG = new THREE.Group();
const ballMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: PALETTE[0], emissiveMap: ballTex, emissiveIntensity: 1.08, roughness: 0.4, metalness: 0 });
const ballM = new THREE.Mesh(new THREE.SphereGeometry(R, 48, 32), ballMat);
ballM.castShadow = true;
ballG.add(ballM);
scene.add(ballG);
const spin = new THREE.Quaternion();

const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: PALETTE[0], transparent: true, opacity: 0.42, depthWrite: false, fog: false }));
halo.scale.setScalar(3.0);
scene.add(halo);
const pool = new THREE.Mesh(new THREE.CircleGeometry(1.7, 40), new THREE.MeshBasicMaterial({ map: glowTex, color: PALETTE[0], transparent: true, opacity: 0.44, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
scene.add(pool);
const ballLight = new THREE.PointLight(PALETTE[0], 2.4, 10, 2);
scene.add(ballLight);

/* ribbon trail */
const TRAIL_N = 46;
const trail = (() => {
  const pos = new Float32Array(TRAIL_N * 6), col = new Float32Array(TRAIL_N * 8), idx = [];
  for (let i = 0; i < TRAIL_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  mesh.frustumCulled = false;
  scene.add(mesh);
  let pts = [];
  return {
    reset() { pts = []; },
    update(x, y, z, f, show) {
      const hx = x + f.dx * (R - 0.05), hy = y + f.dy * (R - 0.05);
      const head = { x: hx, y: hy, z, rx: f.rx, ry: f.ry };
      if (!pts.length || Math.hypot(hx - pts[0].x, hy - pts[0].y, z - pts[0].z) > 0.32) { pts.unshift(head); if (pts.length > TRAIL_N - 1) pts.pop(); }
      for (let i = 0; i < TRAIL_N; i++) {
        const p = i === 0 ? head : pts[Math.min(i - 1, pts.length - 1)], k = 1 - i / (TRAIL_N - 1), w = 0.2 * k * (i === 0 ? 0.7 : 1);
        pos[i * 6] = p.x - p.rx * w; pos[i * 6 + 1] = p.y - p.ry * w; pos[i * 6 + 2] = p.z;
        pos[i * 6 + 3] = p.x + p.rx * w; pos[i * 6 + 4] = p.y + p.ry * w; pos[i * 6 + 5] = p.z;
        const a = show ? k * k * 0.7 : 0;
        for (let j = 0; j < 2; j++) { const o = i * 8 + j * 4; col[o] = accent.r; col[o + 1] = accent.g; col[o + 2] = accent.b; col[o + 3] = a; }
      }
      geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
    },
  };
})();

/* landing shockwaves */
const rings = (() => {
  const geo = new THREE.RingGeometry(0.9, 1, 72), list = [], Z = new THREE.Vector3(0, 0, 1), n = new THREE.Vector3();
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: PALETTE[0], transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    m.visible = false; m.userData = { t: 1, size: 1 };
    scene.add(m); list.push(m);
  }
  let k = 0;
  return {
    spawn(x, y, z, nx, ny, nz, size) {
      const m = list[k++ % list.length];
      n.set(nx, ny, nz).normalize();
      m.position.set(x + n.x * 0.04, y + n.y * 0.04, z + n.z * 0.04);
      m.quaternion.setFromUnitVectors(Z, n);
      m.userData.t = 0; m.userData.size = size; m.visible = true;
    },
    update(dt) {
      for (const m of list) {
        if (!m.visible) continue;
        const u = m.userData; u.t += dt / 0.5;
        if (u.t >= 1) { m.visible = false; continue; }
        const e = 1 - Math.pow(1 - u.t, 3);
        m.scale.setScalar(0.5 + e * u.size);
        m.material.opacity = (1 - u.t) * 0.9;
        m.material.color.copy(accent).multiplyScalar(1.3);
      }
    },
  };
})();

/* 25 physical shards */
const shards = (() => {
  const geos = [new THREE.TetrahedronGeometry(1, 0), new THREE.OctahedronGeometry(1, 0), new THREE.TetrahedronGeometry(1, 0)];
  geos[2].scale(1.5, 0.45, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: PALETTE[0], emissiveIntensity: 1.1, roughness: 0.4, flatShading: true });
  const list = [], r = rng(99);
  for (let i = 0; i < 25; i++) {
    const m = new THREE.Mesh(geos[i % 3], mat);
    m.castShadow = true; m.visible = false;
    m.userData = { vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, life: 0, size: 0.11 + r() * 0.15 };
    scene.add(m); list.push(m);
  }
  let gx = 0, gy = -1;
  return {
    mat,
    burst(s, f) {
      gx = f.dx; gy = f.dy;
      for (const m of list) {
        const u = m.userData;
        let ax = Math.random() * 2 - 1, ay = Math.random() * 2 - 1, az = Math.random() * 2 - 1;
        const l = Math.hypot(ax, ay, az) || 1; ax /= l; ay /= l; az /= l;
        m.position.set(s.x + ax * 0.3, s.y + ay * 0.3, s.z + az * 0.3);
        const sp = 3 + Math.random() * 9;
        u.vx = s.vx * 0.35 + ax * sp + s.nx * 5; u.vy = s.vy * 0.35 + ay * sp + s.ny * 5; u.vz = s.vz * 0.4 + az * sp + s.nz * 6;
        u.wx = (Math.random() - 0.5) * 22; u.wy = (Math.random() - 0.5) * 22; u.wz = (Math.random() - 0.5) * 22;
        u.life = 2.3 + Math.random() * 0.6;
        m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
        m.scale.setScalar(u.size); m.visible = true;
      }
    },
    update(dt, t) {
      const rr = 0.12;
      for (const m of list) {
        if (!m.visible) continue;
        const u = m.userData, p = m.position;
        u.life -= dt; if (u.life <= 0) { m.visible = false; continue; }
        u.vx += gx * G * dt; u.vy += gy * G * dt;
        p.x += u.vx * dt; p.y += u.vy * dt; p.z += u.vz * dt;
        for (const b of W.boxes) {
          if (b.z1 < p.z - rr || b.z0 > p.z + rr) continue;
          let ox = 0, oy = 0;
          if (b.mv) { const o = b.mv.amp * Math.sin(b.mv.w * t + b.mv.ph); ox = b.mv.ux * o; oy = b.mv.uy * o; }
          const cx = clamp(p.x, b.x0 + ox, b.x1 + ox), cy = clamp(p.y, b.y0 + oy, b.y1 + oy), cz = clamp(p.z, b.z0, b.z1);
          const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz, d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= rr * rr || d2 < 1e-9) continue;
          const dd = Math.sqrt(d2), nx = dx / dd, ny = dy / dd, nz = dz / dd, vn = u.vx * nx + u.vy * ny + u.vz * nz;
          p.x += nx * (rr - dd); p.y += ny * (rr - dd); p.z += nz * (rr - dd);
          if (vn < 0) {
            u.vx = (u.vx - nx * vn * 1.45) * 0.86; u.vy = (u.vy - ny * vn * 1.45) * 0.86; u.vz = (u.vz - nz * vn * 1.45) * 0.86;
            u.wx *= 0.7; u.wy *= 0.7; u.wz *= 0.7;
          }
        }
        m.rotation.x += u.wx * dt; m.rotation.y += u.wy * dt; m.rotation.z += u.wz * dt;
        m.scale.setScalar(u.size * Math.min(1, u.life / 0.5));
      }
    },
  };
})();

/* floating dust — the cheapest possible parallax cue */
const dust = (() => {
  const N = 520, pos = new Float32Array(N * 3), r = rng(5);
  for (let i = 0; i < N; i++) { pos[i * 3] = (r() - 0.5) * 44; pos[i * 3 + 1] = (r() - 0.5) * 44; pos[i * 3 + 2] = -r() * 150 + 20; }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.09, transparent: true, opacity: 0.75, depthWrite: false, sizeAttenuation: true }));
  pts.frustumCulled = false; scene.add(pts);
  return {
    update(z) {
      let dirty = false;
      for (let i = 2; i < N * 3; i += 3) {
        if (pos[i] > z + 20) { pos[i] -= 150; dirty = true; } else if (pos[i] < z - 130) { pos[i] += 150; dirty = true; }
      }
      if (dirty) geo.attributes.position.needsUpdate = true;
    },
  };
})();

/* distant monoliths, streamed deterministically by distance cell */
const BG = { mesh: new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), MAT.far, 72), cell: null };
BG.mesh.frustumCulled = false; scene.add(BG.mesh);
function updateBG(d) {
  const ci = Math.floor(d / 40);
  if (ci === BG.cell) return;
  BG.cell = ci;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  let k = 0;
  for (let c = ci - 2; c < ci + 16; c++) {
    const r = rng(c * 9176 + 11);
    for (let j = 0; j < 4; j++) {
      const th = r() * TAU, rad = 50 + r() * 125, long = 34 + r() * 120, t1 = 5 + r() * 14, t2 = 6 + r() * 22;
      const vert = Math.abs(Math.cos(th)) > Math.abs(Math.sin(th));
      p.set(Math.cos(th) * rad, Math.sin(th) * rad, -(c * 40 + r() * 40));
      sc.set(vert ? t1 : long, vert ? long : t1, t2);
      m.compose(p, q, sc); BG.mesh.setMatrixAt(k++, m);
    }
  }
  BG.mesh.instanceMatrix.needsUpdate = true;
}

/* ═══ 10  GAME STATE · INPUT · HUD ══════════════════════════════════════ */

const game = {
  state: 'menu', paused: false, sim: new Sim(), cpi: 0, stage: null,
  ts: 1, focus: 1, focusOn: false, focusLock: false,
  hitstop: 0, deadT: 0, flash: 0, pop: 1, squash: 0, squashV: 0, hot: 0,
  time: 0, startT: 0, best: +(localStorage.getItem('parallax.best') || 0), auto: false, deaths: 0,
};
const cam = { phi: 0, phiV: 0, phiT: 0, f: new THREE.Vector3(), kick: 0, kickV: 0, trauma: 0, fov: 64, lean: 0, blend: 0 };
const pilot = new Pilot();
const keys = {};
const flipQ = [];
let acc = 0;
const prev = new THREE.Vector3(), bp = new THREE.Vector3(), lastBp = new THREE.Vector3();

const hud = {
  root: $('hud'), dist: $('dist'), spd: $('spd'), spdBar: $('spdBar'), focusPct: $('focusPct'), focusBar: $('focusBar'), best: $('best'),
  stageNum: $('stageNum'), stageName: $('stageName'), gdeg: $('gdeg'), gside: $('gside'), gworld: $('gworld'),
  sides: [0, 1, 2, 3].map(i => $('gs' + i)), prompt: $('prompt'), card: $('card'), toast: $('toast'),
  vignette: $('fx-vignette'), flash: $('fx-flash'), start: $('start'), pause: $('pause'), cache: {},
};
function setText(key, v) { if (hud.cache[key] !== v) { hud.cache[key] = v; hud[key].textContent = v; } }
function showCard(st) {
  $('cardNum').textContent = st.num; $('cardName').textContent = st.name; $('cardSub').textContent = st.sub;
  hud.card.classList.remove('show'); void hud.card.offsetWidth; hud.card.classList.add('show');
}
function toast(msg) { hud.toast.textContent = msg; hud.toast.classList.remove('show'); void hud.toast.offsetWidth; hud.toast.classList.add('show'); }
function setAccent(i) {
  accentT.setHex(PALETTE[i]);
  document.documentElement.style.setProperty('--accent', '#' + PALETTE[i].toString(16).padStart(6, '0'));
}
function setStage(st, announce) {
  game.stage = st;
  setText('stageNum', st.num); setText('stageName', st.name);
  setAccent(st.accent);
  if (announce) { showCard(st); AU.stage(); }
}
function saveBest() {
  const d = Math.floor(game.sim.d);
  if (d > game.best) { game.best = d; localStorage.setItem('parallax.best', d); }
}

function resetRun() {
  buildWorld();
  const s = game.sim = new Sim();
  s.place(W.cps[0], 0);
  game.cpi = 0; game.ts = 1; game.focus = 1; game.focusLock = false; game.hitstop = 0; game.pop = 1; game.hot = 0; game.deaths = 0;
  flipQ.length = 0; acc = 0;
  prev.set(s.x, s.y, s.z); bp.copy(prev); lastBp.copy(prev);
  cam.phi = cam.phiT = cam.phiV = 0; cam.f.copy(prev); cam.kick = cam.kickV = cam.trauma = 0;
  ballG.visible = true; trail.reset(); pilot.reset(0);
  BG.cell = null;
  setStage(W.stages[0], false);
}
function startGame() {
  if (game.state !== 'menu') return;
  AU.init(); AU.click(); AU.setPlaying(true);
  game.state = 'playing'; game.startT = game.time;
  hud.start.classList.add('out'); hud.root.classList.remove('hidden');
  showCard(game.stage); AU.stage();
}
function restart() {
  saveBest();
  resetRun();
  if (game.state !== 'menu') { game.state = 'playing'; game.flash = 0.6; showCard(game.stage); }
}
function togglePause() {
  if (game.state === 'menu') return;
  game.paused = !game.paused;
  hud.pause.classList.toggle('on', game.paused);
  AU.suspend(game.paused);
}
function toggleSound() { AU.init(); $('soundState').textContent = AU.toggleMute() ? 'OFF' : 'ON'; }

function doFlip(dir) {
  const s = game.sim;
  s.flip(dir);
  cam.phiT = s.gi * HP;
  cam.phiV += dir * 2.5;
  AU.flip(dir);
}
function onLand(v) {
  const s = game.sim, k = clamp(v / 22, 0.2, 1);
  AU.land(v);
  cam.kickV -= 4.2 * k; cam.trauma = Math.min(1, cam.trauma + 0.12 * k);
  game.squashV += 7 * k;
  rings.spawn(s.x - s.nx * R, s.y - s.ny * R, s.z - s.nz * R, s.nx, s.ny, s.nz, 1.0 + 1.7 * k);
}
function onDeath(why) {
  game.state = 'dead'; game.deaths++;
  game.hitstop = why === 'void' ? 0 : 0.085; game.deadT = 0.46; game.hot = 1;
  saveBest();
  if (why === 'void') shatter(); else { AU.hit(); cam.trauma = Math.min(1, cam.trauma + 0.35); }
}
function shatter() {
  const s = game.sim, f = FR[mod4(s.gi)];
  ballG.visible = false;
  shards.burst(s, f);
  rings.spawn(s.x, s.y, s.z, s.nx, s.ny, s.nz, 5);
  AU.shatter();
  cam.trauma = Math.min(1, cam.trauma + 0.55); game.flash = Math.max(game.flash, 0.22);
}
function respawn() {
  const s = game.sim, cp = W.cps[game.cpi], g0 = s.gi;
  s.place(cp);
  s.gi = cp.side + 4 * Math.round((g0 - cp.side) / 4);
  cam.phiT = s.gi * HP;
  prev.set(s.x, s.y, s.z); bp.copy(prev); lastBp.copy(prev); cam.f.copy(prev);
  acc = 0; flipQ.length = 0;
  game.state = 'playing'; game.pop = 0; game.hot = 0; game.flash = Math.max(game.flash, 0.45);
  ballG.visible = true; trail.reset(); pilot.reset(s.d);
  AU.respawn();
}

/* input */
addEventListener('keydown', e => {
  if (['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  keys[e.code] = true;
  if (e.code === 'KeyM') return toggleSound();
  if (game.state === 'menu') { if (e.code === 'Space' || e.code === 'Enter') startGame(); return; }
  if (e.code === 'KeyP' || e.code === 'Escape') return togglePause();
  if (e.code === 'KeyR') { AU.click(); return restart(); }
  if (game.paused || game.state !== 'playing') return;
  if (e.code === 'KeyE') flipQ.push(1);
  else if (e.code === 'KeyQ') flipQ.push(-1);
  else if (e.code === 'Space') flipQ.push((keys.KeyA || keys.ArrowLeft) && !(keys.KeyD || keys.ArrowRight) ? -1 : 1);
});
addEventListener('keyup', e => { keys[e.code] = false; if (e.code === 'Space') e.preventDefault(); });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
hud.start.addEventListener('click', startGame);
$('btnRestart').addEventListener('click', e => { AU.click(); restart(); e.currentTarget.blur(); });
$('btnSound').addEventListener('click', e => { toggleSound(); AU.click(); e.currentTarget.blur(); });
for (const b of document.querySelectorAll('button')) b.addEventListener('mouseenter', () => AU.hover());
addEventListener('mousemove', e => {
  if (game.state !== 'menu') return;
  hud.start.style.setProperty('--mx', (e.clientX / innerWidth - 0.5).toFixed(3));
  hud.start.style.setProperty('--my', (e.clientY / innerHeight - 0.5).toFixed(3));
});
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth * PR, innerHeight * PR);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
});

/* ═══ 11  FRAME LOOP ════════════════════════════════════════════════════ */

function simulate(raw) {
  const s = game.sim;
  // focus (bullet-time) budget
  const want = !!(game.state === 'playing' && (keys.ShiftLeft || keys.ShiftRight) && !game.focusLock && game.focus > 0);
  if (want) { game.focus -= raw / 2.6; if (game.focus <= 0) { game.focus = 0; game.focusLock = true; } }
  else { game.focus = Math.min(1, game.focus + raw / 5); if (game.focus > 0.3) game.focusLock = false; }
  if (want !== game.focusOn) {
    game.focusOn = want; AU.focus(want);
    hud.vignette.classList.toggle('on', want); canvas.classList.toggle('focus', want);
  }
  game.ts = damp(game.ts, want ? 0.3 : 1, 12, raw);
  AU.setRate(game.ts);

  if (game.state === 'playing') {
    ensureGen(s.d, W.cps[game.cpi].d);
    acc += raw * game.ts;
    let n = 0;
    while (acc >= H && n++ < 10 && game.state === 'playing') {
      prev.set(s.x, s.y, s.z);
      while (flipQ.length) doFlip(flipQ.shift());
      let ax = ((keys.KeyD || keys.ArrowRight) ? 1 : 0) - ((keys.KeyA || keys.ArrowLeft) ? 1 : 0);
      if (game.auto) ax = pilot.update(s, doFlip);
      s.step(H, ax, W.boxes);
      acc -= H;
      if (s.land) onLand(s.land);
      if (s.dead) { onDeath(s.dead); break; }
    }
    if (n >= 10) acc = 0;
    // progression
    const next = W.cps[game.cpi + 1];
    if (next && s.d >= next.d && game.state === 'playing') { game.cpi++; toast('CHECKPOINT'); AU.checkpoint(); }
    const st = stageAt(s.d);
    if (st !== game.stage) setStage(st, true);
  } else if (game.state === 'dead') {
    if (game.hitstop > 0) { game.hitstop -= raw; if (game.hitstop <= 0) shatter(); }
    else { game.deadT -= raw; if (game.deadT <= 0) respawn(); }
  }
  shards.update(raw * game.ts, s.t);
  rings.update(raw * Math.max(0.5, game.ts));
}

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _Y = new THREE.Vector3(0, 1, 0);
const _look = new THREE.Vector3(), _pos = new THREE.Vector3(), _lx = new THREE.Vector3(), _ly = new THREE.Vector3(), _lz = new THREE.Vector3();

function present(raw) {
  const s = game.sim, f = FR[mod4(s.gi)], playing = game.state === 'playing';
  const a = playing ? clamp(acc / H, 0, 1) : 1;
  bp.set(lerp(prev.x, s.x, a), lerp(prev.y, s.y, a), lerp(prev.z, s.z, a));
  const tr = s.t - H * (1 - a);

  // moving blocks
  for (const c of W.chunks) for (const m of c.movers) {
    const u = m.userData, mv = u.b.mv, o = mv.amp * Math.sin(mv.w * tr + mv.ph);
    m.position.x = u.cx + mv.ux * o; m.position.y = u.cy + mv.uy * o;
  }

  // accent drift
  accent.lerp(accentT, 1 - Math.exp(-2.2 * raw));
  const peak = Math.max(accent.r, accent.g, accent.b, 0.001);
  MAT.acc.color.copy(accent).multiplyScalar(1.12 / peak);
  ballMat.emissive.copy(accent).multiplyScalar(1 / peak);
  shards.mat.emissive.copy(ballMat.emissive);
  halo.material.color.copy(accent); pool.material.color.copy(accent); ballLight.color.copy(accent);

  // sphere: roll, squash, pop-in, hit-stop heat
  const upx = -f.dx, upy = -f.dy;
  _v.set(bp.x - lastBp.x, bp.y - lastBp.y, bp.z - lastBp.z);
  const rx = upy * _v.z, ry = -upx * _v.z, rz = upx * _v.y - upy * _v.x, rl = Math.hypot(rx, ry, rz);
  if (rl > 1e-6 && rl < 3) { _q.setFromAxisAngle(_v.set(rx / rl, ry / rl, rz / rl), rl / R); spin.premultiply(_q); }
  lastBp.copy(bp);
  game.squashV += (-420 * game.squash - 24 * game.squashV) * raw; game.squash += game.squashV * raw;
  const fall = playing && !s.grounded ? clamp((s.vx * f.dx + s.vy * f.dy) * 0.006, 0, 0.16) : 0;
  const sq = clamp(game.squash - fall, -0.3, 0.42);
  game.pop = Math.min(1, game.pop + raw / 0.22);
  const pe = game.pop < 1 ? 1 + 2.7 * Math.pow(game.pop - 1, 3) + 1.7 * Math.pow(game.pop - 1, 2) : 1;
  const hot = game.state === 'dead' && game.hitstop > 0 ? 1 : 0;
  ballG.position.copy(bp);
  ballG.quaternion.setFromUnitVectors(_Y, _v.set(upx, upy, 0));
  ballG.scale.set((1 + sq * 0.5) * pe * (1 + hot * 0.16), (1 - sq) * pe * (1 + hot * 0.16), (1 + sq * 0.5) * pe * (1 + hot * 0.16));
  ballM.quaternion.copy(_q2.copy(ballG.quaternion).invert()).multiply(spin);
  ballMat.emissiveIntensity = 1.08 + hot * 2.2;
  ballMat.emissiveMap = hot ? null : ballTex; if ((ballMat.userData.h | 0) !== hot) { ballMat.userData.h = hot; ballMat.needsUpdate = true; }

  const vis = ballG.visible;
  halo.visible = vis; halo.position.copy(bp);
  halo.material.opacity = 0.26 + 0.05 * Math.sin(game.time * 5);
  ballLight.visible = vis; ballLight.position.set(bp.x + upx * 0.35, bp.y + upy * 0.35, bp.z);
  pool.visible = vis && s.grounded;
  pool.position.set(bp.x + f.dx * (R - 0.03), bp.y + f.dy * (R - 0.03), bp.z);
  pool.quaternion.setFromUnitVectors(_v.set(0, 0, 1), _look.set(upx, upy, 0));
  trail.update(bp.x, bp.y, bp.z, f, vis && game.state !== 'menu');

  // camera — world roll on a spring
  cam.phiV += (-190 * (cam.phi - cam.phiT) - 19 * cam.phiV) * raw; cam.phi += cam.phiV * raw;
  cam.kickV += (-300 * cam.kick - 20 * cam.kickV) * raw; cam.kick += cam.kickV * raw;
  cam.trauma = Math.max(0, cam.trauma - raw * 1.9);
  const vl = s.vx * f.rx + s.vy * f.ry;
  cam.lean = damp(cam.lean, playing ? -vl * 0.0052 : 0, 8, raw);
  const phi = cam.phi + cam.lean, ux = -Math.sin(phi), uy = Math.cos(phi);
  cam.f.x = damp(cam.f.x, bp.x, 11, raw); cam.f.y = damp(cam.f.y, bp.y, 11, raw); cam.f.z = bp.z;
  const speed = Math.abs(s.vz), sn = clamp((speed - 12) / 22, 0, 1);
  const hgt = 3.5 + cam.kick, back = 7.3 + sn * 1.3;
  _pos.set(cam.f.x + ux * hgt, cam.f.y + uy * hgt, cam.f.z + back);
  _look.set(cam.f.x + ux * 1.0, cam.f.y + uy * 1.0, cam.f.z - 9.5);
  let upX = ux, upY = uy;
  if (game.state === 'menu' || cam.blend < 1) {         // attract framing → chase framing
    cam.blend = game.state === 'menu' ? 0 : Math.min(1, cam.blend + raw / 1.5);
    const m = smooth(cam.blend), t = game.time;
    _pos.lerpVectors(_v.set(10.5 + Math.sin(t * 0.17) * 1.6, 4.6 + Math.sin(t * 0.11) * 0.7, 17), _pos, m);
    _look.lerpVectors(_v.set(-5, -6.5, -34), _look, m);
  }
  const tq = cam.trauma * cam.trauma, tt = game.time * 47;
  _pos.x += Math.sin(tt) * tq * 0.34; _pos.y += Math.sin(tt * 1.31 + 2) * tq * 0.34;
  camera.position.copy(_pos); camera.up.set(upX, upY, 0); camera.lookAt(_look);
  const fovT = 62 + sn * 9 - (1 - game.ts) / 0.7 * 9;
  cam.fov = damp(cam.fov, fovT, 7, raw);
  if (Math.abs(camera.fov - cam.fov) > 0.01) { camera.fov = cam.fov; camera.updateProjectionMatrix(); }

  // sun & sky ride the gravity frame; shadow frustum snaps to its own texel grid
  const cp = Math.cos(cam.phi), sp = Math.sin(cam.phi);
  _lz.set(SUN_BASE.x * cp - SUN_BASE.y * sp, SUN_BASE.x * sp + SUN_BASE.y * cp, SUN_BASE.z);
  _lx.crossVectors(_Y, _lz).normalize(); _ly.crossVectors(_lz, _lx);
  _v.set(cam.f.x, cam.f.y, bp.z - 30);
  const texel = SHADOW_HALF * 2 / sun.shadow.mapSize.x, dxs = _v.dot(_lx), dys = _v.dot(_ly);
  _v.addScaledVector(_lx, Math.round(dxs / texel) * texel - dxs).addScaledVector(_ly, Math.round(dys / texel) * texel - dys);
  sun.target.position.copy(_v); sun.position.copy(_v).addScaledVector(_lz, 130);
  hemi.position.set(-sp, cp, 0);
  sky.position.copy(camera.position); sky.rotation.z = cam.phi;
  dust.update(bp.z); updateBG(-bp.z);

  // audio follow
  AU.wind(playing ? clamp(speed / 34, 0, 1) * game.ts : 0, playing && !s.grounded ? 1 : 0);

  // HUD
  const d = Math.max(0, Math.floor(-bp.z));
  setText('dist', String(d).padStart(4, '0'));
  setText('spd', (playing ? speed : 0).toFixed(1).padStart(4, '0'));
  hud.spdBar.style.transform = `scaleX(${clamp(speed / 34, 0, 1).toFixed(3)})`;
  setText('focusPct', String(Math.round(game.focus * 100)).padStart(3, '0'));
  hud.focusBar.style.transform = `scaleX(${game.focus.toFixed(3)})`;
  setText('best', String(Math.max(game.best, d)).padStart(4, '0'));
  const side = mod4(s.gi);
  if (hud.cache.side !== side) {
    hud.cache.side = side;
    hud.sides.forEach((el, i) => el.classList.toggle('on', i === side));
    hud.gdeg.textContent = String(side * 90).padStart(3, '0') + '°';
    hud.gside.textContent = SIDE_NAMES[side];
  }
  hud.gworld.setAttribute('transform', `rotate(${(cam.phi * 180 / Math.PI).toFixed(2)})`);
  let pr = '';
  if (playing && !game.auto) for (const p of PROMPTS) if (d >= p[0] && d < p[1]) pr = p[2];
  if (hud.cache.prompt !== pr) { hud.cache.prompt = pr; if (pr) hud.prompt.innerHTML = pr; hud.prompt.classList.toggle('on', !!pr); }
  game.flash = Math.max(0, game.flash - raw * 2.6);
  hud.flash.style.opacity = game.flash.toFixed(3);
}

let last = performance.now(), frames = 0, slow = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const raw = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now;
  if (!game.paused) { game.time += raw; simulate(raw); present(raw); }
  composer.render();
  // one-shot quality step-down for slow GPUs
  if (frames < 150 && raw > 0.001 && raw < 0.045 && ++frames > 30) { slow += raw; if (frames === 150 && slow / 120 > 0.024) degrade(); }
}
function degrade() {
  PR = 1; renderer.setPixelRatio(1); renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
  sun.shadow.mapSize.set(2048, 2048);
  if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
}

/* debug / verification surface */
function selftest(maxD = INF0, seedRuns = 1) {
  const t0 = performance.now(), was = game.state;
  resetRun();
  const s = game.sim, p = new Pilot(), deaths = [];
  let cpi = 0, guard = 0;
  p.reset(0);
  while (s.d < maxD && guard++ < 3e6 && deaths.length < 30) {
    if (guard % 30 === 0) ensureGen(s.d, W.cps[cpi].d);
    const ax = p.update(s, dir => s.flip(dir));
    s.step(H, ax, W.boxes);
    while (W.cps[cpi + 1] && s.d >= W.cps[cpi + 1].d) cpi++;
    if (s.dead) {
      const f = FR[mod4(s.gi)];
      deaths.push({ d: +s.d.toFixed(1), why: s.dead, side: mod4(s.gi), a: +(s.x * f.rx + s.y * f.ry).toFixed(2) });
      const g0 = s.gi; s.place(W.cps[cpi]); s.gi = W.cps[cpi].side + 4 * Math.round((g0 - W.cps[cpi].side) / 4); p.reset(s.d);
    }
  }
  const out = { reached: Math.round(s.d), deaths, simSeconds: +s.t.toFixed(1), ms: Math.round(performance.now() - t0), zones: W.stages.map(z => z.num + '@' + Math.round(z.d)).slice(3) };
  resetRun(); game.state = was;
  return out;
}
window.PARALLAX = {
  game, W, cam, selftest,
  demo(on = true) { game.auto = on; pilot.reset(game.sim.d); if (on) startGame(); return on; },
  // step the game synchronously (verification without relying on rAF timing)
  advance(sec, keysDown = {}) {
    Object.assign(keys, keysDown);
    for (let i = 0, n = Math.round(sec * 60); i < n; i++) { game.time += 1 / 60; simulate(1 / 60); present(1 / 60); }
    composer.render();
    return { d: +game.sim.d.toFixed(1), side: mod4(game.sim.gi), state: game.state, deaths: game.deaths, cp: game.cpi };
  },
  warp(i) { game.cpi = clamp(i, 0, W.cps.length - 1); if (game.state === 'menu') startGame(); respawn(); return W.cps[game.cpi]; },
};

resetRun();
present(0);
requestAnimationFrame(frame);
