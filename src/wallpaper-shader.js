// ==================================================
// LIVING WALLPAPER ENGINE (PC WebGL GLSL SHADER v2)
// High-visibility GPU animation of the actual .jpg theme wallpapers + subtle mouse parallax
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
    aurora: 5
  };

  function getThemeState() {
    const root = document.documentElement;
    const style = STYLE_MODES[root.dataset.style] !== undefined ? root.dataset.style : 'zen';
    const isLight = root.dataset.theme === 'light' ? 1 : 0;
    const url = `../assets/themes/${style}-${isLight ? 'light' : 'dark'}-bg.jpg`;
    return {
      key: `${style}:${isLight}`,
      style,
      mode: STYLE_MODES[style],
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
    uniform vec2 u_mouse;

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
      // Subtle 1.8% breathing overscan margin so parallax & wind motion never expose borders
      res = (res - 0.5) * 0.982 + 0.5 + u_mouse * 0.0055;
      return clamp(res, vec2(0.003), vec2(0.997));
    }

    vec3 sampleLiving(sampler2D tex, vec2 texRes, float mode, float isLight, vec2 screenUV) {
      vec2 u = coverUV(screenUV, u_res, texRes);
      float t = u_time;
      float spd = u_energy;

      // 0: Zen (bamboo wind gusts + travelling metallic gold sheen + drifting lantern/sun warmth)
      if (mode < 0.5) {
        float bambooMask = smoothstep(0.38, 0.06, u.x) * smoothstep(0.28, 0.72, u.y) * smoothstep(1.0, 0.38, u.y);
        float gust = sin(t * 1.15 * spd + u.y * 6.0) * 0.6 + sin(t * 2.05 * spd - u.x * 9.0) * 0.4;
        float sway = gust * 0.0085 * bambooMask;
        vec2 su = clamp(u + vec2(sway, sway * 0.25), vec2(0.003), vec2(0.997));
        vec3 col = texture2D(tex, su).rgb;

        if (isLight < 0.5) {
          float warmRatio = col.r - col.b;
          float goldMask = smoothstep(0.035, 0.13, warmRatio) * smoothstep(0.11, 0.32, col.r);
          float glint = pow(max(0.0, sin(u.x * 5.2 - u.y * 4.0 - t * 0.95 * spd)), 3.0);
          col += col * goldMask * glint * 0.85;
          float auraWave = 0.5 + 0.5 * sin(u.x * 3.0 + u.y * 2.2 - t * 0.45 * spd);
          col += vec3(0.025, 0.018, 0.009) * auraWave;
        } else {
          float dapple = 0.5 + 0.5 * sin(u.x * 4.6 - u.y * 3.4 + t * 0.62 * spd) * cos(u.y * 2.8 - t * 0.4);
          col *= (0.96 + 0.065 * dapple);
        }
        return col;
      }

      // 1: Lo-Fi (vivid amber café bulb flicker & halo + bokeh depth drift / sunlit blinds)
      if (mode < 1.5) {
        if (isLight < 0.5) {
          float upperMask = smoothstep(0.46, 0.14, u.y);
          vec2 drift = vec2(sin(t * 0.58 * spd + u.y * 4.5), cos(t * 0.46 + u.x * 3.5)) * 0.0038 * upperMask;
          vec3 col = texture2D(tex, clamp(u + drift, vec2(0.003), vec2(0.997))).rgb;
          float lum = dot(col, vec3(0.299, 0.587, 0.114));
          float lampMask = smoothstep(0.22, 0.68, lum) * smoothstep(0.03, 0.22, col.r - col.b) * smoothstep(0.62, 0.08, u.y);
          float flicker = 0.14 * sin(t * 2.2 * spd + u.x * 9.0) + 0.07 * cos(t * 3.9);
          col += col * lampMask * flicker;
          // Subtle warm table rim glow breathing
          float edgeWarm = smoothstep(0.58, 0.35, abs(u.y - 0.45)) * smoothstep(0.08, 0.3, col.r - col.b);
          col += vec3(0.04, 0.022, 0.005) * edgeWarm * (0.5 + 0.5 * sin(t * 1.3 * spd));
          return col;
        } else {
          vec3 col = texture2D(tex, u).rgb;
          float blinds = 0.5 + 0.5 * sin(u.x * 5.0 + u.y * 3.5 - t * 0.5 * spd);
          col += vec3(0.045, 0.032, 0.012) * blinds;
          return col;
        }
      }

      // 2: Synthwave (Dark: neon grid waves + skyline pulse + stars | Light: vaporwave palm sway + drifting clouds + grid pulse)
      if (mode < 2.5) {
        if (isLight < 0.5) {
          float hazeMask = smoothstep(0.32, 0.58, u.y) * smoothstep(0.99, 0.72, u.y);
          float haze = sin(u.y * 42.0 - t * 2.0 * spd) * 0.002 * hazeMask;
          vec3 col = texture2D(tex, clamp(u + vec2(haze, 0.0), vec2(0.003), vec2(0.997))).rgb;
          float mx = max(col.r, max(col.g, col.b));
          float mn = min(col.r, min(col.g, col.b));
          float sat = mx - mn;
          float gridMask = smoothstep(0.49, 0.60, u.y) * smoothstep(0.08, 0.32, sat) * smoothstep(0.12, 0.42, mx);
          float depthLog = log(max(0.015, u.y - 0.48));
          float pulse = pow(0.5 + 0.5 * sin(depthLog * 11.0 - t * 3.1 * spd), 2.5);
          col += col * gridMask * (0.30 + 1.05 * pulse);

          float cityMask = smoothstep(0.28, 0.42, u.y) * smoothstep(0.53, 0.43, u.y) * smoothstep(0.10, 0.35, sat);
          float cityBeat = 0.5 + 0.5 * sin(t * 1.8 * spd + u.x * 6.0);
          col += col * cityMask * (0.36 * cityBeat);

          float skyMask = smoothstep(0.45, 0.10, u.y) * smoothstep(0.20, 0.56, mx);
          float starTw = 0.65 + 0.65 * sin(t * 2.8 + u.x * 73.0 + u.y * 57.0);
          col *= mix(1.0, starTw, skyMask);
          return col;
        } else {
          // Vaporwave pastel: palm sides sway gently, clouds drift, lower grid shimmers
          float palmSides = (smoothstep(0.28, 0.04, u.x) + smoothstep(0.72, 0.96, u.x)) * smoothstep(0.84, 0.25, u.y);
          float sway = sin(t * 1.1 * spd + u.y * 6.0) * 0.0065 * clamp(palmSides, 0.0, 1.0);
          float skyDrift = smoothstep(0.82, 0.4, u.y) * (1.0 - clamp(palmSides, 0.0, 1.0)) * sin(t * 0.45 + u.y * 4.0) * 0.0025;
          vec3 col = texture2D(tex, clamp(u + vec2(sway + skyDrift, 0.0), vec2(0.003), vec2(0.997))).rgb;
          float gridFloor = smoothstep(0.83, 0.90, u.y);
          float scan = pow(0.5 + 0.5 * sin(u.y * 55.0 - t * 3.2 * spd), 3.0);
          col += vec3(0.06, 0.14, 0.16) * gridFloor * scan;
          return col;
        }
      }

      // 3: Ocean (vivid dual-octave fluid underwater refraction + sweeping caustics)
      if (mode < 3.5) {
        float surfaceBoost = 0.65 + 0.55 * smoothstep(0.65, 0.0, u.y);
        vec2 wave = vec2(
          sin(u.y * 12.0 + t * 1.5 * spd) * 0.6 + cos(u.x * 8.5 - t * 1.05 * spd) * 0.4,
          cos(u.x * 10.5 - t * 1.3 * spd) * 0.6 + sin(u.y * 8.0 + t * 1.6 * spd) * 0.4
        ) * 0.009 * surfaceBoost;
        vec3 col = texture2D(tex, clamp(u + wave, vec2(0.003), vec2(0.997))).rgb;
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        float thr = isLight < 0.5 ? 0.20 : 0.56;
        float causticMask = smoothstep(thr, thr + 0.30, lum);
        float shimmer = 0.5 + 0.5 * sin(u.x * 14.0 - u.y * 10.0 + t * 2.2 * spd) * cos(u.x * 7.0 + t * 1.3);
        col += col * causticMask * shimmer * (isLight < 0.5 ? 0.48 : 0.24);
        return col;
      }

      // 4: Forest (Dark: pine wind gusts + bright fireflies | Light: swaying fern border + radiant sunbeams)
      if (mode < 4.5) {
        if (isLight < 0.5) {
          float groundMask = smoothstep(0.76, 0.12, u.y);
          float gust = sin(t * 1.05 * spd + u.y * 5.0 + u.x * 3.0) * 0.6 + sin(t * 1.85 * spd - u.x * 8.0) * 0.4;
          float breeze = gust * 0.009 * groundMask;
          vec3 col = texture2D(tex, clamp(u + vec2(breeze, breeze * 0.22), vec2(0.003), vec2(0.997))).rgb;
          float greenGlow = smoothstep(0.04, 0.18, col.g - col.b) * smoothstep(0.26, 0.65, col.g);
          float pulse = 0.65 + 0.85 * sin(t * 2.5 * spd + u.x * 38.0 + u.y * 31.0);
          col += col * greenGlow * (pulse - 0.35) * 0.72;
          return col;
        } else {
          // Framed ferns around edges sway cleanly while central sunbeams breathe
          float borderEdge = smoothstep(0.22, 0.02, min(min(u.x, 1.0 - u.x), min(u.y, 1.0 - u.y)));
          float canopySw = smoothstep(0.65, 0.08, u.y) * 0.45 + borderEdge * 0.75;
          float sway = sin(t * 1.1 * spd + u.y * 5.5 + u.x * 4.0) * 0.0068 * canopySw;
          vec3 col = texture2D(tex, clamp(u + vec2(sway, sway * 0.2), vec2(0.003), vec2(0.997))).rgb;
          float sunShaft = exp(-pow((u.x - 0.48) * 3.8, 2.0)) * smoothstep(0.85, 0.05, u.y);
          float beamPulse = 0.5 + 0.5 * sin(t * 1.2 * spd - u.y * 4.0);
          col += vec3(0.08, 0.065, 0.025) * sunShaft * beamPulse;
          return col;
        }
      }

      // 5: Aurora (Dark: flowing Northern Lights waves + frozen water reflection + frosted edge sparkle | Light: frost glints & alpine light)
      if (isLight < 0.5) {
        float mountainClear = smoothstep(0.72, 0.28, u.y);
        float frameClear = smoothstep(0.02, 0.16, u.x) * smoothstep(0.98, 0.84, u.x) * smoothstep(0.02, 0.16, u.y);
        float skyMask = mountainClear * frameClear;
        vec2 curWave = vec2(
          sin(u.y * 10.5 - t * 1.15 * spd + u.x * 3.0) * 0.014,
          cos(u.x * 7.5 + t * 0.9 * spd) * 0.006
        ) * skyMask;

        float waterMask = smoothstep(0.74, 0.88, u.y) * smoothstep(0.16, 0.52, u.x) * smoothstep(0.84, 0.48, u.x);
        curWave.x += sin(u.y * 42.0 + t * 1.7 * spd) * 0.005 * waterMask;

        vec3 col = texture2D(tex, clamp(u + curWave, vec2(0.003), vec2(0.997))).rgb;
        float auroraMask = skyMask * smoothstep(0.12, 0.50, col.g + col.b - col.r * 0.35);
        float flow = 0.80 + 0.40 * sin(u.x * 8.5 - t * 1.35 * spd + u.y * 5.0);
        col *= mix(1.0, flow, auroraMask);

        float frostMask = (1.0 - frameClear) * smoothstep(0.40, 0.78, col.b);
        float sparkle = pow(0.5 + 0.5 * sin(u.x * 65.0 + u.y * 51.0 + t * 2.4), 7.0);
        col += vec3(0.32, 0.44, 0.56) * frostMask * sparkle * 0.6;
        return col;
      } else {
        vec3 col = texture2D(tex, u).rgb;
        float frameMask = 1.0 - smoothstep(0.04, 0.20, u.x) * smoothstep(0.96, 0.80, u.x) * smoothstep(0.04, 0.22, u.y) * smoothstep(0.96, 0.78, u.y);
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        float sparkle = pow(0.5 + 0.5 * sin(u.x * 58.0 - u.y * 44.0 + t * 2.2 * spd), 8.0);
        col += vec3(0.16, 0.20, 0.26) * frameMask * smoothstep(0.55, 0.92, lum) * sparkle;
        float mist = 0.5 + 0.5 * sin(u.x * 3.0 + t * 0.5 * spd);
        col += vec3(0.025, 0.032, 0.045) * (1.0 - frameMask) * mist;
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

  let targetMouseX = 0;
  let targetMouseY = 0;
  let smoothMouseX = 0;
  let smoothMouseY = 0;

  window.addEventListener('mousemove', (e) => {
    targetMouseX = (e.clientX / Math.max(1, window.innerWidth) - 0.5) * 2.0;
    targetMouseY = (e.clientY / Math.max(1, window.innerHeight) - 0.5) * 2.0;
  }, { passive: true });
  window.addEventListener('mouseleave', () => {
    targetMouseX = 0;
    targetMouseY = 0;
  }, { passive: true });

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
      u_energy: gl.getUniformLocation(program, 'u_energy'),
      u_mouse: gl.getUniformLocation(program, 'u_mouse')
    };

    placeholderTex = makeSolidTexture();
    texCache.clear();
    return true;
  }

  function loadTextureFor(state, onReady) {
    if (texCache.has(state.key)) {
      const entry = texCache.get(state.key);
      if (entry.ready && onReady) onReady(entry);
      return entry;
    }

    const entry = {
      key: state.key,
      tex: placeholderTex,
      w: 16,
      h: 9,
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
        entry.w = img.naturalWidth || 1920;
        entry.h = img.naturalHeight || 1080;
        entry.ready = true;
        if (onReady) onReady(entry);
      } catch (err) {
        console.warn('WebGL wallpaper upload skipped:', err);
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
    const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
    const w = Math.max(1, Math.floor(window.innerWidth * dpr));
    const h = Math.max(1, Math.floor(window.innerHeight * dpr));
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
      if (!document.hidden && rafId === null) {
        lastFrameTime = 0;
        rafId = requestAnimationFrame(render);
      }
    }
  });

  const TARGET_FRAME_MS = 22;
  let rafId = null;
  let lastFrameTime = 0;
  let simTime = 0;
  let smoothEnergy = 1.0;

  function render(now) {
    if (document.hidden) {
      rafId = null;
      return;
    }
    rafId = requestAnimationFrame(render);
    if (now - lastFrameTime < TARGET_FRAME_MS) return;
    const elapsed = lastFrameTime ? Math.min(48, now - lastFrameTime) : TARGET_FRAME_MS;
    lastFrameTime = now;

    if (!currEntry || !currEntry.ready) return;
    if (document.body.classList.contains('mini-mode')) return;

    const dtSec = elapsed / 1000;
    const targetEnergy = document.body.classList.contains('is-playing') ? 1.32 : 1.0;
    smoothEnergy += (targetEnergy - smoothEnergy) * Math.min(1, dtSec * 3.0);
    smoothMouseX += (targetMouseX - smoothMouseX) * Math.min(1, dtSec * 4.5);
    smoothMouseY += (targetMouseY - smoothMouseY) * Math.min(1, dtSec * 4.5);
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
    gl.uniform2f(loc.u_mouse, smoothMouseX, smoothMouseY);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && rafId === null) {
      lastFrameTime = 0;
      rafId = requestAnimationFrame(render);
    }
  });

  rafId = requestAnimationFrame(render);
})();
