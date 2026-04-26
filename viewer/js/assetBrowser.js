import * as THREE from 'three';
import { DFFParser } from './DFFParser.js';
import { ANMParser } from './ANMParser.js';
import { BSPParser  } from './BSPParser.js';
import { ABinParser } from './ABinParser.js';
import { BASE, scene, camera, controls, ui, setStatus, ddsLoader } from './viewerState.js';

// ─── Asset browser state ─────────────────────────────────────────────────────
let assetTreeInitialised = false;
let assetPreviewGroup    = null;
let activeAssetEl        = null;
export let assetSelectionToken  = 0;
const assetBufferCache   = new Map();
const assetInfoCache     = new Map();
const detailObjectUrls   = new Set();
const previewObjectUrls  = new Set();

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']);
const TEXT_EXTS = new Set([
  'txt', 'json', 'xml', 'ini', 'cfg', 'conf', 'lua', 'list', 'md', 'log',
  'csv', 'yaml', 'yml', 'js', 'ts', 'glsl', 'vert', 'frag', 'shader',
  'material', 'bat', 'cmd', 'ps1', 'html', 'css',
]);
const RW_TREE_EXTS = new Set(['dff', 'bsp', 'anm', 'abin']);
const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;
const textDecoder = new TextDecoder('utf-8', { fatal: false });

export function bumpSelectionToken() { return ++assetSelectionToken; }

export function initAssetTree() {
  if (assetTreeInitialised) return;
  assetTreeInitialised = true;
  ui.assetTree.innerHTML = '';
  resetAssetDetail();
  buildDirNodeAsset(ui.assetTree, 'graphics', 0, true);
}

function releaseObjectUrls(set) {
  for (const url of set) URL.revokeObjectURL(url);
  set.clear();
}

function rememberDetailObjectUrl(url) {
  detailObjectUrls.add(url);
  return url;
}

function rememberPreviewObjectUrl(url) {
  previewObjectUrls.add(url);
  return url;
}

function clearDetailMedia() {
  releaseObjectUrls(detailObjectUrls);
}

function disposePreviewGroup(group) {
  if (!group?.userData?.disposeOnClear) return;
  group.traverse((node) => {
    if (!node?.isMesh) return;
    if (node.geometry?.dispose) node.geometry.dispose();
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!material) continue;
      if (material.map?.dispose) material.map.dispose();
      if (material.dispose) material.dispose();
    }
  });
}

export function clearAssetPreview() {
  if (assetPreviewGroup) {
    disposePreviewGroup(assetPreviewGroup);
    scene.remove(assetPreviewGroup);
    assetPreviewGroup = null;
  }
  releaseObjectUrls(previewObjectUrls);
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function selectAssetRow(row) {
  if (activeAssetEl) activeAssetEl.classList.remove('active');
  activeAssetEl = row;
  if (row) row.classList.add('active');
}

// ─── Detail panel helpers ─────────────────────────────────────────────────────

function createTextElement(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function createDetailBlock(title, children = []) {
  const section = document.createElement('section');
  section.className = 'asset-detail-block';
  section.append(createTextElement('h3', 'asset-detail-title', title));
  children.filter(Boolean).forEach(child => section.append(child));
  return section;
}

function createKeyValueBlock(title, entries) {
  const valid = entries.filter(([, value]) => value != null && value !== '');
  if (!valid.length) return null;
  const dl = document.createElement('dl');
  dl.className = 'asset-kv';
  valid.forEach(([label, value]) => {
    dl.append(createTextElement('dt', '', label));
    dl.append(createTextElement('dd', '', String(value)));
  });
  return createDetailBlock(title, [dl]);
}

function createListBlock(title, items) {
  const valid = items.filter(Boolean);
  if (!valid.length) return null;
  const list = document.createElement('ul');
  list.className = 'asset-detail-list';
  valid.forEach(item => list.append(createTextElement('li', '', item)));
  return createDetailBlock(title, [list]);
}

function createChipBlock(title, items) {
  const valid = items.filter(Boolean);
  if (!valid.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'asset-chip-list';
  valid.forEach(item => wrap.append(createTextElement('span', 'asset-chip', item)));
  return createDetailBlock(title, [wrap]);
}

function createCodeBlock(title, lines) {
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines ?? '').trim();
  if (!text) return null;
  return createDetailBlock(title, [createTextElement('pre', 'asset-code', text)]);
}

export function renderAssetDetail(blocks) {
  clearDetailMedia();
  clearChildren(ui.assetDetail);
  blocks.filter(Boolean).forEach(block => ui.assetDetail.append(block));
  ui.assetDetail.scrollTop = 0;
}

export function resetAssetDetail(message = 'Select a file or chunk to inspect it here.') {
  clearDetailMedia();
  clearChildren(ui.assetDetail);
  ui.assetDetail.append(createTextElement('p', 'asset-empty', message));
}

export function showAssetLoading(title, subtitle = '') {
  renderAssetDetail([
    createDetailBlock('Loading', [
      createTextElement('p', 'asset-empty', title),
      subtitle ? createTextElement('p', 'asset-empty', subtitle) : null,
    ]),
  ]);
}

export function showAssetError(title, message) {
  renderAssetDetail([
    createDetailBlock('Error', [
      createTextElement('p', 'asset-empty', title),
      createTextElement('p', 'asset-empty', message),
    ]),
  ]);
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatByteSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const precision = unitIndex === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatNumber(value, digits = 3) {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs >= 1000 || (abs > 0 && abs < 0.001)) return value.toExponential(3);
  return value.toFixed(digits).replace(/\.?0+$/, '');
}

function formatVec3(vec, digits = 3) {
  if (!Array.isArray(vec)) return '';
  return `(${vec.map(v => formatNumber(v, digits)).join(', ')})`;
}

function formatVersion(version) {
  const hex = `0x${version.toString(16).toUpperCase().padStart(8, '0')}`;
  const text = rwVerStr(version).trim();
  return text ? `${hex} (${text})` : hex;
}

function formatRange(start, endExclusive) {
  if (endExclusive <= start) return `0x${start.toString(16).toUpperCase()}`;
  return `0x${start.toString(16).toUpperCase()} - 0x${(endExclusive - 1).toString(16).toUpperCase()}`;
}

function mimeTypeForImageExt(ext) {
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'bmp') return 'image/bmp';
  return 'application/octet-stream';
}

function looksLikeText(bytes, sampleSize = 4096) {
  const sampleLen = Math.min(sampleSize, bytes.length);
  if (!sampleLen) return false;

  let printable = 0;
  let suspicious = 0;
  for (let i = 0; i < sampleLen; i++) {
    const value = bytes[i];
    if (value === 0) return false;
    if (value === 9 || value === 10 || value === 13 || (value >= 32 && value <= 126)) {
      printable++;
      continue;
    }
    if (value >= 0x20) {
      printable++;
      continue;
    }
    suspicious++;
  }

  if (!printable) return false;
  const ratio = printable / sampleLen;
  return ratio >= 0.85 && suspicious <= sampleLen * 0.1;
}

function decodeTextSnippet(bytes, maxBytes = TEXT_PREVIEW_MAX_BYTES) {
  const textBytes = bytes.subarray(0, Math.min(bytes.length, maxBytes));
  const decoded = textDecoder.decode(textBytes);
  const normalised = decoded.replace(/\u0000/g, '').trim();
  if (!normalised) return { text: '', truncated: false, lineCount: 0 };
  const lines = normalised.split(/\r?\n/);
  const previewLines = lines.slice(0, 60);
  const truncated = bytes.length > maxBytes || lines.length > previewLines.length;
  return {
    text: previewLines.join('\n'),
    truncated,
    lineCount: lines.length,
  };
}

function createImagePreviewBlock(info) {
  if (!(info.buffer instanceof ArrayBuffer)) return null;
  const blob = new Blob([info.buffer], { type: mimeTypeForImageExt(info.ext) });
  const url = rememberDetailObjectUrl(URL.createObjectURL(blob));

  const wrap = document.createElement('div');
  wrap.className = 'asset-media-wrap';

  const img = document.createElement('img');
  img.className = 'asset-media-preview';
  img.alt = info.filename;
  img.loading = 'lazy';
  img.src = url;
  wrap.append(img);

  return createDetailBlock('Preview', [wrap]);
}

export function getAssetExt(filename) {
  const value = String(filename ?? '');
  const dot = value.lastIndexOf('.');
  return dot >= 0 ? value.substring(dot + 1).toLowerCase() : '';
}

export function getAssetIconLabel(ext) {
  const value = String(ext ?? '').toLowerCase();
  if (!value) return 'BIN';
  if (value === 'jpeg') return 'JPG';
  if (value.length <= 4) return value.toUpperCase();
  return value.slice(0, 3).toUpperCase();
}

export function canExpandAssetTree(ext) {
  return RW_TREE_EXTS.has(String(ext ?? '').toLowerCase());
}

// ─── Asset buffer / info caches ───────────────────────────────────────────────

async function getAssetBuffer(url) {
  if (!assetBufferCache.has(url)) {
    assetBufferCache.set(url, (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    })().catch((error) => {
      assetBufferCache.delete(url);
      throw error;
    }));
  }
  return assetBufferCache.get(url);
}

async function getAssetInfo(path, filename) {
  const url = `${BASE}/${path}`;
  if (!assetInfoCache.has(url)) {
    assetInfoCache.set(url, (async () => {
      const buffer = await getAssetBuffer(url);
      return inspectAssetBuffer(buffer, path, filename, url);
    })().catch((error) => {
      assetInfoCache.delete(url);
      throw error;
    }));
  }
  return assetInfoCache.get(url);
}

// ─── RW chunk helpers ─────────────────────────────────────────────────────────

const RW_CHUNK_NAMES = new Map([
  [0x0001, 'Struct'],         [0x0002, 'String'],
  [0x0003, 'Extension'],      [0x0006, 'Texture'],
  [0x0007, 'Material'],       [0x0008, 'MaterialList'],
  [0x000B, 'World'],          [0x000E, 'FrameList'],
  [0x000F, 'Geometry'],       [0x0010, 'Clump'],
  [0x0012, 'Light'],          [0x0014, 'Atomic'],
  [0x0016, 'TextureDict'],    [0x001A, 'GeometryList'],
  [0x001B, 'AnimAnimation'],  [0x0025, 'Sky'],
  [0x0031, 'Skin'],           [0x0101, 'NodeDef'],
  [0x0116, 'SkinPlugin'],     [0x011C, 'PatchMesh'],
  [0x011E, 'HAnim'],          [0x011F, 'AliceAsset'],
  [0x0121, 'UserData'],       [0x0253F2F3, 'BinMesh'],
  [0x0253F2F4, 'NativeData'],
]);

function rwChunkLabel(type) {
  const name = RW_CHUNK_NAMES.get(type) ?? `Chunk_0x${type.toString(16).toUpperCase().padStart(4,'0')}`;
  const hex  = `0x${type.toString(16).toUpperCase().padStart(4,'0')}`;
  return `${name} (${hex})`;
}

function rwVerStr(ver) {
  if (!ver) return '';
  const maj = ((ver >> 14) & 0x3F) + 3;
  const min = (ver >> 10) & 0x0F;
  return `  v${maj}.${min}`;
}

export function parseRWChunks(dv, offset, end) {
  const chunks = [];
  let pos = offset;
  while (pos + 12 <= end) {
    const type    = dv.getUint32(pos,     true);
    const size    = dv.getUint32(pos + 4, true);
    const version = dv.getUint32(pos + 8, true);
    const bodyStart = pos + 12;
    const bodyEnd   = bodyStart + size;
    if (bodyEnd > end || size > 0x4000000) break;
    chunks.push({ type, size, version, bodyStart, bodyEnd });
    pos = bodyEnd;
  }
  return chunks;
}

// ─── Data inspection helpers ──────────────────────────────────────────────────

function collectChunkStats(dv, chunks, stats, depth = 0, maxDepth = 5) {
  for (const chunk of chunks) {
    const label = RW_CHUNK_NAMES.get(chunk.type)
      ?? `Chunk 0x${chunk.type.toString(16).toUpperCase().padStart(4, '0')}`;
    const entry = stats.get(label) ?? { label, count: 0, bytes: 0 };
    entry.count++;
    entry.bytes += chunk.size;
    stats.set(label, entry);

    if (depth >= maxDepth || chunk.size < 12 || chunk.type === 0x0001 || chunk.type === 0x0002) continue;
    const subChunks = parseRWChunks(dv, chunk.bodyStart, chunk.bodyEnd);
    if (subChunks.length) collectChunkStats(dv, subChunks, stats, depth + 1, maxDepth);
  }
}

function summariseChunkStats(stats, limit = 10) {
  return [...stats.values()]
    .sort((a, b) => b.count - a.count || b.bytes - a.bytes)
    .slice(0, limit);
}

function extractPrintableStrings(bytes, limit = 8, minLength = 4) {
  const found = [];
  const seen = new Set();
  let current = '';

  const flush = () => {
    const value = current.trim();
    current = '';
    if (value.length < minLength) return;
    if (!/[A-Za-z]/.test(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    found.push(value);
  };

  for (let i = 0; i < bytes.length && found.length < limit; i++) {
    const byte = bytes[i];
    if (byte >= 32 && byte <= 126) {
      current += String.fromCharCode(byte);
      if (current.length >= 120) flush();
    } else {
      flush();
    }
  }
  flush();
  return found;
}

function describeWords(dv, offset = 0, end = dv.byteLength, count = 6) {
  const lines = [];
  for (let i = 0; i < count && offset + 4 <= end; i++, offset += 4) {
    const rel = `+0x${(i * 4).toString(16).toUpperCase().padStart(4, '0')}`;
    const u32 = dv.getUint32(offset, true);
    const i32 = dv.getInt32(offset, true);
    const f32 = dv.getFloat32(offset, true);
    lines.push(`${rel}: u32 ${u32} | i32 ${i32} | f32 ${formatNumber(f32, 4)}`);
  }
  return lines;
}

function hexPreview(bytes, limit = 64) {
  if (!bytes?.length) return '';
  const preview = Array.from(bytes.subarray(0, Math.min(limit, bytes.length)))
    .map(byte => byte.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
  return bytes.length > limit ? `${preview} ...` : preview;
}

// ─── Asset inspection ─────────────────────────────────────────────────────────

export function inspectAssetBuffer(buffer, path, filename, url) {
  const ext = getAssetExt(filename);
  const stem = filename.replace(/\.[^.]+$/, '');
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const topChunks = RW_TREE_EXTS.has(ext) ? parseRWChunks(dv, 0, dv.byteLength) : [];
  const chunkStats = new Map();
  if (topChunks.length) collectChunkStats(dv, topChunks, chunkStats);

  const info = {
    url,
    path,
    filename,
    stem,
    ext,
    buffer,
    size: buffer.byteLength,
    topChunks,
    chunkStats: summariseChunkStats(chunkStats),
    strings: extractPrintableStrings(bytes, 10),
    headerWords: describeWords(dv, 0, dv.byteLength, 6),
    parsed: null,
    parseError: '',
  };

  try {
    if (ext === 'dff') {
      const dffData = new DFFParser().parse(buffer);
      const geometries = dffData.geometries ?? [];
      const frames = dffData.frames ?? [];
      const totalVertices = geometries.reduce((sum, geo) => sum + (geo?.numVertices ?? 0), 0);
      const totalTriangles = geometries.reduce((sum, geo) => sum + (geo?.numTriangles ?? 0), 0);
      const totalMaterials = geometries.reduce((sum, geo) => sum + (geo?.materials?.filter(Boolean).length ?? 0), 0);
      const skinnedGeometries = geometries.filter(geo => geo?.skin).length;
      const nativeGeometries = geometries.filter(geo => geo?.isNative).length;
      const namedFrames = [...new Set(
        frames
          .map(frame => frame?.name)
          .filter(name => name && !/^bone_\d+$/i.test(name))
      )].slice(0, 14);
      const rootFrames = frames
        .filter(frame => frame?.parentIndex < 0)
        .map(frame => frame?.name)
        .filter(Boolean);
      const textureNames = [...new Set(
        geometries.flatMap(geo =>
          (geo?.materials ?? []).map(material => material?.textureName).filter(Boolean)
        )
      )].slice(0, 14);

      info.parsed = {
        kind: 'dff',
        dffData,
        totalVertices,
        totalTriangles,
        totalMaterials,
        skinnedGeometries,
        nativeGeometries,
        namedFrames,
        rootFrames,
        textureNames,
      };
    } else if (ext === 'anm') {
      const anmData = new ANMParser().parse(buffer);
      const sampleTimes = [];
      for (const keyframe of anmData.keyframes) {
        if (!sampleTimes.some(time => Math.abs(time - keyframe.time) < 1e-6)) {
          sampleTimes.push(keyframe.time);
        }
        if (sampleTimes.length >= 8) break;
      }

      const sampleKeyframes = anmData.keyframes
        .slice(0, 6)
        .map((keyframe, index) =>
          `#${index} t=${formatNumber(keyframe.time, 3)} pos=${formatVec3([keyframe.px, keyframe.py, keyframe.pz])} quat=(${formatNumber(keyframe.qx)}, ${formatNumber(keyframe.qy)}, ${formatNumber(keyframe.qz)}, ${formatNumber(keyframe.qw)})`
        );

      info.parsed = {
        kind: 'anm',
        anmData,
        sampleTimes,
        sampleKeyframes,
      };
    } else if (ext === 'bsp') {
      const palette = new BSPParser().parse(buffer);
      const paletteEntries = palette
        ? Object.entries(palette).filter(([, value]) => value).map(([channel, value]) => `${channel}: ${value}`)
        : [];

      info.parsed = {
        kind: 'bsp',
        palette,
        paletteEntries,
      };

      if (!palette) info.parseError = 'No terrain palette was found in this BSP file.';
    } else if (ext === 'abin') {
      const abinData = new ABinParser().parse(buffer);
      const modelNames = (abinData.models ?? []).map(model => model?.name).filter(Boolean).slice(0, 18);
      const cameraNames = (abinData.cameras ?? []).map(camera => camera?.name).filter(Boolean).slice(0, 8);
      const nodeNames = (abinData.nodes ?? []).map(node => node?.name).filter(Boolean).slice(0, 12);

      info.parsed = {
        kind: 'abin',
        abinData,
        modelNames,
        cameraNames,
        nodeNames,
      };
    } else if (ext === 'dds') {
      const ddsData = ddsLoader.parse(buffer);
      info.parsed = {
        kind: 'dds',
        ddsData,
        width: ddsData.width,
        height: ddsData.height,
        mipmaps: Array.isArray(ddsData.mipmaps) ? ddsData.mipmaps.length : 0,
        format: ddsData.format,
      };
    } else if (IMAGE_EXTS.has(ext)) {
      info.parsed = {
        kind: 'image',
        mime: mimeTypeForImageExt(ext),
      };
    } else if (TEXT_EXTS.has(ext) || looksLikeText(bytes)) {
      const decoded = decodeTextSnippet(bytes);
      info.parsed = {
        kind: 'text',
        preview: decoded.text,
        lineCount: decoded.lineCount,
        truncated: decoded.truncated,
      };
    }
  } catch (error) {
    info.parseError = error.message;
  }

  if (!info.parsed) {
    info.parsed = { kind: 'binary' };
  }

  return info;
}

export function buildFileDetailBlocks(info) {
  const blocks = [];

  blocks.push(createKeyValueBlock('Overview', [
    ['Name', info.filename],
    ['Type', info.ext ? info.ext.toUpperCase() : 'BIN'],
    ['Path', info.path],
    ['Size', formatByteSize(info.size)],
  ]));

  if (info.parsed?.kind === 'dff') {
    const parsed = info.parsed;
    blocks.push(createKeyValueBlock('DFF Summary', [
      ['Frames', parsed.dffData.frames.length.toLocaleString()],
      ['Geometries', parsed.dffData.geometries.length.toLocaleString()],
      ['Atomics', parsed.dffData.atomics.length.toLocaleString()],
      ['Vertices', parsed.totalVertices.toLocaleString()],
      ['Triangles', parsed.totalTriangles.toLocaleString()],
      ['Materials', parsed.totalMaterials.toLocaleString()],
      ['Skinned geos', parsed.skinnedGeometries.toLocaleString()],
      ['Native geos', parsed.nativeGeometries.toLocaleString()],
    ]));
    blocks.push(createChipBlock('Textures', parsed.textureNames));
    blocks.push(createListBlock('Named Frames', parsed.namedFrames.map((name, index) => `#${index}: ${name}`)));
    blocks.push(createListBlock('Root Frames', parsed.rootFrames));
  } else if (info.parsed?.kind === 'anm') {
    const parsed = info.parsed;
    const numTimeSteps = parsed.anmData.numTimeSteps ?? parsed.anmData.timeSteps ?? 0;
    const numKeyframes = parsed.anmData.numKeyframes ?? parsed.anmData.keyframes.length;
    blocks.push(createKeyValueBlock('Animation Summary', [
      ['Duration', `${formatNumber(parsed.anmData.duration, 3)} s`],
      ['Bones', parsed.anmData.numBones.toLocaleString()],
      ['Time steps', numTimeSteps.toLocaleString()],
      ['Keyframes', numKeyframes.toLocaleString()],
      ['First time', parsed.anmData.keyframes.length ? `${formatNumber(parsed.anmData.keyframes[0].time, 3)} s` : '0 s'],
      ['Last time', parsed.anmData.keyframes.length ? `${formatNumber(parsed.anmData.keyframes[parsed.anmData.keyframes.length - 1].time, 3)} s` : '0 s'],
    ]));
    blocks.push(createChipBlock('Time Samples', parsed.sampleTimes.map(time => `${formatNumber(time, 3)} s`)));
    blocks.push(createListBlock('Sample Keyframes', parsed.sampleKeyframes));
  } else if (info.parsed?.kind === 'bsp') {
    const parsed = info.parsed;
    blocks.push(createKeyValueBlock('BSP Summary', [
      ['Top-level chunks', info.topChunks.length.toLocaleString()],
      ['Palette slots', parsed.paletteEntries.length.toLocaleString()],
    ]));
    blocks.push(createListBlock('Terrain Palette', parsed.paletteEntries));
  } else if (info.parsed?.kind === 'abin') {
    const parsed = info.parsed;
    blocks.push(createKeyValueBlock('ABIN Summary', [
      ['Version', parsed.abinData.version],
      ['Models', (parsed.abinData.models?.length ?? 0).toLocaleString()],
      ['Cameras', (parsed.abinData.cameras?.length ?? 0).toLocaleString()],
      ['Nodes', (parsed.abinData.nodes?.length ?? 0).toLocaleString()],
    ]));
    blocks.push(createListBlock('Models', parsed.modelNames));
    blocks.push(createListBlock('Cameras', parsed.cameraNames));
    blocks.push(createListBlock('Nodes', parsed.nodeNames));
  } else if (info.parsed?.kind === 'image') {
    blocks.push(createImagePreviewBlock(info));
  } else if (info.parsed?.kind === 'dds') {
    const parsed = info.parsed;
    blocks.push(createKeyValueBlock('DDS Summary', [
      ['Width', parsed.width],
      ['Height', parsed.height],
      ['Mipmaps', parsed.mipmaps],
      ['Format', parsed.format],
    ]));
    blocks.push(createDetailBlock('Preview', [
      createTextElement('p', 'asset-empty', 'Displayed in viewport as a texture quad.'),
    ]));
  } else if (info.parsed?.kind === 'text') {
    const parsed = info.parsed;
    blocks.push(createKeyValueBlock('Text Summary', [
      ['Lines', parsed.lineCount.toLocaleString()],
      ['Preview bytes', formatByteSize(Math.min(info.size, TEXT_PREVIEW_MAX_BYTES))],
      ['Truncated', parsed.truncated ? 'Yes' : 'No'],
    ]));
    blocks.push(createCodeBlock('Text Preview', parsed.preview));
  } else if (info.parsed?.kind === 'binary') {
    blocks.push(createDetailBlock('Binary Preview', [
      createTextElement('p', 'asset-empty', 'No structured parser for this format yet.'),
    ]));
  }

  if (info.topChunks.length) {
    blocks.push(createListBlock(
      'Top-Level Chunks',
      info.topChunks.slice(0, 10).map(chunk => `${rwChunkLabel(chunk.type)} - ${formatByteSize(chunk.size)}`)
    ));
    blocks.push(createChipBlock(
      'Chunk Mix',
      info.chunkStats.map(chunk => `${chunk.label} x${chunk.count}`)
    ));
  }

  blocks.push(createListBlock('Embedded Strings', info.strings));
  blocks.push(createCodeBlock('Header Numbers', info.headerWords));

  if (info.parseError) {
    blocks.push(createDetailBlock('Parser Note', [
      createTextElement('p', 'asset-empty', info.parseError),
    ]));
  }

  return blocks.filter(Boolean);
}

function showFolderDetails(path, listing) {
  renderAssetDetail([
    createKeyValueBlock('Folder', [
      ['Path', path],
      ['Subfolders', listing ? listing.dirs.length.toLocaleString() : 'Expand to inspect'],
      ['Files', listing ? listing.files.length.toLocaleString() : 'Expand to inspect'],
    ]),
    listing?.dirs?.length
      ? createChipBlock('Subfolders', listing.dirs.slice(0, 12).map(dir => dir.name))
      : null,
    listing?.files?.length
      ? createListBlock('Files', listing.files.slice(0, 12).map(file => file.name))
      : null,
  ].filter(Boolean));
}

function showChunkDetails(path, filename, chunk, dv, depth) {
  const sampleBytes = new Uint8Array(dv.buffer, chunk.bodyStart, Math.min(chunk.size, 512));
  const previewBytes = new Uint8Array(dv.buffer, chunk.bodyStart, Math.min(chunk.size, 64));
  const strings = extractPrintableStrings(sampleBytes, 8);
  const childChunks = (chunk.type !== 0x0001 && chunk.type !== 0x0002 && chunk.size >= 12)
    ? parseRWChunks(dv, chunk.bodyStart, chunk.bodyEnd)
    : [];

  renderAssetDetail([
    createKeyValueBlock('Chunk', [
      ['File', filename],
      ['Path', path],
      ['Type', rwChunkLabel(chunk.type)],
      ['Depth', depth.toString()],
      ['Body size', formatByteSize(chunk.size)],
      ['Version', formatVersion(chunk.version)],
      ['Body range', formatRange(chunk.bodyStart, chunk.bodyEnd)],
      ['Child chunks', childChunks.length ? childChunks.length.toLocaleString() : 'None'],
    ]),
    createListBlock('Readable Strings', strings),
    createCodeBlock('Body Numbers', describeWords(dv, chunk.bodyStart, chunk.bodyEnd, 6)),
    createCodeBlock('Hex Preview', hexPreview(previewBytes)),
  ].filter(Boolean));
}

// ─── Tree node helpers ────────────────────────────────────────────────────────

export function makeRow(cls, depth, toggle, iconText, labelText, labelTitle = '') {
  const row = document.createElement('div');
  row.className = cls;
  row.style.paddingLeft = `${6 + depth * 12}px`;
  const tog = document.createElement('span');
  tog.className = 'tree-toggle';
  tog.textContent = toggle;
  const ico = document.createElement('span');
  ico.className = 'tree-icon';
  ico.textContent = iconText;
  const lbl = document.createElement('span');
  lbl.className = 'tree-name';
  lbl.textContent = labelText;
  if (labelTitle) lbl.title = labelTitle;
  row.append(tog, ico, lbl);
  return { row, tog, ico, lbl };
}

export function makeExpandable(parent, headerRow, tog, ico, openIcon, closedIcon, loader, onSelect = null) {
  const children = document.createElement('div');
  children.className = 'tree-children';
  let loaded = false;
  headerRow.addEventListener('click', async () => {
    onSelect?.();
    if (!loaded) {
      loaded = true;
      tog.textContent = '...';
      await loader(children);
    }
    const open = children.classList.toggle('open');
    tog.textContent = open ? 'v' : '>';
    ico.textContent = open ? openIcon : closedIcon;
  });
  parent.append(headerRow, children);
  return children;
}

// ─── Directory listing ────────────────────────────────────────────────────────

async function fetchDirListing(path) {
  let text;
  try { text = await (await fetch(`${BASE}/${path}/`)).text(); } catch { return null; }
  const entries = [...text.matchAll(/href="([^"#?./][^"]*)"/gi)].map(m => m[1]);
  const dirs = [], files = [];
  for (const e of entries) {
    const dec = decodeURIComponent(e);
    if (e.endsWith('/')) dirs.push({ name: dec.slice(0, -1), raw: e.slice(0, -1) });
    else files.push({ name: dec, raw: e });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { dirs, files };
}

// ─── Tree node builders ──────────────────────────────────────────────────────

function buildDirNodeAsset(parent, path, depth, autoExpand = false) {
  const dirName = path.split('/').pop();
  const { row, tog, ico } = makeRow('tree-folder', depth, '>', 'DIR', dirName, path);
  let listingCache = null;

  makeExpandable(
    parent,
    row,
    tog,
    ico,
    'DIR',
    'DIR',
    async (children) => {
      listingCache = await fetchDirListing(path);
      if (!listingCache) {
        tog.textContent = '!';
        if (activeAssetEl === row) {
          renderAssetDetail([
            createKeyValueBlock('Folder', [['Path', path]]),
            createDetailBlock('Error', [createTextElement('p', 'asset-empty', 'This folder could not be listed.')]),
          ].filter(Boolean));
        }
        return;
      }

      for (const dir of listingCache.dirs) buildDirNodeAsset(children, `${path}/${dir.raw}`, depth + 1);
      for (const file of listingCache.files) buildFileNodeAsset(children, `${path}/${file.raw}`, file.name, depth + 1);

      if (!listingCache.dirs.length && !listingCache.files.length) {
        const { row: empty } = makeRow('tree-file', depth + 1, '', '---', '(empty)');
        children.append(empty);
      }

      if (activeAssetEl === row) showFolderDetails(path, listingCache);
    },
    () => {
      selectAssetRow(row);
      showFolderDetails(path, listingCache);
    }
  );

  if (autoExpand) row.click();
}

export function buildRWChunkNodeAsset(parent, dv, chunk, depth, context = { path: '', filename: '' }) {
  const sizeLabel = formatByteSize(chunk.size);
  const versionLabel = rwVerStr(chunk.version).trim();
  const label = `${rwChunkLabel(chunk.type)} - ${sizeLabel}${versionLabel ? ` ${versionLabel}` : ''}`;
  const title = `type=${rwChunkLabel(chunk.type)} size=${chunk.size} version=${formatVersion(chunk.version)}`;

  if (chunk.type === 0x0001) {
    const preview = chunk.size
      ? ` ${hexPreview(new Uint8Array(dv.buffer, chunk.bodyStart, Math.min(chunk.size, 16)), 16)}`
      : '';
    const { row } = makeRow('tree-file', depth, '', 'RAW', `${label}${preview}`, title);
    row.addEventListener('click', () => {
      selectAssetRow(row);
      showChunkDetails(context.path, context.filename, chunk, dv, depth);
    });
    parent.append(row);
    return;
  }

  if (chunk.type === 0x0002) {
    const strings = extractPrintableStrings(
      new Uint8Array(dv.buffer, chunk.bodyStart, Math.min(chunk.size, 128)),
      1
    );
    const { row } = makeRow(
      'tree-file',
      depth,
      '',
      'TXT',
      strings.length ? `${label}: "${strings[0]}"` : label,
      title
    );
    row.addEventListener('click', () => {
      selectAssetRow(row);
      showChunkDetails(context.path, context.filename, chunk, dv, depth);
    });
    parent.append(row);
    return;
  }

  const { row, tog, ico } = makeRow('tree-folder', depth, '>', 'CH', label, title);
  makeExpandable(
    parent,
    row,
    tog,
    ico,
    'CH',
    'CH',
    (children) => {
      if (chunk.size === 0) {
        const { row: empty } = makeRow('tree-file', depth + 1, '', 'RAW', '(empty)');
        children.append(empty);
        return;
      }

      const subChunks = parseRWChunks(dv, chunk.bodyStart, chunk.bodyEnd);
      if (!subChunks.length) {
        const rawPreview = hexPreview(new Uint8Array(dv.buffer, chunk.bodyStart, Math.min(chunk.size, 32)), 32);
        const { row: rawRow } = makeRow('tree-file', depth + 1, '', 'RAW', `(${formatByteSize(chunk.size)} raw) ${rawPreview}`);
        rawRow.addEventListener('click', () => {
          selectAssetRow(rawRow);
          showChunkDetails(context.path, context.filename, chunk, dv, depth);
        });
        children.append(rawRow);
        return;
      }

      for (const child of subChunks) buildRWChunkNodeAsset(children, dv, child, depth + 1, context);
    },
    () => {
      selectAssetRow(row);
      showChunkDetails(context.path, context.filename, chunk, dv, depth);
    }
  );
}

function buildFileNodeAsset(parent, path, filename, depth) {
  const ext = getAssetExt(filename);
  const canExpand = canExpandAssetTree(ext);
  const { row, tog, ico, lbl } = makeRow(
    'tree-file',
    depth,
    canExpand ? '>' : '',
    getAssetIconLabel(ext),
    filename,
    path
  );
  const url = `${BASE}/${path}`;

  const selectFile = async () => {
    const token = ++assetSelectionToken;
    selectAssetRow(row);
    showAssetLoading(filename, path);

    try {
      const info = await getAssetInfo(path, filename);
      if (token !== assetSelectionToken) return;

      renderAssetDetail(buildFileDetailBlocks(info));
      await previewAssetInfo(info, token);
      if (token !== assetSelectionToken) return;
    } catch (error) {
      if (token !== assetSelectionToken) return;
      clearAssetPreview();
      showAssetError(filename, error.message);
      setStatus(`Failed: ${filename} - ${error.message}`, true);
    }
  };

  [lbl, ico].forEach((el) => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', async (event) => {
      event.stopPropagation();
      await selectFile();
    });
  });

  row.addEventListener('click', async (event) => {
    if (canExpand && event.target === tog) return;
    await selectFile();
    if (canExpand && event.target === row) tog.click();
  });

  if (!canExpand) {
    parent.append(row);
    return;
  }

  const children = document.createElement('div');
  children.className = 'tree-children';
  let loaded = false;
  tog.style.cursor = 'pointer';
  tog.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!loaded) {
      loaded = true;
      tog.textContent = '...';
      await loadRWChunkTreeAsset(children, url, depth + 1, { path, filename });
    }
    const open = children.classList.toggle('open');
    tog.textContent = open ? 'v' : '>';
  });

  parent.append(row, children);
}

async function loadRWChunkTreeAsset(parent, url, depth, context) {
  let buffer;
  try {
    buffer = await getAssetBuffer(url);
  } catch (error) {
    const { row } = makeRow('tree-file', depth, '', 'ERR', `Failed: ${error.message}`);
    parent.append(row);
    return;
  }

  const dv = new DataView(buffer);
  const chunks = parseRWChunks(dv, 0, buffer.byteLength);
  if (!chunks.length) {
    const { row } = makeRow('tree-file', depth, '', 'ERR', 'No RW chunks found');
    parent.append(row);
    return;
  }

  for (const chunk of chunks) buildRWChunkNodeAsset(parent, dv, chunk, depth, context);
}

// ─── DFF preview ──────────────────────────────────────────────────────────────

function focusPreviewGroup(group) {
  const box = new THREE.Box3().setFromObject(group);
  const size = Math.max(box.getSize(new THREE.Vector3()).length(), 0.25);
  const center = box.getCenter(new THREE.Vector3());
  controls.target.copy(center);
  camera.position.copy(center)
    .addScaledVector(new THREE.Vector3(1, 0.6, 1).normalize(), size * 1.5);
  controls.update();
}

function createTexturePreviewGroup(texture, width = 1, height = 1) {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1;
  const maxSide = 2.2;
  const scale = maxSide / Math.max(safeWidth, safeHeight);
  const planeWidth = Math.max(0.25, safeWidth * scale);
  const planeHeight = Math.max(0.25, safeHeight * scale);

  const group = new THREE.Group();
  group.userData.disposeOnClear = true;

  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(planeWidth * 1.04, planeHeight * 1.04),
    new THREE.MeshBasicMaterial({ color: 0x1f2236, side: THREE.DoubleSide })
  );
  backdrop.position.z = -0.002;

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(planeWidth, planeHeight),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide })
  );

  group.add(backdrop);
  group.add(plane);
  return group;
}

async function buildImagePreviewGroup(info) {
  const blob = new Blob([info.buffer], { type: mimeTypeForImageExt(info.ext) });
  const objectUrl = rememberPreviewObjectUrl(URL.createObjectURL(blob));

  const texture = await new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.load(objectUrl, resolve, undefined, reject);
  });
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  const image = texture.image;
  const width = image?.naturalWidth ?? image?.width ?? 1;
  const height = image?.naturalHeight ?? image?.height ?? 1;
  return { group: createTexturePreviewGroup(texture, width, height), width, height };
}

function buildDdsPreviewGroup(info) {
  const parsed = info.parsed?.ddsData ?? ddsLoader.parse(info.buffer);
  const texture = new THREE.CompressedTexture(
    parsed.mipmaps,
    parsed.width,
    parsed.height,
    parsed.format
  );
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return {
    group: createTexturePreviewGroup(texture, parsed.width, parsed.height),
    width: parsed.width,
    height: parsed.height,
  };
}

async function previewDffAsset(info, token) {
  const dffData = info?.parsed?.dffData;
  if (!dffData) return false;

  // Lazy import to break circular dependency.
  const { buildMesh } = await import('./characterViewer.js');

  const group = new THREE.Group();
  for (const atomic of dffData.atomics) {
    if (atomic.renderFlags !== 0 && (atomic.renderFlags & 0x04) === 0) continue;
    const geometry = dffData.geometries[atomic.geometryIndex];
    const texDir = info.url?.startsWith('pak://') ? 'pak' : 'bg-index';
    const mesh = await buildMesh(geometry, texDir, [], dffData.frames ?? [], null, false, null);
    if (mesh) group.add(mesh);
  }

  if (token !== assetSelectionToken) return true;
  if (!group.children.length) return false;

  scene.add(group);
  assetPreviewGroup = group;
  focusPreviewGroup(group);
  setStatus(`${info.stem} - ${dffData.geometries.length} geo, ${dffData.atomics.length} atomic(s)`);
  return true;
}

async function previewTextureAsset(info, token) {
  let preview;
  if (info.parsed?.kind === 'dds') {
    preview = buildDdsPreviewGroup(info);
  } else {
    preview = await buildImagePreviewGroup(info);
  }

  if (token !== assetSelectionToken) {
    disposePreviewGroup(preview.group);
    releaseObjectUrls(previewObjectUrls);
    return true;
  }

  scene.add(preview.group);
  assetPreviewGroup = preview.group;
  focusPreviewGroup(preview.group);
  setStatus(`${info.filename} - ${preview.width}x${preview.height}`);
  return true;
}

export async function previewAssetInfo(info, token = assetSelectionToken) {
  if (!info?.parsed) return;
  clearAssetPreview();

  try {
    if (info.parsed.kind === 'dff') {
      setStatus(`Loading ${info.stem}...`);
      const rendered = await previewDffAsset(info, token);
      if (!rendered && token === assetSelectionToken) {
        setStatus(`${info.stem}: no renderable geometry`);
      }
      return;
    }

    if (info.parsed.kind === 'image' || info.parsed.kind === 'dds') {
      setStatus(`Loading texture preview: ${info.filename}...`);
      await previewTextureAsset(info, token);
      return;
    }

    if (token === assetSelectionToken) {
      setStatus(`Selected ${info.filename}`);
    }
  } catch (error) {
    if (token !== assetSelectionToken) return;
    clearAssetPreview();
    setStatus(`Preview failed: ${error.message}`, true);
  }
}

// ─── Search ───────────────────────────────────────────────────────────────────
export function initSearch() {
  ui.assetsSearch.addEventListener('input', () => {
    const q = ui.assetsSearch.value.trim().toLowerCase();
    ui.assetTree.querySelectorAll('.tree-file, .tree-folder').forEach(el => {
      if (!q) { el.style.display = ''; return; }
      const name = el.querySelector('.tree-name')?.textContent.toLowerCase() ?? '';
      el.style.display = name.includes(q) ? '' : 'none';
    });
  });
}
