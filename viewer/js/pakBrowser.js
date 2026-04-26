// ─── PAK asset browser ──────────────────────────────────────────────────────
// Builds a tree from flat PAK asset paths and integrates with the existing
// asset browser detail/preview pipeline.

import { ui, setStatus } from './viewerState.js';
import {
  makeRow, makeExpandable, selectAssetRow,
  renderAssetDetail, resetAssetDetail,
  showAssetLoading, showAssetError,
  inspectAssetBuffer, buildFileDetailBlocks, previewAssetInfo,
  clearAssetPreview, assetSelectionToken, bumpSelectionToken,
  getAssetExt, getAssetIconLabel, canExpandAssetTree,
} from './assetBrowser.js';

let pakConnection = null;
const pakBufferCache = new Map();
const pakInfoCache   = new Map();

export function setPakConnection(conn) {
  pakConnection = conn;
}

// ─── Fetch helpers (PAK-backed) ─────────────────────────────────────────────

export async function getPakAssetBuffer(pakPath) {
  if (!pakBufferCache.has(pakPath)) {
    pakBufferCache.set(pakPath, pakConnection.fetchAsset(pakPath).catch(err => {
      pakBufferCache.delete(pakPath);
      throw err;
    }));
  }
  return pakBufferCache.get(pakPath);
}

async function getPakAssetInfo(pakPath) {
  if (!pakInfoCache.has(pakPath)) {
    pakInfoCache.set(pakPath, (async () => {
      const buffer = await getPakAssetBuffer(pakPath);
      const filename = pakPath.split(/[/\\]/).pop();
      return inspectAssetBuffer(buffer, pakPath, filename, `pak://${pakPath}`);
    })().catch(err => {
      pakInfoCache.delete(pakPath);
      throw err;
    }));
  }
  return pakInfoCache.get(pakPath);
}

// ─── Tree builder ───────────────────────────────────────────────────────────

// Build a virtual directory tree from the flat array of PAK asset entries.
function buildTree(assets) {
  const root = { children: new Map(), files: [] };
  for (const entry of assets) {
    // Normalise backslashes to forward slashes.
    const originalPath = entry.path;              // keep original for server fetch
    const path = originalPath.replace(/\\/g, '/'); // normalised for display/tree
    const parts = path.split('/');
    const filename = parts.pop();
    let node = root;
    for (const part of parts) {
      if (!part) continue;
      if (!node.children.has(part)) {
        node.children.set(part, { children: new Map(), files: [] });
      }
      node = node.children.get(part);
    }
    node.files.push({ ...entry, path, originalPath, filename });
  }
  return root;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let v = bytes, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return ` (${u === 0 ? v : v.toFixed(1)} ${units[u]})`;
}

// ─── Public: populate asset tree from PAK listing ───────────────────────────

export function initPakTree(listing) {
  ui.assetTree.innerHTML = '';
  resetAssetDetail();
  pakBufferCache.clear();
  pakInfoCache.clear();

  const assets = Array.isArray(listing?.assets)
    ? listing.assets
    : Array.isArray(listing?.data)
      ? listing.data
      : Array.isArray(listing)
        ? listing
        : [];
  const tree = buildTree(assets);
  buildPakDirNode(ui.assetTree, tree, '', 0, true);
}

function buildPakDirNode(parent, node, dirPath, depth, autoExpand = false) {
  const dirName = dirPath.split('/').pop() || dirPath || 'PAK';
  const { row, tog, ico } = makeRow('tree-folder', depth, '>', 'PAK', dirName, dirPath);

  makeExpandable(
    parent, row, tog, ico, 'PAK', 'PAK',
    (children) => {
      // Sort subdirectories alphabetically.
      const sortedDirs = [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      for (const [name, child] of sortedDirs) {
        const childPath = dirPath ? `${dirPath}/${name}` : name;
        buildPakDirNode(children, child, childPath, depth + 1);
      }
      // Sort files alphabetically.
      const sortedFiles = [...node.files].sort((a, b) => a.filename.localeCompare(b.filename));
      for (const file of sortedFiles) {
        buildPakFileNode(children, file, depth + 1);
      }
      if (!sortedDirs.length && !sortedFiles.length) {
        const { row: empty } = makeRow('tree-file', depth + 1, '', '---', '(empty)');
        children.append(empty);
      }
    },
    () => {
      selectAssetRow(row);
      const dirCount = node.children.size;
      const fileCount = node.files.length;
      renderAssetDetail([buildPakFolderBlock(dirPath, dirCount, fileCount)]);
    }
  );

  if (autoExpand) row.click();
}

function buildPakFolderBlock(path, dirs, files) {
  const section = document.createElement('section');
  section.className = 'asset-detail-block';
  const h3 = document.createElement('h3');
  h3.className = 'asset-detail-title';
  h3.textContent = 'PAK Folder';
  const dl = document.createElement('dl');
  dl.className = 'asset-kv';
  for (const [label, value] of [['Path', path || '/'], ['Subfolders', dirs], ['Files', files]]) {
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = String(value);
    dl.append(dt, dd);
  }
  section.append(h3, dl);
  return section;
}

function formatPakBool(value) {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return 'Unknown';
}

function buildPakAssetMetaBlock(file) {
  const hasMeta =
    Number.isFinite(file?.timestamp) ||
    typeof file?.are_data_embedded === 'boolean' ||
    typeof file?.are_data_compressed === 'boolean';
  if (!hasMeta) return null;

  const section = document.createElement('section');
  section.className = 'asset-detail-block';
  const h3 = document.createElement('h3');
  h3.className = 'asset-detail-title';
  h3.textContent = 'PAK Entry';

  const dl = document.createElement('dl');
  dl.className = 'asset-kv';
  const entries = [
    ['Timestamp', Number.isFinite(file.timestamp) ? String(file.timestamp) : 'Unknown'],
    ['Embedded', formatPakBool(file.are_data_embedded)],
    ['Compressed', formatPakBool(file.are_data_compressed)],
  ];
  for (const [label, value] of entries) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }

  section.append(h3, dl);
  return section;
}

function buildPakFileNode(parent, file, depth) {
  const ext = getAssetExt(file.filename);
  const canExpand = canExpandAssetTree(ext);
  const iconText = getAssetIconLabel(ext);
  const sizeStr = formatSize(file.size);
  const { row, tog, ico, lbl } = makeRow(
    'tree-file', depth, canExpand ? '>' : '', iconText,
    `${file.filename}${sizeStr}`, file.path
  );

  // Use originalPath for server fetch, normalized path for display.
  const fetchPath = file.originalPath || file.path;

  const selectFile = async () => {
    const token = bumpSelectionToken();
    selectAssetRow(row);
    showAssetLoading(file.filename, file.path);

    try {
      const info = await getPakAssetInfo(fetchPath);
      if (token !== assetSelectionToken) return;

      const blocks = buildFileDetailBlocks(info);
      const metaBlock = buildPakAssetMetaBlock(file);
      if (metaBlock) blocks.unshift(metaBlock);
      renderAssetDetail(blocks);
      await previewAssetInfo(info, token);
    } catch (err) {
      if (token !== assetSelectionToken) return;
      clearAssetPreview();
      showAssetError(file.filename, err.message);
      setStatus(`Failed: ${file.filename} - ${err.message}`, true);
    }
  };

  // Click the label/icon to select and inspect.
  [lbl, ico].forEach(el => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      await selectFile();
    });
  });

  // Click the toggle to expand RW chunk trees for supported RW formats.
  if (canExpand) {
    const children = document.createElement('div');
    children.className = 'tree-children';
    let loaded = false;
    tog.style.cursor = 'pointer';
    tog.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!loaded) {
        loaded = true;
        tog.textContent = '...';
        try {
          const buffer = await getPakAssetBuffer(fetchPath);
          const { parseRWChunks, buildRWChunkNodeAsset } = await import('./assetBrowser.js');
          // If those aren't exported, we just skip chunk expansion.
          if (parseRWChunks && buildRWChunkNodeAsset) {
            const dv = new DataView(buffer);
            const chunks = parseRWChunks(dv, 0, buffer.byteLength);
            if (!chunks.length) {
              const { row: emptyRow } = makeRow('tree-file', depth + 1, '', '---', 'No RW chunks found');
              children.append(emptyRow);
            }
            for (const chunk of chunks) {
              buildRWChunkNodeAsset(children, dv, chunk, depth + 1, { path: file.path, filename: file.filename });
            }
          }
        } catch {
          const { row: errRow } = makeRow('tree-file', depth + 1, '', 'ERR', 'Failed to load chunks');
          children.append(errRow);
        }
      }
      const open = children.classList.toggle('open');
      tog.textContent = open ? 'v' : '>';
    });
    parent.append(row, children);
  } else {
    parent.append(row);
  }

  row.addEventListener('click', async (e) => {
    if (canExpand && e.target === tog) return;
    await selectFile();
  });
}
