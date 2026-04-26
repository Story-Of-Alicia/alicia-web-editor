import * as THREE from 'three';
import { DFFParser } from './DFFParser.js';
import { BASE, scene, camera, controls, state, ui, MOUNT_CFG, setStatus, fetchBinary, getTexDir, initUserLight, updateUserLight } from './viewerState.js';
import { buildBones, buildMesh, buildBoneLinks, syncBoneLinks, clearScene, populateAnimList } from './characterViewer.js';
import { loadTexture } from './textureUtils.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRootBone(frames, bones) {
  const idx = frames.findIndex(f => f.parentIndex < 0);
  return bones[idx >= 0 ? idx : 0];
}

function calculateRestBoneInverses(rootBone, bones) {
  rootBone.updateWorldMatrix(true, true);
  return bones.map(b => b.matrixWorld.clone().invert());
}

// ─── Skin (coat) texture swap ─────────────────────────────────────────────────

async function applySkin(skinPart) {
  const cfg = MOUNT_CFG[state.mountName];
  if (!skinPart || !state.sceneGroup) return;

  const newTex = await loadTexture(getTexDir(cfg.texDir), skinPart.texName, THREE.SRGBColorSpace);
  if (!newTex) return;

  const target = skinPart.target.toLowerCase();
  state.sceneGroup.traverse(obj => {
    if (!obj.isMesh && !obj.isSkinnedMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      // Match by DFF texture stem stored on material (works even when mat.map failed to load)
      const dffTex = mat.userData?.dffTexName ?? mat.map?.userData?.texName ?? '';
      if (dffTex.includes(target)) {
        mat.map = newTex;
        mat.needsUpdate = true;
      }
    }
  });
}

// ─── Slot UI ──────────────────────────────────────────────────────────────────

function setPickerSelected(picker, value) {
  picker.dataset.selected = value ?? '';
  for (const btn of picker.querySelectorAll('.slot-item'))
    btn.classList.toggle('active', btn.dataset.value === (value ?? ''));
}

function getActiveSkinPart() {
  const skinPicker = ui.horseSlotsPanel.querySelector('.slot-picker[data-slot="skin"]');
  if (!skinPicker) return null;
  const val = skinPicker.dataset.selected;
  if (!val) return null;
  return skinPicker._parts?.find(p => String(p.id) === val) ?? null;
}

export function buildHorseSlotUI(mountData) {
  ui.horseSlotsPanel.innerHTML = '';
  for (const slot of mountData.slots) {
    if (!slot.parts.length) continue;

    const row = document.createElement('div');
    row.className = 'slot-row';
    const lbl = document.createElement('label');
    lbl.textContent = slot.label;
    row.appendChild(lbl);

    const picker = document.createElement('div');
    picker.className    = 'slot-picker';
    picker.dataset.slot = slot.id;

    // None button
    const noneBtn = document.createElement('button');
    noneBtn.className    = 'slot-item slot-none';
    noneBtn.dataset.value = '';
    noneBtn.title        = 'None';
    noneBtn.textContent  = '✕';
    picker.appendChild(noneBtn);

    const first = slot.parts[0];

    for (const part of slot.parts) {
      const btn = document.createElement('button');
      // For skins use part.id as value; for mesh slots use part.mesh
      const val = slot.id === 'skin' ? String(part.id) : part.mesh;
      btn.className     = 'slot-item' + (part === first ? ' active' : '');
      btn.dataset.value = val;
      btn.title         = part.desc;

      if (part.iconFile) {
        const cfg = MOUNT_CFG[state.mountName] ?? Object.values(MOUNT_CFG)[0];
        const img = document.createElement('img');
        // Coat thumbnails live in texDir; equipment icons are in graphics/ui/game/icon/horse/
        img.src = slot.id === 'skin'
          ? `${BASE}/${cfg.texDir}/${part.iconFile}.png`
          : `${BASE}/graphics/ui/game/icon/horse/${part.iconFile}.png`;
        img.alt = '';
        img.draggable = false;
        img.onerror = () => {
          btn.removeChild(img);
          btn.textContent = part.desc;
          btn.classList.add('slot-text');
        };
        btn.appendChild(img);
      } else {
        btn.textContent = part.desc;
        btn.classList.add('slot-text');
      }
      picker.appendChild(btn);
    }

    // Store full parts array on the picker for lookup by value
    picker._parts = slot.parts;
    picker.dataset.selected = first ? (slot.id === 'skin' ? String(first.id) : first.mesh) : '';

    picker.addEventListener('click', async (e) => {
      const btn = e.target.closest('.slot-item');
      if (!btn || !state.sceneGroup) return;
      const val = btn.dataset.value;
      setPickerSelected(picker, val);

      if (slot.id === 'skin') {
        if (!val) return;
        const part = picker._parts.find(p => String(p.id) === val);
        if (part) {
          try { await applySkin(part); } catch(err) { console.error(err); }
        }
        return;
      }

      if (!val) { clearHorseSlot(slot.id); return; }
      try {
        setStatus(`Swapping ${slot.label}…`);
        await loadHorseSlot(slot.id, val);
        const skinPart = getActiveSkinPart();
        if (skinPart) await applySkin(skinPart).catch(() => {});
        setStatus(`${state.mountName}  —  ${Object.keys(state.activeParts).length} parts`);
      } catch (err) {
        setStatus(`Swap error: ${err.message}`, true);
        console.error(err);
      }
    });

    row.appendChild(picker);
    ui.horseSlotsPanel.appendChild(row);
  }
}

// ─── Part loading ─────────────────────────────────────────────────────────────

function clearHorseSlot(slotId) {
  const old = state.activeParts[slotId];
  if (!old) return;
  state.sceneGroup.remove(old.mesh);
  if (old.skeletonRoot?.parent) old.skeletonRoot.parent.remove(old.skeletonRoot);
  delete state.activeParts[slotId];
}

async function loadHorseSlot(slotId, meshName) {
  const cfg          = MOUNT_CFG[state.mountName];
  const isManeOrTail = slotId === 'mane' || slotId === 'tail';
  const dir          = isManeOrTail ? cfg.physxDir : cfg.partsDir;
  const url          = `${BASE}/${dir}/${meshName}.dff`;

  const buf     = await fetchBinary(url);
  const dffData = new DFFParser().parse(buf);

  // Bone setup — try to link local frames to shared skeleton by name
  let useBones, useFrames, skeletonRoot = null, boneLinks = [];
  if ((dffData.frames?.length ?? 0) === state.sharedFrames.length) {
    useBones  = state.sharedBones;
    useFrames = state.sharedFrames;
  } else {
    useFrames = dffData.frames;
    useBones  = buildBones(useFrames, `local_${slotId}`);
    const localRootIdx = useFrames.findIndex(f => f.parentIndex < 0);
    skeletonRoot = useBones[localRootIdx >= 0 ? localRootIdx : 0];
    // Link named frames to shared skeleton bones.
    // Always sync position+rotation — horse part DFFs have their own local coordinate
    // space, so copying only rotation causes parts to render at wrong positions.
    boneLinks = buildBoneLinks(useFrames, useBones, slotId);
    for (const link of boneLinks) link.syncPosition = true;
    state.sceneGroup.add(skeletonRoot);
  }

  clearHorseSlot(slotId);

  const group = new THREE.Group();
  group.userData.slotId = slotId;
  const useBoneInverses = useBones === state.sharedBones ? state.sharedBoneInverses : null;
  let built = 0;
  for (const atomic of dffData.atomics) {
    if ((atomic.renderFlags & 0x04) === 0) continue;
    const geo  = dffData.geometries[atomic.geometryIndex];
    const mesh = await buildMesh(geo, getTexDir(cfg.texDir), useBones, useFrames, useBoneInverses, false);
    if (!mesh) continue;
    group.add(mesh);
    built++;
  }
  if (!built) {
    if (skeletonRoot?.parent) skeletonRoot.parent.remove(skeletonRoot);
    return;
  }

  state.sceneGroup.add(group);
  if (boneLinks.length) syncBoneLinks(boneLinks);

  state.activeParts[slotId] = {
    mesh: group, dffData, skeletonRoot,
    boneLinks, alwaysSyncBoneLinks: isManeOrTail,
    attachmentBinding: null, animationAttachment: null,
  };
}

// ─── Main loader ──────────────────────────────────────────────────────────────

export async function loadHorse(horseName) {
  state.mountName = horseName;
  clearScene();

  const cfg = MOUNT_CFG[horseName];
  if (!cfg) { setStatus(`No config for horse "${horseName}"`, true); return; }

  state.sceneGroup = new THREE.Group();
  scene.add(state.sceneGroup);
  state.mixer = new THREE.AnimationMixer(state.sceneGroup);

  setStatus(`Loading skeleton…`);
  try {
    const skelBuf  = await fetchBinary(`${BASE}/${cfg.skelDff}`);
    const skelData = new DFFParser().parse(skelBuf);
    state.sharedFrames       = skelData.frames;
    state.sharedBones        = buildBones(state.sharedFrames, 'shared_bone');
    state.sharedBoneInverses = calculateRestBoneInverses(
      getRootBone(state.sharedFrames, state.sharedBones), state.sharedBones
    );
    const skelRoot = state.sharedFrames.findIndex(f => f.parentIndex < 0);
    state.sceneGroup.add(state.sharedBones[skelRoot >= 0 ? skelRoot : 0]);

    // Load body mesh from the skeleton DFF's atomics (no renderFlags filter — all geometry counts)
    setStatus(`Loading body…`);
    const bodyGroup = new THREE.Group();
    bodyGroup.userData.slotId = 'body';
    let bodyBuilt = 0;
    for (const atomic of skelData.atomics) {
      const geo  = skelData.geometries[atomic.geometryIndex];
      const mesh = await buildMesh(geo, getTexDir(cfg.texDir), state.sharedBones, state.sharedFrames, state.sharedBoneInverses, false);
      if (!mesh) continue;
      bodyGroup.add(mesh);
      bodyBuilt++;
    }
    if (bodyBuilt) {
      state.sceneGroup.add(bodyGroup);
      state.activeParts['body'] = {
        mesh: bodyGroup, dffData: skelData, skeletonRoot: null,
        boneLinks: [], alwaysSyncBoneLinks: false,
        attachmentBinding: null, animationAttachment: null,
      };
    }
  } catch (e) {
    setStatus(`Skeleton error: ${e.message}`, true);
    console.error(e);
    return;
  }

  // Load all selected mesh slots (skip skin — applied after skeleton meshes are in scene)
  const pickers = ui.horseSlotsPanel.querySelectorAll('.slot-picker');
  const meshLoads = [];
  let pendingSkin = null;
  for (const picker of pickers) {
    const slotId = picker.dataset.slot;
    const val    = picker.dataset.selected;
    if (!val) continue;
    if (slotId === 'skin') {
      pendingSkin = { picker, val };
    } else {
      meshLoads.push(loadHorseSlot(slotId, val));
    }
  }

  setStatus(`Loading ${horseName}…`);
  try {
    await Promise.all(meshLoads);
  } catch (e) {
    setStatus(`Load error: ${e.message}`, true);
    console.error(e);
    return;
  }

  // Apply coat after meshes are loaded
  if (pendingSkin?.val) {
    const parts = pendingSkin.picker._parts;
    const part  = parts?.find(p => String(p.id) === pendingSkin.val);
    if (part) await applySkin(part).catch(() => {});
  }

  const box = new THREE.Box3().setFromObject(state.sceneGroup);
  const finite = ['min','max'].every(k => ['x','y','z'].every(ax => Number.isFinite(box[k][ax])));
  if (!box.isEmpty() && finite) {
    const h = box.max.y - box.min.y;
    state.sceneGroup.position.set(-((box.min.x+box.max.x)/2), -box.min.y, -((box.min.z+box.max.z)/2));
    controls.target.set(0, h * 0.5, 0);
    camera.position.set(0, h * 0.5, h * 2.2);
    controls.update();
  }

  // Recompute all skeleton inverse bind matrices now that sceneGroup is in its final position.
  // Bone world matrices were computed before the camera-fit offset was applied, making the
  // cached inverseBindMatrices stale and causing skinning deformation errors.
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
  setStatus(`${horseName}  —  ${Object.keys(state.activeParts).length} parts loaded`);
  initUserLight();
  updateUserLight();
}
