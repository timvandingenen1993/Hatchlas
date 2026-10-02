// Seeded fast PRNG using Mulberry32 (Tommy Ettinger's public-domain generator)
export class FastRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed | 0;
  }

  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  nextFloat(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }
}

// 2D Simplex Noise generator with seed support.
// Follows Stefan Gustavson's public-domain reference implementation
// ("Simplex noise demystified", 2005).
export class SimplexNoise {
  private perm: Uint8Array;
  private permMod12: Uint8Array;

  private static readonly F2 = 0.5 * (Math.sqrt(3.0) - 1.0);
  private static readonly G2 = (3.0 - Math.sqrt(3.0)) / 6.0;

  private static readonly grad3 = new Float32Array([
    1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
    1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
    0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
  ]);

  constructor(seed: number = 1337) {
    const rng = new FastRandom(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      p[i] = i;
    }
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }

    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = (this.perm[i] % 12) * 3;
    }
  }

  // 2D noise returning value in [-1, 1]
  noise2D(xin: number, yin: number): number {
    let n0 = 0, n1 = 0, n2 = 0;
    const s = (xin + yin) * SimplexNoise.F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * SimplexNoise.G2;
    const X0 = i - t;
    const Y0 = j - t;
    const x0 = xin - X0;
    const y0 = yin - Y0;

    let i1: number, j1: number;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    } else {
      i1 = 0;
      j1 = 1;
    }

    const x1 = x0 - i1 + SimplexNoise.G2;
    const y1 = y0 - j1 + SimplexNoise.G2;
    const x2 = x0 - 1.0 + 2.0 * SimplexNoise.G2;
    const y2 = y0 - 1.0 + 2.0 * SimplexNoise.G2;

    const ii = i & 255;
    const jj = j & 255;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const gi0 = this.permMod12[ii + this.perm[jj]];
      t0 *= t0;
      n0 = t0 * t0 * (SimplexNoise.grad3[gi0] * x0 + SimplexNoise.grad3[gi0 + 1] * y0);
    }

    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const gi1 = this.permMod12[ii + i1 + this.perm[jj + j1]];
      t1 *= t1;
      n1 = t1 * t1 * (SimplexNoise.grad3[gi1] * x1 + SimplexNoise.grad3[gi1 + 1] * y1);
    }

    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const gi2 = this.permMod12[ii + 1 + this.perm[jj + 1]];
      t2 *= t2;
      n2 = t2 * t2 * (SimplexNoise.grad3[gi2] * x2 + SimplexNoise.grad3[gi2 + 1] * y2);
    }

    return 70.0 * (n0 + n1 + n2);
  }

  // Rotated Octave FBM with dynamic lacunarity and gain
  fbm(
    x: number,
    y: number,
    octaves: number = 6,
    lacunarity: number = 2.0,
    gain: number = 0.5
  ): number {
    let total = 0;
    let amplitude = gain;
    let px = x;
    let py = y;

    // Rotation matrix (angle ~ 37 degrees: cos=0.8, sin=0.6)
    const cos = 0.8;
    const sin = 0.6;

    for (let i = 0; i < octaves; i++) {
      total += amplitude * this.noise2D(px, py);
      const nx = (px * cos - py * sin) * lacunarity;
      const ny = (px * sin + py * cos) * lacunarity;
      px = nx;
      py = ny;
      amplitude *= gain;
    }

    return total; // in [-1, 1]
  }

  // Musgrave Heterogeneous Multifractal Terrain (smooth lowlands, rough highlands)
  heteroTerrain(
    x: number,
    y: number,
    H: number = 0.9,
    lacunarity: number = 2.0,
    octaves: number = 6,
    offset: number = 0.75
  ): number {
    let px = x;
    let py = y;
    const cos = 0.8;
    const sin = 0.6;

    // First octave
    let value = offset + this.noise2D(px, py);
    let nextPx = (px * cos - py * sin) * lacunarity;
    let nextPy = (px * sin + py * cos) * lacunarity;
    px = nextPx;
    py = nextPy;

    // Successive octaves modulated by cumulative elevation
    for (let i = 1; i < octaves; i++) {
      const exponent = Math.pow(lacunarity, -i * H);
      const increment = (this.noise2D(px, py) + offset) * exponent * value;
      value += increment;

      nextPx = (px * cos - py * sin) * lacunarity;
      nextPy = (px * sin + py * cos) * lacunarity;
      px = nextPx;
      py = nextPy;
    }

    return value;
  }

  // Musgrave Heterogeneous Ridged Multifractal (sharp alpine crests, deep valleys)
  musgraveMountains(
    x: number,
    y: number,
    octaves: number = 5,
    offset: number = 1.0,
    gain: number = 2.0,
    lacunarity: number = 2.02,
    H: number = 1.0
  ): number {
    let sum = 0.0;
    let weight = 1.0;
    let px = x;
    let py = y;
    const cos = 0.8;
    const sin = 0.6;

    for (let i = 0; i < octaves; i++) {
      const exponent = Math.pow(lacunarity, -i * H);
      let signal = offset - Math.abs(this.noise2D(px, py));
      signal = signal * signal; // Sharpen ridge peak
      signal *= weight;
      weight = Math.max(0.0, Math.min(1.0, signal * gain));

      sum += signal * exponent * 0.5;
      const nx = (px * cos - py * sin) * lacunarity;
      const ny = (px * sin + py * cos) * lacunarity;
      px = nx;
      py = ny;
    }

    return Math.max(0.0, Math.min(1.0, sum)); // in [0, 1]
  }

  // Billow noise for rolling smooth hills
  billow(x: number, y: number, octaves: number = 4): number {
    let total = 0;
    let amplitude = 0.5;
    let px = x;
    let py = y;
    const cos = 0.8;
    const sin = 0.6;

    for (let i = 0; i < octaves; i++) {
      total += amplitude * Math.abs(this.noise2D(px, py));
      const nx = (px * cos - py * sin) * 2.02;
      const ny = (px * sin + py * cos) * 2.02;
      px = nx;
      py = ny;
      amplitude *= 0.5;
    }

    return total; // in [0, 1]
  }

  // Backward compatibility
  ridgedMF(x: number, y: number, octaves: number = 5): number {
    return this.musgraveMountains(x, y, octaves);
  }

  domainWarp(x: number, y: number, strength: number = 0.25): { x: number; y: number } {
    const qx = this.noise2D(x, y);
    const qy = this.noise2D(x + 5.2, y + 1.3);
    return {
      x: x + qx * strength,
      y: y + qy * strength,
    };
  }
}

// 2D Cellular / Voronoi Noise
export class VoronoiNoise {
  sample(x: number, y: number, scale: number = 4.0): { f1: number; f2: number } {
    const px = x * scale;
    const py = y * scale;

    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const fx = px - ix;
    const fy = py - iy;

    let f1 = 1e9;
    let f2 = 1e9;

    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const hash = Math.sin((ix + i) * 12.9898 + (iy + j) * 78.233) * 43758.5453;
        const rx = (Math.sin(hash) * 0.5 + 0.5);
        const ry = (Math.cos(hash) * 0.5 + 0.5);

        const dx = i + rx - fx;
        const dy = j + ry - fy;
        const d = Math.hypot(dx, dy);

        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }

    return { f1: Math.min(1.0, f1), f2: Math.min(1.0, f2) };
  }
}
