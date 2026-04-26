import * as THREE from 'three';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { BASE, ddsLoader, texCache, maxAniso, state, DEBUG_MAP_RESOLVE, DEBUG_MAP_RESOLVE_FILTER } from './viewerState.js';

// ─── PAK texture index (populated when browsing a PAK file) ─────────────────
// Maps lowercased texture name (without ext) -> full PAK path
let pakTexIndex = new Map();
let pakFetchAssetFn = null;

export function setPakTextureSource(assetList, fetchFn) {
  pakTexIndex.clear();
  pakFetchAssetFn = fetchFn;
  if (!assetList) return;
  for (const entry of assetList) {
    const originalPath = entry.path;               // original path with backslashes for server
    const lower = originalPath.replace(/\\/g, '/').toLowerCase();
    if (lower.endsWith('.dds') || lower.endsWith('.png')) {
      // Index by filename without extension.
      const filename = lower.split('/').pop();
      const stem = filename.replace(/\.(dds|png)$/, '');
      // Prefer DDS over PNG — only set if not already set or if this is DDS.
      if (!pakTexIndex.has(stem) || lower.endsWith('.dds')) {
        pakTexIndex.set(stem, originalPath);
      }
    }
  }
  console.log(`[PAK tex] indexed ${pakTexIndex.size} textures`);
}

export function clearPakTextureSource() {
  pakTexIndex.clear();
  pakFetchAssetFn = null;
}

// ─── BG file index (shared by textureUtils and mapViewer) ─────────────────────
let bgIndexPromise = null;

// Build the bg-index from PAK listing data (no HTTP scanning needed).
function buildBgIndexFromPak(listingData) {
  const dff = new Map();
  const bsp = new Map();
  const tex = new Map();
  for (const entry of listingData) {
    const path = entry.path.replace(/\\/g, '/');
    const lower = path.toLowerCase();
    const filename = lower.split('/').pop();
    // Use the relative HTTP-style URL so tryFetchDFF/BSP can call fetchBinary on it.
    const url = `${BASE}/${path}`;
    if (filename.endsWith('.dff')) {
      const stem = filename.slice(0, -4);
      if (!dff.has(stem)) dff.set(stem, url);
    } else if (filename.endsWith('.bsp')) {
      const stem = filename.slice(0, -4);
      if (!bsp.has(stem)) bsp.set(stem, url);
    } else if (filename.endsWith('.dds') || filename.endsWith('.png')) {
      if (!tex.has(filename)) tex.set(filename, url);
      const stripped = filename.replace(/^[^a-z]+/, '');
      if (stripped !== filename && !tex.has(stripped)) tex.set(stripped, url);
    }
  }
  console.log(`[PAK BG index] ${dff.size} DFF, ${bsp.size} BSP, ${tex.size} textures`);
  return { dff, bsp, tex };
}

export function resetBgIndex() {
  bgIndexPromise = null;
}

export function getBgIndex() {
  if (!bgIndexPromise) bgIndexPromise = (async () => {
    // If PAK is connected, build from listing instead of scanning HTTP directories.
    if (state.pakListing) {
      return buildBgIndexFromPak(state.pakListing);
    }

    const dff = new Map();
    const bsp = new Map();
    const tex = new Map();

    async function scan(path, depth) {
      if (depth > 8) return;
      let text;
      try { text = await (await fetch(`${BASE}/${path}/`)).text(); } catch { return; }
      const entries = [...text.matchAll(/href="([^"#?./][^"]*)"/gi)].map(m => m[1]);
      const subdirs = [], files = [];
      for (const e of entries) {
        (e.endsWith('/') ? subdirs : files).push(e);
      }
      for (const f of files) {
        const decoded = decodeURIComponent(f).toLowerCase();
        const url = `${BASE}/${path}/${f}`;
        if (decoded.endsWith('.dff')) {
          const stem = decoded.slice(0, -4);
          if (!dff.has(stem)) dff.set(stem, url);
        } else if (decoded.endsWith('.bsp')) {
          const stem = decoded.slice(0, -4);
          if (!bsp.has(stem)) bsp.set(stem, url);
        } else if (decoded.endsWith('.dds') || decoded.endsWith('.png')) {
          if (!tex.has(decoded)) tex.set(decoded, url);
          const stripped = decoded.replace(/^]+/, '');
          if (stripped !== decoded && !tex.has(stripped)) tex.set(stripped, url);
        }
      }
      await Promise.all(subdirs.map(s => scan(`${path}/${s.slice(0, -1)}`, depth + 1)));
    }

    await scan('graphics', 0);
    console.log(`[BG index] ${dff.size} DFF, ${bsp.size} BSP, ${tex.size} textures`);
    return { dff, bsp, tex };
  })();
  return bgIndexPromise;
}

// ─── Texture loading & caching ────────────────────────────────────────────────

export async function loadTexture(texDir, name, colorSpace = THREE.SRGBColorSpace) {
  if (!name) return null;

  // pak mode: load texture from PAK via WebSocket
  if (texDir === 'pak') {
    if (!pakFetchAssetFn || !pakTexIndex.size) return null;
    const coreName = name.replace(/_(dif|spc|sss)$/i, '');
    const lowerName = name.toLowerCase();
    const lowerCore = coreName.toLowerCase();
    const pakPath = pakTexIndex.get(lowerName) ?? pakTexIndex.get(lowerCore);
    if (!pakPath) return null;
    const key = `pak:${pakPath}@${colorSpace}`;
    if (!texCache.has(key)) {
      texCache.set(key, (async () => {
        const buffer = await pakFetchAssetFn(pakPath);
        const ext = pakPath.toLowerCase().endsWith('.dds') ? '.dds' : '.png';
        let tex;
        if (ext === '.dds') {
          const ddsData = new DDSLoader().parse(buffer);
          tex = new THREE.CompressedTexture(
            ddsData.mipmaps, ddsData.width, ddsData.height, ddsData.format
          );
          tex.needsUpdate = true;
        } else {
          const blob = new Blob([buffer], { type: 'image/png' });
          const url = URL.createObjectURL(blob);
          tex = await new Promise((ok, fail) =>
            new THREE.TextureLoader().load(url, ok, undefined, fail)
          );
          URL.revokeObjectURL(url);
        }
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = maxAniso;
        tex.colorSpace = colorSpace;
        tex.userData.texName = name.toLowerCase();
        return tex;
      })().catch(() => null));
    }
    return texCache.get(key);
  }

  // bg-index mode: look up the exact URL from the pre-built file index
  if (texDir === 'bg-index') {
    const { tex: texIndex } = await getBgIndex();
    const coreName = name.replace(/_(dif|spc|sss)$/i, '');
    const url = texIndex.get(`${name}.dds`) ?? texIndex.get(`${name}.png`)
             ?? (coreName !== name ? (texIndex.get(`${coreName}.dds`) ?? texIndex.get(`${coreName}.png`)) : undefined);
    if (!url) return null;
    const key = `bg-index:${name}@${colorSpace}`;
    if (!texCache.has(key)) {
      const ext = url.toLowerCase().endsWith('.dds') ? '.dds' : '.png';
      texCache.set(key, (ext === '.dds'
        ? new Promise((ok, fail) => ddsLoader.load(url, ok, undefined, fail))
        : new Promise((ok, fail) => new THREE.TextureLoader().load(url, ok, undefined, fail))
      ).then(tex => { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.anisotropy = maxAniso; tex.colorSpace = colorSpace; tex.userData.texName = name.toLowerCase(); return tex; })
       .catch(() => null));
    }
    return texCache.get(key);
  }

  const dirs = Array.isArray(texDir) ? texDir : [texDir];
  for (const dir of dirs) {
    for (const ext of ['.dds', '.png']) {
      const key = `${dir}/${name}${ext}@${colorSpace}`;
      if (!texCache.has(key)) {
        const url = `${BASE}/${dir}/${name}${ext}`;
        texCache.set(key, (ext === '.dds'
          ? new Promise((ok, fail) => ddsLoader.load(url, ok, undefined, fail))
          : new Promise((ok, fail) => new THREE.TextureLoader().load(url, ok, undefined, fail))
        ).then(tex => {
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          tex.anisotropy = maxAniso;
          tex.colorSpace = colorSpace;
          tex.userData.texName = name.toLowerCase();
          return tex;
        }).catch(() => null));
      }
      const tex = await texCache.get(key);
      if (tex !== null) return tex;
    }
  }
  return null;
}

// ─── Texture name helpers ─────────────────────────────────────────────────────

export function deriveTextureNames(texName) {
  if (!texName) return {};
  const match = texName.match(/^(.*)_(dif|spc|sss)(\+.*)?$/i);
  const suffix = match?.[2]?.toLowerCase();
  const variant = match?.[3] ?? '';
  const core = match ? match[1] : texName.replace(/(_dif|_spc|_sss)(\+.*)?$/i, '');
  const stemWith = suf => `${core}_${suf}`;
  return {
    diffuse: suffix === 'dif' ? texName : `${stemWith('dif')}${variant}`,
    specular: stemWith('spc'),
    sss: stemWith('sss'),
  };
}

export function normalizeTextureStem(name) {
  if (!name) return null;
  const stem = String(name)
    .replace(/\0/g, '')
    .trim()
    .replace(/^.*[/\\]/, '')
    .replace(/\.(dds|png)$/i, '');
  if (!stem || /^none$/i.test(stem)) return null;
  return stem;
}

export function pushUniqueName(list, name, max = 32) {
  if (!Array.isArray(list) || list.length >= max) return;
  const stem = normalizeTextureStem(name);
  if (!stem) return;
  if (!list.includes(stem)) list.push(stem);
}

export function logMapResolveDebug(modelName, debugInfo) {
  if (!DEBUG_MAP_RESOLVE) return;
  const filter = DEBUG_MAP_RESOLVE_FILTER.trim().toLowerCase();
  if (filter && !modelName.toLowerCase().includes(filter)) return;

  const dffList = debugInfo?.dffNames ?? [];
  const bspList = debugInfo?.bspNames ?? [];
  const dffHead = dffList.slice(0, 12);
  const bspHead = bspList.slice(0, 12);
  const dffTail = dffList.length > dffHead.length ? ` (+${dffList.length - dffHead.length} more)` : '';
  const bspTail = bspList.length > bspHead.length ? ` (+${bspList.length - bspHead.length} more)` : '';

  console.groupCollapsed(`[MAP resolve] ${modelName}`);
  console.log(`DFF source: ${debugInfo?.dffUrl ?? '(none)'}`);
  console.log(`BSP source: ${debugInfo?.bspUrl ?? '(none)'}`);
  console.log(`DFF resolved textures (${dffList.length}):`, dffHead, dffTail);
  console.log(`BSP resolved textures (${bspList.length}):`, bspHead, bspTail);
  console.groupEnd();
}

export async function loadTextureSet(texDir, texName) {
  const stem = normalizeTextureStem(texName);
  if (!stem) return {};
  const { diffuse, specular, sss } = deriveTextureNames(stem);
  // Some DFFs store bare texture names without _dif suffix (e.g. "h000_macho" not "h000_macho_dif").
  // Try the derived _dif name first; fall back to the bare stem if it returns null.
  const mapDiff = await loadTexture(texDir, diffuse, THREE.SRGBColorSpace)
    ?? (diffuse !== stem ? await loadTexture(texDir, stem, THREE.SRGBColorSpace) : null);
  const [specMap, sssMap] = await Promise.all([
    loadTexture(texDir, specular, THREE.LinearSRGBColorSpace),
    loadTexture(texDir, sss, THREE.LinearSRGBColorSpace),
  ]);
  return { map: mapDiff, specMap, sssMap };
}
