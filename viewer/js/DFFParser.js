import { BinaryReader } from './BinaryReader.js';

// RenderWare chunk type IDs
const RW = {
  STRUCT:       0x0001,
  STRING:       0x0002,
  EXTENSION:    0x0003,
  TEXTURE:      0x0006,
  MATERIAL:     0x0007,
  MATERIALLIST: 0x0008,
  FRAMELIST:    0x000E,
  GEOMETRY:     0x000F,
  CLUMP:        0x0010,
  ATOMIC:       0x0014,
  GEOMETRYLIST: 0x001A,
  // Plugin IDs (appear inside Extension chunks)
  SKIN:         0x0116,
  HANIM:        0x011E,
};

// Geometry flags
const GF = {
  TRISTRIP:  0x0001,
  POSITIONS: 0x0002,
  TEXTURED:  0x0004,
  PRELIT:    0x0008,
  NORMALS:   0x0010,
  LIGHT:     0x0020,
  MODULATE:  0x0040,
  TEXTURED2: 0x0080,
  NATIVE:    0x01000000,
};

export class DFFParser {
  parse(buffer) {
    const r = new BinaryReader(buffer);
    const chunk = this._readChunk(r);
    if (chunk.type !== RW.CLUMP) throw new Error(`Expected Clump chunk, got 0x${chunk.type.toString(16)}`);
    return this._parseClump(chunk.reader);
  }

  _readChunk(r) {
    if (r.remaining < 12) return null;
    const type    = r.readUInt32();
    const size    = r.readUInt32();
    const version = r.readUInt32();
    const reader  = r.subReader(size);
    return { type, size, version, reader };
  }

  _readAllChunks(r) {
    const chunks = [];
    while (r.remaining >= 12) {
      const c = this._readChunk(r);
      if (!c) break;
      chunks.push(c);
    }
    return chunks;
  }

  _parseClump(r) {
    const struct = this._readChunk(r);
    const sr = struct.reader;
    const numAtomics  = sr.readUInt32();
    sr.readUInt32(); // numLights
    sr.readUInt32(); // numCameras

    const frameListChunk = this._readChunk(r);
    const frames = this._parseFrameList(frameListChunk.reader);

    const geoListChunk = this._readChunk(r);
    const geometries = this._parseGeometryList(geoListChunk.reader);

    const atomics = [];
    for (let i = 0; i < numAtomics; i++) {
      const ac = this._readChunk(r);
      if (ac) atomics.push(this._parseAtomic(ac.reader));
    }

    return { frames, geometries, atomics };
  }

  _parseFrameList(r) {
    const struct = this._readChunk(r);
    const sr = struct.reader;
    const numFrames = sr.readUInt32();

    const frames = [];
    for (let i = 0; i < numFrames; i++) {
      // 3x3 rotation matrix (row-major)
      const rot = sr.readMat3();
      const pos = sr.readVec3();
      const parentIndex = sr.readInt32();
      const frameFlags = sr.readUInt32();
      frames.push({
        rot,
        pos,
        parentIndex,
        frameFlags,
        name: `bone_${i}`,
        nodeId: null,
        nodeIndex: -1,
        hierarchyIndex: -1,
      });
    }

    // Extension chunk — contains HAnim plugins per frame
    if (r.remaining >= 12) {
      const extChunks = [];
      while (extChunks.length < numFrames && r.remaining >= 12) {
        const extChunk = this._readChunk(r);
        if (!extChunk) break;
        extChunks.push(extChunk);
      }
      this._parseFrameListExt(extChunks, frames);
    }

    return frames;
  }

  _parseFrameListExt(extChunks, frames) {
    let rootHierarchy = null;
    for (let fi = 0; fi < frames.length && fi < extChunks.length; fi++) {
      const extChunk = extChunks[fi];
      if (extChunk.type !== RW.EXTENSION) continue;

      // Detect format: physx DFFs store AliceData key-value pairs directly in the
      // Extension payload (paramCount is a small integer like 1–5).  Standard DFFs
      // wrap HAnim (0x011E) / FrameName (0x011F) sub-chunks whose type words are ≥ 256.
      const savedPos = extChunk.reader.pos;
      const firstWord = extChunk.reader.remaining >= 4
        ? extChunk.reader.readUInt32() : -1;
      extChunk.reader.pos = savedPos;

      if (firstWord >= 1 && firstWord <= 32) {
        // AliceData path — parse name from key-value pairs, skip sub-chunk loop
        frames[fi].name = this._parseFrameNamePlugin(extChunk.reader) ?? frames[fi].name;
        continue;
      }

      // Standard Extension sub-chunk path
      while (extChunk.reader.remaining >= 12) {
        const plugin = this._readChunk(extChunk.reader);
        if (!plugin) break;

        if (plugin.type === RW.HANIM) {
          const hierarchy = this._parseHAnimPlugin(plugin.reader, frames, fi);
          if (hierarchy?.length) rootHierarchy = hierarchy;
        } else if (plugin.type === 0x011f) {
          frames[fi].name = this._parseFrameNamePlugin(plugin.reader) ?? frames[fi].name;
        }
      }
    }

    if (rootHierarchy?.length) {
      rootHierarchy.forEach(({ order, nodeId, nodeIndex }) => {
        const frame = frames.find(f => f.nodeId === nodeId);
        if (!frame) return;
        frame.hierarchyIndex = order;
        frame.nodeIndex = nodeIndex;
      });
    }
  }

  _parseFrameNamePlugin(r) {
    if (r.remaining < 4) return null;
    const paramCount = r.readUInt32();

    for (let p = 0; p < paramCount && r.remaining >= 8; p++) {
      const keyLen = r.readUInt32();
      if (keyLen > r.remaining) return null;
      const key = r.readString(keyLen).replace(/\0/g, '');
      if (r.remaining < 8) return null;
      const typeClass = r.readUInt32();
      const count = r.readUInt32();

      for (let i = 0; i < count; i++) {
        if (typeClass === 3) {
          if (r.remaining < 4) return null;
          const valueLen = r.readUInt32();
          if (valueLen > r.remaining) return null;
          const value = r.readString(valueLen).replace(/\0/g, '');
          if (key === 'name' && value) return value;
        } else {
          if (r.remaining < 4) return null;
          r.readUInt32();
        }
      }
    }

    return null;
  }

  _parseHAnimPlugin(r, frames, frameIdx) {
    r.readUInt32(); // hanimVer (0x100)
    const nodeId = r.readUInt32();
    frames[frameIdx].nodeId = nodeId;

    if (r.remaining < 4) return null;
    const maybeNumNodes = r.readUInt32();

    // Root frame: version, nodeId, numNodes, flags, maxKeyframeSize, node table[]
    if (maybeNumNodes > 0 && maybeNumNodes <= frames.length) {
      const numNodes = maybeNumNodes;
      const flags = r.readUInt32();
      r.readUInt32(); // maxKeyframeSize

      frames[frameIdx].hanimFlags = flags;
      frames[frameIdx].isHierarchyRoot = true;
      frames[frameIdx].numBones = numNodes;

      const hierarchy = [];
      for (let i = 0; i < numNodes && r.remaining >= 12; i++) {
        const nId = r.readUInt32();
        const nIdx = r.readUInt32();
        const nFlags = r.readUInt32();
        hierarchy.push({ order: i, nodeId: nId, nodeIndex: nIdx, flags: nFlags });
      }
      return hierarchy;
    }

    // Non-root frame: version, nodeId, flags
    frames[frameIdx].hanimFlags = maybeNumNodes;
    return null;
  }

  _parseGeometryList(r) {
    const struct = this._readChunk(r);
    const numGeos = struct.reader.readUInt32();
    const geometries = [];
    for (let i = 0; i < numGeos; i++) {
      const gc = this._readChunk(r);
      if (gc) geometries.push(this._parseGeometry(gc.reader));
    }
    return geometries;
  }

  _parseGeometry(r) {
    const struct = this._readChunk(r);
    const sr = struct.reader;
    const geo = this._parseGeometryStruct(sr, struct.version);

    // MaterialList
    const mlChunk = this._readChunk(r);
    if (mlChunk && mlChunk.type === RW.MATERIALLIST) {
      geo.materials = this._parseMaterialList(mlChunk.reader);
    }

    // Extension (Skin plugin, etc.)
    if (r.remaining >= 12) {
      const extChunk = this._readChunk(r);
      if (extChunk) this._parseGeometryExt(extChunk.reader, geo);
    }

    return geo;
  }

  _parseGeometryStruct(sr, version) {
    const flags          = sr.readUInt32();
    const numTriangles   = sr.readUInt32();
    const numVertices    = sr.readUInt32();
    const numMorphTargets = sr.readUInt32();

    // Pre-3.4 versions store lighting info here
    if (version < 0x34000) {
      sr.readFloat32(); // ambient
      sr.readFloat32(); // specular
      sr.readFloat32(); // diffuse
    }

    const isNative = (flags & GF.NATIVE) !== 0;

    // Determine UV set count from high bits, fallback to flags
    let numUVSets = (flags >> 16) & 0xFF;
    if (numUVSets === 0) {
      numUVSets = (flags & GF.TEXTURED) ? 1 : 0;
      if (flags & GF.TEXTURED2) numUVSets = 2;
    }

    const hasPrelit  = (flags & GF.PRELIT)  !== 0;
    const hasNormals = (flags & GF.NORMALS) !== 0;

    let colors = null;
    let uvSets = [];
    let triangles = [];
    let vertices = [];
    let normals = [];

    if (!isNative) {
      // Vertex colors
      if (hasPrelit) {
        colors = new Uint8Array(numVertices * 4);
        for (let i = 0; i < numVertices; i++) {
          colors[i * 4 + 0] = sr.readUInt8(); // R
          colors[i * 4 + 1] = sr.readUInt8(); // G
          colors[i * 4 + 2] = sr.readUInt8(); // B
          colors[i * 4 + 3] = sr.readUInt8(); // A
        }
      }

      // UV coordinates
      for (let s = 0; s < numUVSets; s++) {
        const uvs = new Float32Array(numVertices * 2);
        for (let i = 0; i < numVertices; i++) {
          uvs[i * 2 + 0] = sr.readFloat32(); // U
          uvs[i * 2 + 1] = sr.readFloat32(); // V
        }
        uvSets.push(uvs);
      }

      // Triangles: v2(u16), v1(u16), matIdx(u16), v3(u16)
      for (let i = 0; i < numTriangles; i++) {
        const v2 = sr.readUInt16();
        const v1 = sr.readUInt16();
        const matIdx = sr.readUInt16();
        const v3 = sr.readUInt16();
        triangles.push(v1, v2, v3, matIdx);
      }

      // Morph targets (usually 1 for static/skinned meshes)
      for (let m = 0; m < numMorphTargets; m++) {
        // Bounding sphere
        sr.readFloat32(); sr.readFloat32(); sr.readFloat32(); sr.readFloat32();
        const hasVerts  = sr.readUInt32();
        const hasNorms  = sr.readUInt32();

        if (hasVerts) {
          vertices = new Float32Array(numVertices * 3);
          for (let i = 0; i < numVertices; i++) {
            vertices[i * 3 + 0] = sr.readFloat32();
            vertices[i * 3 + 1] = sr.readFloat32();
            vertices[i * 3 + 2] = sr.readFloat32();
          }
        }
        if (hasNorms) {
          normals = new Float32Array(numVertices * 3);
          for (let i = 0; i < numVertices; i++) {
            normals[i * 3 + 0] = sr.readFloat32();
            normals[i * 3 + 1] = sr.readFloat32();
            normals[i * 3 + 2] = sr.readFloat32();
          }
        }
      }
    }

    return {
      flags, numVertices, numTriangles, numMorphTargets,
      numUVSets, hasNormals, isNative,
      vertices, normals, uvSets, triangles, colors,
      materials: [], skin: null,
    };
  }

  _parseMaterialList(r) {
    const struct = this._readChunk(r);
    const sr = struct.reader;
    const numMaterials = sr.readUInt32();
    // Material instance flags (-1 = new material, >=0 = reference to previous)
    const matFlags = [];
    for (let i = 0; i < numMaterials; i++) matFlags.push(sr.readInt32());

    const materials = [];
    for (let i = 0; i < numMaterials; i++) {
      if (matFlags[i] === -1) {
        const mc = this._readChunk(r);
        if (mc && mc.type === RW.MATERIAL) {
          materials.push(this._parseMaterial(mc.reader));
        }
      } else {
        // Reference to already-read material
        materials.push(materials[matFlags[i]] || null);
      }
    }
    return materials;
  }

  _parseMaterial(r) {
    const struct = this._readChunk(r);
    const sr = struct.reader;
    sr.readUInt32(); // flags
    const color = [sr.readUInt8(), sr.readUInt8(), sr.readUInt8(), sr.readUInt8()];
    sr.readUInt32(); // unused
    const isTextured = sr.readUInt32();
    sr.readFloat32(); // ambient
    sr.readFloat32(); // specular
    sr.readFloat32(); // diffuse

    let textureName = null;
    let maskName    = null;

    if (isTextured) {
      const tc = this._readChunk(r);
      if (tc && tc.type === RW.TEXTURE) {
        const tr = tc.reader;
        this._readChunk(tr); // struct (filter flags)
        const namec  = this._readChunk(tr);
        const maskc  = this._readChunk(tr);
        textureName = namec  ? namec.reader.readString(namec.size)  : null;
        maskName    = maskc  ? maskc.reader.readString(maskc.size)  : null;
      }
    }

    // Read material extension — AliceAsset stores real texture paths here (plugin 0x011f)
    let texChannels = null;
    while (r.remaining >= 12) {
      const ec = this._readChunk(r);
      if (!ec) break;
      if (ec.type === RW.EXTENSION) {
        const channels = this._extractDiffuseFromMatPlugin(ec.reader);
        const hasChannelData = !!(
          channels.c0 || channels.c1 || channels.c2 || channels.c3 ||
          channels.aoTex1 || channels.selfIlumTex0 || channels.specTex0 ||
          (channels.alphaTest ?? 0) > 0
        );
        if (hasChannelData) {
          texChannels = channels;
          // Keep the original material textureName (e.g. c_diffTexN placeholder)
          // so buildMesh can correctly route channel-based terrain materials.
          if (!textureName) {
            textureName = channels.c0 ?? channels.c1 ?? channels.c2 ?? channels.c3 ?? textureName;
          }
        }
      }
    }

    return { color, textureName, maskName, texChannels };
  }

  // Parse the AliceAsset material plugin (0x011f).
  // Returns diffuse channels plus selected helper params used by map objects.
  _extractDiffuseFromMatPlugin(r) {
    const channels = {
      c0: null, c1: null, c2: null, c3: null,
      aoTex1: null,
      selfIlumTex0: null,
      specTex0: null,
      alphaTest: 0,
    };
    const normalizeTexName = (raw) => {
      const fname = raw.replace(/^.*[/\\]/, '').replace(/\.dds$/i, '');
      if (!fname || /^none$/i.test(fname)) return null;
      return fname;
    };
    while (r.remaining >= 12) {
      const chunk = this._readChunk(r);
      if (!chunk) break;
      if (chunk.type !== 0x011f) continue;

      const pr = chunk.reader;
      if (pr.remaining < 4) break;
      const paramCount = pr.readUInt32();

      let lastName = null;
      for (let p = 0; p < paramCount && pr.remaining >= 8; p++) {
        const keyLen = pr.readUInt32();
        if (keyLen > pr.remaining) break;
        const key = pr.readString(keyLen).replace(/\0/g, '');
        if (pr.remaining < 8) break;
        const typeClass = pr.readUInt32();
        const count     = pr.readUInt32();

        const values = [];
        let ok = true;
        for (let i = 0; i < count && pr.remaining >= 4; i++) {
          if (typeClass === 3) {
            const slen = pr.readUInt32();
            if (slen > pr.remaining) { ok = false; break; }
            values.push(pr.readString(slen).replace(/\0/g, ''));
          } else {
            values.push(pr.readUInt32());
          }
        }
        if (!ok) break;

        if (key === 'name' && values.length) {
          lastName = values[0];
        } else if (key === 'data' && values.length) {
          if (typeClass === 3) {
            const texName = normalizeTexName(values[0]);
            const m = lastName?.match(/^c_diffTex(\d)$/);
            if (m) {
              const ch = 'c' + m[1];
              if (texName && !channels[ch]) channels[ch] = texName;
            } else if (lastName === 'c_aoTex1') {
              channels.aoTex1 = texName ?? channels.aoTex1;
            } else if (lastName === 'c_selfIlumTex0') {
              channels.selfIlumTex0 = texName ?? channels.selfIlumTex0;
            } else if (lastName === 'c_specTex0') {
              channels.specTex0 = texName ?? channels.specTex0;
            }
          } else if (typeClass === 1) {
            if (lastName === 'c_alphaTest') channels.alphaTest = Number(values[0]) || 0;
          }
        }
      }
      break; // only one 0x011f plugin per material
    }
    return channels;
  }

  _parseGeometryExt(r, geo) {
    while (r.remaining >= 12) {
      const chunk = this._readChunk(r);
      if (!chunk) break;
      if (chunk.type === RW.SKIN) {
        geo.skin = this._parseSkin(chunk.reader, geo.numVertices);
      }
      // other plugins: skipped (data consumed by subReader inside _readChunk)
    }
  }

  _parseSkin(r, numVertices) {
    const numBones           = r.readUInt8();
    const numUsedBones       = r.readUInt8();
    const maxWeightsPerVertex = r.readUInt8();
    r.readUInt8(); // padding

    const usedBones = [];
    for (let i = 0; i < numUsedBones; i++) usedBones.push(r.readUInt8());

    // Bone indices per vertex (4 per vertex)
    const boneIndices = new Uint8Array(numVertices * 4);
    for (let i = 0; i < numVertices * 4; i++) boneIndices[i] = r.readUInt8();

    // Bone weights per vertex (4 per vertex)
    const boneWeights = new Float32Array(numVertices * 4);
    for (let i = 0; i < numVertices * 4; i++) boneWeights[i] = r.readFloat32();

    // Inverse bind matrices are stored as RenderWare matrices:
    // three basis vectors + translation, each followed by a padding float.
    // Normalize them into standard 4x4 column-major arrays for Three.js.
    const inverseBindMatrices = [];
    for (let b = 0; b < numBones; b++) {
      const raw = [];
      for (let i = 0; i < 16; i++) raw.push(r.readFloat32());
      inverseBindMatrices.push([
        raw[0],  raw[1],  raw[2],  0,
        raw[4],  raw[5],  raw[6],  0,
        raw[8],  raw[9],  raw[10], 0,
        raw[12], raw[13], raw[14], 1,
      ]);
    }

    return { numBones, numUsedBones, maxWeightsPerVertex, usedBones, boneIndices, boneWeights, inverseBindMatrices };
  }

  _parseAtomic(r) {
    const struct = this._readChunk(r);
    const sr = struct.reader;
    const frameIndex = sr.readUInt32();
    const geometryIndex = sr.readUInt32();
    const renderFlags = sr.remaining >= 4 ? sr.readUInt32() : 0x05;
    const pipeline = sr.remaining >= 4 ? sr.readUInt32() : 0;
    return {
      frameIndex,
      geometryIndex,
      renderFlags,
      pipeline,
    };
  }
}
