import { BinaryReader } from './BinaryReader.js';

const RW_ANIMATION = 0x001B;

export class ANMParser {
  /**
   * Parse a RenderWare HAnim animation file (.anm).
   *
   * Format (confirmed for Alicia Online / RW 3.6):
   *   Chunk header: type(4) size(4) version(4)
   *   Data:
   *     interpVersion  u32  = 0x100
   *     interpPluginId u32  = 0x1 (standard HAnim)
   *     numKeyframes   u32  = total keyframes (all bones × all time steps)
   *     flags          u32  = 0
   *     duration       f32  = animation length in seconds
   *     keyframes[numKeyframes]:
   *       time       f32
   *       quat       f32[4]  (x, y, z, w)
   *       pos        f32[3]
   *       prevFrame  s32     (index of previous keyframe for same bone; circular for first)
   *
   * Each 36-byte keyframe. Keyframes are interleaved by time:
   *   [bone0@t0, bone1@t0, ..., boneN@t0, bone0@t1, ...]
   * so bone i's keyframe at step t = keyframes[t * numBones + i].
   */
  parse(buffer, numBones) {
    const r = new BinaryReader(buffer);

    const type    = r.readUInt32();
    const size    = r.readUInt32();
    r.readUInt32(); // version

    if (type !== RW_ANIMATION) {
      throw new Error(`Expected Animation chunk (0x1B), got 0x${type.toString(16)}`);
    }

    const interpVer      = r.readUInt32(); // 0x100
    const interpPluginId = r.readUInt32(); // 0x1
    const numKeyframes   = r.readUInt32();
    r.readUInt32(); // flags
    const duration = r.readFloat32();

    if (numKeyframes === 0) {
      return { duration, numBones: 0, timeSteps: 0, keyframes: [] };
    }

    // Read all keyframes flat
    const keyframes = [];
    for (let i = 0; i < numKeyframes; i++) {
      const time  = r.readFloat32();
      const qx    = r.readFloat32();
      const qy    = r.readFloat32();
      const qz    = r.readFloat32();
      const qw    = r.readFloat32();
      const px    = r.readFloat32();
      const py    = r.readFloat32();
      const pz    = r.readFloat32();
      const prevFrame = r.readInt32();
      keyframes.push({ time, qx, qy, qz, qw, px, py, pz, prevFrame });
    }

    // Store raw prevFrame values for diagnostics.
    const _rawPrevFrames = keyframes.slice(0, Math.min(6, keyframes.length)).map(k => k.prevFrame);

    // Infer numBones from caller or from the data itself.
    let detectedBones = numBones || 0;
    if (!detectedBones) {
      // Primary: prevFrame as absolute byte offset — bone0's keyframe at t1 is at
      // index numBones and has prevFrame == 0 (byte offset of bone0@t0).
      for (let i = 1; i < keyframes.length; i++) {
        if (keyframes[i].prevFrame === 0) { detectedBones = i; break; }
      }
    }
    if (!detectedBones) {
      // Try prevFrame as negative relative byte offset: bone0@t1 has prevFrame = -numBones*36.
      // So numBones = -prevFrame[numBones] / 36.
      for (let i = 1; i < keyframes.length; i++) {
        const pf = keyframes[i].prevFrame;
        if (pf < 0 && (-pf % 36) === 0) {
          const candidate = -pf / 36;
          if (candidate === i) { detectedBones = i; break; }
        }
      }
    }
    if (!detectedBones) {
      // Fallback: count consecutive keyframes with time ≈ 0 (single-timestep ANMs).
      detectedBones = 1;
      for (let i = 1; i < keyframes.length; i++) {
        if (Math.abs(keyframes[i].time) < 1e-6) detectedBones++;
        else break;
      }
    }

    const numTimeSteps = Math.ceil(numKeyframes / detectedBones);

    return { duration, numBones: detectedBones, numTimeSteps, numKeyframes, keyframes, _rawPrevFrames };
  }

  /**
   * Convert parsed ANM data into per-bone track arrays usable by Three.js.
   * Returns: Map<boneIndex, { times, positions, quaternions }>
   */
  buildTracks(anmData) {
    const { numBones, numTimeSteps, keyframes } = anmData;
    const tracks = new Map();

    for (let b = 0; b < numBones; b++) {
      const times = [];
      const positions = [];
      const quaternions = [];

      for (let t = 0; t < numTimeSteps; t++) {
        const idx = t * numBones + b;
        if (idx >= keyframes.length) break;
        const kf = keyframes[idx];
        times.push(kf.time);
        positions.push(kf.px, kf.py, kf.pz);
        quaternions.push(kf.qx, kf.qy, kf.qz, kf.qw);
      }

      tracks.set(b, { times, positions, quaternions });
    }

    return tracks;
  }
}
