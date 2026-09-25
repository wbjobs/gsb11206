// Incremental SHA-256 (pure JS, works in Window/Worker/Node).
// Used so large files can be hashed chunk-by-chunk without loading
// the whole file into memory.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  constructor() {
    this._h = new Uint32Array(8);
    this._block = new Uint8Array(64);
    this._blockLen = 0;
    this._totalLen = 0;
    this.reset();
  }

  reset() {
    this._h.set([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this._blockLen = 0;
    this._totalLen = 0;
  }

  _compress() {
    const w = new Uint32Array(64);
    const b = this._block;
    for (let i = 0; i < 16; i++) {
      w[i] = (b[i * 4] << 24) | (b[i * 4 + 1] << 16) | (b[i * 4 + 2] << 8) | b[i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = this._h[0], b2 = this._h[1], c = this._h[2], d = this._h[3];
    let e = this._h[4], f = this._h[5], g = this._h[6], h = this._h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b2) ^ (a & c) ^ (b2 & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b2; b2 = a; a = (t1 + t2) >>> 0;
    }
    this._h[0] = (this._h[0] + a) >>> 0;
    this._h[1] = (this._h[1] + b2) >>> 0;
    this._h[2] = (this._h[2] + c) >>> 0;
    this._h[3] = (this._h[3] + d) >>> 0;
    this._h[4] = (this._h[4] + e) >>> 0;
    this._h[5] = (this._h[5] + f) >>> 0;
    this._h[6] = (this._h[6] + g) >>> 0;
    this._h[7] = (this._h[7] + h) >>> 0;
  }

  update(data) {
    if (typeof data === 'string') data = new TextEncoder().encode(data);
    this._totalLen += data.length;
    let offset = 0;
    while (offset < data.length) {
      const take = Math.min(64 - this._blockLen, data.length - offset);
      this._block.set(data.subarray(offset, offset + take), this._blockLen);
      this._blockLen += take;
      offset += take;
      if (this._blockLen === 64) {
        this._compress();
        this._blockLen = 0;
      }
    }
  }

  digest() {
    const savedBlock = this._block.slice(0, this._blockLen);
    const savedBlockLen = this._blockLen;
    const savedTotal = this._totalLen;
    const savedH = this._h.slice();
    const bitLenHi = Math.floor(this._totalLen / 0x20000000);
    const bitLenLo = (this._totalLen << 3) >>> 0;
    this.update(new Uint8Array([0x80]));
    while (this._blockLen !== 56) this.update(new Uint8Array([0]));
    const tail = new Uint8Array(8);
    const dv = new DataView(tail.buffer);
    dv.setUint32(0, bitLenHi >>> 0);
    dv.setUint32(4, bitLenLo);
    this.update(tail);
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, this._h[i]);
    // restore state so the instance stays reusable
    this._block.set(savedBlock);
    this._blockLen = savedBlockLen;
    this._totalLen = savedTotal;
    this._h.set(savedH);
    return out;
  }

  digestHex() {
    return [...this.digest()].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}

export function sha256Hex(data) {
  const h = new Sha256();
  h.update(data);
  return h.digestHex();
}

function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}
