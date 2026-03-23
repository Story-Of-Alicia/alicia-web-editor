import { BASE, ABIN_DIR, canvas, renderer, scene, camera, controls, clock, state, ui, setStatus, initUserLight, updateUserLight } from './viewerState.js';
import { loadCharacter, buildSlotUI, clearScene, hasActiveAnimationPose, syncBoneLinks, syncAttachmentGroup, syncAttachmentGroupPosition } from './characterViewer.js';
import { loadMap, clearMap } from './mapViewer.js';
import { initAssetTree, clearAssetPreview, bumpSelectionToken, initSearch } from './assetBrowser.js';

// ─── Tab / mode switching ─────────────────────────────────────────────────────
function setMode(mode) {
  state.mapMode = mode === 'map';
  const isAssets = mode === 'assets';
  ui.tabChar.classList.toggle('active', mode === 'char');
  ui.tabMap.classList.toggle('active', mode === 'map');
  ui.tabAssets.classList.toggle('active', isAssets);
  ui.charToolbar.style.display   = mode === 'char'   ? '' : 'none';
  ui.mapToolbar.style.display    = mode === 'map'    ? '' : 'none';
  ui.assetsToolbar.style.display = isAssets          ? '' : 'none';
  ui.charSidebar.style.display   = mode === 'char'   ? '' : 'none';
  ui.mapSidebar.style.display    = mode === 'map'    ? '' : 'none';
  ui.assetsSidebar.style.display = isAssets          ? '' : 'none';
  ui.controlsEl.style.display    = mode === 'char'   ? 'flex' : 'none';
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
ui.tabMap.addEventListener('click',    () => { setMode('map');    clearScene(); if (ui.mapSelect.value) loadMap(ui.mapSelect.value); });
ui.tabAssets.addEventListener('click', () => { setMode('assets'); clearScene(); clearMap(); initAssetTree(); });

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

ui.btnBones.addEventListener('click', () => {
  state.showBones = !state.showBones;
  if (state.skeletonHelper) state.skeletonHelper.visible = state.showBones;
  ui.btnBones.classList.toggle('active', state.showBones);
});
ui.btnWire.addEventListener('click', () => {
  state.showWireframe = !state.showWireframe;
  state.sceneGroup?.traverse(obj => {
    if (obj.isMesh || obj.isSkinnedMesh) [obj.material].flat().forEach(m => { m.wireframe = state.showWireframe; });
  });
  ui.btnWire.classList.toggle('active', state.showWireframe);
});

[ui.lightX, ui.lightY, ui.lightZ, ui.lightInt].forEach(ctrl => {
  ctrl?.addEventListener('input', () => {
    initUserLight();
    updateUserLight();
  });
});

initSearch();

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

// ─── Init: load char_parts.json then build UI ─────────────────────────────────
(async () => {
  try {
    state.partsData = await (await fetch('char_parts.json')).json();

    for (const char of Object.keys(state.partsData)) {
      const opt = document.createElement('option');
      opt.value = char; opt.textContent = char;
      ui.charSelect.appendChild(opt);
    }
    ui.charSelect.value = 'r00';

    // Populate map select
    try {
      const text  = await (await fetch(`${BASE}/${ABIN_DIR}/`)).text();
      const files = [...text.matchAll(/href="([^"]+\.abin)"/gi)].map(m => m[1]);
      for (const f of files) {
        const opt = document.createElement('option');
        opt.value = f; opt.textContent = f.replace(/\.abin$/i, '');
        ui.mapSelect.appendChild(opt);
      }
    } catch { /* no abin directory listing available */ }

    setMode('char');
    await switchChar('r00');
  } catch (e) {
    setStatus(`Init error: ${e.message}`, true);
    console.error(e);
  }
})();
