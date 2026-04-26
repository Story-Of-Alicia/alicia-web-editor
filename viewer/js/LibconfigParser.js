// ─── libconfig_c.dat parser ───────────────────────────────────────────────────
// The file is UTF-8 XML containing game config tables.
// We read CharPartSet, CharPartInfo, _ClientCharDefaultPartInfo for characters,
// and MountPartSet/MountPartInfo/MountSkinInfo/MountManeInfo/MountTailInfo for horses.

const PC  = 'graphics/pc';
const VEH = 'graphics/vehicle';

// CharPartType (CharPartInfo) → slot id
const PART_TYPE_SLOT = { 1: 'hair', 2: 'top', 4: 'bottom', 6: 'top', 8: 'hat', 16: 'accessory' };

// ClientCharPartType (_ClientCharDefaultPartInfo) → slot id
const CLIENT_PART_TYPE_SLOT = { 2: 'mouth', 3: 'eyes' };

const SLOT_ORDER  = ['hair', 'mouth', 'eyes', 'top', 'bottom', 'hat', 'accessory'];
const SLOT_LABELS = {
  hair: 'Hair', mouth: 'Mouth', eyes: 'Eyes',
  top: 'Top', bottom: 'Bottom', hat: 'Hat', accessory: 'Accessory',
};

function tableRows(doc, tableName) {
  const table = doc.querySelector(`TABLE[name="${tableName}"]`);
  if (!table) return [];
  return [...table.querySelectorAll('ROW')].map(row => {
    const obj = {};
    for (const child of row.children) obj[child.tagName] = child.textContent.trim();
    return obj;
  });
}

function ensureSlot(map, dff, slotId) {
  if (!map[dff]) map[dff] = {};
  if (!map[dff][slotId]) map[dff][slotId] = [];
  return map[dff][slotId];
}

export function parseLibconfig(xmlText) {
  // Strip RowCount attributes — some browsers cap querySelectorAll results to that value.
  const stripped = xmlText.replace(/\bRowCount\s*=\s*'[^']*'/g, '');
  const doc = new DOMParser().parseFromString(stripped, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('libconfig XML parse error');

  // ── CharPartSet: CharID → DFF filename (e.g. 20→"r00", 10→"r02") ──────────
  const charIdToDff = {};
  for (const row of tableRows(doc, 'CharPartSet')) {
    const dff = row.DffFileName;
    if (!dff || dff === ' ') continue;
    charIdToDff[parseInt(row.CharID)] = dff;
  }

  // ── Build CHAR_CFG path entries ───────────────────────────────────────────
  const charCfg = {};
  for (const dff of Object.values(charIdToDff)) {
    charCfg[dff] = {
      texDir:   `${PC}/${dff}/textures`,
      partsDir: `${PC}/${dff}_parts`,
      anmDir:   `${PC}/${dff}/anm`,
      skelDff:  `${PC}/${dff}/${dff}.dff`,
    };
  }

  // ── ItemIndex: TID → icon filename (TID matches CharPartInfo.Tid) ─────────
  const tidToIcon = {};
  const tidToName = {};
  for (const row of tableRows(doc, 'ItemIndex')) {
    const tid  = parseInt(row.TID);
    if (!Number.isFinite(tid)) continue;
    const icon = row.LargeUIFileName;
    const name = row.Name;
    if (icon && icon !== ' ') tidToIcon[tid] = icon;
    if (name && name !== ' ') tidToName[tid]  = name;
  }

  // ── CharPartInfo: clothing/accessory parts per character ──────────────────
  const bySlot = {};
  for (const row of tableRows(doc, 'CharPartInfo')) {
    const dff = charIdToDff[parseInt(row.CharID)];
    if (!dff) continue;
    const partType = parseInt(row.CharPartType);
    const slotId   = PART_TYPE_SLOT[partType];
    if (!slotId) continue;
    const tid      = parseInt(row.Tid);
    const iconFile = tidToIcon[tid] ?? null;
    const name     = tidToName[tid]  ?? null;
    const extraProps = partType === 6 ? { dress: true } : {};
    for (const key of ['MeshFileName', 'MeshFileNameB', 'MeshFileNameC', 'MeshFileNameD']) {
      const mesh = row[key];
      if (!mesh || mesh === ' ') continue;
      ensureSlot(bySlot, dff, slotId).push({
        mesh,
        desc:     name ?? mesh,
        iconFile,
        released: true,
        ...extraProps,
      });
    }
  }

  // ── _ClientCharDefaultPartInfo: mouth, eyes (and default hair) ────────────
  for (const row of tableRows(doc, '_ClientCharDefaultPartInfo')) {
    const dff = charIdToDff[parseInt(row.CharId)];
    if (!dff) continue;
    const partType = parseInt(row.ClientCharPartType);
    const slotId   = CLIENT_PART_TYPE_SLOT[partType];
    if (!slotId) continue;
    const mesh = row.MeshFileNameA;
    if (!mesh || mesh === ' ') continue;
    const iconFile = (row.IconFileName && row.IconFileName !== ' ') ? row.IconFileName : null;
    ensureSlot(bySlot, dff, slotId).push({
      mesh,
      desc:     row.Desc || mesh,
      iconFile,
      released: row.ReleaseFlag === '1',
    });
  }

  // ── Assemble partsData (slot UI format) ───────────────────────────────────
  const partsData = {};
  for (const dff of Object.keys(charCfg)) {
    const slotMap = bySlot[dff] ?? {};
    const slots = SLOT_ORDER
      .filter(id => slotMap[id]?.length)
      .map(id => ({ id, label: SLOT_LABELS[id], parts: slotMap[id] }));
    if (slots.length) partsData[dff] = { slots };
  }

  return { charCfg, partsData };
}

// ─── Mount / horse data ───────────────────────────────────────────────────────

const MOUNT_PART_FLAG_SLOT = { 2: 'saddle', 4: 'armor_l', 8: 'shield', 16: 'armor_r' };
const MOUNT_SLOT_ORDER  = ['skin', 'mane', 'tail', 'saddle', 'armor_l', 'armor_r', 'shield'];
const MOUNT_SLOT_LABELS = { skin: 'Coat', saddle: 'Saddle', armor_l: 'Armor L', armor_r: 'Armor R', shield: 'Shield', mane: 'Mane', tail: 'Tail' };

export function parseMounts(xmlText) {
  const stripped = xmlText.replace(/\bRowCount\s*=\s*'[^']*'/g, '');
  const doc = new DOMParser().parseFromString(stripped, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('libconfig XML parse error');

  // TID → icon/name from ItemIndex
  const tidToIcon = {};
  const tidToName = {};
  for (const row of tableRows(doc, 'ItemIndex')) {
    const tid = parseInt(row.TID);
    if (!Number.isFinite(tid)) continue;
    if (row.LargeUIFileName && row.LargeUIFileName !== ' ') tidToIcon[tid] = row.LargeUIFileName;
    if (row.Name           && row.Name            !== ' ') tidToName[tid]  = row.Name;
  }

  // ── MountPartSet: Tid → { dff, skinId, maneId, tailId } ─────────────────
  const mountPartSet = {};
  for (const row of tableRows(doc, 'MountPartSet')) {
    const tid = parseInt(row.Tid);
    const dff = row.DffFileName;
    if (!dff || dff === ' ') continue;
    mountPartSet[tid] = {
      dff,
      skinId: parseInt(row.SkinID) || 0,
      maneId: parseInt(row.ManeID) || 0,
      tailId: parseInt(row.TailID) || 0,
    };
  }

  // ── Build mountCfg ────────────────────────────────────────────────────────
  const mountCfg = {};
  const dffSeen = new Set();
  for (const { dff } of Object.values(mountPartSet)) {
    if (dffSeen.has(dff)) continue;
    dffSeen.add(dff);
    mountCfg[dff] = {
      texDir:    `${VEH}/${dff}/textures`,
      partsDir:  `${VEH}/${dff}_parts`,
      physxDir:  `${VEH}/${dff}_physx`,
      anmDir:    `${VEH}/${dff}/anm`,
      skelDff:   `${VEH}/${dff}/${dff}.dff`,
    };
  }

  // ── MountPartInfo: equipment (saddle/armor/shield) ────────────────────────
  const equipByDff = {};
  // Inject bare-body entry first in the saddle slot — hXXX_hbd000_00_a.dff is the no-saddle body
  for (const dff of dffSeen) {
    if (!equipByDff[dff]) equipByDff[dff] = {};
    equipByDff[dff]['saddle'] = [{ mesh: `${dff}_hbd000_00_a`, desc: 'Bare', iconFile: null, released: true, bare: true }];
  }
  for (const row of tableRows(doc, 'MountPartInfo')) {
    const flag   = parseInt(row.MountPartFlag);
    const slotId = MOUNT_PART_FLAG_SLOT[flag];
    if (!slotId) continue;
    const tid      = parseInt(row.Tid);
    const iconFile = tidToIcon[tid] ?? null;
    const name     = tidToName[tid] ?? null;
    for (const key of ['MeshFileName', 'MeshFileNameB', 'MeshFileNameC', 'MeshFileNameD']) {
      const mesh = row[key];
      if (!mesh || mesh === ' ') continue;
      for (const dff of dffSeen) {
        if (!equipByDff[dff]) equipByDff[dff] = {};
        if (!equipByDff[dff][slotId]) equipByDff[dff][slotId] = [];
        equipByDff[dff][slotId].push({ mesh: `${dff}_${mesh}`, desc: name ?? mesh, iconFile, released: true });
      }
    }
  }

  // ── MountManeInfo / MountTailInfo — deduplicate by mesh, color is a texture swap ──
  function parseManeOrTail(tableName, slotId) {
    const byDff = {};
    const seenMesh = new Set();
    for (const row of tableRows(doc, tableName)) {
      const meshA = row.MeshFileNameA;
      if (!meshA || meshA === ' ') continue;
      if (seenMesh.has(meshA)) continue;  // same mesh, different color row — skip
      seenMesh.add(meshA);
      const shape = parseInt(row.Shape) || 0;
      const desc  = `Shape ${shape}`;
      for (const dff of dffSeen) {
        if (!byDff[dff]) byDff[dff] = {};
        if (!byDff[dff][slotId]) byDff[dff][slotId] = [];
        byDff[dff][slotId].push({ mesh: `${dff}_${meshA}`, desc, iconFile: null, released: true, shape });
      }
    }
    return byDff;
  }
  const maneByDff = parseManeOrTail('MountManeInfo', 'mane');
  const tailByDff = parseManeOrTail('MountTailInfo', 'tail');

  // ── MountSkinInfo: coat texture swaps ─────────────────────────────────────
  // Target is the texture slot on the base mesh (e.g. "_macho.dds"), Texture is the replacement.
  // Thumbnail is at texDir/{dff}_{skinN}_thumbnail.png
  const skinByDff = {};
  for (const row of tableRows(doc, 'MountSkinInfo')) {
    const id      = parseInt(row.ID);
    const texture = row.Texture;  // e.g. "_skin001_dif.dds"
    const target  = row.Target;   // e.g. "_macho.dds"
    if (!texture || texture === ' ' || !target || target === ' ') continue;
    // Derive stem: "_skin001_dif.dds" → "skin001"
    const stem = texture.replace(/^_/, '').replace(/\.dds$/i, '').replace(/_dif$/, '');
    const desc = `Coat ${id}`;
    for (const dff of dffSeen) {
      if (!skinByDff[dff]) skinByDff[dff] = { skin: [] };
      const thumbStem = `${dff}_${stem}_thumbnail`;
      skinByDff[dff].skin.push({
        id, desc,
        // texture name as used in texDir (without .dds)
        texName:  `${dff}_${stem}_dif`,
        target:   target.replace(/^_/, '').replace(/\.dds$/i, ''),
        iconFile: thumbStem,
        released: true,
      });
    }
  }

  // ── Assemble mountsData ───────────────────────────────────────────────────
  const mountsData = {};
  for (const dff of dffSeen) {
    const slotMap = {
      ...(skinByDff[dff] ?? {}),
      ...equipByDff[dff],
      ...(maneByDff[dff] ?? {}),
      ...(tailByDff[dff] ?? {}),
    };
    const slots = MOUNT_SLOT_ORDER
      .filter(id => slotMap[id]?.length)
      .map(id => ({ id, label: MOUNT_SLOT_LABELS[id], parts: slotMap[id] }));
    mountsData[dff] = { slots };
  }

  return { mountCfg, mountsData };
}
