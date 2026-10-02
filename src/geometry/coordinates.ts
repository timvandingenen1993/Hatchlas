/**
 * 3D Spherical Vector and Coordinate Utilities
 */

export type Vec3 = [number, number, number];

export function vec3(x: number, y: number, z: number): Vec3 {
  return [x, y, z];
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length3(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function normalize3(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1.0;
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function distance3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Great-circle angular distance on unit sphere in radians
 */
export function greatCircleAngle(a: Vec3, b: Vec3): number {
  const d = Math.max(-1.0, Math.min(1.0, dot3(a, b)));
  return Math.acos(d);
}

/**
 * Great-circle physical distance in meters
 */
export function greatCircleDistance(a: Vec3, b: Vec3, radiusMeters: number = 6371000): number {
  return greatCircleAngle(a, b) * radiusMeters;
}

/**
 * Spherical coordinates (lat, lon in radians) from unit Cartesian vector
 * - lat: -PI/2 (South Pole) to +PI/2 (North Pole)
 * - lon: -PI to +PI
 */
export function vec3ToLatLonRad(v: Vec3): [number, number] {
  const lat = Math.asin(Math.max(-1.0, Math.min(1.0, v[2])));
  const lon = Math.atan2(v[1], v[0]);
  return [lat, lon];
}

export function vec3ToLatLonDeg(v: Vec3): [number, number] {
  const [latRad, lonRad] = vec3ToLatLonRad(v);
  return [(latRad * 180) / Math.PI, (lonRad * 180) / Math.PI];
}

/**
 * Unit Cartesian vector on S^2 from latitude and longitude in radians
 */
export function latLonRadToVec3(latRad: number, lonRad: number): Vec3 {
  const cosLat = Math.cos(latRad);
  return [
    cosLat * Math.cos(lonRad),
    cosLat * Math.sin(lonRad),
    Math.sin(latRad),
  ];
}

export function latLonDegToVec3(latDeg: number, lonDeg: number): Vec3 {
  return latLonRadToVec3((latDeg * Math.PI) / 180, (lonDeg * Math.PI) / 180);
}

/**
 * Spherical linear interpolation (Slerp) along the great circle between two unit vectors
 */
export function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const omega = greatCircleAngle(a, b);
  if (omega < 1e-6) return a;
  const sinOmega = Math.sin(omega);
  const scaleA = Math.sin((1 - t) * omega) / sinOmega;
  const scaleB = Math.sin(t * omega) / sinOmega;
  return [
    scaleA * a[0] + scaleB * b[0],
    scaleA * a[1] + scaleB * b[1],
    scaleA * a[2] + scaleB * b[2],
  ];
}
