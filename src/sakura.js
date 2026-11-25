// ==================================================
// THEMATIC AMBIENT PARTICLES (Optimized Sprite-Cached Canvas Engine)
// ==================================================
(function() {
  const canvas = document.getElementById('sakura-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });

  let width = canvas.width = window.innerWidth;
  let height = canvas.height = window.innerHeight;

  window.addEventListener('resize', () => {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  });

  const PARTICLE_COUNT = 34;
  const TARGET_FRAME_MS = 22; // ~45 FPS smooth & low GPU overhead over blurred glass UI
  const particles = [];
  const spriteCache = new Map();

  function getGlowSprite(color, hasCore, scaleFactor) {
    const key = `glow:${color}:${hasCore ? 1 : 0}:${scaleFactor}`;
    if (spriteCache.has(key)) return spriteCache.get(key);
    const size = Math.ceil(36 * scaleFactor);
    const half = size / 2;
    const off = document.createElement('canvas');
    off.width = size;
    off.height = size;
    const octx = off.getContext('2d');
    const grad = octx.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, color);
    grad.addColorStop(0.45, color);
    grad.addColorStop(1, 'transparent');
    octx.fillStyle = grad;
    octx.beginPath();
    octx.arc(half, half, half, 0, Math.PI * 2);
    octx.fill();
    if (hasCore) {
      octx.fillStyle = '#fff9ef';
      octx.beginPath();
      octx.arc(half, half, half * 0.28, 0, Math.PI * 2);
      octx.fill();
    }
    spriteCache.set(key, off);
    return off;
  }

  function getBubbleSprite() {
    const key = 'ocean:bubble';
    if (spriteCache.has(key)) return spriteCache.get(key);
    const off = document.createElement('canvas');
    off.width = 32;
    off.height = 32;
    const octx = off.getContext('2d');
    octx.beginPath();
    octx.arc(16, 16, 13, 0, Math.PI * 2);
    octx.fillStyle = 'rgba(0, 220, 255, 0.14)';
    octx.fill();
    octx.strokeStyle = 'rgba(0, 240, 255, 0.65)';
    octx.lineWidth = 1.5;
    octx.stroke();
    octx.beginPath();
    octx.arc(11.5, 11.5, 3.6, 0, Math.PI * 2);
    octx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    octx.fill();
    spriteCache.set(key, off);
    return off;
  }

  class AmbientParticle {
    constructor() {
      this.reset(true);
    }

    getStyle() {
      return document.documentElement.dataset.style || 'zen';
    }

    reset(initial = false) {
      this.style = this.getStyle();
      this.time = Math.random() * 100;
      this.sprite = null;

      if (this.style === 'ocean') {
        this.x = Math.random() * width;
        this.y = initial ? Math.random() * height : height + 15 + Math.random() * 20;
        this.radius = Math.random() * 6 + 2.5;
        this.speedY = -(Math.random() * 0.9 + 0.5);
        this.wobbleSpeed = Math.random() * 0.04 + 0.02;
        this.wobbleAmp = Math.random() * 1.2 + 0.4;
        this.opacity = Math.random() * 0.35 + 0.35;
        this.sprite = getBubbleSprite();
      } else if (this.style === 'lofi') {
        this.x = Math.random() * width;
        this.y = initial ? Math.random() * height : height + 10;
        this.radius = Math.random() * 3.2 + 1.6;
        this.speedY = -(Math.random() * 0.4 + 0.15);
        this.speedX = (Math.random() - 0.5) * 0.5;
        this.wobbleSpeed = Math.random() * 0.03 + 0.01;
        this.wobbleAmp = Math.random() * 1.5 + 0.5;
        this.baseOpacity = Math.random() * 0.35 + 0.25;
        this.opacity = this.baseOpacity;
        const colors = ['#e0a96d', '#d4a373', '#f4a261', '#eeddc9', '#dfcca9'];
        this.color = colors[Math.floor(Math.random() * colors.length)];
        this.sprite = getGlowSprite(this.color, true, 1);
      } else if (this.style === 'synthwave') {
        this.x = Math.random() * width;
        this.y = initial ? Math.random() * height : -15;
        this.size = Math.random() * 5 + 3;
        this.speedY = Math.random() * 0.8 + 0.4;
        this.speedX = (Math.random() - 0.5) * 0.4;
        this.angle = Math.random() * 360;
        this.spin = (Math.random() - 0.5) * 2;
        this.opacity = Math.random() * 0.5 + 0.3;
        const colors = ['#ff2d95', '#2de2e6', '#ffe600', '#b14aed'];
        this.color = colors[Math.floor(Math.random() * colors.length)];
      } else if (this.style === 'aurora') {
        this.x = Math.random() * width;
        this.y = initial ? Math.random() * height : height + 10;
        this.radius = Math.random() * 4 + 2;
        this.speedY = -(Math.random() * 0.3 + 0.15);
        this.speedX = (Math.random() - 0.5) * 0.4;
        this.wobbleSpeed = 0.02;
        this.opacity = Math.random() * 0.4 + 0.25;
        const colors = ['#7ee8fa', '#a5a6f6', '#c8b6ff', '#80ffdb'];
        this.color = colors[Math.floor(Math.random() * colors.length)];
        this.sprite = getGlowSprite(this.color, false, 1.2);
      } else if (this.style === 'forest') {
        this.isFirefly = Math.random() > 0.4;
        this.x = Math.random() * width;
        this.y = initial ? Math.random() * height : (this.isFirefly ? height + 10 : -15);
        if (this.isFirefly) {
          this.radius = Math.random() * 2.5 + 1.5;
          this.speedY = -(Math.random() * 0.35 + 0.1);
          this.speedX = (Math.random() - 0.5) * 0.4;
          this.wobbleSpeed = Math.random() * 0.03 + 0.015;
          this.pulseSpeed = Math.random() * 0.04 + 0.02;
          this.baseOpacity = Math.random() * 0.4 + 0.3;
          this.opacity = this.baseOpacity;
          const colors = ['#9ef01a', '#70e000', '#d8f3dc', '#ffeaa7'];
          this.color = colors[Math.floor(Math.random() * colors.length)];
          this.sprite = getGlowSprite(this.color, true, 1.3);
        } else {
          this.size = Math.random() * 6 + 4;
          this.speedY = Math.random() * 0.7 + 0.3;
          this.speedX = Math.random() * 0.8 - 0.4;
          this.angle = Math.random() * 360;
          this.spin = (Math.random() - 0.5) * 1.5;
          this.opacity = Math.random() * 0.4 + 0.3;
          const leafColors = ['#588157', '#3a5a40', '#a3b18a', '#c2a356'];
          this.color = leafColors[Math.floor(Math.random() * leafColors.length)];
        }
      } else {
        this.x = Math.random() * width;
        this.y = initial ? Math.random() * height : -20;
        this.size = Math.random() * 8 + 6;
        this.scale = Math.random() * 0.8 + 0.2;
        this.speedY = Math.random() * 1.0 + 0.6;
        this.speedX = Math.random() * 1.2 - 0.6;
        this.angle = Math.random() * 360;
        this.spinSpeed = Math.random() * 2 - 1;
        this.opacity = Math.random() * 0.4 + 0.4;
        const colors = ['#ffb7c5', '#ffa1b2', '#fff0f3'];
        this.color = colors[Math.floor(Math.random() * colors.length)];
      }
    }

    update(dtScale) {
      const currentStyle = this.getStyle();
      if (this.style !== currentStyle) {
        this.reset(true);
        return;
      }

      this.time += dtScale;

      if (this.style === 'ocean') {
        this.y += this.speedY * dtScale;
        this.x += Math.sin(this.time * this.wobbleSpeed) * this.wobbleAmp * dtScale;
        if (this.y < -20 || this.x < -20 || this.x > width + 20) this.reset(false);
      } else if (this.style === 'lofi') {
        this.y += this.speedY * dtScale;
        this.x += (this.speedX + Math.sin(this.time * this.wobbleSpeed) * this.wobbleAmp) * dtScale;
        this.opacity = this.baseOpacity + Math.sin(this.time * 0.05) * 0.12;
        if (this.y < -20 || this.x < -20 || this.x > width + 20) this.reset(false);
      } else if (this.style === 'synthwave') {
        this.y += this.speedY * dtScale;
        this.x += this.speedX * dtScale;
        this.angle += this.spin * dtScale;
        if (this.y > height + 20 || this.x < -20 || this.x > width + 20) this.reset(false);
      } else if (this.style === 'aurora') {
        this.y += this.speedY * dtScale;
        this.x += (this.speedX + Math.sin(this.time * this.wobbleSpeed) * 0.6) * dtScale;
        if (this.y < -20 || this.x < -20 || this.x > width + 20) this.reset(false);
      } else if (this.style === 'forest') {
        if (this.isFirefly) {
          this.y += this.speedY * dtScale;
          this.x += (this.speedX + Math.sin(this.time * this.wobbleSpeed) * 0.8) * dtScale;
          this.opacity = this.baseOpacity + Math.sin(this.time * this.pulseSpeed) * 0.25;
          if (this.y < -20 || this.x < -20 || this.x > width + 20) this.reset(false);
        } else {
          this.y += this.speedY * dtScale;
          this.x += (this.speedX + Math.sin(this.y / 25) * 0.5) * dtScale;
          this.angle += this.spin * dtScale;
          if (this.y > height + 20 || this.x < -20 || this.x > width + 20) this.reset(false);
        }
      } else {
        this.y += this.speedY * dtScale;
        this.x += (this.speedX + Math.sin(this.y / 30) * 0.4) * dtScale;
        this.angle += this.spinSpeed * dtScale;
        if (this.y > height + 20 || this.x < -20 || this.x > width + 20) this.reset(false);
      }
    }

    draw() {
      if (this.sprite) {
        const d = (this.style === 'aurora' ? this.radius * 5 : (this.style === 'forest' ? this.radius * 6 : this.radius * 4));
        const half = d * 0.5;
        ctx.globalAlpha = Math.max(0.05, Math.min(1, this.opacity));
        ctx.drawImage(this.sprite, this.x - half, this.y - half, d, d);
        return;
      }

      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.rotate(this.angle * 0.01745329);
      ctx.globalAlpha = this.opacity;
      ctx.fillStyle = this.color;

      if (this.style === 'synthwave') {
        const s = this.size;
        ctx.beginPath();
        ctx.moveTo(0, -s);
        ctx.quadraticCurveTo(0, 0, s, 0);
        ctx.quadraticCurveTo(0, 0, 0, s);
        ctx.quadraticCurveTo(0, 0, -s, 0);
        ctx.quadraticCurveTo(0, 0, 0, -s);
        ctx.fill();
      } else if (this.style === 'forest') {
        ctx.beginPath();
        ctx.moveTo(0, -this.size);
        ctx.quadraticCurveTo(this.size * 0.6, 0, 0, this.size);
        ctx.quadraticCurveTo(-this.size * 0.6, 0, 0, -this.size);
        ctx.fill();
      } else {
        ctx.scale(this.scale, this.scale);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(-this.size, -this.size * 0.5, -this.size, this.size, 0, this.size * 1.5);
        ctx.bezierCurveTo(this.size, this.size, this.size, -this.size * 0.5, 0, 0);
        ctx.fill();

        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 0.8;
        ctx.moveTo(0, 0);
        ctx.lineTo(0, this.size * 1.1);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push(new AmbientParticle());
  }

  let rafId = null;
  let lastFrameTime = 0;

  function animateParticles(now) {
    if (document.hidden) { rafId = null; return; }
    rafId = requestAnimationFrame(animateParticles);
    if (now - lastFrameTime < TARGET_FRAME_MS) return;
    const elapsed = lastFrameTime ? Math.min(40, now - lastFrameTime) : TARGET_FRAME_MS;
    lastFrameTime = now;
    const dtScale = elapsed / 16.6;

    ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < particles.length; i++) {
      particles[i].update(dtScale);
      particles[i].draw();
    }
    ctx.globalAlpha = 1;
  }

  window.resetSakuraParticles = function() {
    particles.forEach(p => p.reset(true));
  };
  document.addEventListener('mintpy:style-change', () => {
    window.resetSakuraParticles();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && rafId === null) {
      lastFrameTime = 0;
      rafId = requestAnimationFrame(animateParticles);
    }
  });

  rafId = requestAnimationFrame(animateParticles);
})();
