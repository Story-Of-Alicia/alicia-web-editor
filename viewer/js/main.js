import { BASE, ABIN_DIR, canvas, renderer, scene, camera, controls, clock, state, ui, setStatus, fetchBinary, buildPakAssetIndex, applyCharCfg, applyMountCfg, initUserLight, updateUserLight } from './viewerState.js';
import { parseLibconfig, parseMounts } from './LibconfigParser.js';
import { loadCharacter, buildSlotUI, clearScene, hasActiveAnimationPose, syncBoneLinks, syncAttachmentGroup, syncAttachmentGroupPosition } from './characterViewer.js';
import { loadHorse, buildHorseSlotUI } from './horseViewer.js';
import { loadMap, clearMap } from './mapViewer.js';
import { initAssetTree, clearAssetPreview, bumpSelectionToken, initSearch } from './assetBrowser.js';
import { PakConnection } from './pakConnection.js';
import { initPakTree, setPakConnection } from './pakBrowser.js';
import { setPakTextureSource, clearPakTextureSource, resetBgIndex } from './textureUtils.js';

// ─── Tab / mode switching ─────────────────────────────────────────────────────
function setMode(mode) {
  state.mapMode = mode === 'map';
  const isAssets = mode === 'assets';
  const isAnim   = mode === 'char' || mode === 'horse';
  ui.tabChar.classList.toggle('active',  mode === 'char');
  ui.tabHorse.classList.toggle('active', mode === 'horse');
  ui.tabMap.classList.toggle('active',   mode === 'map');
  ui.tabAssets.classList.toggle('active', isAssets);
  ui.charToolbar.style.display   = mode === 'char'  ? '' : 'none';
  ui.horseToolbar.style.display  = mode === 'horse' ? '' : 'none';
  ui.mapToolbar.style.display    = mode === 'map'   ? '' : 'none';
  ui.assetsToolbar.style.display = isAssets         ? '' : 'none';
  ui.charSidebar.style.display   = mode === 'char'  ? '' : 'none';
  ui.horseSidebar.style.display  = mode === 'horse' ? '' : 'none';
  ui.mapSidebar.style.display    = mode === 'map'   ? '' : 'none';
  ui.assetsSidebar.style.display = isAssets         ? '' : 'none';
  ui.animPanel.style.display     = isAnim           ? '' : 'none';
  ui.controlsEl.style.display    = isAnim           ? 'flex' : 'none';
  if (!isAssets) {
    bumpSelectionToken();
    clearAssetPreview();
  }
}

// ─── UI wiring ────────────────────────────────────────────────────────────────
ui.charSelect.addEventListener('change', () => switchChar(ui.charSelect.value));

async function switchChar(char) {
  state.charName = char;
  const data = state.partsData[char];
  if (!data) return;
  buildSlotUI(data);
  await loadCharacter(char);
}

ui.btnPlay.addEventListener('click',  () => { if (state.currentAction) { state.currentAction.paused = false; state.animPaused = false; } });
ui.btnPause.addEventListener('click', () => { if (state.currentAction) { state.currentAction.paused = true;  state.animPaused = true;  } });
ui.btnStop.addEventListener('click',  () => {
  if (state.currentAction) { state.currentAction.stop(); state.currentAction.reset(); }
  state.animPaused = false; ui.timeline.value = 0; ui.timeLabel.textContent = '0.00 / 0.00';
});

ui.speedRange.addEventListener('input', () => {
  const v = parseFloat(ui.speedRange.value);
  ui.speedLabel.textContent = `${v.toFixed(1)}×`;
  if (state.mixer) state.mixer.timeScale = v;
});
ui.timeline.addEventListener('input', () => {
  if (state.mixer && state.currentAction) state.mixer.setTime(parseFloat(ui.timeline.value));
  Object.values(state.activeParts).forEach(part => {
    const hasPose = part.alwaysSyncBoneLinks || hasActiveAnimationPose();
    if (hasPose) {
      syncBoneLinks(part.boneLinks);
      if (part.animationAttachment) syncAttachmentGroupPosition(part.mesh, part.animationAttachment);
    }
    if (part.attachmentBinding) syncAttachmentGroup(part.mesh, part.attachmentBinding);
  });
});

ui.tabChar.addEventListener('click',   () => { setMode('char');   clearMap(); switchChar(ui.charSelect.value); });
ui.tabHorse.addEventListener('click',  () => { setMode('horse');  clearMap(); switchHorse(ui.horseSelect.value); });
ui.tabMap.addEventListener('click',    () => { setMode('map');    clearScene(); if (ui.mapSelect.value) loadMap(ui.mapSelect.value); });
ui.tabAssets.addEventListener('click', () => { setMode('assets'); clearScene(); clearMap(); if (!state.pakConnection) initAssetTree(); });

ui.horseSelect.addEventListener('change', () => switchHorse(ui.horseSelect.value));

async function switchHorse(horse) {
  state.mountName = horse;
  const data = state.mountsData?.[horse];
  if (!data) return;
  buildHorseSlotUI(data);
  await loadHorse(horse);
}

function populateHorseSelect(mountsData) {
  ui.horseSelect.innerHTML = '';
  for (const horse of Object.keys(mountsData)) {
    const opt = document.createElement('option');
    opt.value = horse; opt.textContent = horse;
    ui.horseSelect.appendChild(opt);
  }
}

ui.mapSelect.addEventListener('change', () => { if (ui.mapSelect.value) loadMap(ui.mapSelect.value); });

ui.btnMapWire.addEventListener('click', () => {
  state.mapShowWire = !state.mapShowWire;
  state.mapGroup?.traverse(obj => {
    if (obj.isMesh) [obj.material].flat().forEach(m => { m.wireframe = state.mapShowWire; });
  });
  ui.btnMapWire.classList.toggle('active', state.mapShowWire);
});
ui.btnMapNodes.addEventListener('click', () => {
  state.mapShowNodes = !state.mapShowNodes;
  if (state.mapNodeHelpers) state.mapNodeHelpers.visible = state.mapShowNodes;
  ui.btnMapNodes.classList.toggle('active', state.mapShowNodes);
});

function toggleBones() {
  state.showBones = !state.showBones;
  if (state.skeletonHelper) state.skeletonHelper.visible = state.showBones;
  ui.btnBones.classList.toggle('active', state.showBones);
  ui.btnHorseBones.classList.toggle('active', state.showBones);
}
function toggleWire() {
  state.showWireframe = !state.showWireframe;
  state.sceneGroup?.traverse(obj => {
    if (obj.isMesh || obj.isSkinnedMesh) [obj.material].flat().forEach(m => { m.wireframe = state.showWireframe; });
  });
  ui.btnWire.classList.toggle('active', state.showWireframe);
  ui.btnHorseWire.classList.toggle('active', state.showWireframe);
}
ui.btnBones.addEventListener('click', toggleBones);
ui.btnHorseBones.addEventListener('click', toggleBones);
ui.btnWire.addEventListener('click', toggleWire);
ui.btnHorseWire.addEventListener('click', toggleWire);

[ui.lightX, ui.lightY, ui.lightZ, ui.lightInt].forEach(ctrl => {
  ctrl?.addEventListener('input', () => {
    initUserLight();
    updateUserLight();
  });
});

initSearch();
setMode('assets');
if (!state.pakConnection) initAssetTree();

// ─── PAK connection ───────────────────────────────────────────────────────────
const btnBrowsePak    = document.getElementById('btn-browse-pak');
const btnDisconnectPak = document.getElementById('btn-disconnect-pak');
const btnAddAssetPak = document.getElementById('btn-add-asset-pak');
const btnExportPak = document.getElementById('btn-export-pak');

function extractPakAssets(listing) {
  if (Array.isArray(listing?.assets)) return listing.assets;
  if (Array.isArray(listing?.data)) return listing.data;
  return [];
}

function pickLocalAssetFile() {
  if (typeof window.showOpenFilePicker === 'function') {
    return (async () => {
      try {
        const handles = await window.showOpenFilePicker({ multiple: false });
        if (!handles?.length) return null;
        return handles[0].getFile();
      } catch (error) {
        if (error?.name === 'AbortError') return null;
        throw error;
      }
    })();
  }

  return new Promise((resolve) => {
    let settled = false;
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    const finish = (file) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onWindowFocus);
      input.remove();
      resolve(file);
    };
    const onWindowFocus = () => {
      setTimeout(() => {
        if (settled) return;
        const selected = input.files?.[0] ?? null;
        finish(selected);
      }, 1000);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    window.addEventListener('focus', onWindowFocus, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

function populateMapSelectFromPak(listingData) {
  ui.mapSelect.innerHTML = '';
  const abinDirNorm = ABIN_DIR.replace(/\\/g, '/').toLowerCase();
  const abinFiles = listingData
    .map(e => e.path.replace(/\\/g, '/'))
    .filter(p => p.toLowerCase().startsWith(abinDirNorm + '/') && p.toLowerCase().endsWith('.abin'))
    .map(p => p.split('/').pop());
  for (const f of abinFiles) {
    const opt = document.createElement('option');
    opt.value = f; opt.textContent = f.replace(/\.abin$/i, '');
    ui.mapSelect.appendChild(opt);
  }
}

function getSelectedPakAssetPath() {
  const activeFileRow = ui.assetTree.querySelector('.tree-file.active');
  const label = activeFileRow?.querySelector('.tree-name');
  const rawPath = String(label?.title ?? '').trim();
  if (!rawPath) return '';

  const normalisedPath = rawPath.replace(/\\/g, '/');
  const listedEntry = state.pakListing?.find((entry) => {
    const listedPath = String(entry?.path ?? '').replace(/\\/g, '/').toLowerCase();
    return listedPath && listedPath === normalisedPath.toLowerCase();
  });

  return listedEntry ? String(listedEntry.path).replace(/\\/g, '/') : '';
}

function getSelectedPakFolderPath() {
  const activeFolderRow = ui.assetTree.querySelector('.tree-folder.active');
  const label = activeFolderRow?.querySelector('.tree-name');
  const rawPath = String(label?.title ?? '').trim();
  if (!rawPath || rawPath === 'PAK') return '';

  const normalisedPath = rawPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return normalisedPath;
}

function buildSuggestedPakAssetPath(fileName) {
  const selectedPath = getSelectedPakAssetPath();
  if (!selectedPath) {
    const selectedFolder = getSelectedPakFolderPath();
    return selectedFolder ? `${selectedFolder}/${fileName}` : fileName;
  }

  // If an asset file is selected, default to replacing that exact path when
  // extensions match; otherwise keep its folder and swap in the new name.
  if (/\.[^./]+$/i.test(selectedPath)) {
    const selectedExt = selectedPath.split('.').pop()?.toLowerCase() ?? '';
    const fileExt = fileName.split('.').pop()?.toLowerCase() ?? '';
    if (selectedExt && fileExt && selectedExt === fileExt) return selectedPath;
    return selectedPath.replace(/[^/]+$/, fileName);
  }

  return `${selectedPath.replace(/\/+$/, '')}/${fileName}`;
}

function splitPath(path) {
  const value = String(path ?? '').trim();
  const lastSlash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  if (lastSlash < 0) return { dir: '', file: value };
  return {
    dir: value.slice(0, lastSlash + 1),
    file: value.slice(lastSlash + 1),
  };
}

function buildEditedFileName(fileName) {
  const fallback = 'output.pak';
  const name = String(fileName ?? '').trim() || fallback;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  if (/_edited$/i.test(stem)) return `${stem}2${ext}`;
  return `${stem}_edited${ext}`;
}

function normaliseFsPath(path) {
  return String(path ?? '').trim().replace(/\\/g, '/').toLowerCase();
}

function normaliseAssetPath(path) {
  return String(path ?? '').trim().replace(/\\/g, '/');
}

async function refreshPakStateFromListing(pakConn, listing) {
  const assets = extractPakAssets(listing);
  state.pakConnection = pakConn;
  state.pakResourcePath = listing?.resource_path ?? pakConn.resourcePath ?? '';
  state.pakListing = assets;
  state.pakAssetIndex = buildPakAssetIndex(assets);

  // Set up PAK texture source for DFF/BSP texture resolution.
  setPakTextureSource(assets, (path) => pakConn.fetchAsset(path));
  setPakConnection(pakConn);

  // Reset bg-index so it rebuilds from PAK data.
  resetBgIndex();

  // Populate map select from PAK abin files.
  populateMapSelectFromPak(assets);

  // Build the PAK tree in the asset browser.
  initPakTree({ ...listing, assets });

  // Try to reload character config from the libconfig in this PAK.
  try {
    const { charCfg, partsData, mountCfg, mountsData } = await loadLibconfig();
    applyCharCfg(charCfg);
    applyMountCfg(mountCfg);
    state.partsData  = partsData;
    state.mountsData = mountsData;
    populateCharSelect(partsData);
    populateHorseSelect(mountsData);
    console.log('[libconfig] reloaded from PAK:', Object.keys(partsData).length, 'chars,', Object.keys(mountsData).length, 'horses');
  } catch (e) {
    console.warn('[libconfig] not found in PAK, keeping existing char config:', e.message);
  }
}

function upsertPakListingAsset(listingData, assetPath) {
  const path = normaliseAssetPath(assetPath);
  if (!path) return Array.isArray(listingData) ? [...listingData] : [];

  const normalisedPath = path.toLowerCase();
  const nextAssets = (Array.isArray(listingData) ? listingData : []).map((entry) => ({ ...entry }));
  const existingIndex = nextAssets.findIndex((entry) => {
    const listedPath = normaliseAssetPath(entry?.path).toLowerCase();
    return listedPath === normalisedPath;
  });

  if (existingIndex >= 0) {
    nextAssets[existingIndex].path = path;
  } else {
    nextAssets.push({ path });
  }

  return nextAssets;
}

btnBrowsePak.addEventListener('click', async () => {
  let pakConn = null;
  try {
    setStatus('Connecting to PAK server...');
    btnBrowsePak.disabled = true;

    pakConn = new PakConnection();
    await pakConn.connect();

    setStatus('Waiting for PAK file selection in the editor...');
    const listing = await pakConn.openPak();

    await refreshPakStateFromListing(pakConn, listing);

    btnBrowsePak.style.display = 'none';
    btnDisconnectPak.style.display = '';
    btnAddAssetPak.style.display = '';
    btnExportPak.style.display = '';
    setStatus(`PAK loaded: ${extractPakAssets(listing).length} assets`);
  } catch (err) {
    setStatus(`PAK error: ${err.message}`, true);
    btnBrowsePak.disabled = false;
    if (pakConn) pakConn.disconnect();
    if (state.pakConnection) state.pakConnection.disconnect();
    state.pakConnection = null;
    state.pakResourcePath = '';
    state.pakAssetIndex = null;
    state.pakListing = null;
    btnAddAssetPak.style.display = 'none';
    btnExportPak.style.display = 'none';
  }
});

btnAddAssetPak.addEventListener('click', async () => {
  if (!state.pakConnection?.connected) {
    setStatus('Connect to a PAK server first.', true);
    return;
  }

  try {
    btnAddAssetPak.disabled = true;
    setStatus('Select the source asset file...');
    const file = await pickLocalAssetFile();
    if (!file) {
      setStatus('Asset update cancelled.');
      return;
    }

    const suggestedPath = buildSuggestedPakAssetPath(file.name);
    const pathInput = window.prompt(
      'Target PAK asset path (example: some/folder/new_asset.dff):',
      suggestedPath
    );
    if (pathInput == null) {
      setStatus('Asset update cancelled.');
      return;
    }

    const assetPath = normaliseAssetPath(pathInput);
    if (!assetPath) {
      setStatus('Asset path cannot be empty.', true);
      return;
    }

    setStatus(`Uploading ${file.name}...`);
    const data = await file.arrayBuffer();
    await state.pakConnection.writeAsset(assetPath, data);

    // Avoid expensive pak.read() after each write; update local listing instead.
    const updatedAssets = upsertPakListingAsset(state.pakListing, assetPath);
    await refreshPakStateFromListing(state.pakConnection, {
      resource_path: state.pakResourcePath ?? state.pakConnection.resourcePath ?? '',
      assets: updatedAssets,
    });
    setStatus(`Updated asset: ${assetPath}`);
  } catch (err) {
    setStatus(`PAK update error: ${err.message}`, true);
  } finally {
    btnAddAssetPak.disabled = false;
  }
});

btnExportPak.addEventListener('click', async () => {
  if (!state.pakConnection?.connected) {
    setStatus('Connect to a PAK server first.', true);
    return;
  }

  const sourcePakPath = String(state.pakResourcePath ?? state.pakConnection.resourcePath ?? '').trim();
  if (!sourcePakPath) {
    setStatus('Current PAK source path is missing. Re-open the PAK and try again.', true);
    return;
  }

  const currentPath = sourcePakPath;
  const { dir: currentDir, file: currentFile } = splitPath(currentPath);
  const suggestedName = buildEditedFileName(currentFile);
  const targetInput = window.prompt(
    'Target PAK path (or just filename for same folder):',
    suggestedName
  );
  if (targetInput == null) return;

  const rawTarget = targetInput.trim();
  if (!rawTarget) {
    setStatus('Target PAK path cannot be empty.', true);
    return;
  }

  let targetPath = rawTarget;
  const isLikelyAbsolute = /^[A-Za-z]:[\\/]/.test(rawTarget) || rawTarget.startsWith('\\\\');
  const hasDirectoryPart = /[\\/]/.test(rawTarget);
  if (currentDir && !isLikelyAbsolute && !hasDirectoryPart) {
    targetPath = `${currentDir}${rawTarget}`;
  }

  if (currentPath && normaliseFsPath(targetPath) === normaliseFsPath(currentPath)) {
    setStatus('Please choose a different output file path.', true);
    return;
  }

  try {
    btnExportPak.disabled = true;
    setStatus('Writing modified PAK to disk...');
    await state.pakConnection.writePak(sourcePakPath, targetPath);
    setStatus(`PAK written${targetPath ? `: ${targetPath}` : '.'}`);
  } catch (err) {
    setStatus(`PAK write error: ${err.message}`, true);
  } finally {
    btnExportPak.disabled = false;
  }
});

btnDisconnectPak.addEventListener('click', async () => {
  if (state.pakConnection?.connected) {
    try {
      await state.pakConnection.invalidatePak();
    } catch (err) {
      console.warn('Failed to invalidate PAK resource before disconnect:', err);
    }
  }

  if (state.pakConnection) state.pakConnection.disconnect();
  state.pakConnection = null;
  state.pakResourcePath = '';
  state.pakAssetIndex = null;
  state.pakListing = null;
  setPakConnection(null);
  clearPakTextureSource();
  resetBgIndex();
  clearAssetPreview();
  bumpSelectionToken();
  ui.assetTree.innerHTML = '';
  ui.mapSelect.innerHTML = '';
  btnBrowsePak.style.display = '';
  btnBrowsePak.disabled = false;
  btnDisconnectPak.style.display = 'none';
  btnAddAssetPak.style.display = 'none';
  btnExportPak.style.display = 'none';
  setStatus('Disconnected from PAK server');
});

// ─── Render loop ──────────────────────────────────────────────────────────────
(function animate() {
  requestAnimationFrame(animate);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const dt = clock.getDelta();
  if (state.mixer) {
    if (!state.animPaused) state.mixer.update(dt);
    Object.values(state.activeParts).forEach(part => {
      const hasPose = part.alwaysSyncBoneLinks || hasActiveAnimationPose();
      if (hasPose) {
        syncBoneLinks(part.boneLinks);
        if (part.animationAttachment) syncAttachmentGroupPosition(part.mesh, part.animationAttachment);
      }
      if (part.attachmentBinding) syncAttachmentGroup(part.mesh, part.attachmentBinding);
    });
    if (state.currentAction?.isRunning()) {
      ui.timeline.value = state.currentAction.time;
      ui.timeLabel.textContent = `${state.currentAction.time.toFixed(2)} / ${state.currentAction.getClip().duration.toFixed(2)}`;
    }
  }
  controls.update();
  renderer.render(scene, camera);
})();

// ─── Libconfig loading ────────────────────────────────────────────────────────
const LIBCONFIG_PATH = `${BASE}/other/ini/libconfig_c.dat`;

async function loadLibconfig() {
  const buf  = await fetchBinary(LIBCONFIG_PATH);
  const text = new TextDecoder('utf-8').decode(buf);
  const charResult  = parseLibconfig(text);
  const mountResult = parseMounts(text);
  return { ...charResult, ...mountResult };
}

function populateCharSelect(partsData) {
  ui.charSelect.innerHTML = '';
  for (const char of Object.keys(partsData)) {
    const opt = document.createElement('option');
    opt.value = char; opt.textContent = char;
    ui.charSelect.appendChild(opt);
  }
}

// ─── Init: load libconfig (or fall back to char_parts.json) then build UI ────
(async () => {
  try {
    const { charCfg, partsData, mountCfg, mountsData } = await loadLibconfig();
    applyCharCfg(charCfg);
    applyMountCfg(mountCfg);
    state.partsData  = partsData;
    state.mountsData = mountsData;
    console.log('[libconfig] loaded', Object.keys(partsData).length, 'chars,', Object.keys(mountsData).length, 'horses');

    populateCharSelect(state.partsData);
    ui.charSelect.value = 'r00';
    populateHorseSelect(state.mountsData);
    ui.horseSelect.value = 'h000';

    // Populate map select — try HTTP directory listing first, fall back to known list.
    const KNOWN_ABINS = [
      'award.abin','bg_award02.abin','bg_award03.abin',
      'li_tabi01.abin','li_tabi02.abin',
      'ranch_00.abin','ranch_w.abin',
      'readyroom01.abin','readyroom01_w.abin',
      'ri_dorf02.abin','ri_dorf03.abin','ri_dorf04.abin',
      'ri_fore01.abin','ri_fore02.abin','ri_fore03.abin','ri_fore04.abin',
      'ri_land01.abin','ri_land02.abin','ri_land03.abin','ri_land04.abin',
      'ri_land05.abin','ri_land06.abin','ri_land07.abin',
      'ri_pgri01.abin',
      'select_bg_tuto02.abin','set_waterfall.abin','stable.abin',
      'title_w_scene_waterfall01.abin',
      'tuto_01.abin','tuto_02.abin','tuto_03.abin',
    ];
    try {
      const text  = await (await fetch(`${BASE}/${ABIN_DIR}/`)).text();
      const files = [...text.matchAll(/href="([^"]+\.abin)"/gi)].map(m => m[1]);
      const list  = files.length ? files : KNOWN_ABINS;
      for (const f of list) {
        const opt = document.createElement('option');
        opt.value = f; opt.textContent = f.replace(/\.abin$/i, '');
        ui.mapSelect.appendChild(opt);
      }
    } catch {
      for (const f of KNOWN_ABINS) {
        const opt = document.createElement('option');
        opt.value = f; opt.textContent = f.replace(/\.abin$/i, '');
        ui.mapSelect.appendChild(opt);
      }
    }
  } catch (e) {
    setStatus(`Init error: ${e.message}`, true);
    console.error(e);
  }
})();
