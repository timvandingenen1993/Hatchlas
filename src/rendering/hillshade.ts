// Computes multidirectional shaded relief using 3D vector surface normals and light dot product
export function computeHillshade(
  width: number,
  height: number,
  elevation: Float32Array,
  zScale: number = 24.0,
  azimuthDeg: number = 315, // Light from North-West
  altitudeDeg: number = 45
): Float32Array {
  const totalCells = width * height;
  const hillshade = new Float32Array(totalCells);

  // Convert lighting angles to 3D unit direction vector pointing towards light source
  const azRad = (azimuthDeg * Math.PI) / 180.0;
  const altRad = (altitudeDeg * Math.PI) / 180.0;

  // In screen space (X East, Y South, Z Up):
  const lx = -Math.sin(azRad) * Math.cos(altRad);
  const ly = -Math.cos(azRad) * Math.cos(altRad);
  const lz = Math.sin(altRad);

  for (let y = 0; y < height; y++) {
    const yN = Math.max(0, y - 1);
    const yS = Math.min(height - 1, y + 1);

    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const xW = Math.max(0, x - 1);
      const xE = Math.min(width - 1, x + 1);

      // 3x3 neighborhood elevation samples with border clamping (no black edge borders!)
      const zNW = elevation[yN * width + xW];
      const zN  = elevation[yN * width + x];
      const zNE = elevation[yN * width + xE];
      const zW  = elevation[y * width + xW];
      const zE  = elevation[y * width + xE];
      const zSW = elevation[yS * width + xW];
      const zS  = elevation[yS * width + x];
      const zSE = elevation[yS * width + xE];

      // dz/dx gradient (West to East)
      const dzdx = ((zNE + 2.0 * zE + zSE) - (zNW + 2.0 * zW + zSW)) / 8.0 * zScale;
      // dz/dy gradient (North to South in screen space)
      const dzdy = ((zSW + 2.0 * zS + zSE) - (zNW + 2.0 * zN + zNE)) / 8.0 * zScale;

      // Surface normal vector N = (-dzdx, -dzdy, 1.0)
      const nLen = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1.0);
      const nx = -dzdx / nLen;
      const ny = -dzdy / nLen;
      const nz = 1.0 / nLen;

      // Diffuse Lambertian term N · L
      const dot = nx * lx + ny * ly + nz * lz;
      // Ambient base (0.28) + direct diffuse (0.72)
      const shade = Math.max(0.0, Math.min(1.0, 0.28 + 0.72 * Math.max(0.0, dot)));

      hillshade[idx] = shade;
    }
  }

  return hillshade;
}
