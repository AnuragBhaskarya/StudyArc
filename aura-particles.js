/**
 * StudyArc — Ambient Green Aura & Constellation Web Particle Engine (v2.3)
 * Features:
 * 1. 100% Organic fluid particle dynamics (First Version Physics): Free velocity drift with sinusoidal floating.
 * 2. Gaussian Normal Distribution around Timer: 70% of particles are distributed in a dense Gaussian cluster around the timer dial.
 * 3. Continuous Dynamic Balance ("The gone are gone and new will be generated"):
 *    - Particles drifting beyond the halo boundary whisper-fade smoothly out of sight (zero backward dragging).
 *    - Reincarnated particles smoothly bloom into the Gaussian center cloud, guaranteeing the center is ALWAYS crowded forever.
 * 4. Hold-to-Reset Hyperspace Warp: Pure first-version outward radial acceleration with luminous streak tails.
 * 5. Delicate Constellation Connections: Max 4 connections per node, reducing during hold with eye-of-the-warp clearance.
 * 6. Chromatic Shift: Warm golden amber near the timer on paused/idle/load, transitioning smoothly into neon green.
 */
(function() {
  'use strict';

  class AuraConstellation {
    constructor(canvasId) {
      this.canvas = document.getElementById(canvasId);
      if (!this.canvas) return;
      this.ctx = this.canvas.getContext('2d', { alpha: true });
      if (!this.ctx) return;

      this.particles = [];
      this.width = window.innerWidth;
      this.height = window.innerHeight;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);

      // Mouse tracking
      this.mouse = { x: -9999, y: -9999, radius: 140, active: false };

      // Hold-to-Reset speedup state
      this.isHolding = false;
      this.holdProgress = 0; // 0.0 to 1.0
      this.currentSpeedMultiplier = 1.0;
      this.targetSpeedMultiplier = 1.0;

      // Timer center and dimensions
      this.centerX = this.width / 2;
      this.centerY = this.height * 0.36;
      this.timerRadius = 175;

      // Timer state & chromatic amber shift
      // Check immediately if timer is already running; if not, start in amber mode (1.0) right away!
      const timerSection = document.querySelector('.timer-section');
      const isInitiallyRunning = timerSection ? timerSection.classList.contains('is-running') : false;
      this.timerStatus = isInitiallyRunning ? 'running' : 'idle';
      this.amberFactor = isInitiallyRunning ? 0.0 : 1.0;

      // Responsive configuration
      this.isMobile = this.width < 768;
      this.particleCount = this.isMobile ? 54 : 96;
      this.maxConnectDistance = this.isMobile ? 105 : 138;
      this.centerRatio = 0.70; // 70% of dots maintained in dense normal distribution around timer

      // Color Palettes
      this.greenPalette = [
        { r: 16, g: 224, b: 104 },  // #10E068 (Neon green primary)
        { r: 78, g: 250, b: 143 },  // #4EFA8F (Luminous lime highlight)
        { r: 36, g: 232, b: 124 },  // #24E87C (Electric emerald)
        { r: 14, g: 200, b: 96 }    // #0EC860 (Deep vivid green)
      ];

      this.amberPalette = [
        { r: 229, g: 169, b: 88 },  // #E5A958 (Warm timer amber)
        { r: 245, g: 199, b: 130 }, // #F5C782 (Bright amber bead)
        { r: 255, g: 186, b: 82 },  // #FFBA52 (Golden glow)
        { r: 220, g: 150, b: 68 }   // #DC9644 (Deep honey amber)
      ];

      this.rafId = null;
      this.lastTime = performance.now();

      this.init();
    }

    init() {
      this.resize();
      this.createParticles();
      this.bindEvents();
      this.start();
    }

    updateTimerCenter() {
      const timerWrapper = document.querySelector('.timer-wrapper');
      if (timerWrapper) {
        const rect = timerWrapper.getBoundingClientRect();
        this.centerX = rect.left + rect.width / 2;
        this.centerY = rect.top + rect.height / 2;
        this.timerRadius = Math.max(120, rect.width / 2);
      } else {
        this.centerX = this.width / 2;
        this.centerY = this.height * 0.36;
        this.timerRadius = 175;
      }
    }

    resize() {
      this.width = window.innerWidth;
      this.height = window.innerHeight;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.isMobile = this.width < 768;

      this.canvas.width = Math.round(this.width * this.dpr);
      this.canvas.height = Math.round(this.height * this.dpr);
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;

      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.scale(this.dpr, this.dpr);

      this.updateTimerCenter();

      this.maxConnectDistance = this.isMobile ? 105 : 138;
      const targetCount = this.isMobile ? 54 : 96;

      if (this.particles.length === 0) {
        this.createParticles(targetCount);
      } else if (this.particles.length < targetCount) {
        while (this.particles.length < targetCount) {
          const spawnInCenter = Math.random() < this.centerRatio;
          this.particles.push(this.createSingleParticle(spawnInCenter));
        }
      } else if (this.particles.length > targetCount) {
        this.particles.length = targetCount;
      }
    }

    getNormalRadius() {
      // Box-Muller transform for true Gaussian normal distribution around the timer
      const u1 = Math.max(0.0001, Math.random());
      const u2 = Math.random();
      const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

      // Peak density (mean) sits closely around the timer dial (~0.90 * timerRadius)
      const mean = this.timerRadius * 0.90;
      const stdDev = this.timerRadius * 0.36;
      const r = mean + z * stdDev;

      // Bound within organic core and outer halo margin
      const minR = 25;
      const maxR = this.timerRadius * 1.55;
      return Math.max(minR, Math.min(maxR, r));
    }

    createSingleParticle(spawnInCenter = false) {
      const colorIdx = Math.floor(Math.random() * this.greenPalette.length);
      const baseColor = this.greenPalette[colorIdx];
      const amberColor = this.amberPalette[colorIdx % this.amberPalette.length];

      // 3 Sleek Visual Tiers
      const roll = Math.random();
      let tier, baseRadius, alpha;

      if (roll < 0.50) {
        // Tier 1: Micro Stardust (50% of dots)
        tier = 'micro';
        baseRadius = 0.75 + Math.random() * 0.4;
        alpha = 0.30 + Math.random() * 0.35;
      } else if (roll < 0.86) {
        // Tier 2: Regular Constellation Nodes (36% of dots)
        tier = 'regular';
        baseRadius = 1.35 + Math.random() * 0.45;
        alpha = 0.45 + Math.random() * 0.35;
      } else {
        // Tier 3: Luminous Nodes (14% of dots)
        tier = 'prominent';
        baseRadius = 2.1 + Math.random() * 0.5;
        alpha = 0.70 + Math.random() * 0.28;
      }

      let x, y;
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.24 + Math.random() * 0.44;

      if (spawnInCenter) {
        // High density Gaussian normal distribution around the circular timer
        const r = this.getNormalRadius();
        x = this.centerX + Math.cos(angle) * r;
        y = this.centerY + Math.sin(angle) * r;
      } else {
        // Naturally generated across the wider screen canvas
        x = Math.random() * this.width;
        y = Math.random() * this.height;
      }

      return {
        isCenterDot: spawnInCenter,
        tier,
        x,
        y,
        baseVx: Math.cos(angle) * speed,
        baseVy: Math.sin(angle) * speed,
        currentVx: Math.cos(angle) * speed,
        currentVy: Math.sin(angle) * speed,
        radius: baseRadius,
        baseRadius,
        baseColor,
        amberColor,
        currentR: baseColor.r,
        currentG: baseColor.g,
        currentB: baseColor.b,
        amberRatio: 0,
        alpha,
        fadeAlpha: 1.0,
        fadingOut: false,
        pulseSpeed: 0.012 + Math.random() * 0.02,
        pulsePhase: Math.random() * Math.PI * 2,
        oscillationSpeed: 0.007 + Math.random() * 0.012,
        oscillationAmp: 0.35 + Math.random() * 0.55,
        oscillationPhase: Math.random() * Math.PI * 2
      };
    }

    createParticles(count = this.particleCount) {
      this.particles = [];
      const centerTarget = Math.round(count * this.centerRatio);

      for (let i = 0; i < count; i++) {
        const spawnInCenter = i < centerTarget;
        this.particles.push(this.createSingleParticle(spawnInCenter));
      }
    }

    bindEvents() {
      let resizeTimer = null;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => this.resize(), 100);
      }, { passive: true });

      window.addEventListener('pointermove', (e) => {
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
        this.mouse.active = true;
      }, { passive: true });

      window.addEventListener('pointerleave', () => {
        this.mouse.active = false;
        this.mouse.x = -9999;
        this.mouse.y = -9999;
      }, { passive: true });

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
          }
        } else {
          this.lastTime = performance.now();
          this.start();
        }
      });
    }

    setHoldProgress(progress) {
      this.holdProgress = Math.max(0, Math.min(1, progress));
      this.isHolding = this.holdProgress > 0;
    }

    setHolding(holding) {
      this.isHolding = !!holding;
      if (!this.isHolding) {
        this.holdProgress = 0;
      }
    }

    onReset() {
      this.isHolding = false;
      this.holdProgress = 0;
      this.targetSpeedMultiplier = 1.0;
    }

    setTimerStatus(status) {
      this.timerStatus = status || 'idle';
    }

    update() {
      // 1. Check hold state
      const bodyHolding = document.body.classList.contains('is-holding');
      if (bodyHolding && !this.isHolding) {
        this.isHolding = true;
      } else if (!bodyHolding && this.isHolding && this.holdProgress <= 0.01) {
        this.isHolding = false;
      }

      // Compute warp speed multiplier (1.0x -> 16.0x) smoothly based on holdProgress
      if (this.isHolding) {
        const prog = Math.max(0, Math.min(1, this.holdProgress || 0));
        this.targetSpeedMultiplier = 1.0 + Math.pow(prog, 1.25) * 16.0;
      } else {
        this.targetSpeedMultiplier = 1.0;
      }

      // Smooth damped spring deceleration / acceleration
      const easeRate = this.isHolding ? 0.14 : 0.065;
      this.currentSpeedMultiplier += (this.targetSpeedMultiplier - this.currentSpeedMultiplier) * easeRate;

      const speedMult = this.currentSpeedMultiplier;
      const isWarping = speedMult > 1.7;

      // 2. Amber Mode Detection:
      const timerSection = document.querySelector('.timer-section');
      const isRunning = this.timerStatus === 'running' ||
                        (timerSection ? timerSection.classList.contains('is-running') : false);

      const targetAmberFactor = isRunning ? 0.0 : 1.0;
      this.amberFactor += (targetAmberFactor - this.amberFactor) * 0.065;

      // Re-anchor timer center
      this.updateTimerCenter();

      const innerAmberRadius = this.timerRadius * 1.12;
      const outerAmberRadius = this.timerRadius * 2.10;

      // 3. Normal Distribution Population Thermostat:
      // Defines the Gaussian halo boundary where density naturally tapers off
      const maxHaloRadius = this.timerRadius * 1.55; // ~270px desktop, ~210px mobile
      let visibleCenterCount = 0;

      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];
        const dist = Math.hypot(p.x - this.centerX, p.y - this.centerY);
        if (dist <= maxHaloRadius && (p.fadeAlpha ?? 1.0) > 0.3) {
          visibleCenterCount++;
        }
      }

      const targetCenterCount = Math.round(this.particles.length * this.centerRatio);
      const centerNeedsDots = visibleCenterCount < targetCenterCount;

      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];

        p.oscillationPhase += p.oscillationSpeed;
        p.pulsePhase += p.pulseSpeed;

        const oscX = Math.sin(p.oscillationPhase) * p.oscillationAmp;
        const oscY = Math.cos(p.oscillationPhase) * p.oscillationAmp;

        let vx = (p.baseVx + oscX) * speedMult;
        let vy = (p.baseVy + oscY) * speedMult;

        // When holding to reset: add radial warp vector outward from timer center
        if (isWarping) {
          const dx = p.x - this.centerX;
          const dy = p.y - this.centerY;
          const distFromCenter = Math.hypot(dx, dy) || 1;

          const warpForce = ((speedMult - 1.0) / 15.0) * (4.5 + distFromCenter / 110);
          const dirX = dx / distFromCenter;
          const dirY = dy / distFromCenter;

          vx += dirX * warpForce;
          vy += dirY * warpForce;
        }

        // Mouse repulsion
        if (this.mouse.active && !isWarping) {
          const mdx = p.x - this.mouse.x;
          const mdy = p.y - this.mouse.y;
          const mDist = Math.hypot(mdx, mdy);
          if (mDist < this.mouse.radius && mDist > 0) {
            const force = (1 - mDist / this.mouse.radius) * 0.85;
            vx += (mdx / mDist) * force;
            vy += (mdy / mDist) * force;
          }
        }

        p.x += vx;
        p.y += vy;
        p.currentVx = vx;
        p.currentVy = vy;

        // 4. Lifecycle & Normal Distribution Maintenance:
        // "the gone are gone and new will be generated"
        if (isWarping) {
          // Continuous warp stream during hold:
          p.fadingOut = false;
          p.fadeAlpha = Math.min(1.0, (p.fadeAlpha ?? 1.0) + 0.04);

          // If particle flew off screen during warp, respawn near timer center to keep stream flowing
          if (p.x < -40 || p.x > this.width + 40 || p.y < -40 || p.y > this.height + 40) {
            const angle = Math.random() * Math.PI * 2;
            const r = 25 + Math.random() * 65;
            p.x = this.centerX + Math.cos(angle) * r;
            p.y = this.centerY + Math.sin(angle) * r;
            const speed = 0.28 + Math.random() * 0.52;
            p.baseVx = Math.cos(angle) * speed;
            p.baseVy = Math.sin(angle) * speed;
            p.currentVx = p.baseVx;
            p.currentVy = p.baseVy;
            p.fadeAlpha = 0.0;
          }
        } else {
          // Normal cruising mode:
          const distFromCenter = Math.hypot(p.x - this.centerX, p.y - this.centerY);

          if (p.isCenterDot) {
            // A dedicated normal distribution center dot:
            if (distFromCenter > maxHaloRadius) {
              // Drifted outside the crowded halo: smoothly fade out!
              p.fadingOut = true;
              const fadeRate = centerNeedsDots ? 0.024 : 0.012;
              p.fadeAlpha = Math.max(0, (p.fadeAlpha ?? 1.0) - fadeRate);

              if (p.fadeAlpha <= 0 || p.x < -30 || p.x > this.width + 30 || p.y < -30 || p.y > this.height + 30) {
                // The gone are gone! Reincarnate in the center with Gaussian normal distribution!
                const r = this.getNormalRadius();
                const angle = Math.random() * Math.PI * 2;
                p.x = this.centerX + Math.cos(angle) * r;
                p.y = this.centerY + Math.sin(angle) * r;

                const newAngle = Math.random() * Math.PI * 2;
                const speed = 0.24 + Math.random() * 0.44;
                p.baseVx = Math.cos(newAngle) * speed;
                p.baseVy = Math.sin(newAngle) * speed;
                p.currentVx = p.baseVx;
                p.currentVy = p.baseVy;

                p.fadingOut = false;
                p.fadeAlpha = 0.0; // Softly blooms in over ~40-50 frames (0.75s)
              }
            } else {
              // Inside the crowded halo: softly bloom to full brightness!
              p.fadingOut = false;
              p.fadeAlpha = Math.min(1.0, (p.fadeAlpha ?? 1.0) + 0.025);
            }
          } else {
            // Ambient outer dot: smoothly blooms and roams the screen, wrapping at canvas edges
            p.fadeAlpha = Math.min(1.0, (p.fadeAlpha ?? 1.0) + 0.025);

            if (p.x < -15) p.x = this.width + 15;
            else if (p.x > this.width + 15) p.x = -15;

            if (p.y < -15) p.y = this.height + 15;
            else if (p.y > this.height + 15) p.y = -15;
          }
        }

        // 5. Distance-based amber shift calculation
        const dx = p.x - this.centerX;
        const dy = p.y - this.centerY;
        const distFromTimer = Math.hypot(dx, dy);

        if (this.amberFactor > 0.001) {
          let distInfluence = 0.0;
          if (distFromTimer <= innerAmberRadius) {
            distInfluence = 1.0;
          } else if (distFromTimer < outerAmberRadius) {
            const t = (distFromTimer - innerAmberRadius) / (outerAmberRadius - innerAmberRadius);
            distInfluence = 1.0 - (t * t * (3 - 2 * t));
          } else {
            distInfluence = 0.0;
          }

          p.amberRatio = distInfluence * this.amberFactor;
        } else {
          p.amberRatio = 0.0;
        }

        p.currentR = Math.round(p.baseColor.r + (p.amberColor.r - p.baseColor.r) * p.amberRatio);
        p.currentG = Math.round(p.baseColor.g + (p.amberColor.g - p.baseColor.g) * p.amberRatio);
        p.currentB = Math.round(p.baseColor.b + (p.amberColor.b - p.baseColor.b) * p.amberRatio);
      }
    }

    render() {
      this.ctx.clearRect(0, 0, this.width, this.height);

      const speedMult = this.currentSpeedMultiplier;
      // Continuous smoothstep warp intensity (0.00 at 1.0x cruising speed, 1.00 at full warp)
      const rawWarp = Math.max(0, Math.min(1, (speedMult - 1.0) / 9.0));
      const warpIntensity = rawWarp * rawWarp * (3 - 2 * rawWarp);

      // 1. Constellation Web Lines
      const timerClearRadius = this.timerRadius + 45; // ~220px: clear eye zone around timer during hold
      const holdLineFactor = Math.max(0, 1.0 - warpIntensity * 1.35);
      const effectiveMaxDist = this.maxConnectDistance * (1 - warpIntensity * 0.25);

      if (holdLineFactor > 0.01) {
        this.ctx.lineWidth = 0.65;
        const connectionCounts = new Uint8Array(this.particles.length);
        const maxConnsPerDot = 4;

        for (let i = 0; i < this.particles.length; i++) {
          const p1 = this.particles[i];
          if (connectionCounts[i] >= maxConnsPerDot) continue;

          const dist1 = Math.hypot(p1.x - this.centerX, p1.y - this.centerY);
          if (warpIntensity > 0.08 && dist1 < timerClearRadius) {
            continue;
          }

          for (let j = i + 1; j < this.particles.length; j++) {
            if (connectionCounts[i] >= maxConnsPerDot) break;
            if (connectionCounts[j] >= maxConnsPerDot) continue;

            const p2 = this.particles[j];
            const dist2 = Math.hypot(p2.x - this.centerX, p2.y - this.centerY);
            if (warpIntensity > 0.08 && dist2 < timerClearRadius) {
              continue;
            }

            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const dist = Math.hypot(dx, dy);

            if (dist < effectiveMaxDist) {
              connectionCounts[i]++;
              connectionCounts[j]++;

              const alphaFactor = 1 - (dist / effectiveMaxDist);
              const p1Fade = p1.fadeAlpha !== undefined ? p1.fadeAlpha : 1.0;
              const p2Fade = p2.fadeAlpha !== undefined ? p2.fadeAlpha : 1.0;
              const lineAlpha = (alphaFactor * alphaFactor) * 0.20 * holdLineFactor * p1Fade * p2Fade;

              if (Math.abs(p1.amberRatio - p2.amberRatio) < 0.18) {
                const r = Math.round((p1.currentR + p2.currentR) / 2);
                const g = Math.round((p1.currentG + p2.currentG) / 2);
                const b = Math.round((p1.currentB + p2.currentB) / 2);

                this.ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${lineAlpha.toFixed(3)})`;
                this.ctx.beginPath();
                this.ctx.moveTo(p1.x, p1.y);
                this.ctx.lineTo(p2.x, p2.y);
                this.ctx.stroke();
              } else {
                const grad = this.ctx.createLinearGradient(p1.x, p1.y, p2.x, p2.y);
                grad.addColorStop(0, `rgba(${p1.currentR}, ${p1.currentG}, ${p1.currentB}, ${lineAlpha.toFixed(3)})`);
                grad.addColorStop(1, `rgba(${p2.currentR}, ${p2.currentG}, ${p2.currentB}, ${lineAlpha.toFixed(3)})`);

                this.ctx.strokeStyle = grad;
                this.ctx.beginPath();
                this.ctx.moveTo(p1.x, p1.y);
                this.ctx.lineTo(p2.x, p2.y);
                this.ctx.stroke();
              }
            }
          }

          // Mouse link
          if (this.mouse.active && warpIntensity < 0.2 && connectionCounts[i] < maxConnsPerDot) {
            const mDist = Math.hypot(p1.x - this.mouse.x, p1.y - this.mouse.y);
            if (mDist < this.mouse.radius) {
              const mAlpha = (1 - mDist / this.mouse.radius) * 0.26 * (1 - warpIntensity * 3.0);
              if (mAlpha > 0.01) {
                this.ctx.strokeStyle = `rgba(${p1.currentR}, ${p1.currentG}, ${p1.currentB}, ${mAlpha.toFixed(3)})`;
                this.ctx.beginPath();
                this.ctx.moveTo(p1.x, p1.y);
                this.ctx.lineTo(this.mouse.x, this.mouse.y);
                this.ctx.stroke();
              }
            }
          }
        }
      }

      // 2. Draw Particles (Dots & Hyperspace Streaks with 100% continuous size & luminance interpolation)
      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];
        const pulse = Math.sin(p.pulsePhase) * 0.20;

        // Continuous smooth radius: expands seamlessly during hold, shrinks seamlessly on release
        const calmRadius = Math.max(0.65, p.baseRadius + pulse);
        const currentRadius = calmRadius * (1.0 + warpIntensity * 0.35);

        // Continuous smooth luminance: calm alpha smoothly brightens to radiant neon, smoothly dims on release
        const calmAlpha = p.alpha;
        const boostedAlpha = Math.min(1.0, p.alpha * 1.35 + 0.35);
        const effectiveAlpha = calmAlpha + (boostedAlpha - calmAlpha) * warpIntensity;
        const finalAlpha = Math.min(1.0, effectiveAlpha * (p.fadeAlpha ?? 1.0));

        // Draw luminous streak tail (only when moving fast enough, smoothly growing & dissolving)
        if (warpIntensity > 0.01) {
          const maxStreak = Math.min(36, speedMult * 2.2);
          const streakLen = maxStreak * warpIntensity;
          const tailX = p.x - (p.currentVx || 0) * (streakLen / Math.max(1, speedMult));
          const tailY = p.y - (p.currentVy || 0) * (streakLen / speedMult);

          const grad = this.ctx.createLinearGradient(tailX, tailY, p.x, p.y);
          grad.addColorStop(0, `rgba(${p.currentR}, ${p.currentG}, ${p.currentB}, 0)`);
          grad.addColorStop(1, `rgba(${p.currentR}, ${p.currentG}, ${p.currentB}, ${(finalAlpha * warpIntensity).toFixed(2)})`);

          this.ctx.beginPath();
          this.ctx.moveTo(tailX, tailY);
          this.ctx.lineTo(p.x, p.y);
          this.ctx.strokeStyle = grad;
          this.ctx.lineWidth = currentRadius * (1.0 + warpIntensity * 0.40);
          this.ctx.lineCap = 'round';
          this.ctx.stroke();
        }

        // Draw core particle bead (continuous smooth alpha and radius, ZERO cuts)
        this.ctx.beginPath();
        this.ctx.arc(p.x, p.y, currentRadius, 0, Math.PI * 2);
        this.ctx.fillStyle = `rgba(${p.currentR}, ${p.currentG}, ${p.currentB}, ${finalAlpha.toFixed(2)})`;
        this.ctx.fill();

        // Luminous soft aura glow: smoothly expands with warp intensity
        const hasProminentHalo = p.tier === 'prominent';
        if (hasProminentHalo || warpIntensity > 0.04) {
          const haloBaseAlpha = hasProminentHalo ? (0.20 + warpIntensity * 0.30) : (warpIntensity * 0.35);
          const haloRadius = currentRadius * (1.75 + warpIntensity * 0.50);

          this.ctx.beginPath();
          this.ctx.arc(p.x, p.y, haloRadius, 0, Math.PI * 2);
          this.ctx.fillStyle = `rgba(${p.currentR}, ${p.currentG}, ${p.currentB}, ${(finalAlpha * haloBaseAlpha).toFixed(2)})`;
          this.ctx.fill();
        }
      }
    }

    loop(timestamp) {
      this.lastTime = timestamp;
      this.update();
      this.render();
      this.rafId = requestAnimationFrame((t) => this.loop(t));
    }

    start() {
      if (!this.rafId) {
        this.lastTime = performance.now();
        this.rafId = requestAnimationFrame((t) => this.loop(t));
      }
    }

    stop() {
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
    }
  }

  function initAmbientAura() {
    if (document.getElementById('ambient-constellation-canvas')) {
      window.AmbientAura = new AuraConstellation('ambient-constellation-canvas');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAmbientAura);
  } else {
    initAmbientAura();
  }
})();
