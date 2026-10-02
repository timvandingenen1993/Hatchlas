/**
 * Deterministic PRNG and Spherical Noise Utilities
 */

export class Mulberry32 {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  rangeInt(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }
}

/**
 * 3D Simplex Noise for spherical coordinate evaluations
 */
export class Simplex3D {
  private p: Uint8Array;
  private perm: Uint8Array;
  private permMod12: Uint8Array;

  private static readonly G3 = 1.0 / 6.0;
  private static readonly F3 = 1.0 / 3.0;

  private static readonly GRAD3 = new Float32Array([
    1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
    1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
    0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
  ]);

  constructor(seed: number = 0) {
    this.p = new Uint8Array(256);
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);

    for (let i = 0; i < 256; i++) {
      this.p[i] = i;
    }

    const rng = new Mulberry32(seed);
    for (let i = 255; i > 0; i--) {
      const r = rng.rangeInt(0, i);
      const tmp = this.p[i];
      this.p[i] = this.p[r];
      this.p[r] = tmp;
    }

    for (let i = 0; i < 512; i++) {
      this.perm[i] = this.p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  noise3D(xin: number, yin: number, zin: number): number {
    const s = (xin + yin + zin) * Simplex3D.F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * Simplex3D.G3;

    const X0 = i - t;
    const Y0 = j - t;
    const Z0 = k - t;
    const x0 = xin - X0;
    const y0 = yin - Y0;
    const z0 = zin - Z0;

    let i1: number, j1: number, k1: number;
    let i2: number, j2: number, k2: number;

    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1;
      } else {
        i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1;
      }
    } else {
      if (y0 < z0) {
        i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1;
      } else if (x0 < z0) {
        i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1;
      } else {
        i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      }
    }

    const x1 = x0 - i1 + Simplex3D.G3;
    const y1 = y0 - j1 + Simplex3D.G3;
    const z1 = z0 - k1 + Simplex3D.G3;

    const x2 = x0 - i2 + 2.0 * Simplex3D.G3;
    const y2 = y0 - j2 + 2.0 * Simplex3D.G3;
    const z2 = z0 - k2 + 2.0 * Simplex3D.G3;

    const x3 = x0 - 1.0 + 3.0 * Simplex3D.G3;
    const y3 = y0 - 1.0 + 3.0 * Simplex3D.G3;
    const z3 = z0 - 1.0 + 3.0 * Simplex3D.G3;

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;

    const gi0 = this.permMod12[ii + this.perm[jj + this.perm[kk]]] * 3;
    const gi1 = this.permMod12[ii + i1 + this.perm[jj + j1 + this.perm[kk + k1]]] * 3;
    const gi2 = this.permMod12[ii + i2 + this.perm[jj + j2 + this.perm[kk + k2]]] * 3;
    const gi3 = this.permMod12[ii + 1 + this.perm[jj + 1 + this.perm[kk + 1]]] * 3;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    let n0 = 0;
    if (t0 > 0) {
      t0 *= t0;
      n0 = t0 * t0 * (Simplex3D.GRAD3[gi0] * x0 + Simplex3D.GRAD3[gi0 + 1] * y0 + Simplex3D.GRAD3[gi0 + 2] * z0);
    }

    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    let n1 = 0;
    if (t1 > 0) {
      t1 *= t1;
      n1 = t1 * t1 * (Simplex3D.GRAD3[gi1] * x1 + Simplex3D.GRAD3[gi1 + 1] * y1 + Simplex3D.GRAD3[gi1 + 2] * z1);
    }

    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    let n2 = 0;
    if (t2 > 0) {
      t2 *= t2;
      n2 = t2 * t2 * (Simplex3D.GRAD3[gi2] * x2 + Simplex3D.GRAD3[gi2 + 1] * y2 + Simplex3D.GRAD3[gi2 + 2] * z2);
    }

    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    let n3 = 0;
    if (t3 > 0) {
      t3 *= t3;
      n3 = t3 * t3 * (Simplex3D.GRAD3[gi3] * x3 + Simplex3D.GRAD3[gi3 + 1] * y3 + Simplex3D.GRAD3[gi3 + 2] * z3);
    }

    return 32.0 * (n0 + n1 + n2 + n3);
  }

  fbm(x: number, y: number, z: number, octaves: number = 4, lacunarity: number = 2.0, gain: number = 0.5): number {
    let sum = 0;
    let amp = 1.0;
    let freq = 1.0;
    let maxAmp = 0;

    for (let i = 0; i < octaves; i++) {
      sum += this.noise3D(x * freq, y * freq, z * freq) * amp;
      maxAmp += amp;
      freq *= lacunarity;
      amp *= gain;
    }

    return sum / maxAmp;
  }
}
