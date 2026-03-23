import { BinaryReader } from './BinaryReader.js';

export class ABinParser {
  parse(buffer) {
    const r = new BinaryReader(buffer);

    const version        = r.readUInt32();
    const modelCount     = r.readUInt32();
    const cameraCount    = r.readUInt32();
    const pathPointCount = r.readUInt32();
    const areaCount      = r.readUInt32();
    const textureCount   = r.readUInt32();
    const nodeCount      = r.readUInt32();
    r.readUInt32(); // member8
    r.readUInt32(); // member9

    if (version > 1086) r.skip(32); // AmbSoundHeader.name[32]
    let sphereCount = 0;
    if (version > 1087) sphereCount = r.readUInt32();

    // Cameras
    const cameras = [];
    for (let i = 0; i < cameraCount; i++) {
      cameras.push({
        name:        r.readString(32),
        position:    r.readVec3(),
        orientation: r.readVec3(),
      });
      r.readUInt32(); r.readUInt32(); // member12, member13
    }

    // PathPoints
    for (let i = 0; i < pathPointCount; i++) {
      const m1 = r.readUInt8();
      r.skip(32); r.readVec3();
      if (m1 !== 0) r.skip(32);
    }

    // Areas
    for (let i = 0; i < areaCount; i++) {
      r.readUInt8(); r.skip(32); r.skip(24); r.readVec3();
      r.readUInt32(); r.readUInt32(); r.readUInt32(); r.readUInt32(); r.readUInt32();
      const soundLen = r.readUInt32(); r.skip(soundLen);
      if (version > 1088) { const slen = r.readUInt32(); r.skip(slen); }
    }

    // Spheres
    for (let i = 0; i < sphereCount; i++) {
      r.readUInt8(); r.skip(32); r.readVec3(); r.readUInt32(); r.skip(260);
    }

    // Textures
    for (let i = 0; i < textureCount; i++) r.skip(32);

    // Nodes
    const nodes = [];
    for (let i = 0; i < nodeCount; i++) {
      const name  = r.readString(32);
      const count = r.readUInt32();
      r.readUInt32(); // member2
      const positions = [];
      for (let j = 0; j < count; j++) positions.push(r.readVec3());
      nodes.push({ name, positions });
    }

    // Model struct (per entry):
    //  name[32]         — char[32]: model filename (null-terminated)
    //  member2–member6  — u32 × 5
    //  value            — float32 (negative → member39 Vec3 present)
    //  member8–member19 — u32 × 12
    //  position         — Vec3
    //  member21–member36 — u32 × 16
    //  member37         — s32 (length of optional member40 string)
    //  [member31 > 0]   char[member31]  — member38
    //  [value < 0]      Vec3            — member39
    //  [member37 > 0]   char[member37]  — member40
    //  member41         — Vec3 scale
    //  member42         — Vec3 boundMin
    //  member43         — Vec3 boundMax
    const models = [];
    for (let i = 0; i < modelCount; i++) {
      const nameBytes = r.subReader(32);
      const typeCode  = nameBytes.readUInt8();
      const name      = nameBytes.readString(31);

      // member2–member6: five u32 fields
      const flags = [r.readUInt32(), r.readUInt32(), r.readUInt32(), r.readUInt32(), r.readUInt32()];

      // value (float, negative = member39 present)
      const val = r.readFloat32();

      // member8–member19: twelve fields
      // [0..7]  = unknown u32s (member8–member15; member15 often = -1.0 as float)
      // [8..11] = quaternion (qx, qy, qz, qw) as float32 (member16–member19)
      const pre = [];
      for (let j = 0; j < 8;  j++) pre.push(r.readUInt32());
      const rotation = [r.readFloat32(), r.readFloat32(), r.readFloat32(), r.readFloat32()];

      const position = r.readVec3();

      // member21–member36: sixteen u32 fields
      const post = [];
      for (let j = 0; j < 16; j++) post.push(r.readUInt32());
      // member31 is post[10] (m21=post[0], m22=post[1], ..., m31=post[10])
      const member31 = post[10];

      // member37: s32 — length of optional member40 string
      const member37 = r.readInt32();

      if (member31 > 0 && member31 < 512) r.skip(member31); // member38
      if (val < 0.0)                       r.skip(12);       // member39 Vec3
      if (member37 > 0 && member37 < 512)  r.skip(member37); // member40

      const scale = r.readVec3(); // member41
      r.readVec3();                // member42 boundMin
      r.readVec3();                // member43 boundMax

      models.push({ name, typeCode, position, rotation, flags, val, pre, post, member31, member37, scale });
    }

    return { version, models, cameras, nodes };
  }
}
