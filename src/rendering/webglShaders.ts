/**
 * WebGL GLSL Shaders for Planetary Map Projections and Cubed-Sphere Sampling
 */

export const PROJECTED_VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const PROJECTED_FRAGMENT_SHADER = `
precision highp float;

varying vec2 v_uv;

// Uniforms
uniform int u_projection; // 0: Equal Earth, 1: Mercator, 2: Equirectangular
uniform int u_layer;      // 0: elevation, 1: crust_type, 2: crust_age, 3: plate_boundaries,
                          // 4: tectonic_uplift, 5: discharge, 6: lakes, 7: drainage_basins,
                          // 8: temp, 9: precip, 10: ice, 11: biomes, 16: continental material
uniform int u_showHillshade;
uniform float u_seaLevel;
uniform vec2 u_extentsX;  // minX, maxX
uniform vec2 u_extentsY;  // minY, maxY
uniform vec3 u_sunDir;    // Unit vector towards light
uniform float u_gridRes;  // Face resolution N (e.g. 192)

// Textures
// Data atlas layout (3 columns x 2 rows of faces):
// Row 0 (bottom in WebGL): Face 0 (+X), Face 1 (-X), Face 2 (+Y)
// Row 1 (top in WebGL): Face 3 (-Y), Face 4 (+Z North), Face 5 (-Z South)
uniform sampler2D u_dataTexture;     // Primary layer data / elevation
uniform sampler2D u_climateTexture;  // Selected monthly climate / secondary data
uniform sampler2D u_extraTexture;    // Categorical / auxiliary data (biomes, basins, crust)

const float PI = 3.141592653589793;
const float SQRT3 = 1.7320508075688772;
const float A1 = 1.340264;
const float A2 = -0.081106;
const float A3 = 0.000893;
const float A4 = 0.003796;
const float MERCATOR_MAX_LAT = 1.4844222297453323; // ~85.0511 degrees

// Inverse Equal Earth Projection in GLSL
bool inverseEqualEarth(vec2 xy, out float latRad, out float lonRad) {
  float maxY = 1.31705;
  if (abs(xy.y) > maxY) return false;

  float theta = xy.y;
  for (int i = 0; i < 4; i++) {
    float theta2 = theta * theta;
    float theta6 = theta2 * theta2 * theta2;
    float f = theta * (A1 + A2 * theta2 + A3 * theta6 + A4 * theta6 * theta2) - xy.y;
    float fPrime = A1 + 3.0 * A2 * theta2 + 7.0 * A3 * theta6 + 9.0 * A4 * theta6 * theta2;
    float delta = f / fPrime;
    theta -= delta;
    if (abs(delta) < 1e-5) break;
  }

  float sinTheta = sin(theta);
  float sinPhi = (2.0 / SQRT3) * sinTheta;
  if (abs(sinPhi) > 1.0) return false;

  latRad = asin(clamp(sinPhi, -1.0, 1.0));
  float cosTheta = cos(theta);
  if (abs(cosTheta) < 1e-6) {
    lonRad = 0.0;
    return true;
  }

  float theta2 = theta * theta;
  float theta6 = theta2 * theta2 * theta2;
  float polyX = A1 + 3.0 * A2 * theta2 + 7.0 * A3 * theta6 + 9.0 * A4 * theta6 * theta2;

  lonRad = (3.0 * xy.x * polyX) / (2.0 * SQRT3 * cosTheta);
  if (abs(lonRad) > PI + 1e-4) return false;
  lonRad = clamp(lonRad, -PI, PI);
  return true;
}

// Inverse Mercator Projection in GLSL
bool inverseMercator(vec2 xy, out float latRad, out float lonRad) {
  if (abs(xy.x) > PI || abs(xy.y) > PI) return false;
  lonRad = xy.x;
  latRad = 2.0 * atan(exp(xy.y)) - 0.5 * PI;
  if (abs(latRad) > MERCATOR_MAX_LAT) return false;
  return true;
}

// Inverse Equirectangular Projection in GLSL
bool inverseEquirectangular(vec2 xy, out float latRad, out float lonRad) {
  if (abs(xy.x) > PI || abs(xy.y) > 0.5 * PI) return false;
  lonRad = xy.x;
  latRad = xy.y;
  return true;
}

// Map 3D Sphere Point P to Cubed Sphere Face (0..5) and Atlas UV in [0, 1]
vec2 cubePointToAtlasUV(vec3 p) {
  vec3 a = abs(p);
  int face = 0;
  vec2 uv = vec2(0.0);

  if (a.x >= a.y && a.x >= a.z) {
    if (p.x > 0.0) {
      face = 0; // +X
      uv = vec2(p.y / p.x, p.z / p.x);
    } else {
      face = 1; // -X
      uv = vec2(p.y / p.x, -p.z / p.x);
    }
  } else if (a.y >= a.x && a.y >= a.z) {
    if (p.y > 0.0) {
      face = 2; // +Y
      uv = vec2(-p.x / p.y, p.z / p.y);
    } else {
      face = 3; // -Y
      uv = vec2(-p.x / p.y, -p.z / p.y);
    }
  } else {
    if (p.z > 0.0) {
      face = 4; // +Z (North Pole)
      uv = vec2(p.y / p.z, -p.x / p.z);
    } else {
      face = 5; // -Z (South Pole)
      uv = vec2(-p.y / p.z, -p.x / p.z);
    }
  }

  // Convert u, v in [-1, 1] to linear face sub-coordinates in [0, 1]
  float alpha = atan(uv.x);
  float beta = atan(uv.y);
  float localU = clamp((alpha + 0.25 * PI) / (0.5 * PI), 0.0001, 0.9999);
  float localV = clamp((beta + 0.25 * PI) / (0.5 * PI), 0.0001, 0.9999);

  float col = mod(float(face), 3.0);
  float row = floor(float(face) / 3.0);

  float atlasU = (col + localU) / 3.0;
  float atlasV = (row + localV) / 2.0;

  return vec2(atlasU, atlasV);
}

// Exact Hypsometric Color Ramp matching colorRamps.ts
vec3 sampleElevationRamp(float elev) {
  if (elev <= -9000.0) return vec3(7.0/255.0, 24.0/255.0, 58.0/255.0);
  if (elev <= -5500.0) {
    float t = (elev + 9000.0) / 3500.0;
    return mix(vec3(7.0/255.0, 24.0/255.0, 58.0/255.0), vec3(13.0/255.0, 52.0/255.0, 104.0/255.0), t);
  }
  if (elev <= -2500.0) {
    float t = (elev + 5500.0) / 3000.0;
    return mix(vec3(13.0/255.0, 52.0/255.0, 104.0/255.0), vec3(24.0/255.0, 91.0/255.0, 145.0/255.0), t);
  }
  if (elev <= -200.0) {
    float t = (elev + 2500.0) / 2300.0;
    return mix(vec3(24.0/255.0, 91.0/255.0, 145.0/255.0), vec3(55.0/255.0, 132.0/255.0, 161.0/255.0), t);
  }
  if (elev <= 0.0) {
    float t = (elev + 200.0) / 200.0;
    return mix(vec3(55.0/255.0, 132.0/255.0, 161.0/255.0), vec3(184.0/255.0, 173.0/255.0, 122.0/255.0), t);
  }
  if (elev <= 250.0) {
    float t = elev / 250.0;
    return mix(vec3(112.0/255.0, 145.0/255.0, 79.0/255.0), vec3(137.0/255.0, 159.0/255.0, 82.0/255.0), t);
  }
  if (elev <= 650.0) {
    float t = (elev - 250.0) / 400.0;
    return mix(vec3(137.0/255.0, 159.0/255.0, 82.0/255.0), vec3(171.0/255.0, 157.0/255.0, 91.0/255.0), t);
  }
  if (elev <= 1400.0) {
    float t = (elev - 650.0) / 750.0;
    return mix(vec3(171.0/255.0, 157.0/255.0, 91.0/255.0), vec3(166.0/255.0, 133.0/255.0, 91.0/255.0), t);
  }
  if (elev <= 2400.0) {
    float t = (elev - 1400.0) / 1000.0;
    return mix(vec3(166.0/255.0, 133.0/255.0, 91.0/255.0), vec3(143.0/255.0, 111.0/255.0, 89.0/255.0), t);
  }
  if (elev <= 3800.0) {
    float t = (elev - 2400.0) / 1400.0;
    return mix(vec3(143.0/255.0, 111.0/255.0, 89.0/255.0), vec3(126.0/255.0, 116.0/255.0, 107.0/255.0), t);
  }
  if (elev <= 5500.0) {
    float t = (elev - 3800.0) / 1700.0;
    return mix(vec3(126.0/255.0, 116.0/255.0, 107.0/255.0), vec3(211.0/255.0, 213.0/255.0, 207.0/255.0), t);
  }
  if (elev <= 8500.0) {
    float t = (elev - 5500.0) / 3000.0;
    return mix(vec3(211.0/255.0, 213.0/255.0, 207.0/255.0), vec3(248.0/255.0, 249.0/255.0, 244.0/255.0), t);
  }
  return vec3(248.0/255.0, 249.0/255.0, 244.0/255.0);
}

vec3 sampleTempRamp(float temp) {
  float t = clamp((temp + 40.0) / 85.0, 0.0, 1.0);
  if (t < 0.25) {
    float f = t / 0.25;
    return mix(vec3(49.0/255.0, 54.0/255.0, 149.0/255.0), vec3(116.0/255.0, 173.0/255.0, 209.0/255.0), f);
  } else if (t < 0.5) {
    float f = (t - 0.25) / 0.25;
    return mix(vec3(116.0/255.0, 173.0/255.0, 209.0/255.0), vec3(254.0/255.0, 224.0/255.0, 144.0/255.0), f);
  } else if (t < 0.75) {
    float f = (t - 0.5) / 0.25;
    return mix(vec3(254.0/255.0, 224.0/255.0, 144.0/255.0), vec3(244.0/255.0, 109.0/255.0, 67.0/255.0), f);
  } else {
    float f = (t - 0.75) / 0.25;
    return mix(vec3(244.0/255.0, 109.0/255.0, 67.0/255.0), vec3(165.0/255.0, 0.0, 38.0/255.0), f);
  }
}

vec3 samplePrecipRamp(float precip) {
  float t = clamp(precip / 450.0, 0.0, 1.0);
  if (t < 0.33) {
    float f = t / 0.33;
    return mix(vec3(254.0/255.0, 240.0/255.0, 217.0/255.0), vec3(252.0/255.0, 141.0/255.0, 89.0/255.0), f);
  } else if (t < 0.66) {
    float f = (t - 0.33) / 0.33;
    return mix(vec3(252.0/255.0, 141.0/255.0, 89.0/255.0), vec3(102.0/255.0, 194.0/255.0, 164.0/255.0), f);
  } else {
    float f = (t - 0.66) / 0.34;
    return mix(vec3(102.0/255.0, 194.0/255.0, 164.0/255.0), vec3(8.0/255.0, 104.0/255.0, 172.0/255.0), f);
  }
}

void main() {
  float normX = mix(u_extentsX.x, u_extentsX.y, v_uv.x);
  float normY = mix(u_extentsY.x, u_extentsY.y, v_uv.y);

  float latRad = 0.0;
  float lonRad = 0.0;
  bool valid = false;

  if (u_projection == 0) {
    valid = inverseEqualEarth(vec2(normX, normY), latRad, lonRad);
  } else if (u_projection == 1) {
    valid = inverseMercator(vec2(normX, normY), latRad, lonRad);
  } else {
    valid = inverseEquirectangular(vec2(normX, normY), latRad, lonRad);
  }

  if (!valid) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }

  float cosLat = cos(latRad);
  vec3 p = vec3(cosLat * cos(lonRad), cosLat * sin(lonRad), sin(latRad));

  vec2 atlasUV = cubePointToAtlasUV(p);

  vec4 primaryTex = texture2D(u_dataTexture, atlasUV);
  vec4 climateTex = texture2D(u_climateTexture, atlasUV);
  vec4 extraTex   = texture2D(u_extraTexture, atlasUV);

  float elev = (primaryTex.r * 2.0 - 1.0) * 8000.0;

  vec3 baseColor = vec3(0.0);

  if (u_layer == 0) {
    // Elevation Topography
    baseColor = sampleElevationRamp(elev);
  } else if (u_layer == 1) {
    // Crust Type: 0 (Oceanic), 1 (Continental), 2 (Orogen)
    float cType = extraTex.r * 255.0;
    if (cType < 0.5) baseColor = vec3(30.0/255.0, 64.0/255.0, 115.0/255.0);
    else if (cType < 1.5) baseColor = vec3(195.0/255.0, 135.0/255.0, 75.0/255.0);
    else baseColor = vec3(220.0/255.0, 38.0/255.0, 38.0/255.0);
  } else if (u_layer == 2) {
    // Crust Age
    float age = extraTex.g * 250.0;
    float t = clamp(age / 220.0, 0.0, 1.0);
    baseColor = mix(vec3(239.0/255.0, 68.0/255.0, 68.0/255.0), vec3(59.0/255.0, 130.0/255.0, 246.0/255.0), t);
  } else if (u_layer == 3) {
    // Plate Boundaries
    float bType = floor(extraTex.b * 255.0 + 0.5);
    baseColor = sampleElevationRamp(elev) * 0.45;
    if (bType == 1.0) baseColor = vec3(239.0/255.0, 68.0/255.0, 68.0/255.0);
    else if (bType == 2.0) baseColor = vec3(249.0/255.0, 115.0/255.0, 22.0/255.0);
    else if (bType == 3.0) baseColor = vec3(16.0/255.0, 185.0/255.0, 129.0/255.0);
    else if (bType == 4.0) baseColor = vec3(132.0/255.0, 204.0/255.0, 22.0/255.0);
    else if (bType == 5.0) baseColor = vec3(6.0/255.0, 182.0/255.0, 212.0/255.0);
  } else if (u_layer == 4) {
    // Tectonic Uplift
    float uplift = (extraTex.a * 2.0 - 1.0) * 8.0;
    float t = clamp((uplift + 2.0) / 5.0, 0.0, 1.0);
    baseColor = mix(vec3(30.0/255.0, 64.0/255.0, 175.0/255.0), vec3(239.0/255.0, 68.0/255.0, 68.0/255.0), t);
  } else if (u_layer == 5) {
    // Discharge / Rivers
    float q = climateTex.b * 10000.0;
    if (elev <= u_seaLevel) {
      baseColor = vec3(10.0/255.0, 25.0/255.0, 55.0/255.0);
    } else {
      baseColor = sampleElevationRamp(elev) * 0.40;
      if (q >= 150.0) {
        float logQ = log(max(100.0, q)) / log(10.0);
        float t = clamp((logQ - 2.2) / 2.8, 0.0, 1.0);
        vec3 riverColor = mix(vec3(20.0/255.0, 160.0/255.0, 235.0/255.0), vec3(8.0/255.0, 215.0/255.0, 255.0/255.0), t);
        baseColor = mix(baseColor, riverColor, clamp(0.6 + t * 0.4, 0.0, 1.0));
      }
    }
  } else if (u_layer == 6) {
    // Lakes
    if (elev <= u_seaLevel) {
      baseColor = vec3(12.0/255.0, 30.0/255.0, 65.0/255.0);
    } else {
      baseColor = sampleElevationRamp(elev) * 0.45;
    }
  } else if (u_layer == 8) {
    // Monthly Temperature
    float temp = (climateTex.r * 2.0 - 1.0) * 50.0;
    baseColor = sampleTempRamp(temp);
  } else if (u_layer == 9) {
    // Monthly Precipitation
    float precip = climateTex.g * 500.0;
    baseColor = samplePrecipRamp(precip);
  } else if (u_layer == 10) {
    // Ice Thickness
    float ice = climateTex.a * 60.0;
    if (ice > 0.5) {
      float t = clamp(ice / 40.0, 0.0, 1.0);
      baseColor = mix(vec3(180.0/255.0, 220.0/255.0, 250.0/255.0), vec3(1.0, 1.0, 1.0), t);
    } else if (elev <= u_seaLevel) {
      baseColor = vec3(15.0/255.0, 40.0/255.0, 80.0/255.0);
    } else {
      baseColor = vec3(60.0/255.0, 70.0/255.0, 65.0/255.0);
    }
  } else if (u_layer == 11) {
    // Biomes
    baseColor = extraTex.rgb;
  } else if (u_layer == 12) {
    // Plate IDs (Distinct Palette)
    float pId = extraTex.r * 255.0;
    float hue = mod(pId * 0.61803398875, 1.0);
    vec3 col = clamp(abs(mod(hue * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    baseColor = col * 0.75 + 0.20;
  } else if (u_layer == 13) {
    // Relative Normal Velocity: Convergence (Red), Divergence (Green)
    float vn = (extraTex.a * 2.0 - 1.0) * 50.0;
    if (vn < -1.0) {
      float t = clamp(-vn / 50.0, 0.0, 1.0);
      baseColor = mix(vec3(0.2, 0.22, 0.28), vec3(0.95, 0.2, 0.2), t);
    } else if (vn > 1.0) {
      float t = clamp(vn / 50.0, 0.0, 1.0);
      baseColor = mix(vec3(0.2, 0.22, 0.28), vec3(0.1, 0.85, 0.4), t);
    } else {
      baseColor = vec3(0.2, 0.22, 0.28);
    }
  } else if (u_layer == 14) {
    // Ownership Closure Residual: Blue for gap, White for valid (0), Red for overlap
    float res = (extraTex.g - 0.5) * 2.0;
    if (res < -0.0001) {
      float t = clamp(-res / 0.5, 0.0, 1.0);
      baseColor = mix(vec3(1.0, 1.0, 1.0), vec3(0.1, 0.4, 1.0), t);
    } else if (res > 0.0001) {
      float t = clamp(res / 0.5, 0.0, 1.0);
      baseColor = mix(vec3(1.0, 1.0, 1.0), vec3(1.0, 0.15, 0.15), t);
    } else {
      baseColor = vec3(0.98, 0.98, 0.98);
    }
  } else if (u_layer == 15) {
    // Dominance Confidence: primaryTex.g contains max fraction in [0, 1]
    float conf = primaryTex.g;
    if (conf >= 0.98) {
      baseColor = vec3(34.0/255.0, 211.0/255.0, 238.0/255.0);
    } else {
      float t = clamp((conf - 0.5) / 0.5, 0.0, 1.0);
      baseColor = mix(vec3(0.12, 0.15, 0.25), vec3(34.0/255.0, 211.0/255.0, 238.0/255.0), t);
    }
  } else if (u_layer == 16) {
    // Aggregate continental volume expressed as equivalent thickness, 0..70 km.
    float t = clamp(primaryTex.b, 0.0, 1.0);
    baseColor = mix(vec3(18.0/255.0, 42.0/255.0, 88.0/255.0), vec3(240.0/255.0, 188.0/255.0, 34.0/255.0), sqrt(t));
  } else {
    baseColor = sampleElevationRamp(elev);
  }


  // Hillshading Pass
  if (u_showHillshade == 1 && elev > u_seaLevel) {
    float dAng = (0.5 * PI) / max(32.0, u_gridRes);
    float latClamp = clamp(latRad, -0.48 * PI, 0.48 * PI);
    float cosL = max(0.1, cos(latClamp));

    vec3 pE = vec3(cosL * cos(lonRad + dAng), cosL * sin(lonRad + dAng), sin(latClamp));
    vec3 pW = vec3(cosL * cos(lonRad - dAng), cosL * sin(lonRad - dAng), sin(latClamp));

    float latN = clamp(latRad + dAng, -0.48 * PI, 0.48 * PI);
    float latS = clamp(latRad - dAng, -0.48 * PI, 0.48 * PI);
    vec3 pN = vec3(cos(latN) * cos(lonRad), cos(latN) * sin(lonRad), sin(latN));
    vec3 pS = vec3(cos(latS) * cos(lonRad), cos(latS) * sin(lonRad), sin(latS));

    float eE = (texture2D(u_dataTexture, cubePointToAtlasUV(pE)).r * 2.0 - 1.0) * 8000.0;
    float eW = (texture2D(u_dataTexture, cubePointToAtlasUV(pW)).r * 2.0 - 1.0) * 8000.0;
    float eN = (texture2D(u_dataTexture, cubePointToAtlasUV(pN)).r * 2.0 - 1.0) * 8000.0;
    float eS = (texture2D(u_dataTexture, cubePointToAtlasUV(pS)).r * 2.0 - 1.0) * 8000.0;

    float dsLon = 6371000.0 * dAng * cosL;
    float dsLat = 6371000.0 * dAng;

    float dzdx = (eE - eW) / (2.0 * dsLon);
    float dzdy = (eN - eS) / (2.0 * dsLat);

    float nLen = sqrt(dzdx * dzdx + dzdy * dzdy + 1.0);
    vec3 normal = vec3(-dzdx / nLen, -dzdy / nLen, 1.0 / nLen);

    float dotL = max(0.0, dot(normal, u_sunDir));
    float shade = 0.30 + 0.70 * pow(dotL, 0.90);

    baseColor *= shade;
  }

  gl_FragColor = vec4(clamp(baseColor, 0.0, 1.0), 1.0);
}
`;
