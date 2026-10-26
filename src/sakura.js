// ==================================================
// THEMATIC AMBIENT PARTICLES (Zen Sakura, Ocean Bubbles, Lo-Fi Steam/Motes, etc.)
// ==================================================
(function() {
  const canvas = document.getElementById('sakura-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  let width = canvas.width = window.innerWidth;
  let height = canvas.height = window.innerHeight;

  window.addEventListener('resize', () => {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  });

  const PARTICLE_COUNT = 40;
  const particles = [];

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

      if (this.style === 'ocean') {
        // --- DEEP OCEAN: Rising Water Bubbles ---
        this.x = Math.random() * width;
        this.y = initial ? Math.random() * height : height + 15 + Math.random() * 20;
        this.radius = Math.random() * 6 + 2.5; // 2.5 to 8.5px
        this.speedY = -(Math.random() * 0.9 + 0.5); // float upwards
        this.wobbleSpeed = Math.random() * 0.04 + 0.02;
        this.wobbleAmp = Math.random() * 1.2 + 0.4;
        this.opacity = Math.random() * 0.35 + 0.35;
      } else if (this.style === 'lofi') {
        // --- LO-FI CHILL: Floating Coffee Steam & Cozy Dust Motes ---
        this.x = Math.random() * width;
        this.y = initial ? Math.random() * height : height + 10;
        this.radius = Math.random() * 3.2 + 1.6;
        this.speedY = -(Math.random() * 0.4 + 0.15); // gentle slow rise
        this.speedX = (Math.random() - 0.5) * 0.5;
        this.wobbleSpeed = Math.random() * 0.03 + 0.01;
        this.wobbleAmp = Math.random() * 1.5 + 0.5;
        this.baseOpacity = Math.random() * 0.35 + 0.25;
        this.opacity = this.baseOpacity;
        const colors = ['#e0a96d', '#d4a373', '#f4a261', '#eeddc9', '#dfcca9'];
        this.color = colors[Math.floor(Math.random() * colors.length)];
      } else if (this.style === 'synthwave') {
        // --- SYNTHWAVE: Neon cyber stars & sparks ---
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
        // --- AURORA: Celestial floating light orbs ---
        this.x = Math.random() * width;
        this.y = initial ? Math.random() * height : height + 10;
        this.radius = Math.random() * 4 + 2;
        this.speedY = -(Math.random() * 0.3 + 0.15);
        this.speedX = (Math.random() - 0.5) * 0.4;
        this.wobbleSpeed = 0.02;
        this.opacity = Math.random() * 0.4 + 0.25;
        const colors = ['#7ee8fa', '#a5a6f6', '#c8b6ff', '#80ffdb'];
      } else if (this.style === 'forest') {
        // --- FOREST ZEN: Glowing Fireflies & Drifting Forest Leaves ---
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
        // --- JAPANESE ZEN (Default): Cherry Blossom Sakura Petals ---
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

    update() {
      const currentStyle = this.getStyle();
      if (this.style !== currentStyle) {
        this.reset(true);
        return;
      }

      this.time += 1;

      if (this.style === 'ocean') {
        this.y += this.speedY;
        this.x += Math.sin(this.time * this.wobbleSpeed) * this.wobbleAmp;
        if (this.y < -20 || this.x < -20 || this.x > width + 20) {
          this.reset(false);
        }
      } else if (this.style === 'lofi') {
        this.y += this.speedY;
        this.x += this.speedX + Math.sin(this.time * this.wobbleSpeed) * this.wobbleAmp;
        this.opacity = this.baseOpacity + Math.sin(this.time * 0.05) * 0.12;
        if (this.y < -20 || this.x < -20 || this.x > width + 20) {
          this.reset(false);
        }
      } else if (this.style === 'synthwave') {
        this.y += this.speedY;
        this.x += this.speedX;
        this.angle += this.spin;
        if (this.y > height + 20 || this.x < -20 || this.x > width + 20) {
          this.reset(false);
        }
      } else if (this.style === 'aurora') {
        this.y += this.speedY;
        this.x += this.speedX + Math.sin(this.time * this.wobbleSpeed) * 0.6;
        if (this.y < -20 || this.x < -20 || this.x > width + 20) {
          this.reset(false);
        }
      } else if (this.style === 'forest') {
        if (this.isFirefly) {
          this.y += this.speedY;
          this.x += this.speedX + Math.sin(this.time * this.wobbleSpeed) * 0.8;
          this.opacity = this.baseOpacity + Math.sin(this.time * this.pulseSpeed) * 0.25;
          if (this.y < -20 || this.x < -20 || this.x > width + 20) this.reset(false);
        } else {
          this.y += this.speedY;
          this.x += this.speedX + Math.sin(this.y / 25) * 0.5;
          this.angle += this.spin;
          if (this.y > height + 20 || this.x < -20 || this.x > width + 20) this.reset(false);
        }
      } else {
        // Zen Sakura
        this.y += this.speedY;
        this.x += this.speedX + Math.sin(this.y / 30) * 0.4;
        this.angle += this.spinSpeed;
        if (this.y > height + 20 || this.x < -20 || this.x > width + 20) {
          this.reset(false);
        }
      }
    }

    draw() {
      ctx.save();

      if (this.style === 'ocean') {
        // --- DRAW WATER BUBBLE ---
        ctx.translate(this.x, this.y);
        ctx.globalAlpha = Math.max(0.1, Math.min(1, this.opacity));

        // Bubble body
        ctx.beginPath();
        ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 220, 255, 0.12)';
        ctx.fill();

        // Bubble rim
        ctx.strokeStyle = 'rgba(0, 240, 255, 0.55)';
        ctx.lineWidth = 0.9;
        ctx.stroke();

        // Specular highlight gleam
        ctx.beginPath();
        ctx.arc(-this.radius * 0.35, -this.radius * 0.35, this.radius * 0.28, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
        ctx.fill();

      } else if (this.style === 'lofi') {
        // --- DRAW COFFEE DUST MOTE / WARM STEAM AROMA ---
        ctx.translate(this.x, this.y);
        ctx.globalAlpha = Math.max(0.05, Math.min(1, this.opacity));

        // Soft glowing aura
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, this.radius * 2);
        grad.addColorStop(0, this.color);
        grad.addColorStop(0.5, this.color);
        grad.addColorStop(1, 'transparent');

        ctx.beginPath();
        ctx.arc(0, 0, this.radius * 2, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

        // Bright center core
        ctx.beginPath();
        ctx.arc(0, 0, this.radius * 0.6, 0, Math.PI * 2);
        ctx.fillStyle = '#fff7ea';
        ctx.fill();

      } else if (this.style === 'synthwave') {
        // --- DRAW 4-POINT NEON STAR ---
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle * Math.PI / 180);
        ctx.globalAlpha = this.opacity;
        ctx.fillStyle = this.color;
        ctx.beginPath();
        const s = this.size;
        ctx.moveTo(0, -s);
        ctx.quadraticCurveTo(0, 0, s, 0);
        ctx.quadraticCurveTo(0, 0, 0, s);
        ctx.quadraticCurveTo(0, 0, -s, 0);
        ctx.quadraticCurveTo(0, 0, 0, -s);
        ctx.fill();

      } else if (this.style === 'aurora') {
        // --- DRAW AURORA LIGHT ORB ---
        ctx.translate(this.x, this.y);
        ctx.globalAlpha = this.opacity;
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, this.radius * 2.5);
        grad.addColorStop(0, this.color);
        grad.addColorStop(1, 'transparent');
        ctx.beginPath();
        ctx.arc(0, 0, this.radius * 2.5, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

      } else if (this.style === 'forest') {
        // --- DRAW GLOWING FIREFLY OR DRIFTING LEAF ---
        ctx.translate(this.x, this.y);
        if (this.isFirefly) {
          ctx.globalAlpha = Math.max(0.05, Math.min(1, this.opacity));
          const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, this.radius * 3);
          grad.addColorStop(0, this.color);
          grad.addColorStop(0.4, this.color);
          grad.addColorStop(1, 'transparent');
          ctx.beginPath();
          ctx.arc(0, 0, this.radius * 3, 0, Math.PI * 2);
          ctx.fillStyle = grad;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(0, 0, this.radius * 0.7, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
        } else {
          ctx.rotate(this.angle * Math.PI / 180);
          ctx.globalAlpha = this.opacity;
          ctx.fillStyle = this.color;
          ctx.beginPath();
          ctx.moveTo(0, -this.size);
          ctx.quadraticCurveTo(this.size * 0.6, 0, 0, this.size);
          ctx.quadraticCurveTo(-this.size * 0.6, 0, 0, -this.size);
          ctx.fill();
        }

      } else {
        // --- DRAW SAKURA PETAL ---
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle * Math.PI / 180);
        ctx.scale(this.scale, this.scale);

        ctx.beginPath();
        ctx.fillStyle = this.color;
        ctx.globalAlpha = this.opacity;

        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(-this.size, -this.size / 2, -this.size, this.size, 0, this.size * 1.5);
        ctx.bezierCurveTo(this.size, this.size, this.size, -this.size / 2, 0, 0);
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

  function animateParticles() {
    if (document.hidden) { rafId = null; return; }
    ctx.clearRect(0, 0, width, height);
    particles.forEach(p => {
      p.update();
      p.draw();
    });
    rafId = requestAnimationFrame(animateParticles);
  }

  window.resetSakuraParticles = function() {
    particles.forEach(p => p.reset(true));
  };
  document.addEventListener('mintpy:style-change', () => {
    window.resetSakuraParticles();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && rafId === null) rafId = requestAnimationFrame(animateParticles);
  });

  animateParticles();
})();
