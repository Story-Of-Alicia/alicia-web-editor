export class BinaryReader {
  constructor(buffer, littleEndian = true) {
    this.buf = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
    this.view = new DataView(this.buf);
    this.pos = 0;
    this.le = littleEndian;
  }

  get size() { return this.view.byteLength; }
  get remaining() { return this.view.byteLength - this.pos; }

  readUInt8()  { return this.view.getUint8(this.pos++); }
  readInt8()   { return this.view.getInt8(this.pos++); }
  readUInt16() { const v = this.view.getUint16(this.pos, this.le); this.pos += 2; return v; }
  readInt16()  { const v = this.view.getInt16(this.pos, this.le);  this.pos += 2; return v; }
  readUInt32() { const v = this.view.getUint32(this.pos, this.le); this.pos += 4; return v; }
  readInt32()  { const v = this.view.getInt32(this.pos, this.le);  this.pos += 4; return v; }
  readFloat32(){ const v = this.view.getFloat32(this.pos, this.le);this.pos += 4; return v; }

  readString(len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = this.view.getUint8(this.pos++);
      if (c !== 0) s += String.fromCharCode(c);
    }
    return s;
  }

  readNullString() {
    let s = '';
    let c;
    while (this.pos < this.size && (c = this.view.getUint8(this.pos++)) !== 0) {
      s += String.fromCharCode(c);
    }
    return s;
  }

  skip(n) { this.pos += n; }

  slice(offset, size) {
    return new BinaryReader(this.buf.slice(offset, offset + size));
  }

  subReader(size) {
    const r = this.slice(this.pos, size);
    this.pos += size;
    return r;
  }

  readVec3() {
    return [this.readFloat32(), this.readFloat32(), this.readFloat32()];
  }

  readVec4() {
    return [this.readFloat32(), this.readFloat32(), this.readFloat32(), this.readFloat32()];
  }

  readMat3() {
    const m = [];
    for (let i = 0; i < 9; i++) m.push(this.readFloat32());
    return m;
  }

  readMat4() {
    const m = [];
    for (let i = 0; i < 16; i++) m.push(this.readFloat32());
    return m;
  }
}
