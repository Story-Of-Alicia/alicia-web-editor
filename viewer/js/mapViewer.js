import * as THREE from 'three';
import { DFFParser } from './DFFParser.js';
import { BSPParser  } from './BSPParser.js';
import { BASE, ABIN_DIR, scene, camera, controls, state, ui, setStatus, fetchBinary, getTexDir } from './viewerState.js';
import { loadTexture, pushUniqueName, logMapResolveDebug, getBgIndex } from './textureUtils.js';
import { ABinParser } from './ABinParser.js';

// Forward-declared: buildMesh is imported lazily to break circular dependency
let _buildMesh = null;
async function getBuildMesh() {
  if (!_buildMesh) {
    const mod = await import('./characterViewer.js');
    _buildMesh = mod.buildMesh;
  }
  return _buildMesh;
}

function softenMapMeshGloss(mesh) {
  const mats = Array.isArray(mesh?.material) ? mesh.material : [mesh?.material];
  for (const mat of mats) {
    if (!mat || !mat.isMeshPhongMaterial) continue;

    const shininess = Number(mat.shininess ?? 0);
    const hasSpecMap = !!mat.specularMap;
    const specPeak = mat.specular ? Math.max(mat.specular.r, mat.specular.g, mat.specular.b) : 0;
    const needsSoftening = hasSpecMap && shininess >= 30 && specPeak >= 0.30;
    if (!needsSoftening) continue;

    // Keep lighting response, but reduce specular peak and highlight size
    // only for materials that are likely to over-gloss.
    if (mat.specular) mat.specular.multiplyScalar(0.45);
    mat.shininess = Math.min(shininess, 14);
    mat.needsUpdate = true;
  }
}

function buildFrameRelativeMatrices(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return [];

  const locals = frames.map((frame) => {
    const rot = frame?.rot ?? [1,0,0,0,1,0,0,0,1];
    const pos = frame?.pos ?? [0,0,0];
    const [r0,r1,r2,r3,r4,r5,r6,r7,r8] = rot;
    return new THREE.Matrix4().set(
      r0, r3, r6, pos[0],
      r1, r4, r7, pos[1],
      r2, r5, r8, pos[2],
      0,  0,  0,  1
    );
  });

  const worlds = Array(frames.length);
  const rootIndexOf = Array(frames.length).fill(-1);
  for (let i = 0; i < frames.length; i++) {
    let w = locals[i].clone();
    let p = Number(frames[i]?.parentIndex ?? -1);
    let guard = 0;
    let root = i;
    while (p >= 0 && p < frames.length && guard < frames.length + 1) {
      w = locals[p].clone().multiply(w);
      root = p;
      p = Number(frames[p]?.parentIndex ?? -1);
      guard++;
    }
    worlds[i] = w;
    rootIndexOf[i] = root;
  }
  const invRootByIndex = new Map();
  const relatives = Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    const rootIdx = rootIndexOf[i];
    if (!invRootByIndex.has(rootIdx)) {
      invRootByIndex.set(rootIdx, worlds[rootIdx].clone().invert());
    }
    relatives[i] = invRootByIndex.get(rootIdx).clone().multiply(worlds[i]);
  }
  return relatives;
}

const atomicFramePos = new THREE.Vector3();
const atomicFrameQuat = new THREE.Quaternion();
const atomicFrameScale = new THREE.Vector3();

// ─── BSP 4-layer terrain shader ──────────────────────────────────────────────
function buildBSP4LayerMaterial(lightMap, t0, t1, t2, t3, layerScale, layerUV, useAlphaComposite = true) {
  const makeGray = () => {
    const d = new Uint8Array([128, 128, 128, 255]);
    const tx = new THREE.DataTexture(d, 1, 1); tx.needsUpdate = true; return tx;
  };
  const gray = makeGray();

  const vertexShader = /* glsl */`
    attribute vec2 aBlendUV;
    attribute vec2 aGroupUV;
    attribute vec2 aTilingUV;
    attribute vec2 aSecUV;
    attribute vec4 aPrelitColor;
    attribute vec2 aUV2;
    attribute vec2 aUV4raw;
    attribute vec2 aUV5;
    attribute vec2 aUV6;
    varying vec2 vUv0;
    varying vec2 vTilingUV;
    varying vec2 vSecUV;
    varying vec4 vBlend;
    varying float vT01;    // c0/c1 blend ratio, for alpha redistribution
    varying vec4 vRawUV;   // for debug: xy=aGroupUV(UV5), zw=aBlendUV(UV3)
    varying vec4 vPrelit;  // prelit vertex color RGBA
    varying vec2 vUV2;
    varying vec2 vUV4raw;
    varying vec2 vUV5;
    varying vec2 vUV6;
    void main() {
      vUv0      = uv;
      vTilingUV = aTilingUV;
      vSecUV    = aSecUV;
      vRawUV    = vec4(aGroupUV, aBlendUV);
      vPrelit   = aPrelitColor;
      vUV2      = aUV2;
      vUV4raw   = aUV4raw;
      vUV5      = aUV5;
      vUV6      = aUV6;

      // UV3.x = c0 vs c1 blend within group A
      // UV3.y - 1 = c2 weight (bridge/stone textures)
      // UV6.x = c3 weight (grass, exclusively debug 5)
      // gA = remainder for c0/c1
      float t01 = clamp(aBlendUV.x,        0.0, 1.0);
      float w2  = clamp(aBlendUV.y - 1.0,  0.0, 1.0);
      float w3  = clamp(aUV6.x,            0.0, 1.0);
      float gA  = max(1.0 - w2 - w3,       0.0);
      vT01 = t01;
      vBlend = vec4(
        gA * (1.0 - t01),   // w0 (c0)
        gA * t01,            // w1 (c1)
        w2,                  // w2 (c2)
        w3                   // w3 (c3)
      );

      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  const fragmentShader = /* glsl */`
    uniform sampler2D lightMap;
    uniform sampler2D tex0;
    uniform sampler2D tex1;
    uniform sampler2D tex2;
    uniform sampler2D tex3;
    uniform vec4 uLayerScale;
    uniform vec4 uLayerUV;
    uniform bool uUseLightMap;
    uniform bool uUseAlphaComposite;
    varying vec2 vUv0;
    varying vec2 vTilingUV;
    varying vec2 vSecUV;
    varying vec4 vBlend;
    varying float vT01;

    uniform float uDebugMode;
    varying vec4 vRawUV;
    varying vec4 vPrelit;
    varying vec2 vUV2;
    varying vec2 vUV4raw;
    varying vec2 vUV5;
    varying vec2 vUV6;

    vec2 pickUV(float selector) {
      // c_layerUV is expected to be 0 (tiling) or 1 (secondary atlas UV).
      // Treat unexpected values as tiling to avoid sampling the wrong UV set.
      return (selector > 0.5 && selector < 1.5) ? vSecUV : vTilingUV;
    }

    vec4 pickZoneSample(vec4 blend, vec4 d0, vec4 d1, vec4 d2, vec4 d3) {
      float y  = max(blend.r, 0.0); // yellow zone -> tex0
      float g1 = max(blend.g, 0.0); // green zone A -> tex1
      float p  = max(blend.b, 0.0); // pink/blue zone -> tex2
      float g2 = max(blend.a, 0.0); // green zone B -> tex3
      float g  = g1 + g2;
      const float YELLOW_BIAS = 0.035;
      const float BLUE_BIAS   = 0.015;

      float yScore = y + YELLOW_BIAS;
      float bScore = g + BLUE_BIAS;
      float pScore = p;
      if (yScore >= bScore && yScore >= pScore) return d0;
      if (bScore >= pScore) return (g1 >= g2) ? d1 : d3;
      return d2;
    }

    void main() {
      vec4 blend = vBlend;
      float total = blend.r + blend.g + blend.b + blend.a;
      if (total < 0.001) { blend = vec4(1.0, 0.0, 0.0, 0.0); total = 1.0; }

      // Per-layer UV: c_layerUV=0 uses tiling UV0, c_layerUV=1 uses secondary UV2
      vec2 tc0 = pickUV(uLayerUV.x) * uLayerScale.x;
      vec2 tc1 = pickUV(uLayerUV.y) * uLayerScale.y;
      vec2 tc2 = pickUV(uLayerUV.z) * uLayerScale.z;
      vec2 tc3 = pickUV(uLayerUV.w) * uLayerScale.w;

      vec4 d0 = texture2D(tex0, tc0);
      vec4 d1 = texture2D(tex1, tc1);
      vec4 d2 = texture2D(tex2, tc2);
      vec4 d3 = texture2D(tex3, tc3);

      vec4 col;
      if (uDebugMode > 0.5 && uDebugMode < 1.5) {
        // 1: Zone weights: R=yellow(c0), G=green(c1+c3), B=pink(c2)
        col = vec4(blend.r / total, (blend.g + blend.a) / total, blend.b / total, 1.0);
      } else if (uDebugMode > 1.5 && uDebugMode < 2.5) {
        col = d0; // 2: show only tex0
      } else if (uDebugMode > 2.5 && uDebugMode < 3.5) {
        col = d1; // 3: show only tex1
      } else if (uDebugMode > 3.5 && uDebugMode < 4.5) {
        col = d2; // 4: show only tex2
      } else if (uDebugMode > 4.5 && uDebugMode < 5.5) {
        col = d3; // 5: show only tex3
      } else if (uDebugMode > 5.5 && uDebugMode < 6.5) {
        float w3 = blend.a / total;
        col = vec4(w3, w3, w3, 1.0);
      } else if (uDebugMode > 6.5 && uDebugMode < 7.5) {
        col = vec4(vRawUV.x, vRawUV.y, 0.0, 1.0);
      } else if (uDebugMode > 7.5 && uDebugMode < 8.5) {
        col = vec4(vRawUV.z, vRawUV.w * 0.5, 0.0, 1.0);
      } else if (uDebugMode > 8.5 && uDebugMode < 9.5) {
        // 9: Render without pickUV — all layers use vTilingUV
        vec4 e0 = texture2D(tex0, vTilingUV * uLayerScale.x);
        vec4 e1 = texture2D(tex1, vTilingUV * uLayerScale.y);
        vec4 e2 = texture2D(tex2, vTilingUV * uLayerScale.z);
        vec4 e3 = texture2D(tex3, vTilingUV * uLayerScale.w);
        col = (e0*blend.r + e1*blend.g + e2*blend.b + e3*blend.a) / total;
        if (uUseLightMap) {
          vec3 lm = texture2D(lightMap, vUv0).rgb;
          col.rgb *= lm * 2.5;
        }
      } else if (uDebugMode > 9.5 && uDebugMode < 10.5) {
        col = vec4(vPrelit.rgb, 1.0);
      } else if (uDebugMode > 10.5 && uDebugMode < 11.5) {
        col = vec4(vPrelit.aaa, 1.0);
      } else if (uDebugMode > 11.5 && uDebugMode < 12.5) {
        col = vec4(fract(vUV2.x), fract(vUV2.y), 0.0, 1.0);
      } else if (uDebugMode > 12.5 && uDebugMode < 13.5) {
        col = vec4(fract(vUV5.x), fract(vUV5.y), 0.0, 1.0);
      } else if (uDebugMode > 13.5 && uDebugMode < 14.5) {
        col = vec4(fract(vUV6.x), fract(vUV6.y), 0.0, 1.0);
      } else if (uDebugMode > 14.5 && uDebugMode < 15.5) {
        if (uUseLightMap) {
          col = vec4(texture2D(lightMap, vUv0).rgb, 1.0);
        } else {
          col = vec4(0.5, 0.5, 0.5, 1.0);
        }
      } else if (uDebugMode > 19.5 && uDebugMode < 20.5) {
        col = vec4(fract(vTilingUV.x * 0.1), fract(vTilingUV.y * 0.1), 0.0, 1.0);
      } else if (uDebugMode > 20.5 && uDebugMode < 21.5) {
        col = vec4(vUv0.x, vUv0.y, 0.0, 1.0);
      } else if (uDebugMode > 21.5 && uDebugMode < 22.5) {
        col = vec4(fract(vUV2.x * 0.01), fract(vUV2.y * 0.01), 0.0, 1.0);
      } else if (uDebugMode > 22.5 && uDebugMode < 23.5) {
        col = vec4(clamp(vRawUV.z, 0.0, 1.0), clamp(vRawUV.w - 1.0, 0.0, 1.0), 0.0, 1.0);
      } else if (uDebugMode > 23.5 && uDebugMode < 24.5) {
        col = vec4(clamp(vUV4raw.x, 0.0, 1.0), clamp(vUV4raw.y, 0.0, 1.0), 0.0, 1.0);
      } else if (uDebugMode > 24.5 && uDebugMode < 25.5) {
        col = vec4(clamp(vRawUV.x, 0.0, 1.0), clamp(vRawUV.y - 1.0, 0.0, 1.0), 0.0, 1.0);
      } else if (uDebugMode > 25.5 && uDebugMode < 26.5) {
        col = vec4(clamp(vUV6.x, 0.0, 1.0), clamp(vUV6.y, 0.0, 1.0), 0.0, 1.0);
      } else {
        // 0: Normal rendering: smooth weighted blend with texture alpha compositing
        if (uUseAlphaComposite) {
          float w0 = blend.r;
          float w1 = blend.g;
          float w2 = blend.b * d2.a;
          float w3 = blend.a * d3.a;
          float lost = blend.b * (1.0 - d2.a) + blend.a * (1.0 - d3.a);
          w0 += lost * (1.0 - vT01);
          w1 += lost * vT01;
          float wTotal = w0 + w1 + w2 + w3;
          if (wTotal < 0.001) wTotal = 1.0;
          col = (d0 * w0 + d1 * w1 + d2 * w2 + d3 * w3) / wTotal;
        } else {
          // Fallback for maps where diffuse alpha is not reliable.
          col = (d0*blend.r + d1*blend.g + d2*blend.b + d3*blend.a) / total;
        }
        col.a = 1.0;
        if (uUseLightMap) {
          vec3 lm = texture2D(lightMap, vUv0).rgb;
          col.rgb *= lm * 2.5;
        }
      }

      col.a = 1.0;
      gl_FragColor = col;
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `;

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      lightMap:    { value: lightMap ?? gray },
      tex0:        { value: t0 ?? gray },
      tex1:        { value: t1 ?? gray },
      tex2:        { value: t2 ?? gray },
      tex3:        { value: t3 ?? gray },
      uLayerScale: { value: new THREE.Vector4(...layerScale) },
      uLayerUV:    { value: new THREE.Vector4(...layerUV) },
      uUseLightMap:{ value: !!lightMap },
      uUseAlphaComposite: { value: !!useAlphaComposite },
      uDebugMode:  { value: 0 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
  });
  mat._bspDebug = true;
  return mat;
}

// ─── BSP world geometry renderer ─────────────────────────────────────────────
async function buildBSPMesh(geoData, bspMaterials, texDir, resolvedTexOut = null, opts = {}) {
  const { vertices, normals, prelitColors, uvSets, matGroups } = geoData;
  const useAlphaComposite = opts.useAlphaComposite ?? true;
  const numVerts = vertices.length / 3;
  const empty = new Float32Array(numVerts * 2);
  const uvLightmap = uvSets[1] ?? empty;
  const uvTiling   = uvSets[0] ?? empty;
  const uvBlend    = uvSets[3] ?? empty;
  const uvGroup    = uvSets[5] ?? empty;
  // Diagnostic: dump UV ranges for all 7 sets
  for (let si = 0; si < 7; si++) {
    const s = uvSets[si];
    if (!s) { console.log(`[UV${si}] not present`); continue; }
    let minU=Infinity, maxU=-Infinity, minV=Infinity, maxV=-Infinity;
    for (let i = 0; i < s.length; i += 2) {
      const u = s[i], v = s[i+1];
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    console.log(`[UV${si}] U=[${minU.toFixed(4)}, ${maxU.toFixed(4)}] V=[${minV.toFixed(4)}, ${maxV.toFixed(4)}]`);
  }
  const uvSec      = uvSets[2] ?? empty;
  const uv2        = uvSets[2] ?? empty;
  const uv4raw     = uvSets[4] ?? empty;
  const uv5        = uvSets[5] ?? empty;
  const uv6        = uvSets[6] ?? empty;

  const bufGeo = new THREE.BufferGeometry();
  bufGeo.setAttribute('position',   new THREE.Float32BufferAttribute(vertices, 3));
  if (normals) bufGeo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  bufGeo.setAttribute('uv',         new THREE.Float32BufferAttribute(uvLightmap, 2));
  bufGeo.setAttribute('aTilingUV',  new THREE.Float32BufferAttribute(uvTiling, 2));
  bufGeo.setAttribute('aBlendUV',   new THREE.Float32BufferAttribute(uvBlend, 2));
  bufGeo.setAttribute('aGroupUV',   new THREE.Float32BufferAttribute(uvGroup, 2));
  bufGeo.setAttribute('aSecUV',     new THREE.Float32BufferAttribute(uvSec, 2));
  bufGeo.setAttribute('aUV2',       new THREE.Float32BufferAttribute(uv2, 2));
  bufGeo.setAttribute('aUV4raw',    new THREE.Float32BufferAttribute(uv4raw, 2));
  bufGeo.setAttribute('aUV5',       new THREE.Float32BufferAttribute(uv5, 2));
  bufGeo.setAttribute('aUV6',       new THREE.Float32BufferAttribute(uv6, 2));
  if (prelitColors) bufGeo.setAttribute('aPrelitColor', new THREE.Float32BufferAttribute(prelitColors, 4));

  const allIdx = [], mats = [];
  for (const [matIdx, idx] of [...matGroups.entries()].sort((a, b) => a[0] - b[0])) {
    bufGeo.addGroup(allIdx.length, idx.length, mats.length);
    allIdx.push(...idx);

    const bspMat     = bspMaterials[matIdx] ?? null;
    const layerScale = bspMat?.layerScale ?? [1.0, 1.0, 1.0, 1.0];
    const layerUV    = bspMat?.layerUV    ?? [0, 0, 0, 0];
    pushUniqueName(resolvedTexOut, bspMat?.ltmapTex);
    pushUniqueName(resolvedTexOut, bspMat?.c0);
    pushUniqueName(resolvedTexOut, bspMat?.c1);
    pushUniqueName(resolvedTexOut, bspMat?.c2);
    pushUniqueName(resolvedTexOut, bspMat?.c3);
    console.log(`[BSP mat${matIdx}] layerUV=[${layerUV}] scale=[${layerScale.map(f=>f.toFixed(2)).join(',')}] c0=${bspMat?.c0} c1=${bspMat?.c1} c2=${bspMat?.c2} c3=${bspMat?.c3}`);

    const [lightMap, t0, t1, t2, t3] = await Promise.all([
      bspMat?.ltmapTex ? loadTexture(texDir, bspMat.ltmapTex, THREE.LinearSRGBColorSpace) : Promise.resolve(null),
      bspMat?.c0 ? loadTexture(texDir, bspMat.c0, THREE.SRGBColorSpace) : Promise.resolve(null),
      bspMat?.c1 ? loadTexture(texDir, bspMat.c1, THREE.SRGBColorSpace) : Promise.resolve(null),
      bspMat?.c2 ? loadTexture(texDir, bspMat.c2, THREE.SRGBColorSpace) : Promise.resolve(null),
      bspMat?.c3 ? loadTexture(texDir, bspMat.c3, THREE.SRGBColorSpace) : Promise.resolve(null),
    ]);
    console.log(`[BSP tex${matIdx}] loaded: t0=${t0?'OK':'FAIL'}(${bspMat?.c0}) t1=${t1?'OK':'FAIL'}(${bspMat?.c1}) t2=${t2?'OK':'FAIL'}(${bspMat?.c2}) t3=${t3?'OK':'FAIL'}(${bspMat?.c3}) lm=${lightMap?'OK':'FAIL'}`);

    mats.push(buildBSP4LayerMaterial(lightMap, t0, t1, t2, t3, layerScale, layerUV, useAlphaComposite));
  }

  bufGeo.setIndex(allIdx);
  if (!normals) bufGeo.computeVertexNormals();
  return new THREE.Mesh(bufGeo, mats);
}

// ─── 4-way terrain blend shader ──────────────────────────────────────────────
export function buildTerrainBlendMaterial(tex0, tex1, tex2, tex3, hasVertexAlpha) {
  const vertexShader = /* glsl */`
    attribute vec4 aBlend;
    varying vec2 vUv;
    varying vec4 vBlend;
    void main() {
      vUv    = uv;
      vBlend = aBlend;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  const fragmentShader = /* glsl */`
    uniform sampler2D uMap0, uMap1, uMap2, uMap3;
    uniform bool      uHas0, uHas1, uHas2, uHas3;
    varying vec2 vUv;
    varying vec4 vBlend;
    void main() {
      vec4 w = vBlend;
      float s = w.r + w.g + w.b + w.a;
      if (s > 0.001) w /= s; else w = vec4(0.25);
      float y  = max(w.r, 0.0);
      float g1 = max(w.g, 0.0);
      float p  = max(w.b, 0.0);
      float g2 = max(w.a, 0.0);
      float g  = g1 + g2;
      const float YELLOW_BIAS = 0.035;
      const float BLUE_BIAS   = 0.015;
      vec4 d0 = uHas0 ? texture2D(uMap0, vUv) : vec4(0.0);
      vec4 d1 = uHas1 ? texture2D(uMap1, vUv) : d0;
      vec4 d2 = uHas2 ? texture2D(uMap2, vUv) : d0;
      vec4 d3 = uHas3 ? texture2D(uMap3, vUv) : d1;
      vec4 col = vec4(0.0);
      float yScore = y + YELLOW_BIAS;
      float bScore = g + BLUE_BIAS;
      float pScore = p;
      if (yScore >= bScore && yScore >= pScore)      col = d0;
      else if (bScore >= pScore)                     col = (g1 >= g2) ? d1 : d3;
      else                                            col = d2;
      gl_FragColor = vec4(col.rgb, 1.0);
    }
  `;
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap0: { value: tex0 }, uMap1: { value: tex1 },
      uMap2: { value: tex2 }, uMap3: { value: tex3 },
      uHas0: { value: !!tex0 }, uHas1: { value: !!tex1 },
      uHas2: { value: !!tex2 }, uHas3: { value: !!tex3 },
    },
    vertexShader,
    fragmentShader,
    side:        THREE.DoubleSide,
    transparent: hasVertexAlpha,
    alphaTest:   0.05,
  });
}

// ─── Map selection ────────────────────────────────────────────────────────────
export function selectMapObject(li, group) {
  if (state.mapSelHelper) { scene.remove(state.mapSelHelper); state.mapSelHelper = null; }
  if (state.mapSelLi) state.mapSelLi.classList.remove('active');
  state.mapSelLi = li;
  li.classList.add('active');
  li.scrollIntoView({ block: 'nearest' });

  state.mapSelHelper = new THREE.BoxHelper(group, 0xff8800);
  scene.add(state.mapSelHelper);

  const box = new THREE.Box3().setFromObject(group);
  if (!box.isEmpty() && Number.isFinite(box.min.x)) {
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3()).length();
    const dist   = Math.max(size * 1.5, 0.5);
    const dir    = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(center).addScaledVector(dir, dist);
    controls.target.copy(center);
    controls.update();
  }
}

// ─── Map helpers ──────────────────────────────────────────────────────────────
export function clearMap() {
  if (state.mapSelHelper) { scene.remove(state.mapSelHelper); state.mapSelHelper = null; }
  state.mapSelLi = null;
  if (state.mapGroup)       { scene.remove(state.mapGroup);       state.mapGroup = null; }
  if (state.mapNodeHelpers) { scene.remove(state.mapNodeHelpers); state.mapNodeHelpers = null; }
  ui.mapObjList.innerHTML = '';
  state.mapShowWire = false;
  state.mapShowNodes = false;
  ui.btnMapWire.classList.remove('active');
  ui.btnMapNodes.classList.remove('active');
}

async function tryFetchDFF(name) {
  const { dff } = await getBgIndex();
  const key = name.toLowerCase();
  const url = dff.get(key) ?? dff.get(key + '_ao');
  if (!url) return null;
  try {
    const buffer = await fetchBinary(url);
    return { url, buffer };
  } catch { return null; }
}

async function tryFetchBSP(name) {
  const { bsp } = await getBgIndex();
  const key = name.toLowerCase();
  const url = bsp.get(key);
  if (!url) return null;
  try {
    const buffer = await fetchBinary(url);
    return { url, buffer };
  } catch { return null; }
}

// ─── Load map ─────────────────────────────────────────────────────────────────
export async function loadMap(abinFile) {
  clearMap();
  setStatus('Loading map…');
  const mapDir = abinFile.replace(/\.abin$/i, '');
  const mapBase = mapDir.split('/').pop();
  // Use pure weight blending for all terrain maps while keeping per-layer UV selection.
  const useTerrainAlphaComposite = false;
  const buildMesh = await getBuildMesh();
  try {
    const buf      = await fetchBinary(`${BASE}/${ABIN_DIR}/${abinFile}`);
    const abinData = new ABinParser().parse(buf);
    state.mapGroup = new THREE.Group();
    state.mapGroup.scale.setScalar(0.01);
    scene.add(state.mapGroup);
    ui.mapObjList.innerHTML = '';

    let loaded = 0, missing = 0;
    const tasks = abinData.models.map(async (model) => {
      const li = document.createElement('li');
      li.textContent = model.name || '(unnamed)';
      const u32ToF32 = u32 => new Float32Array(new Uint32Array([u32]).buffer)[0].toFixed(4);
      const preF32  = (model.pre  ?? []).map(u32ToF32);
      const postF32 = (model.post ?? []).map(u32ToF32);
      li.title = [
        `pos=(${model.position.map(v => v.toFixed(2)).join(', ')})`,
        `val=${model.val?.toFixed(4)}  flags=[${(model.flags ?? []).join(', ')}]`,
        `pre(f32) =[${preF32.join(', ')}]`,
        `  last4  =[${preF32.slice(8).join(', ')}]  ← quaternion candidate`,
        `post(f32)=[${postF32.join(', ')}]`,
        `m31=${model.member31}  m37=${model.member37}`,
      ].join('\n');
      ui.mapObjList.appendChild(li);
      if (!model.name) { li.className = 'missing'; missing++; return; }

      const dffAsset = await tryFetchDFF(model.name);
      if (!dffAsset) { li.className = 'missing'; missing++; return; }

      try {
        const dffData = new DFFParser().parse(dffAsset.buffer);
        const frameRelativeMatrices = buildFrameRelativeMatrices(dffData.frames ?? []);
        const resolvedDebug = { dffUrl: dffAsset.url, bspUrl: null, dffNames: [], bspNames: [] };

        let bspTextures = null;
        let bspGeoData  = null;
        try {
          const bspAsset = await tryFetchBSP(model.name);
          if (bspAsset) {
            resolvedDebug.bspUrl = bspAsset.url;
            const parser = new BSPParser();
            bspTextures  = parser.parse(bspAsset.buffer);
            bspGeoData   = parser.parseWorldGeometry(bspAsset.buffer);
            if (bspTextures) {
              const sample = bspTextures.map((m, i) =>
                `[${i}] splat=${m?.ltmapTex ?? 'null'} c0=${m?.c0 ?? '-'} c1=${m?.c1 ?? '-'} c2=${m?.c2 ?? '-'} c3=${m?.c3 ?? '-'}`
              ).join('\n');
              console.log(`[BSP mats] ${model.name} (${bspTextures.length} mats):\n` + sample);
            }
          }
        } catch { /* BSP optional */ }

        const isMapTerrain = model.name.toLowerCase() === mapBase.toLowerCase();

        let sceneObj;
        if (isMapTerrain && bspGeoData && bspTextures?.length) {
          console.log(`[BSP render] ${model.name}: ${bspGeoData.vertices.length/3} verts, ${bspGeoData.matGroups.size} groups, ${bspTextures.length} mats, uvSets=${bspGeoData.uvSets.length}`);
          sceneObj = await buildBSPMesh(
            bspGeoData,
            bspTextures,
            getTexDir('bg-index'),
            resolvedDebug.bspNames,
            { useAlphaComposite: useTerrainAlphaComposite }
          );
          state.mapGroup.add(sceneObj);
          li.className = 'terrain';
        } else {
          const group = new THREE.Group();
          group.position.set(model.position[0], model.position[1], model.position[2]);
          if (model.rotation) group.quaternion.set(model.rotation[0], model.rotation[1], model.rotation[2], model.rotation[3]);
          if (model.scale) group.scale.set(model.scale[0], model.scale[1], model.scale[2]);
          const renderableAtomics = (dffData.atomics ?? []).filter((atomic) =>
            atomic.renderFlags === 0 || (atomic.renderFlags & 0x04) !== 0
          );

          for (const atomic of renderableAtomics) {
            const geo  = dffData.geometries[atomic.geometryIndex];
            const mesh = await buildMesh(geo, getTexDir('bg-index'), [], dffData.frames ?? [], null, false, bspTextures, resolvedDebug.dffNames);
            if (!mesh) continue;
            softenMapMeshGloss(mesh);

            const frameMtx = frameRelativeMatrices[atomic.frameIndex];
            if (frameMtx) {
              frameMtx.decompose(atomicFramePos, atomicFrameQuat, atomicFrameScale);
              mesh.position.copy(atomicFramePos);
              mesh.quaternion.copy(atomicFrameQuat);
            }
            group.add(mesh);
          }
          state.mapGroup.add(group);
          sceneObj = group;
          li.className = model.typeCode === 1 ? 'terrain' : 'loaded';
        }
        logMapResolveDebug(model.name, resolvedDebug);
        li.style.cursor = 'pointer';
        li.addEventListener('click', () => selectMapObject(li, sceneObj));
        loaded++;
      } catch (e) {
        li.className = 'missing'; missing++;
        console.warn(`[MAP] ${model.name}:`, e.message);
      }
    });
    await Promise.all(tasks);

    if (abinData.nodes?.length) {
      state.mapNodeHelpers = new THREE.Group();
      state.mapNodeHelpers.scale.setScalar(0.01);
      const sphereGeo = new THREE.SphereGeometry(0.2, 6, 4);
      const sphereMat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });
      for (const node of abinData.nodes) {
        for (const pos of node.positions ?? []) {
          const s = new THREE.Mesh(sphereGeo, sphereMat);
          s.position.set(pos[0], pos[1], pos[2]);
          state.mapNodeHelpers.add(s);
        }
      }
      state.mapNodeHelpers.visible = false;
      scene.add(state.mapNodeHelpers);
    }

    const sun = new THREE.DirectionalLight(0xfff5e0, 1.8);
    sun.position.set(0.4, 1, 0.6).normalize();
    state.mapGroup.add(sun);
    const fill = new THREE.DirectionalLight(0xc8d8ff, 0.6);
    fill.position.set(-0.5, 0.2, -0.8).normalize();
    state.mapGroup.add(fill);

    const box = new THREE.Box3().setFromObject(state.mapGroup);
    if (!box.isEmpty() && Number.isFinite(box.min.x)) {
      const center = box.getCenter(new THREE.Vector3());
      const size   = box.getSize(new THREE.Vector3());
      const hSpan  = Math.max(size.x, size.z);
      controls.target.set(center.x, center.y, center.z);
      camera.position.set(
        center.x + hSpan * 0.35,
        center.y + hSpan * 0.30,
        center.z + hSpan * 0.60
      );
      controls.update();
    }
    setStatus(`Map: ${mapDir}  —  ${loaded} loaded, ${missing} missing`);
  } catch (e) {
    setStatus(`Map error: ${e.message}`, true);
    console.error(e);
  }
}
