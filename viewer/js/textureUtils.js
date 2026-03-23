import * as THREE from 'three';
import { BASE, ddsLoader, texCache, DEBUG_MAP_RESOLVE, DEBUG_MAP_RESOLVE_FILTER } from './viewerState.js';

// ─── BG file index (shared by textureUtils and mapViewer) ─────────────────────
let bgIndexPromise = null;
export function getBgIndex() {
  if (!bgIndexPromise) bgIndexPromise = (async () => {
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
      ).then(tex => { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = colorSpace; return tex; })
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
          tex.colorSpace = colorSpace;
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
  const [map, specMap, sssMap] = await Promise.all([
    loadTexture(texDir, diffuse, THREE.SRGBColorSpace),
    loadTexture(texDir, specular, THREE.LinearSRGBColorSpace),
    loadTexture(texDir, sss, THREE.LinearSRGBColorSpace),
  ]);
  return { map, specMap, sssMap };
}
