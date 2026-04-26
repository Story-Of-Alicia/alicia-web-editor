import * as THREE from 'three';
import { DFFParser } from './DFFParser.js';
import { ANMParser } from './ANMParser.js';
import { BASE, scene, camera, controls, state, ui, CHAR_CFG, setStatus, fetchBinary, getTexDir, initUserLight, updateUserLight } from './viewerState.js';
import { loadTexture, loadTextureSet, normalizeTextureStem, pushUniqueName } from './textureUtils.js';
import { buildTerrainBlendMaterial } from './mapViewer.js';

// ─── Frame / bone helpers ─────────────────────────────────────────────────────

function getFrameAnimIndex(frame) {
  const hierarchyIndex = Number(frame?.hierarchyIndex);
  if (Number.isInteger(hierarchyIndex) && hierarchyIndex >= 0) return hierarchyIndex;
  const nodeIndex = Number(frame?.nodeIndex);
  if (Number.isInteger(nodeIndex) && nodeIndex >= 0) return nodeIndex;
  return -1;
}

export function hasActiveAnimationPose() {
  return Boolean(state.currentAction && (state.currentAction.isRunning() || state.currentAction.paused));
}

function buildSharedFrameNameMap(frames) {
  const map = new Map();
  frames?.forEach((frame, index) => {
    if (frame?.name && !map.has(frame.name)) map.set(frame.name, index);
  });
  return map;
}

function getFrameSkinBoneId(frame, frameIndex, skin, useNodeIds = false) {
  // Only treat nodeId as valid if it was explicitly set (not null/undefined).
  // Number(null) === 0 would otherwise map every un-parsed frame to bone 0.
  if (frame?.nodeId != null) {
    const nodeId = Number(frame.nodeId);
    if (Number.isInteger(nodeId) && nodeId >= 0 && nodeId < skin.numBones) return nodeId;
    // nodeId was set but out of range — respect useNodeIds to avoid bad fallback.
    if (useNodeIds) return -1;
  }
  // nodeId was never set (null) — always fall back to frameIndex regardless of useNodeIds.
  // This handles extra DFF-specific bones (e.g. armor attachment bones) that have no HAnim.
  if (frameIndex >= 0 && frameIndex < skin.numBones) return frameIndex;
  return -1;
}

function buildSkinBinding(frames, skin) {
  const useNodeIds = frames.some((frame) => {
    if (frame?.nodeId == null) return false;
    const nodeId = Number(frame.nodeId);
    return Number.isInteger(nodeId) && nodeId >= 0 && nodeId < skin.numBones;
  });

  const frameIndexByBoneId = new Map();
  frames.forEach((frame, frameIndex) => {
    const boneId = getFrameSkinBoneId(frame, frameIndex, skin, useNodeIds);
    if (boneId >= 0 && !frameIndexByBoneId.has(boneId)) frameIndexByBoneId.set(boneId, frameIndex);
  });

  const skinIndices = new Uint16Array(skin.boneIndices.length);
  for (let i = 0; i < skin.boneIndices.length; i++) {
    skinIndices[i] = frameIndexByBoneId.get(skin.boneIndices[i]) ?? 0;
  }

  return { skinIndices, frameIndexByBoneId };
}

function cloneBoneInverses(boneInverses) {
  return boneInverses?.map((matrix) => matrix.clone()) ?? null;
}

function getRootBone(frames, bones) {
  const rootBoneIdx = frames.findIndex(f => f.parentIndex < 0);
  return bones[rootBoneIdx >= 0 ? rootBoneIdx : 0];
}

function calculateRestBoneInverses(rootBone, bones) {
  rootBone.updateWorldMatrix(true, true);
  return bones.map((bone) => bone.matrixWorld.clone().invert());
}

function buildSkinnedBoneInverses(frames, bones, skin, skinBinding) {
  if (!skin?.inverseBindMatrices?.length || !skinBinding?.frameIndexByBoneId) return null;

  const boneInverses = calculateRestBoneInverses(getRootBone(frames, bones), bones);
  skin.inverseBindMatrices.forEach((matrixValues, boneId) => {
    const frameIndex = skinBinding.frameIndexByBoneId.get(boneId);
    if (frameIndex == null || !Array.isArray(matrixValues) || matrixValues.length !== 16) return;
    boneInverses[frameIndex] = new THREE.Matrix4().fromArray(matrixValues);
  });

  return boneInverses;
}

function findSharedBoneByName(name) {
  if (!name || !state.sharedFrames?.length || !state.sharedBones?.length) return null;
  const frameIndex = buildSharedFrameNameMap(state.sharedFrames).get(name);
  return frameIndex == null ? null : state.sharedBones[frameIndex];
}

function pushBoneLink(links, source, target, syncPosition = false) {
  if (!source || !target || links.some(link => link.target === target)) return;
  links.push({ source, target, syncPosition });
}

function isGeneratedFrameName(name) {
  return /^bone_\d+$/.test(name ?? '');
}

function isDummyRootFrameName(name) {
  return /^Opt_DummyRoot_r\d\d$/i.test(name ?? '');
}

function buildHairAttachment(localFrames, localBones) {
  if (!state.sharedFrames?.length || !state.sharedBones?.length) return null;

  const localHeadIndex = localFrames.findIndex(frame => frame?.name === 'Opt_Bip01_Head');
  const localHeadBone = localBones[localHeadIndex >= 0 ? localHeadIndex : 2];
  const sharedHeadBone = findSharedBoneByName('Opt_Bip01_Head');
  if (!localHeadBone || !sharedHeadBone) return null;

  return {
    source: sharedHeadBone,
    target: localHeadBone,
    targetLocalInverse: null,
  };
}

function buildHairAnimationAttachment(localFrames, localBones) {
  if (!state.sharedFrames?.length || !state.sharedBones?.length) return null;

  const localHeadIndex = localFrames.findIndex(frame => frame?.name === 'Opt_Bip01_Head');
  const localHeadBone = localBones[localHeadIndex >= 0 ? localHeadIndex : 2];
  const sharedHeadBone = findSharedBoneByName('Opt_Bip01_Head');
  if (!localHeadBone || !sharedHeadBone) return null;

  return {
    source: sharedHeadBone,
    target: localHeadBone,
    restOffset: new THREE.Vector3(),
  };
}

function hasRiggedHairBones(localFrames) {
  if (!state.sharedFrames?.length) return false;
  const sharedByName = buildSharedFrameNameMap(state.sharedFrames);
  return localFrames.some((frame) => {
    if (!frame?.name || !frame.name.trim()) return false;
    if (isGeneratedFrameName(frame.name)) return false;
    return !sharedByName.has(frame.name);
  });
}

function buildHairBoneLinks(localFrames, localBones) {
  if (!state.sharedFrames?.length || !state.sharedBones?.length) return [];

  const sharedByName = buildSharedFrameNameMap(state.sharedFrames);
  const links = [];
  const syncPositionNames = new Set(['Opt_Bip01_Neck', 'Opt_Bip01_Head']);

  localFrames.forEach((frame, index) => {
    if (!frame?.name) return;
    const sharedIndex = sharedByName.get(frame.name);
    if (sharedIndex == null) return;
    pushBoneLink(
      links,
      state.sharedBones[sharedIndex],
      localBones[index],
      isDummyRootFrameName(frame.name) || syncPositionNames.has(frame.name)
    );
  });

  return links;
}

export function buildBoneLinks(localFrames, localBones, slotId = '') {
  if (!state.sharedFrames?.length || !state.sharedBones?.length) return [];

  const sharedByName = buildSharedFrameNameMap(state.sharedFrames);
  const links = [];
  const syncPositionNames = new Set(['Opt_Bip01']);
  if (slotId === 'hat' || slotId === 'accessory') {
    syncPositionNames.add('Opt_Bip01_Neck');
    syncPositionNames.add('Opt_Bip01_Head');
  }

  localFrames.forEach((frame, index) => {
    if (!frame?.name) return;
    const sharedIndex = sharedByName.get(frame.name);
    if (sharedIndex == null) return;
    pushBoneLink(
      links,
      state.sharedBones[sharedIndex],
      localBones[index],
      isDummyRootFrameName(frame.name) || syncPositionNames.has(frame.name)
    );
  });

  if (links.length && !links.some(link => link.syncPosition)) {
    links[0].syncPosition = true;
  }

  return links;
}

// ─── Bone sync temporaries ────────────────────────────────────────────────────
const syncIdentityMatrix = new THREE.Matrix4();
const syncParentInverseMatrix = new THREE.Matrix4();
const syncLocalMatrix = new THREE.Matrix4();
const syncLocalPosition = new THREE.Vector3();
const syncLocalQuaternion = new THREE.Quaternion();
const syncLocalScale = new THREE.Vector3();
const syncAttachmentLocalMatrix = new THREE.Matrix4();
const syncAttachmentSourcePosition = new THREE.Vector3();
const syncAttachmentTargetPosition = new THREE.Vector3();
const syncAttachmentGroupWorldPosition = new THREE.Vector3();
const syncAttachmentDeltaPosition = new THREE.Vector3();

export function syncBoneLinks(links) {
  for (const { source, target, syncPosition } of links) {
    if (!source || !target) continue;
    source.updateWorldMatrix(true, false);
    const parentInverse = target.parent
      ? syncParentInverseMatrix.copy(target.parent.matrixWorld).invert()
      : syncIdentityMatrix;
    syncLocalMatrix.multiplyMatrices(parentInverse, source.matrixWorld);
    syncLocalMatrix.decompose(syncLocalPosition, syncLocalQuaternion, syncLocalScale);
    target.quaternion.copy(syncLocalQuaternion);
    if (syncPosition) target.position.copy(syncLocalPosition);
    target.updateMatrixWorld(true);
  }
}

function captureAttachmentTargetLocalInverse(group, attachment) {
  if (!attachment) return;
  attachment.target.updateWorldMatrix(true, false);
  attachment.targetLocalInverse = group.matrixWorld.clone().invert().multiply(attachment.target.matrixWorld).invert();
}

function captureAnimationAttachmentOffset(group, attachment) {
  if (!attachment) return;
  attachment.source.updateWorldMatrix(true, false);
  group.updateWorldMatrix(true, false);
  syncAttachmentSourcePosition.setFromMatrixPosition(attachment.source.matrixWorld);
  syncAttachmentGroupWorldPosition.setFromMatrixPosition(group.matrixWorld);
  attachment.restOffset.copy(syncAttachmentGroupWorldPosition).sub(syncAttachmentSourcePosition);
}

export function syncAttachmentGroup(group, attachment) {
  if (!attachment?.source || !attachment?.target) return;
  attachment.source.updateWorldMatrix(true, false);
  attachment.target.updateWorldMatrix(true, false);
  if (attachment.targetLocalInverse) {
    syncAttachmentLocalMatrix.multiplyMatrices(attachment.target.matrixWorld, attachment.targetLocalInverse);
  } else {
    syncAttachmentLocalMatrix.copy(attachment.source.matrixWorld);
  }
  group.matrixAutoUpdate = false;
  group.matrix.copy(syncAttachmentLocalMatrix);
  group.matrixWorld.copy(syncAttachmentLocalMatrix);
}

export function syncAttachmentGroupPosition(group, attachment) {
  if (!attachment?.source) return;
  attachment.source.updateWorldMatrix(true, false);
  group.updateWorldMatrix(true, false);
  syncAttachmentSourcePosition.setFromMatrixPosition(attachment.source.matrixWorld);
  syncAttachmentTargetPosition.copy(syncAttachmentSourcePosition).add(attachment.restOffset);
  const parent = group.parent;
  if (parent) {
    parent.updateWorldMatrix(true, false);
    syncAttachmentDeltaPosition.copy(syncAttachmentTargetPosition);
    const parentInverse = syncParentInverseMatrix.copy(parent.matrixWorld).invert();
    syncAttachmentDeltaPosition.applyMatrix4(parentInverse);
    group.position.copy(syncAttachmentDeltaPosition);
  } else {
    group.position.copy(syncAttachmentTargetPosition);
  }
  group.updateMatrixWorld(true);
}

// ─── Build bones from DFF frames ─────────────────────────────────────────────
export function buildBones(frames, namePrefix = 'bone') {
  const bones = frames.map((_f, i) => {
    const b = new THREE.Bone();
    b.name  = `${namePrefix}_${i}`;
    return b;
  });
  frames.forEach((f, i) => {
    const [r0,r1,r2,r3,r4,r5,r6,r7,r8] = f.rot;
    const m = new THREE.Matrix4().set(
      r0, r3, r6, f.pos[0],
      r1, r4, r7, f.pos[1],
      r2, r5, r8, f.pos[2],
      0,  0,  0,  1
    );
    if (f.parentIndex >= 0) {
      bones[f.parentIndex].add(bones[i]);
      bones[i].matrix.copy(m);
      bones[i].matrix.decompose(bones[i].position, bones[i].quaternion, bones[i].scale);
    } else {
      bones[i].position.set(f.pos[0], f.pos[1], f.pos[2]);
    }
  });
  return bones;
}

// ─── Build a single SkinnedMesh from a parsed DFF geometry ───────────────────
export async function buildMesh(geo, texDir, bones, frames, boneInverses = null, attachRoot = false, bspTextures = null, resolvedTexOut = null) {
  if (!geo || geo.isNative || !geo.vertices?.length) return null;
  if (geo.numUVSets === 0 && !geo.materials?.some(m => m?.textureName)) return null;
  const skinBinding = geo.skin ? buildSkinBinding(frames, geo.skin) : null;

  const matGroups = new Map();
  for (let t = 0; t < geo.numTriangles; t++) {
    const v1 = geo.triangles[t*4], v2 = geo.triangles[t*4+1];
    const v3 = geo.triangles[t*4+2], mid = geo.triangles[t*4+3];
    if (!matGroups.has(mid)) matGroups.set(mid, []);
    matGroups.get(mid).push(v1, v2, v3);
  }

  const bufGeo = new THREE.BufferGeometry();
  bufGeo.setAttribute('position', new THREE.Float32BufferAttribute(geo.vertices, 3));
  if (geo.normals?.length)  bufGeo.setAttribute('normal', new THREE.Float32BufferAttribute(geo.normals, 3));

  let uvData = geo.uvSets?.[0] ?? null;
  if (uvData && bspTextures) {
    let maxUV = 0;
    for (let i = 0; i < uvData.length; i++) if (uvData[i] > maxUV) maxUV = uvData[i];
    if (maxUV > 0 && maxUV < 100) {
      const scale = 100 / maxUV;
      const scaled = new Float32Array(uvData.length);
      for (let i = 0; i < uvData.length; i++) scaled[i] = uvData[i] * scale;
      uvData = scaled;
    }
  }

  if (uvData) bufGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvData, 2));
  if (skinBinding) {
    bufGeo.setAttribute('skinIndex',  new THREE.Uint16BufferAttribute(skinBinding.skinIndices, 4));
    bufGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(geo.skin.boneWeights, 4));
  }

  let hasVertexAlpha = false;
  if (geo.colors) {
    const fc = new Float32Array(geo.colors.length);
    for (let i = 0; i < geo.colors.length; i++) fc[i] = geo.colors[i] / 255;
    bufGeo.setAttribute('color',   new THREE.Float32BufferAttribute(fc, 4));
    bufGeo.setAttribute('aBlend',  new THREE.Float32BufferAttribute(fc, 4));
    for (let i = 3; i < geo.colors.length; i += 4) if (geo.colors[i] < 250) { hasVertexAlpha = true; break; }
  }

  if (uvData) {
    bufGeo.setAttribute('uv2', new THREE.Float32BufferAttribute(uvData, 2));
  }

  const allIdx = [], mats = [];
  for (const [mid, idx] of [...matGroups.entries()].sort((a,b) => a[0]-b[0])) {
    bufGeo.addGroup(allIdx.length, idx.length, mats.length);
    allIdx.push(...idx);
    const matDef = geo.materials[mid];
    const dfftex      = matDef?.textureName ?? null;
    const blendMatch  = (dfftex ?? '').match(/^c_diffTex(\d)/i);
    const blendChIdx  = blendMatch ? Number(blendMatch[1]) : -1;
    const isBlendMat  = blendChIdx >= 0;
    const bspMat      = isBlendMat && Array.isArray(bspTextures)
                          ? (bspTextures[mid] ?? bspTextures[0]) : null;
    const dffChannels = matDef?.texChannels ?? null;
    const dffChannelStems = dffChannels ? [dffChannels.c0, dffChannels.c1, dffChannels.c2, dffChannels.c3] : [null, null, null, null];
    const dffChannelCount = dffChannelStems.filter(Boolean).length;
    const useDffChannelZones = !isBlendMat && geo.colors && dffChannelCount > 1;

    let mat;
    if ((isBlendMat && bspMat && geo.colors) || useDffChannelZones) {
      const stems = useDffChannelZones ? dffChannelStems : [bspMat.c0, bspMat.c1, bspMat.c2, bspMat.c3];
      stems.forEach((s) => pushUniqueName(resolvedTexOut, s));
      const [t0, t1, t2, t3] = await Promise.all(
        stems.map(s => s ? loadTexture(texDir, s, THREE.SRGBColorSpace) : Promise.resolve(null))
      );
      mat = buildTerrainBlendMaterial(t0, t1, t2, t3, hasVertexAlpha);
    } else {
      let texName = dfftex;
      if (isBlendMat && bspMat) {
        const preferredKey = blendChIdx >= 0 ? `c${blendChIdx}` : null;
        texName = (preferredKey ? bspMat[preferredKey] : null)
          ?? bspMat.c0 ?? bspMat.c1 ?? bspMat.c2 ?? bspMat.c3
          ?? dfftex ?? null;
      }
      const texSet  = texName ? await loadTextureSet(texDir, texName) : {};
      const baseColor = matDef?.color
        ? new THREE.Color(matDef.color[0] / 255, matDef.color[1] / 255, matDef.color[2] / 255)
        : new THREE.Color(0xffffff);
      const disableTerrainVertexTint = !!(bspTextures && geo.colors && (isBlendMat || dffChannelCount > 0));
      const alphaTestEnabled = Number(dffChannels?.alphaTest ?? 0) > 0;
      const alphaMaskStem = alphaTestEnabled ? normalizeTextureStem(matDef?.maskName) : null;
      pushUniqueName(resolvedTexOut, texName);
      pushUniqueName(resolvedTexOut, alphaMaskStem);
      pushUniqueName(resolvedTexOut, dffChannels?.aoTex1);
      pushUniqueName(resolvedTexOut, dffChannels?.specTex0);
      pushUniqueName(resolvedTexOut, dffChannels?.selfIlumTex0);
      const alphaMapTex = alphaMaskStem
        ? await loadTexture(texDir, alphaMaskStem, THREE.LinearSRGBColorSpace)
        : null;
      // +ab = DXT5 texture with embedded alpha channel (alpha blended, e.g. lace/mesh fabric).
      // transparent:true + depthWrite:true gives blending while keeping correct depth occlusion.
      const alphaBlend = /\+ab\b/i.test(texName ?? '');
      const alphaClip  = alphaTestEnabled ? 0.30 : 0.0;

      mat = geo.colors != null
        ? new THREE.MeshBasicMaterial({
            map:          texSet.map ?? null,
            alphaMap:     alphaMapTex ?? null,
            color:        new THREE.Color(1, 1, 1),
            vertexColors: !disableTerrainVertexTint,
            side:         THREE.DoubleSide,
            transparent:  alphaBlend,
            depthWrite:   true,
            alphaTest:    alphaBlend ? 0.0 : alphaClip,
          })
        : new THREE.MeshPhongMaterial({
            map:          texSet.map     ?? null,
            alphaMap:     alphaMapTex    ?? null,
            specularMap:  texSet.specMap ?? null,
            emissiveMap:  texSet.sssMap  ?? null,
            color:        baseColor,
            specular:     new THREE.Color(0.35, 0.35, 0.35),
            shininess:    40,
            emissive:     texSet.sssMap ? new THREE.Color(0.12, 0.09, 0.07) : new THREE.Color(0, 0, 0),
            side:         THREE.DoubleSide,
            transparent:  alphaBlend,
            depthWrite:   true,
            alphaTest:    alphaBlend ? 0.0 : alphaClip,
          });
      // Store the DFF texture stem on the material so coat/skin swaps can match by name
      // even when mat.map is null (texture failed to load) or is a compressed DDS.
      if (texName) mat.userData.dffTexName = normalizeTextureStem(texName)?.toLowerCase() ?? '';
    }
    mats.push(mat);
  }
  bufGeo.setIndex(allIdx);
  if (!geo.normals?.length) bufGeo.computeVertexNormals();

  if (!geo.skin || !bones.length) return new THREE.Mesh(bufGeo, mats);

  const rootBone = getRootBone(frames, bones);
  const resolvedBoneInverses = cloneBoneInverses(boneInverses)
    ?? buildSkinnedBoneInverses(frames, bones, geo.skin, skinBinding)
    ?? calculateRestBoneInverses(rootBone, bones);
  const skeleton = attachRoot
    ? new THREE.Skeleton(bones, resolvedBoneInverses)
    : new THREE.Skeleton(bones, resolvedBoneInverses);
  const mesh = new THREE.SkinnedMesh(bufGeo, mats);
  if (attachRoot) {
    mesh.add(rootBone);
    mesh.bind(skeleton);
  } else {
    mesh.bindMode = THREE.DetachedBindMode;
    mesh.bind(skeleton, new THREE.Matrix4());
  }
  mesh.normalizeSkinWeights();
  mesh.frustumCulled = false;
  return mesh;
}

// ─── Load one slot part ───────────────────────────────────────────────────────
async function loadSlot(slotId, meshName) {
  const cfg = CHAR_CFG[state.charName];
  const url = `${BASE}/${cfg.partsDir}/${meshName}.dff`;

  const buf     = await fetchBinary(url);
  const dffData = new DFFParser().parse(buf);
  let skeletonRoot = null;
  let boneLinks = [];
  let attachLocalSkeleton = false;
  let attachmentBinding = null;
  let animationAttachment = null;
  let alwaysSyncBoneLinks = false;

  let useBones, useFrames;
  if ((dffData.frames?.length ?? 0) === state.sharedFrames.length) {
    useBones  = state.sharedBones;
    useFrames = state.sharedFrames;
  } else {
    useFrames = dffData.frames;
    useBones  = buildBones(useFrames, `local_${slotId}`);
    const localRootIdx = useFrames.findIndex(f => f.parentIndex < 0);
    skeletonRoot = useBones[localRootIdx >= 0 ? localRootIdx : 0];
    const useHairBoneLinks = slotId === 'hair' && hasRiggedHairBones(useFrames);
    attachmentBinding = slotId === 'hair' && !useHairBoneLinks ? buildHairAttachment(useFrames, useBones) : null;
    animationAttachment = null;
    boneLinks = slotId === 'hair'
      ? (useHairBoneLinks ? buildHairBoneLinks(useFrames, useBones) : [])
      : buildBoneLinks(useFrames, useBones, slotId);
    attachLocalSkeleton = slotId === 'hair' && !useHairBoneLinks;
    // Accessories with no bone links: the DFF has no named skeleton frames, so we
    // attach both the group (for non-skinned meshes) and the root bone (for skinned
    // meshes) directly to the shared head bone.
    if (slotId === 'accessory' && !boneLinks.length) {
      const sharedHeadBone = findSharedBoneByName('Opt_Bip01_Head');
      if (sharedHeadBone) {
        // Drive the mesh group to the head position each frame (handles plain Mesh).
        attachmentBinding = { source: sharedHeadBone, target: skeletonRoot, targetLocalInverse: null, direct: true };
        // Also parent the skeleton root under the head bone (handles SkinnedMesh).
        sharedHeadBone.add(skeletonRoot);
        attachLocalSkeleton = true;
      }
    }
    if (!attachLocalSkeleton) state.sceneGroup.add(skeletonRoot);
  }

  if (state.activeParts[slotId]) {
    const old = state.activeParts[slotId].mesh;
    state.sceneGroup.remove(old);
    if (state.activeParts[slotId].skeletonRoot?.parent) state.activeParts[slotId].skeletonRoot.parent.remove(state.activeParts[slotId].skeletonRoot);
    old.traverse(obj => { obj.geometry?.dispose(); });
  }

  const group = new THREE.Group();
  group.userData.slotId = slotId;
  const useBoneInverses = useBones === state.sharedBones ? state.sharedBoneInverses : null;
  let built = 0;
  for (const atomic of dffData.atomics) {
    if (atomic.renderFlags !== 0 && (atomic.renderFlags & 0x04) === 0) continue;
    const geo  = dffData.geometries[atomic.geometryIndex];
    const mesh = await buildMesh(geo, getTexDir(cfg.texDir), useBones, useFrames, useBoneInverses, attachLocalSkeleton);
    if (!mesh) continue;
    group.add(mesh);
    built++;
  }
  if (!built) {
    if (skeletonRoot?.parent) skeletonRoot.parent.remove(skeletonRoot);
    return;
  }

  state.sceneGroup.add(group);
  if (attachmentBinding) {
    if (!attachmentBinding.direct) captureAttachmentTargetLocalInverse(group, attachmentBinding);
    syncAttachmentGroup(group, attachmentBinding);
  }
  if (boneLinks.length && (alwaysSyncBoneLinks || hasActiveAnimationPose())) {
    syncBoneLinks(boneLinks);
  }
  state.activeParts[slotId] = {
    mesh: group,
    dffData,
    skeletonRoot,
    boneLinks,
    alwaysSyncBoneLinks,
    attachmentBinding,
    animationAttachment,
  };
}

// ─── Load full character (all default slots) ──────────────────────────────────
export async function loadCharacter(char) {
  state.charName = char;
  clearScene();

  const cfg = CHAR_CFG[char];
  state.sceneGroup = new THREE.Group();
  scene.add(state.sceneGroup);
  state.mixer = new THREE.AnimationMixer(state.sceneGroup);

  setStatus(`Loading skeleton…`);
  try {
    const skelBuf  = await fetchBinary(`${BASE}/${cfg.skelDff}`);
    const skelData = new DFFParser().parse(skelBuf);
    state.sharedFrames   = skelData.frames;
    state.sharedBones    = buildBones(state.sharedFrames, 'shared_bone');
    state.sharedBoneInverses = calculateRestBoneInverses(getRootBone(state.sharedFrames, state.sharedBones), state.sharedBones);
    const skelRoot = state.sharedFrames.findIndex(f => f.parentIndex < 0);
    state.sceneGroup.add(state.sharedBones[skelRoot >= 0 ? skelRoot : 0]);
  } catch (e) {
    console.error('[SKEL] failed to load skeleton:', e);
    setStatus(`Skeleton error: ${e.message}`, true);
    return;
  }

  const pickers = ui.slotsPanel.querySelectorAll('.slot-picker');
  const loads = [];
  for (const picker of pickers) {
    const mesh = picker.dataset.selected;
    if (mesh) loads.push(loadSlot(picker.dataset.slot, mesh));
  }

  setStatus(`Loading ${char}…`);
  const results = await Promise.allSettled(loads);
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length) {
    failed.forEach(r => console.warn('[slot] failed to load:', r.reason));
  }

  const box = new THREE.Box3().setFromObject(state.sceneGroup);
  const finiteBox = Number.isFinite(box.min.x) && Number.isFinite(box.min.y) && Number.isFinite(box.min.z)
    && Number.isFinite(box.max.x) && Number.isFinite(box.max.y) && Number.isFinite(box.max.z);
  if (!box.isEmpty() && finiteBox) {
    const h = box.max.y - box.min.y;
    state.sceneGroup.position.set(-((box.min.x+box.max.x)/2), -box.min.y, -((box.min.z+box.max.z)/2));
    controls.target.set(0, h * 0.55, 0);
    camera.position.set(0, h * 0.55, h * 1.8);
    controls.update();
  }

  // Recompute all skeleton inverse bind matrices after camera-fit repositions sceneGroup.
  state.sceneGroup.updateMatrixWorld(true);
  const seenSkeletons = new Set();
  state.sceneGroup.traverse(obj => {
    if (obj.isSkinnedMesh && !seenSkeletons.has(obj.skeleton)) {
      seenSkeletons.add(obj.skeleton);
      obj.skeleton.calculateInverses();
    }
  });
  if (state.sharedBones?.length) {
    state.sharedBoneInverses = state.sharedBones.map(b => b.matrixWorld.clone().invert());
  }

  state.sceneGroup.traverse(obj => {
    if (obj.isSkinnedMesh && !state.skeletonHelper) {
      state.skeletonHelper = new THREE.SkeletonHelper(obj);
      state.skeletonHelper.visible = state.showBones;
      scene.add(state.skeletonHelper);
    }
  });

  await populateAnimList(cfg.anmDir);
  const partCount = Object.keys(state.activeParts).length;
  setStatus(`${char}  —  ${partCount} parts loaded`);

  initUserLight();
  updateUserLight();
}

// ─── Slot UI ──────────────────────────────────────────────────────────────────
function slotIconUrl(iconFile) {
  if (!iconFile) return null;
  const charMatch = iconFile.match(/^icon_(r\d+)_/);
  if (charMatch) return `${BASE}/graphics/ui/game/icon/char/${charMatch[1]}/${iconFile}.png`;
  return `${BASE}/graphics/ui/game/make_account/${iconFile}.png`;
}

function setPickerSelected(picker, mesh) {
  picker.dataset.selected = mesh ?? '';
  for (const btn of picker.querySelectorAll('.slot-item')) {
    btn.classList.toggle('active', btn.dataset.mesh === (mesh ?? ''));
  }
}

function clearSlotPart(slotId) {
  if (!state.activeParts[slotId]) return;
  state.sceneGroup.remove(state.activeParts[slotId].mesh);
  if (state.activeParts[slotId].skeletonRoot?.parent)
    state.activeParts[slotId].skeletonRoot.parent.remove(state.activeParts[slotId].skeletonRoot);
  (state.activeParts[slotId].attachedBones ?? []).forEach(b => b.parent?.remove(b));
  delete state.activeParts[slotId];
}

export function buildSlotUI(charData) {
  ui.slotsPanel.innerHTML = '';
  for (const slot of charData.slots) {
    if (!slot.parts.length) continue;

    const dressSet = slot.id === 'top'
      ? new Set(slot.parts.filter(p => p.dress).map(p => p.mesh))
      : null;

    const first = slot.parts.find(p => p.released) ?? slot.parts[0];

    const row = document.createElement('div');
    row.className = 'slot-row';

    const label = document.createElement('label');
    label.textContent = slot.label;
    row.appendChild(label);

    const picker = document.createElement('div');
    picker.className      = 'slot-picker';
    picker.dataset.slot   = slot.id;
    picker.dataset.selected = first?.mesh ?? '';

    // None button
    const noneBtn = document.createElement('button');
    noneBtn.className  = 'slot-item slot-none';
    noneBtn.dataset.mesh = '';
    noneBtn.title      = 'None';
    noneBtn.textContent = '✕';
    picker.appendChild(noneBtn);

    for (const part of slot.parts) {
      const btn = document.createElement('button');
      btn.className    = 'slot-item' + (part.mesh === first?.mesh ? ' active' : '');
      btn.dataset.mesh = part.mesh;
      const label2 = part.desc !== part.mesh
        ? part.desc
        : part.mesh.replace(/^r0\d_/, '').replace(/_00_[a-z]$/, '');
      btn.title = label2 + (part.released ? '' : ' ✦');
      if (!part.released) btn.classList.add('unreleased');

      const url = slotIconUrl(part.iconFile);
      if (url) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.draggable = false;
        btn.appendChild(img);
      } else {
        btn.textContent = label2;
        btn.classList.add('slot-text');
      }
      picker.appendChild(btn);
    }

    picker.addEventListener('click', async (e) => {
      const btn = e.target.closest('.slot-item');
      if (!btn || !state.sceneGroup) return;
      const mesh = btn.dataset.mesh;

      setPickerSelected(picker, mesh);

      if (!mesh) {
        clearSlotPart(slot.id);
        return;
      }

      if (slot.id === 'top' && dressSet?.has(mesh)) {
        const botPicker = ui.slotsPanel.querySelector('.slot-picker[data-slot="bottom"]');
        if (botPicker && botPicker.dataset.selected) {
          setPickerSelected(botPicker, '');
          clearSlotPart('bottom');
        }
      }

      try {
        setStatus(`Swapping ${slot.label}…`);
        await loadSlot(slot.id, mesh);
        setStatus(`${state.charName}  —  ${slot.label} → ${mesh}`);
        rebuildSkeletonHelper();
      } catch (e) {
        setStatus(`Slot error: ${e.message}`, true);
        console.error(e);
      }
    });

    row.appendChild(picker);
    ui.slotsPanel.appendChild(row);
  }

  // If initial top selection is a dress, clear bottom
  const topSlot = charData.slots.find(s => s.id === 'top');
  if (topSlot) {
    const topPicker = ui.slotsPanel.querySelector('.slot-picker[data-slot="top"]');
    const botPicker = ui.slotsPanel.querySelector('.slot-picker[data-slot="bottom"]');
    if (topPicker && botPicker) {
      const selectedPart = topSlot.parts.find(p => p.mesh === topPicker.dataset.selected);
      if (selectedPart?.dress) setPickerSelected(botPicker, '');
    }
  }
}

export function rebuildSkeletonHelper() {
  if (state.skeletonHelper) { scene.remove(state.skeletonHelper); state.skeletonHelper = null; }
  state.sceneGroup?.traverse(obj => {
    if (obj.isSkinnedMesh && !state.skeletonHelper) {
      state.skeletonHelper = new THREE.SkeletonHelper(obj);
      state.skeletonHelper.visible = state.showBones;
      scene.add(state.skeletonHelper);
    }
  });
}

// ─── Animation list ───────────────────────────────────────────────────────────
export async function populateAnimList(anmDir) {
  ui.animList.innerHTML = '';
  try {
    let files;

    if (state.pakListing) {
      const anmDirNorm = anmDir.replace(/\\/g, '/').toLowerCase();
      files = state.pakListing
        .map(e => e.path.replace(/\\/g, '/'))
        .filter(p => p.toLowerCase().startsWith(anmDirNorm + '/') && p.toLowerCase().endsWith('.anm'))
        .map(p => p.split('/').pop());
    } else {
      const text = await (await fetch(`${BASE}/${anmDir}/`)).text();
      files = [...text.matchAll(/href="([^"]+\.anm)"/gi)].map(m => m[1]);
    }

    if (!files.length) { ui.animList.innerHTML = '<li class="empty">No animations</li>'; return; }

    for (const file of files) {
      const li = document.createElement('li');
      const decoded = decodeURIComponent(file);
      li.textContent = decoded.replace(/\.anm$/i, '').replace(/^r0\d_/, '');
      li.title       = decoded;
      li.dataset.url = `${BASE}/${anmDir}/${file}`;
      li.addEventListener('click', () => {
        document.querySelectorAll('#anim-list li').forEach(x => x.classList.remove('active'));
        li.classList.add('active');
        playAnimation(li.dataset.url);
      });
      ui.animList.appendChild(li);
    }
  } catch {
    ui.animList.innerHTML = '<li class="empty">Could not list</li>';
  }
}

export async function playAnimation(url) {
  if (!state.mixer || !state.sharedFrames) return;
  if (state.currentAction) { state.currentAction.stop(); state.currentAction = null; }
  const fname = url.split('/').pop().replace(/\.anm$/i, '');
  setStatus(`Loading: ${fname}…`);
  try {
    const buf = await fetchBinary(url);
    const numAnimBones = state.sharedFrames
      ? state.sharedFrames.reduce((max, f) => {
          const idx = getFrameAnimIndex(f);
          return idx >= 0 ? Math.max(max, idx + 1) : max;
        }, 0)
      : 0;
    const anmData = new ANMParser().parse(buf, numAnimBones || 0);
    const tracks  = new ANMParser().buildTracks(anmData);

    const kwTracks = [];
    state.sharedFrames.forEach((frame, frameIndex) => {
      const animBoneIndex = getFrameAnimIndex(frame);
      if (animBoneIndex < 0) return;
      const t = tracks.get(animBoneIndex);
      if (!t?.times.length) return;
      const boneName = state.sharedBones?.[frameIndex]?.name ?? `bone_${frameIndex}`;
      kwTracks.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, t.times, t.quaternions));
      // Only apply position tracks to the HAnim root bone (the first direct child of the
      // dummy root). Non-root bone ANM positions can diverge significantly from the DFF bind
      // pose (especially wrist/palm twist bones — measured ~1.18 unit delta for hIdx 33 & 58),
      // causing those bones to snap far from their bind position every frame, producing the
      // "stretched fingers/arms" deformation. Non-root bones should only rotate in-place from
      // their DFF bind positions, not have their positions overridden by the ANM.
      const isHAnimRoot = frame.hierarchyIndex === 0;
      if (isHAnimRoot) {
        kwTracks.push(new THREE.VectorKeyframeTrack(`${boneName}.position`, t.times, t.positions));
      }
    });

    const clip = new THREE.AnimationClip(fname, -1, kwTracks);
    state.currentAction = state.mixer.clipAction(clip);
    state.currentAction.reset().setLoop(THREE.LoopRepeat).play();
    // Force the mixer to apply frame 0 before we re-capture hair attachment offsets,
    // so the head bone is at its animated position when we measure the offset.
    state.mixer.update(0);
    // Re-capture animation attachment offsets for parts that use position-based syncing
    // (e.g. physics hair). The offset must be measured after the animation has set the
    // head bone to its t=0 position, not before.
    Object.values(state.activeParts).forEach(part => {
      if (part.animationAttachment) captureAnimationAttachmentOffset(part.mesh, part.animationAttachment);
    });
    state.animPaused = false;
    ui.timeline.max  = clip.duration;
    ui.timeline.value = 0;
    setStatus(`▶ ${fname}  (${anmData.numBones} bones, ${clip.duration.toFixed(2)}s)`);
  } catch (e) {
    setStatus(`Anim error: ${e.message}`, true);
    console.error(e);
  }
}

// ─── Scene clear ──────────────────────────────────────────────────────────────
export function clearScene() {
  if (state.currentAction)  { state.currentAction.stop(); state.currentAction = null; }
  if (state.mixer)          { state.mixer.stopAllAction(); state.mixer = null; }
  if (state.skeletonHelper) { scene.remove(state.skeletonHelper); state.skeletonHelper = null; }
  if (state.sceneGroup)     { scene.remove(state.sceneGroup); state.sceneGroup = null; }
  state.activeParts  = {};
  state.sharedBones  = null;
  state.sharedFrames = null;
  state.sharedBoneInverses = null;
  ui.animList.innerHTML = '';
  ui.timeline.value = 0;
  ui.timeLabel.textContent = '0.00 / 0.00';
}
