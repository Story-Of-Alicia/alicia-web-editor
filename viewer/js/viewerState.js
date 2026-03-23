import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';

// ─── Constants ────────────────────────────────────────────────────────────────
export const BASE     = '..';
export const PC       = 'graphics/pc';
export const MAP_BASE = 'graphics/bg';
export const ABIN_DIR = `${MAP_BASE}/abin`;
export const DEBUG_MAP_RESOLVE = false;
export const DEBUG_MAP_RESOLVE_FILTER = '';

export const CHAR_CFG = {
  r00: { texDir: `${PC}/r00/textures`, partsDir: `${PC}/r00_parts`, anmDir: `${PC}/r00/anm`, skelDff: `${PC}/r00/r00.dff` },
  r02: { texDir: `${PC}/r02/textures`, partsDir: `${PC}/r02_parts`, anmDir: `${PC}/r02/anm`, skelDff: `${PC}/r02/r02.dff` },
};

// ─── Three.js setup ───────────────────────────────────────────────────────────
export const canvas   = document.getElementById('canvas');
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14172a);
scene.environment = null;
scene.add(new THREE.AmbientLight(0xffffff, 0.8));
scene.add(new THREE.HemisphereLight(0xc6d4ff, 0x3a2d1a, 1.1));
scene.add(new THREE.GridHelper(10, 20, 0x404060, 0x2a2c40));

export const camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight || 1, 0.01, 5000);
camera.position.set(0, 1.5, 3.5);
export const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.update();

export const ddsLoader = new DDSLoader();
export const texCache  = new Map();
export const clock     = new THREE.Clock();

// ─── BSP terrain shader debug ─────────────────────────────────────────────────
export const debugNames = ['normal','blend weights','tex0','tex1','tex2','tex3',
  'w3 grass weight','raw groupUV','raw blendUV','no-pickUV','prelit RGB','prelit alpha',
  'UV2','UV5','UV6','splatmap RGB',
  '','','','','',  // 16-19 unused
  'UV0 tiling','UV1 lightmap','UV2 atlas','UV3 blend','UV4','UV5 group','UV6'];

window.addEventListener('keydown', (e) => {
  let mode = parseInt(e.key);
  if (e.key === 'q') mode = 10;
  if (e.key === 'w') mode = 11;
  if (e.key === 'p') mode = 15;
  if (e.key === 'y') mode = 20;
  if (e.key === 'u') mode = 21;
  if (e.key === 'i') mode = 22;
  if (e.key === 'o') mode = 23;
  if (e.key === 'a') mode = 24;
  if (e.key === 's') mode = 25;
  if (e.key === 'd') mode = 26;
  if (isNaN(mode) || mode < 0 || mode > 26) return;
  console.log(`[BSP debug] mode=${mode} (${debugNames[mode]})`);
  scene.traverse(obj => {
    if (obj.isMesh && obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m._bspDebug && m.uniforms?.uDebugMode) m.uniforms.uDebugMode.value = mode;
      }
    }
  });
});

// ─── Mutable app state ────────────────────────────────────────────────────────
export const state = {
  charName:   'r00',
  partsData:  null,
  activeParts:  {},
  sharedBones:  null,
  sharedFrames: null,
  sharedBoneInverses: null,
  sceneGroup:   null,
  skeletonHelper: null,
  mixer:          null,
  currentAction:  null,
  animPaused:     false,
  showBones:      false,
  showWireframe:  false,
  userLight:      null,
  userLightViz:   null,
  // Map state
  mapMode:           false,
  mapGroup:          null,
  mapNodeHelpers:    null,
  mapShowWire:       false,
  mapShowNodes:      false,
  mapSelHelper:      null,
  mapSelLi:          null,
};

// ─── UI element references ────────────────────────────────────────────────────
export const ui = {
  charSelect:   document.getElementById('char-select'),
  animList:     document.getElementById('anim-list'),
  btnPlay:      document.getElementById('btn-play'),
  btnPause:     document.getElementById('btn-pause'),
  btnStop:      document.getElementById('btn-stop'),
  speedRange:   document.getElementById('speed-range'),
  speedLabel:   document.getElementById('speed-label'),
  timeline:     document.getElementById('timeline'),
  timeLabel:    document.getElementById('time-label'),
  btnBones:     document.getElementById('btn-bones'),
  btnWire:      document.getElementById('btn-wire'),
  statusEl:     document.getElementById('status'),
  slotsPanel:   document.getElementById('slots-panel'),
  tabChar:      document.getElementById('tab-char'),
  tabMap:       document.getElementById('tab-map'),
  tabAssets:    document.getElementById('tab-assets'),
  charToolbar:  document.getElementById('char-toolbar'),
  mapToolbar:   document.getElementById('map-toolbar'),
  assetsToolbar:document.getElementById('assets-toolbar'),
  charSidebar:  document.getElementById('char-sidebar'),
  mapSidebar:   document.getElementById('map-sidebar'),
  assetsSidebar:document.getElementById('assets-sidebar'),
  assetsSearch: document.getElementById('assets-search'),
  assetTree:    document.getElementById('asset-tree'),
  assetDetail:  document.getElementById('asset-detail'),
  mapSelect:    document.getElementById('map-select'),
  btnMapWire:   document.getElementById('btn-map-wire'),
  btnMapNodes:  document.getElementById('btn-map-nodes'),
  mapObjList:   document.getElementById('map-object-list'),
  controlsEl:   document.getElementById('controls'),
  lightX:       document.getElementById('light-x'),
  lightY:       document.getElementById('light-y'),
  lightZ:       document.getElementById('light-z'),
  lightInt:     document.getElementById('light-int'),
};

// ─── Utility functions ────────────────────────────────────────────────────────
export function setStatus(msg, err = false) {
  ui.statusEl.textContent = msg;
  ui.statusEl.className   = err ? 'error' : '';
}

export function initUserLight() {
  if (state.userLight) return;
  state.userLight = new THREE.PointLight(0xffffff, parseFloat(ui.lightInt?.value ?? 1.2), 0, 2);
  state.userLight.position.set(
    parseFloat(ui.lightX?.value ?? 1.5),
    parseFloat(ui.lightY?.value ?? 2.0),
    parseFloat(ui.lightZ?.value ?? 2.0)
  );
  state.userLightViz = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0xffddaa })
  );
  state.userLight.add(state.userLightViz);
  scene.add(state.userLight);
}

export function updateUserLight() {
  if (!state.userLight) return;
  state.userLight.position.set(
    parseFloat(ui.lightX?.value ?? 1.5),
    parseFloat(ui.lightY?.value ?? 2.0),
    parseFloat(ui.lightZ?.value ?? 2.0)
  );
  state.userLight.intensity = parseFloat(ui.lightInt?.value ?? 1.2);
}

export async function fetchBinary(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.arrayBuffer();
}
