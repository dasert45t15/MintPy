// ==================================================
// LIVING WALLPAPER ENGINE (MOBILE WebGL GLSL SHADER v2)
// Vivid GPU animation for all 9 mobile themes (~30 FPS)
// ==================================================
(function() {
  const canvas = document.getElementById('bg-shader-canvas');
  if (!canvas) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'low-power'
  });
  if (!gl) return;

  const STYLE_MODES = {
    zen: 0,
    lofi: 1,
    synthwave: 2,
    ocean: 3,
    forest: 4,
    aurora: 5,
    sakura: 6,
    midnight: 7,
    cyber: 8
  };

  function getThemeState() {
    const root = document.documentElement;
    const style = STYLE_MODES[root.dataset.style] !== undefined ? root.dataset.style : 'zen';
    const mode = STYLE_MODES[style];
    const isLight = root.dataset.theme === 'light' ? 1 : 0;
    const url = mode <= 5 ? `../assets/themes/mobile/${style}-${isLight ? 'light' : 'dark'}-mobile.jpg` : null;
    return {
      key: `${style}:${isLight}`,
      style,
      mode,
      isLight,
      url
    };
  }

  const VS_SRC = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  const FS_SRC = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif

    varying vec2 v_uv;
    uniform sampler2D u_texPrev;
    uniform sampler2D u_texCurr;
    uniform vec2 u_res;
    uniform vec2 u_prevRes;
    uniform vec2 u_currRes;
    uniform float u_prevMode;
    uniform float u_currMode;
    uniform float u_prevLight;
    uniform float u_currLight;
    uniform float u_fade;
    uniform float u_time;
    uniform float u_energy;

    vec2 coverUV(vec2 uv, vec2 canvasRes, vec2 texRes) {
      float ca = max(0.001, canvasRes.x / max(1.0, canvasRes.y));
      float ta = max(0.001, texRes.x / max(1.0, texRes.y));
      vec2 res = uv;
      if (ca > ta) {
        float s = ta / ca;
        res.y = (uv.y - 0.5) * s + 0.5;
      } else {
        float s = ca / ta;
        res.x = (uv.x - 0.5) * s + 0.5;
      }
      // Subtle 1.6% overscan margin + slow ambient drift so borders never expose
      res = (res - 0.5) * 0.984 + 0.5;
      return clamp(res, vec2(0.003), vec2(0.997));
    }

    vec3 proceduralStyle(float mode, float isLight, vec2 u, float t, float spd) {
      vec2 centerShift = vec2(sin(t * 0.34 * spd), cos(t * 0.28 * spd)) * 0.09;

      // 6: Sakura Night (flowing nebula silk + twinkling night stars)
      if (mode < 6.5) {
        vec2 p1 = vec2(0.22, 0.20) + centerShift;
        vec2 p2 = vec2(0.82, 0.30) - centerShift * 0.8;
        vec2 p3 = vec2(0.50, 0.86) + vec2(centerShift.y, -centerShift.x * 0.6);
        float d1 = exp(-dot(u - p1, u - p1) * 4.6);
        float d2 = exp(-dot(u - p2, u - p2) * 4.2);
        float d3 = exp(-dot(u - p3, u - p3) * 3.8);
        float silk = 0.5 + 0.5 * sin(u.x * 6.0 + u.y * 4.5 - t * 0.95 * spd);
        if (isLight < 0.5) {
          vec3 base = mix(vec3(0.075, 0.04, 0.11), vec3(0.14, 0.065, 0.17), u.y);
          base += vec3(0.92, 0.38, 0.62) * d1 * (0.34 + 0.12 * silk);
          base += vec3(0.60, 0.28, 0.88) * d2 * 0.30;
          base += vec3(0.90, 0.24, 0.40) * d3 * 0.24;
          return base;
        } else {
          vec3 base = mix(vec3(1.0, 0.95, 0.97), vec3(0.97, 0.85, 0.91), u.y);
          base -= vec3(0.01, 0.14, 0.07) * d1 * (0.45 + 0.14 * silk);
          base -= vec3(0.02, 0.16, 0.09) * d2 * 0.34;
          return base;
        }
      }

      // 7: Midnight Gold (cosmic gold-indigo pulse + soft aurora halo)
      if (mode < 7.5) {
        vec2 p1 = vec2(0.76, 0.18) + centerShift * 0.8;
        vec2 p2 = vec2(0.20, 0.72) - centerShift * 0.9;
        float d1 = exp(-dot(u - p1, u - p1) * 5.0);
        float d2 = exp(-dot(u - p2, u - p2) * 3.8);
        float breathe = 0.72 + 0.28 * sin(t * 1.15 * spd);
        if (isLight < 0.5) {
          vec3 base = mix(vec3(0.038, 0.062, 0.125), vec3(0.09, 0.068, 0.12), u.y);
          base += vec3(0.95, 0.76, 0.42) * d1 * 0.36 * breathe;
          base += vec3(0.24, 0.52, 0.96) * d2 * (0.24 + 0.06 * sin(t * 0.8 + u.y * 4.0));
          return base;
        } else {
          vec3 base = mix(vec3(0.985, 0.972, 0.945), vec3(0.91, 0.88, 0.81), u.y);
          base += vec3(0.075, 0.04, -0.045) * d1 * 0.6 * breathe;
          base -= vec3(0.05, 0.035, 0.01) * d2 * 0.32;
          return base;
        }
      }

      // 8: Cyberpunk (neon cyber-fog + travelling scan pulse)
      vec2 p1 = vec2(0.18, 0.24) + centerShift;
      vec2 p2 = vec2(0.84, 0.70) - centerShift;
      float d1 = exp(-dot(u - p1, u - p1) * 4.4);
      float d2 = exp(-dot(u - p2, u - p2) * 4.2);
      float sweep = pow(0.5 + 0.5 * sin(u.y * 6.5 - t * 1.55 * spd + u.x * 2.5), 2.0);
      if (isLight < 0.5) {
        vec3 base = mix(vec3(0.025, 0.042, 0.085), vec3(0.11, 0.058, 0.19), u.y);
        base += vec3(0.0, 0.92, 0.80) * d1 * (0.34 + 0.14 * sweep);
        base += vec3(0.98, 0.18, 0.60) * d2 * (0.30 + 0.14 * (1.0 - sweep));
        base += vec3(0.0, 0.12, 0.14) * pow(sweep, 4.0) * 0.5;
        return base;
      } else {
        vec3 base = mix(vec3(0.94, 0.98, 0.99), vec3(0.91, 0.89, 0.97), u.y);
        base -= vec3(0.14, 0.01, 0.03) * d1 * 0.42;
        base -= vec3(0.01, 0.16, 0.03) * d2 * (0.28 + 0.1 * sweep);
        return base;
      }
    }

    vec3 sampleLiving(sampler2D tex, vec2 texRes, float mode, float isLight, vec2 screenUV) {
      float t = u_time;
      float spd = u_energy;

      if (mode > 5.5) {
        return proceduralStyle(mode, isLight, screenUV, t, spd);
      }

      vec2 u = coverUV(screenUV, u_res, texRes);

      // 0: Zen mobile (bamboo wind gusts + bright kintsugi gold sheen / sunlight paper wave)
      if (mode < 0.5) {
        float topLeft = smoothstep(0.58, 0.08, u.x) * smoothstep(0.48, 0.06, u.y);
        float botRight = smoothstep(0.40, 0.88, u.x) * smoothstep(0.50, 0.92, u.y);
        float swayMask = max(topLeft, botRight);
        float gust = sin(t * 1.1 * spd + u.y * 5.2) * 0.65 + cos(t * 0.72 + u.x * 7.0) * 0.35;
        float sway = gust * 0.0082 * swayMask;
        vec3 col = texture2D(tex, clamp(u + vec2(sway, sway * 0.25), vec2(0.003), vec2(0.997))).rgb;
        if (isLight < 0.5) {
          float goldMask = smoothstep(0.05, 0.16, col.r - col.b) * smoothstep(0.16, 0.40, col.r);
          float glint = pow(max(0.0, sin(u.x * 5.0 - u.y * 5.5 - t * 0.95 * spd)), 3.0);
          col += col * goldMask * glint * 0.85;
        } else {
          float dapple = 0.5 + 0.5 * sin(u.x * 4.0 - u.y * 3.6 + t * 0.65 * spd);
          col *= (0.96 + 0.06 * dapple);
        }
        return col;
      }

      // 1: Lo-Fi mobile (vivid glass window raindrops + warm Edison bulbs/table lamp/candle flicker)
      if (mode < 1.5) {
        float winMask = smoothstep(0.05, 0.10, u.x) * smoothstep(0.36, 0.30, u.x)
                      * smoothstep(0.01, 0.05, u.y) * smoothstep(0.84, 0.78, u.y);
        float colCell = pow(max(0.0, sin(u.x * 115.0 + sin(u.y * 14.0) * 0.6)), 4.5);
        float dropFlow = pow(max(0.0, sin(u.y * 18.0 - t * 2.5 * spd + u.x * 67.0)), 3.0);
        float trickle = winMask * colCell * dropFlow;
        vec2 dropOffset = vec2(trickle * 0.0035, trickle * 0.009);

        vec3 col = texture2D(tex, clamp(u + dropOffset, vec2(0.003), vec2(0.997))).rgb;
        col += vec3(0.09, 0.13, 0.18) * trickle * (isLight < 0.5 ? 1.15 : 0.6);

        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        float lampMask = smoothstep(0.34, 0.75, lum) * smoothstep(0.06, 0.25, col.r - col.b);
        float flicker = 0.13 * sin(t * 2.3 * spd + u.x * 8.0) + 0.06 * cos(t * 4.1);
        col += col * lampMask * flicker;
        return col;
      }

      // 2: Synthwave mobile (Dark: racing neon grid waves + palm sway | Light: pastel palms sway + vaporwave sun/clouds)
      if (mode < 2.5) {
        float palmMask = (smoothstep(0.36, 0.10, u.x) + smoothstep(0.64, 0.90, u.x))
                       * smoothstep(0.62, 0.14, u.y);
        float palmSway = sin(t * 1.15 * spd + u.y * 6.0) * 0.0075 * clamp(palmMask, 0.0, 1.0);
        vec3 col = texture2D(tex, clamp(u + vec2(palmSway, 0.0), vec2(0.003), vec2(0.997))).rgb;

        if (isLight < 0.5) {
          float mx = max(col.r, max(col.g, col.b));
          float mn = min(col.r, min(col.g, col.b));
          float sat = mx - mn;
          float gridMask = smoothstep(0.54, 0.64, u.y) * smoothstep(0.08, 0.32, sat) * smoothstep(0.14, 0.44, mx);
          float depthLog = log(max(0.015, u.y - 0.53));
          float pulse = pow(0.5 + 0.5 * sin(depthLog * 11.0 - t * 3.0 * spd), 2.5);
          col += col * gridMask * (0.28 + 1.0 * pulse);

          float palmGlow = smoothstep(0.12, 0.42, sat) * smoothstep(0.60, 0.12, u.y);
          col += col * palmGlow * (0.28 * (0.5 + 0.5 * sin(t * 1.6 * spd + u.y * 4.5)));
          return col;
        } else {
          float gridFloor = smoothstep(0.82, 0.90, u.y);
          float pulse = pow(0.5 + 0.5 * sin(u.y * 48.0 - t * 3.0 * spd), 2.5);
          col += vec3(0.07, 0.11, 0.14) * gridFloor * pulse;
          float sunZone = exp(-dot(u - vec2(0.5, 0.68), u - vec2(0.5, 0.68)) * 18.0);
          col += vec3(0.07, 0.04, 0.05) * sunZone * (0.5 + 0.5 * sin(t * 1.3 * spd));
          return col;
        }
      }

      // 3: Ocean mobile (vivid fluid liquid swell + shimmering cyan bioluminescence & rays)
      if (mode < 3.5) {
        float rayMask = 0.65 + 0.45 * smoothstep(0.75, 0.0, u.y);
        vec2 wave = vec2(
          sin(u.y * 12.0 + t * 1.45 * spd) * 0.6 + cos(u.x * 8.5 - t * 1.05 * spd) * 0.4,
          cos(u.x * 10.5 - t * 1.25 * spd) * 0.6 + sin(u.y * 8.0 + t * 1.5 * spd) * 0.4
        ) * 0.0088 * rayMask;
        vec3 col = texture2D(tex, clamp(u + wave, vec2(0.003), vec2(0.997))).rgb;
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        float thr = isLight < 0.5 ? 0.18 : 0.56;
        float causticMask = smoothstep(thr, thr + 0.30, lum);
        float shimmer = 0.5 + 0.5 * sin(u.x * 14.0 - u.y * 10.0 + t * 2.1 * spd);
        col += col * causticMask * shimmer * (isLight < 0.5 ? 0.46 : 0.24);
        return col;
      }

      // 4: Forest mobile (pine wind sway + pulsing fireflies dark / sunlit forest glow light)
      if (mode < 4.5) {
        float groundMask = smoothstep(0.74, 0.14, u.y);
        float gust = sin(t * 1.05 * spd + u.y * 5.2 + u.x * 3.0) * 0.65 + sin(t * 1.75 - u.x * 7.0) * 0.35;
        float breeze = gust * 0.0085 * groundMask;
        vec3 col = texture2D(tex, clamp(u + vec2(breeze, breeze * 0.2), vec2(0.003), vec2(0.997))).rgb;
        if (isLight < 0.5) {
          float warmDot = smoothstep(0.03, 0.18, (col.r + col.g) * 0.5 - col.b) * smoothstep(0.28, 0.68, col.g);
          float pulse = 0.65 + 0.85 * sin(t * 2.5 * spd + u.x * 38.0 + u.y * 31.0);
          col += col * warmDot * (pulse - 0.35) * 0.72;
        } else {
          float sunShaft = exp(-pow((u.x - 0.58) * 3.2, 2.0)) * smoothstep(0.75, 0.05, u.y);
          float beam = 0.5 + 0.5 * sin(t * 1.15 * spd - u.y * 3.8);
          col += vec3(0.075, 0.06, 0.025) * sunShaft * beam;
        }
        return col;
      }

      // 5: Aurora mobile (Dark: undulating Northern Lights curtains | Light: frosted crystal shimmer + alpine sun)
      if (isLight < 0.5) {
        float skyMask = smoothstep(0.76, 0.32, u.y);
        vec2 curWave = vec2(
          sin(u.y * 10.5 - t * 1.1 * spd + u.x * 3.5) * 0.013,
          cos(u.x * 7.5 + t * 0.85 * spd) * 0.0055
        ) * skyMask;
        vec3 col = texture2D(tex, clamp(u + curWave, vec2(0.003), vec2(0.997))).rgb;
        float auroraMask = skyMask * smoothstep(0.12, 0.50, col.g + col.b - col.r * 0.35);
        float flow = 0.80 + 0.38 * sin(u.x * 8.5 - t * 1.3 * spd + u.y * 5.2);
        col *= mix(1.0, flow, auroraMask);
        return col;
      } else {
        float skyClear = smoothstep(0.68, 0.22, u.y) * smoothstep(0.12, 0.28, u.x) * smoothstep(0.88, 0.72, u.x);
        vec2 drift = vec2(sin(u.y * 8.0 - t * 0.85 * spd) * 0.006, 0.0) * skyClear;
        vec3 col = texture2D(tex, clamp(u + drift, vec2(0.003), vec2(0.997))).rgb;
        float frameMask = 1.0 - smoothstep(0.04, 0.22, u.x) * smoothstep(0.96, 0.78, u.x) * smoothstep(0.04, 0.24, u.y) * smoothstep(0.96, 0.76, u.y);
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        float sparkle = pow(0.5 + 0.5 * sin(u.x * 58.0 - u.y * 44.0 + t * 2.2 * spd), 7.0);
        col += vec3(0.16, 0.22, 0.28) * frameMask * smoothstep(0.55, 0.92, lum) * sparkle;
        return col;
      }
    }

    void main() {
      vec3 cCurr = sampleLiving(u_texCurr, u_currRes, u_currMode, u_currLight, v_uv);
      if (u_fade < 0.999) {
        vec3 cPrev = sampleLiving(u_texPrev, u_prevRes, u_prevMode, u_prevLight, v_uv);
        gl_FragColor = vec4(mix(cPrev, cCurr, u_fade), 1.0);
      } else {
        gl_FragColor = vec4(cCurr, 1.0);
      }
    }
  `;

  function compileShader(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  let program = null;
  let posBuf = null;
  let loc = {};
  let placeholderTex = null;
  const texCache = new Map();

  let currState = getThemeState();
  let prevEntry = null;
  let currEntry = null;
  let fadeProgress = 1.0;
  let fadeStartMs = 0;
  const FADE_MS = 450;

  function makeSolidTexture() {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([18, 20, 19, 255]));
    return tex;
  }

  function initGL() {
    const vs = compileShader(gl.VERTEX_SHADER, VS_SRC);
    const fs = compileShader(gl.FRAGMENT_SHADER, FS_SRC);
    if (!vs || !fs) return false;
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;

    posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1
    ]), gl.STATIC_DRAW);

    loc = {
      a_pos: gl.getAttribLocation(program, 'a_pos'),
      u_texPrev: gl.getUniformLocation(program, 'u_texPrev'),
      u_texCurr: gl.getUniformLocation(program, 'u_texCurr'),
      u_res: gl.getUniformLocation(program, 'u_res'),
      u_prevRes: gl.getUniformLocation(program, 'u_prevRes'),
      u_currRes: gl.getUniformLocation(program, 'u_currRes'),
      u_prevMode: gl.getUniformLocation(program, 'u_prevMode'),
      u_currMode: gl.getUniformLocation(program, 'u_currMode'),
      u_prevLight: gl.getUniformLocation(program, 'u_prevLight'),
      u_currLight: gl.getUniformLocation(program, 'u_currLight'),
      u_fade: gl.getUniformLocation(program, 'u_fade'),
      u_time: gl.getUniformLocation(program, 'u_time'),
      u_energy: gl.getUniformLocation(program, 'u_energy')
    };

    placeholderTex = makeSolidTexture();
    texCache.clear();
    return true;
  }

  function loadTextureFor(state, onReady) {
    if (!state.url) {
      const entry = {
        key: state.key,
        tex: placeholderTex,
        w: 9,
        h: 16,
        mode: state.mode,
        isLight: state.isLight,
        ready: true
      };
      if (onReady) onReady(entry);
      return entry;
    }

    if (texCache.has(state.key)) {
      const entry = texCache.get(state.key);
      if (entry.ready && onReady) onReady(entry);
      return entry;
    }

    const entry = {
      key: state.key,
      tex: placeholderTex,
      w: 9,
      h: 16,
      mode: state.mode,
      isLight: state.isLight,
      ready: false
    };
    texCache.set(state.key, entry);

    const img = new Image();
    img.onload = () => {
      try {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        entry.tex = tex;
        entry.w = img.naturalWidth || 1080;
        entry.h = img.naturalHeight || 1920;
        entry.ready = true;
        if (onReady) onReady(entry);
      } catch (err) {
        console.warn('Mobile WebGL wallpaper skipped:', err);
      }
    };
    img.src = state.url;
    return entry;
  }

  function syncState(forceInitial = false) {
    const next = getThemeState();
    if (!forceInitial && next.key === currState.key && currEntry) return;
    const oldEntry = currEntry && currEntry.ready ? currEntry : null;
    currState = next;
    loadTextureFor(next, (loaded) => {
      if (next.key !== currState.key) return;
      if (oldEntry && oldEntry !== loaded) {
        prevEntry = oldEntry;
        fadeProgress = 0.0;
        fadeStartMs = performance.now();
      } else {
        prevEntry = loaded;
        fadeProgress = 1.0;
      }
      currEntry = loaded;
      canvas.classList.add('ready');
    });
  }

  function resize() {
    const w = Math.max(1, Math.floor(window.innerWidth));
    const h = Math.max(1, Math.floor(window.innerHeight));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  if (!initGL()) return;
  resize();
  syncState(true);

  window.addEventListener('resize', resize);

  const observer = new MutationObserver(() => syncState(false));
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-style', 'data-theme']
  });

  const dynArtEl = document.getElementById('dynamicArtBg');
  let dynBgActive = !!(dynArtEl && dynArtEl.classList.contains('active'));
  if (dynArtEl) {
    new MutationObserver(() => {
      dynBgActive = dynArtEl.classList.contains('active');
      if (!dynBgActive && !document.hidden && rafId === null) {
        lastFrameTime = 0;
        rafId = requestAnimationFrame(render);
      }
    }).observe(dynArtEl, { attributes: true, attributeFilter: ['class'] });
  }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    cancelAnimationFrame(rafId);
    rafId = null;
  });

  canvas.addEventListener('webglcontextrestored', () => {
    if (initGL()) {
      currEntry = null;
      prevEntry = null;
      syncState(true);
      if (!document.hidden && !dynBgActive && rafId === null) {
        lastFrameTime = 0;
        rafId = requestAnimationFrame(render);
      }
    }
  });

  const TARGET_FRAME_MS = 33;
  let rafId = null;
  let lastFrameTime = 0;
  let simTime = 0;
  let smoothEnergy = 1.0;

  function render(now) {
    if (document.hidden || dynBgActive) {
      rafId = null;
      return;
    }
    rafId = requestAnimationFrame(render);
    if (now - lastFrameTime < TARGET_FRAME_MS) return;
    const elapsed = lastFrameTime ? Math.min(64, now - lastFrameTime) : TARGET_FRAME_MS;
    lastFrameTime = now;

    if (!currEntry || !currEntry.ready) return;

    const dtSec = elapsed / 1000;
    const targetEnergy = window.isPlaying ? 1.32 : 1.0;
    smoothEnergy += (targetEnergy - smoothEnergy) * Math.min(1, dtSec * 3.0);
    simTime += dtSec;

    if (fadeProgress < 1.0) {
      fadeProgress = Math.min(1.0, (now - fadeStartMs) / FADE_MS);
    }

    const pEntry = prevEntry && prevEntry.ready ? prevEntry : currEntry;

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.enableVertexAttribArray(loc.a_pos);
    gl.vertexAttribPointer(loc.a_pos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, pEntry.tex);
    gl.uniform1i(loc.u_texPrev, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, currEntry.tex);
    gl.uniform1i(loc.u_texCurr, 1);

    gl.uniform2f(loc.u_res, canvas.width, canvas.height);
    gl.uniform2f(loc.u_prevRes, pEntry.w, pEntry.h);
    gl.uniform2f(loc.u_currRes, currEntry.w, currEntry.h);
    gl.uniform1f(loc.u_prevMode, pEntry.mode);
    gl.uniform1f(loc.u_currMode, currEntry.mode);
    gl.uniform1f(loc.u_prevLight, pEntry.isLight);
    gl.uniform1f(loc.u_currLight, currEntry.isLight);
    gl.uniform1f(loc.u_fade, fadeProgress);
    gl.uniform1f(loc.u_time, simTime);
    gl.uniform1f(loc.u_energy, smoothEnergy);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !dynBgActive && rafId === null) {
      lastFrameTime = 0;
      rafId = requestAnimationFrame(render);
    }
  });

  rafId = requestAnimationFrame(render);
})();
