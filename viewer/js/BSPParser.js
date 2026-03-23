import { BinaryReader } from './BinaryReader.js';

// Parses a RenderWare .bsp (World 0x000B) file and extracts per-material
// texture stems from the AliceAsset 0x011F plugin in each Material.
// Returns: Array of { c0, c1, c2, c3 } — one entry per BSP material, or null.
// BSP material[i] corresponds to DFF terrain material[i].

export class BSPParser {
  // Parse BSP world geometry into renderable data.
  // Returns { vertices(Float32Array), uvs(Float32Array), matGroups(Map<matIdx,[i0,i1,i2,…]>) }
  // or null if the geometry can't be read.
  parseWorldGeometry(buffer) {
    const view     = new DataView(buffer);
    const fileSize = buffer.byteLength;

    // ── World header ────────────────────────────────────────────────────────
    if (fileSize < 12 || view.getUint32(0, true) !== 0x000B) return null;
    const worldSize = view.getUint32(4, true);

    // ── Read World Struct format flags (first child = Struct 0x0001) ─────────
    // WorldStructV52 (size=52): format is at body offset 48
    // WorldStructV64 (size=64): format is at body offset 36
    let worldFormat = 0;
    {
      const wsType = view.getUint32(12, true);
      const wsSize = view.getUint32(16, true);
      if (wsType === 0x0001) {
        const wsBody = 24; // after World header(12) + Struct chunk header(12)
        if (wsSize === 52)      worldFormat = view.getUint32(wsBody + 48, true);
        else if (wsSize === 64) worldFormat = view.getUint32(wsBody + 36, true);
      }
    }
    // Decode format flags (standard RW World flags)
    const hasNormals = !!(worldFormat & 0x00000010);
    const hasPrelit  = !!(worldFormat & 0x00000008);
    // numTexCoordSets: bits 16–23 (0 = use TEXCOORDS/TEXCOORDS2 flags)
    let numUVSets = (worldFormat >> 16) & 0xFF;
    if (numUVSets === 0) numUVSets = (worldFormat & 0x80) ? 2 : (worldFormat & 0x04) ? 1 : 0;
    console.log(`[BSP fmt] 0x${worldFormat.toString(16).padStart(8,'0')} normals=${hasNormals} prelit=${hasPrelit} numUV=${numUVSets}`);

    // ── Collect ALL AtomicSections (BSP tree may have many leaf sectors) ────
    const worldEnd = Math.min(12 + worldSize, fileSize);
    const atomicSections = [];
    this._scanSectors(view, 12, worldEnd, fileSize, atomicSections);
    if (atomicSections.length === 0) return null;
    console.log(`[BSP] ${atomicSections.length} sector(s)`);

    // ── Merge geometry from all sectors ─────────────────────────────────────
    const matGroups   = new Map();
    const vertBufs    = [];
    const normalBufs  = [];
    const prelitBufs  = [];
    const uvBufs      = []; // one entry per sector: Float32Array[numActualUVSets][N×2]
    let   actualUVSets = 0; // derived from first sector's data
    let   vertOffset  = 0;
    let   totalSkip   = 0;

    for (const asSectionPos of atomicSections) {
      const structPos = asSectionPos + 12;
      if (structPos + 12 > fileSize || view.getUint32(structPos, true) !== 0x0001) continue;
      const astSize      = view.getUint32(structPos + 4, true);
      const astBodyStart = structPos + 12;

      const matListWindow = view.getUint32(astBodyStart,     true);
      const numTriangles  = view.getUint32(astBodyStart + 4, true);
      const numVertices   = view.getUint32(astBodyStart + 8, true);
      if (numVertices === 0 || numTriangles === 0) continue;

      const vertStart = astBodyStart + 44;
      const triStart  = astBodyStart + astSize - numTriangles * 8;
      if (vertStart >= triStart) continue;

      // Derive actual UV set count from vertex data byte range
      // Total vertex data = triStart - vertStart
      // Fixed per-vertex: 12 (pos) + 4*hasNormals (packed uint8×4) + 4*hasPrelit
      const fixedBytesPerVert = 12 + (hasNormals ? 4 : 0) + (hasPrelit ? 4 : 0);
      const totalVertBytes    = triStart - vertStart;
      const uvBytesPerVert    = totalVertBytes / numVertices - fixedBytesPerVert;
      const derivedUVSets     = Math.max(0, Math.round(uvBytesPerVert / 8));

      // On first sector, log and store
      if (actualUVSets === 0) {
        actualUVSets = derivedUVSets;
        console.log(`[BSP UV] worldFmt says numUV=${numUVSets}, derived=${derivedUVSets} from vertex layout`);

        // Log position range from first sector
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < numVertices; i++) {
          const b = vertStart + i * 12;
          const x = view.getFloat32(b,     true);
          const z = view.getFloat32(b + 8, true);
          if (isFinite(x)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
          if (isFinite(z)) { minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
        }
        console.log(`[BSP pos] X=[${minX.toFixed(1)}, ${maxX.toFixed(1)}] Z=[${minZ.toFixed(1)}, ${maxZ.toFixed(1)}] spans: ${(maxX-minX).toFixed(1)} × ${(maxZ-minZ).toFixed(1)}`);

        // Log range of each UV set from first sector
        const uvBaseStart = vertStart + numVertices * fixedBytesPerVert;
        for (let s = 0; s < derivedUVSets; s++) {
          let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
          const base = uvBaseStart + s * numVertices * 8;
          for (let i = 0; i < numVertices; i++) {
            const u = view.getFloat32(base + i*8,     true);
            const v = view.getFloat32(base + i*8 + 4, true);
            if (isFinite(u)) { minU = Math.min(minU, u); maxU = Math.max(maxU, u); }
            if (isFinite(v)) { minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
          }
          console.log(`[BSP UV${s}] U=[${minU.toFixed(3)}, ${maxU.toFixed(3)}] V=[${minV.toFixed(3)}, ${maxV.toFixed(3)}]`);
        }
      }

      // Positions
      const verts = new Float32Array(numVertices * 3);
      for (let i = 0; i < numVertices; i++) {
        const b = vertStart + i * 12;
        verts[i*3]   = view.getFloat32(b,     true);
        verts[i*3+1] = view.getFloat32(b + 4, true);
        verts[i*3+2] = view.getFloat32(b + 8, true);
      }

      // Normals (if present, stored right after positions as packed uint8×3 + int8 padding = 4 bytes)
      let norms = null;
      if (hasNormals) {
        norms = new Float32Array(numVertices * 3);
        const normStart = vertStart + numVertices * 12;
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < numVertices; i++) {
          const b = normStart + i * 4;
          // Convert uint8 [0,255] to float [-1,1]: (val - 128) / 127
          norms[i*3]   = (bytes[b]     - 128) / 127.0;
          norms[i*3+1] = (bytes[b + 1] - 128) / 127.0;
          norms[i*3+2] = (bytes[b + 2] - 128) / 127.0;
        }
      }

      // Prelit vertex colors (RGBA, 4 bytes per vertex, right after normals)
      let prelitColors = null;
      if (hasPrelit) {
        prelitColors = new Float32Array(numVertices * 4);
        const prelitStart = vertStart + numVertices * 12 + (hasNormals ? numVertices * 4 : 0);
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < numVertices; i++) {
          const b = prelitStart + i * 4;
          prelitColors[i*4]   = bytes[b]     / 255.0;  // R
          prelitColors[i*4+1] = bytes[b + 1] / 255.0;  // G
          prelitColors[i*4+2] = bytes[b + 2] / 255.0;  // B
          prelitColors[i*4+3] = bytes[b + 3] / 255.0;  // A
        }
      }

      // Read all derived UV sets for this sector
      const uvBaseStart = vertStart + numVertices * fixedBytesPerVert;
      const sectorUVs = [];
      for (let s = 0; s < derivedUVSets; s++) {
        const arr  = new Float32Array(numVertices * 2);
        const base = uvBaseStart + s * numVertices * 8;
        for (let i = 0; i < numVertices; i++) {
          arr[i*2]   = view.getFloat32(base + i*8,     true);
          arr[i*2+1] = view.getFloat32(base + i*8 + 4, true);
        }
        sectorUVs.push(arr);
      }

      // Triangles: [v1, v2, v3, matOffset]
      for (let i = 0; i < numTriangles; i++) {
        const b  = triStart + i * 8;
        const v1 = view.getUint16(b,     true);
        const v2 = view.getUint16(b + 2, true);
        const v3 = view.getUint16(b + 4, true);
        const mo = view.getUint16(b + 6, true);
        if (v1 >= numVertices || v2 >= numVertices || v3 >= numVertices) { totalSkip++; continue; }
        const mat = matListWindow + mo;
        if (!matGroups.has(mat)) matGroups.set(mat, []);
        matGroups.get(mat).push(vertOffset + v1, vertOffset + v2, vertOffset + v3);
      }

      vertBufs.push(verts);
      normalBufs.push(norms);
      prelitBufs.push(prelitColors);
      uvBufs.push(sectorUVs);
      vertOffset += numVertices;
    }

    if (vertOffset === 0) return null;

    // Merge all sectors into flat arrays, one per UV set
    const vertices = new Float32Array(vertOffset * 3);
    const normals  = hasNormals ? new Float32Array(vertOffset * 3) : null;
    const prelitColors = hasPrelit ? new Float32Array(vertOffset * 4) : null;
    const uvSets   = Array.from({ length: actualUVSets }, () => new Float32Array(vertOffset * 2));
    let vOff = 0, nOff = 0, pOff = 0, uOff = 0;
    for (let i = 0; i < vertBufs.length; i++) {
      vertices.set(vertBufs[i], vOff); vOff += vertBufs[i].length;
      if (normals && normalBufs[i]) { normals.set(normalBufs[i], nOff); nOff += normalBufs[i].length; }
      if (prelitColors && prelitBufs[i]) { prelitColors.set(prelitBufs[i], pOff); pOff += prelitBufs[i].length; }
      for (let s = 0; s < actualUVSets; s++) {
        if (uvBufs[i][s]) uvSets[s].set(uvBufs[i][s], uOff);
      }
      uOff += uvBufs[i][0]?.length ?? 0;
    }

    console.log(`[BSP geo] verts=${vertOffset} groups=${matGroups.size} skip=${totalSkip} uvSets=${actualUVSets} normals=${!!normals} prelit=${!!prelitColors}`);
    return { vertices, normals, prelitColors, uvSets, matGroups };
  }

  // Scan a chunk range and collect all AtomicSection (0x0009) positions into `out`.
  // Recurses into PlaneSection (0x000A) nodes.
  _scanSectors(view, pos, end, fileSize, out) {
    while (pos + 12 <= end) {
      const chType = view.getUint32(pos,     true);
      const chSize = view.getUint32(pos + 4, true);
      const chEnd  = pos + 12 + chSize;
      if (chType === 0x0009) {
        out.push(pos);
      } else if (chType === 0x000A) {
        // PlaneSection body: Struct child + two sector children
        let inner = pos + 12;
        const innerEnd = Math.min(chEnd, fileSize);
        if (inner + 12 <= innerEnd) {
          // skip PlaneSection's own Struct child
          const stSize = view.getUint32(inner + 4, true);
          inner += 12 + stSize;
          // recurse into the two child sectors
          this._scanSectors(view, inner, innerEnd, fileSize, out);
        }
      }
      if (chEnd <= pos || chEnd > end) break;
      pos = chEnd;
    }
  }

  parse(buffer) {
    const r = new BinaryReader(buffer);

    const worldType = r.readUInt32();
    if (worldType !== 0x000B) return null;
    const worldSize = r.readUInt32();
    r.readUInt32(); // version

    const worldEnd = 12 + worldSize;

    while (r.pos < worldEnd) {
      const type = r.readUInt32();
      const size = r.readUInt32();
      r.readUInt32(); // version
      const end  = r.pos + size;

      if (type === 0x0008) { // MaterialList
        return this._parseMatList(r, end);
      }
      r.pos = end;
    }
    return null;
  }

  _parseMatList(r, end) {
    const materials = []; // one { c0,c1,c2,c3 } per material

    // MatList Struct: numMaterials (u32) + matFlags[] (s32 each) — skip entirely
    const stType = r.readUInt32();
    const stSize = r.readUInt32();
    r.readUInt32(); // version
    r.pos += stSize;

    while (r.pos < end) {
      const type = r.readUInt32();
      const size = r.readUInt32();
      r.readUInt32(); // version
      const mEnd = r.pos + size;

      if (type === 0x0007) { // Material
        const mat = { c0: null, c1: null, c2: null, c3: null, textureName: null,
                      ltmapTex: null, layerScale: [1.0, 1.0, 1.0, 1.0],
                      layerUV: [0, 0, 0, 0] }; // 0=UV1(primary tiling), 1=UV3(secondary); overridden by c_layerUV0-3
        this._parseMaterial(r, mEnd, mat);
        materials.push(mat);
      } else {
        r.pos = mEnd;
      }
    }
    return materials;
  }

  _parseMaterial(r, end, mat) {
    let isTextured = 0;
    while (r.pos < end) {
      const type = r.readUInt32();
      const size = r.readUInt32();
      r.readUInt32(); // version
      const cEnd = r.pos + size;

      if (type === 0x0001) { // Struct — contains isTextured flag
        r.readUInt32(); // flags
        r.skip(4);      // RGBA color
        r.readUInt32(); // unused
        isTextured = r.readUInt32();
      } else if (type === 0x0006 && isTextured) { // Texture chunk
        // Struct (filter flags) + String (name) + String (mask)
        const fType = r.readUInt32(); const fSize = r.readUInt32(); r.readUInt32(); r.skip(fSize); // struct
        const nType = r.readUInt32(); const nSize = r.readUInt32(); r.readUInt32(); // name String
        if (nType === 0x0002 && nSize > 0) {
          const raw = r.readString(nSize).replace(/\0/g, '').trim();
          if (raw) mat.textureName = raw;
        }
      } else if (type === 0x0003) { // Extension — AliceAsset plugin
        this._parseExtension(r, cEnd, mat);
      }
      r.pos = cEnd;
    }
  }

  // Helper: given body bytes and a dataPos pointing at "data\0",
  // try to read a float32 at the standard parameter value offset.
  _readParamFloat(body, dv, dataPos) {
    const off = dataPos + 5 + 8; // after "data\0" skip 8-byte header, then 4-byte value
    if (off + 4 > body.length) return null;
    const f = dv.getFloat32(off, true);
    return isFinite(f) ? f : null;
  }

  // Helper: read a uint32 at the same offset (for integer parameters like UV channel indices).
  _readParamUint(body, dv, dataPos) {
    const off = dataPos + 5 + 8;
    if (off + 4 > body.length) return null;
    return dv.getUint32(off, true);
  }

  // Helper: given body bytes and a dataPos pointing at "data\0",
  // try to read a null-terminated string path and return its basename (without .dds).
  _readParamString(body, dataPos) {
    const strLenOff = dataPos + 5 + 8;
    if (strLenOff + 4 > body.length) return null;
    const strLen = body[strLenOff] | (body[strLenOff+1] << 8) |
                   (body[strLenOff+2] << 16) | (body[strLenOff+3] << 24);
    if (strLen < 4 || strLen > 500) return null;
    const strStart = strLenOff + 4;
    if (strStart + strLen > body.length) return null;
    let path = '';
    for (let i = strStart; i < strStart + strLen - 1 && body[i] !== 0; i++)
      path += String.fromCharCode(body[i]);
    if (!path) return null;
    const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    let name = slash >= 0 ? path.slice(slash + 1) : path;
    if (name.toLowerCase().endsWith('.dds')) name = name.slice(0, -4);
    return name || null;
  }

  _parseExtension(r, end, mat) {
    while (r.pos < end) {
      const type = r.readUInt32();
      const size = r.readUInt32();
      r.readUInt32(); // version
      const pEnd = r.pos + size;

      if (type === 0x011F) { // AliceAsset plugin
        this._parseAlicePlugin(r, pEnd, mat);
      }
      r.pos = pEnd;
    }
  }

  _parseAlicePlugin(r, end, mat) {
    const body = new Uint8Array(r.buf, r.pos, end - r.pos);
    const dv   = new DataView(r.buf, r.pos, end - r.pos);

    // ── Extract c_diffTex0–3 (diffuse layer textures) ───────────────────────
    for (let ch = 0; ch <= 3; ch++) {
      const keyPos = this._findBytes(body, `c_diffTex${ch}\0`);
      if (keyPos < 0) continue;
      const dataPos = this._findBytes(body, 'data\0', keyPos);
      if (dataPos < 0 || dataPos - keyPos > 200) continue;
      const name = this._readParamString(body, dataPos);
      if (name && !mat['c' + ch]) mat['c' + ch] = name;
    }

    // ── Extract c_ltmapTex (splatmap / lightmap texture) ────────────────────
    {
      const keyPos = this._findBytes(body, 'c_ltmapTex\0');
      if (keyPos >= 0) {
        const dataPos = this._findBytes(body, 'data\0', keyPos);
        if (dataPos >= 0 && dataPos - keyPos < 200) {
          const name = this._readParamString(body, dataPos);
          if (name) mat.ltmapTex = name;
        }
      }
    }

    // ── Extract c_layerScale0–3 (per-layer UV tiling multiplier) ────────────
    for (let ch = 0; ch <= 3; ch++) {
      const keyPos = this._findBytes(body, `c_layerScale${ch}\0`);
      if (keyPos < 0) continue;
      const dataPos = this._findBytes(body, 'data\0', keyPos);
      if (dataPos < 0 || dataPos - keyPos > 200) continue;
      const f = this._readParamFloat(body, dv, dataPos);
      if (f !== null && f > 0.001 && f < 100) mat.layerScale[ch] = f;
    }

    // ── Extract c_layerUV0–3 (UV channel index used by each diffuse layer) ──
    const uvFound = [];
    for (let ch = 0; ch <= 3; ch++) {
      const keyPos = this._findBytes(body, `c_layerUV${ch}\0`);
      if (keyPos < 0) { uvFound.push('?'); continue; }
      const dataPos = this._findBytes(body, 'data\0', keyPos);
      if (dataPos < 0 || dataPos - keyPos > 200) { uvFound.push('?'); continue; }
      const v = this._readParamUint(body, dv, dataPos);
      if (v !== null && v < 16) { mat.layerUV[ch] = v; uvFound.push(v); }
      else uvFound.push(`raw=${v}`);
    }
    console.log(`[AlicePlugin] c_layerUV=[${uvFound.join(',')}] c_layerScale=[${mat.layerScale.map(f=>f.toFixed(3)).join(',')}] c0=${mat.c0} ltmap=${mat.ltmapTex}`);
  }

  _findBytes(arr, str, startAt = 0) {
    const needle = str.split('').map(c => c.charCodeAt(0));
    outer: for (let i = startAt; i <= arr.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (arr[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }
}
