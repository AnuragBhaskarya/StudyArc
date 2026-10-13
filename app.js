/**
 * STUDYARC — CLIENT LOGIC & ENGINE
 * Architecture: Clean Vanilla JS, accurate time delta timer,
 * Web Audio synthesizer, dynamic calendar heatmap, and reactive localStorage.
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'studyarc_store_v1';

  // =========================================================================
  // APP STATE & STORAGE
  // =========================================================================
  const defaultState = {
    // Focus Timer State (Max 3 hours = 10,800s, Default 1 hour = 3,600s)
    timer: {
      status: 'idle', // 'idle' | 'running' | 'paused'
      targetSeconds: 60 * 60, // 1 hour default
      remainingSeconds: 60 * 60,
      startTime: null,
      lastTickTime: null
    },

    // Gamification & Progression (Loaded dynamically from SQLite)
    streak: 0,
    xp: 0,
    totalFocusSeconds: 0,

    // Activity Records & Sessions (Loaded from SQLite database)
    dayActivity: {},
    sessions: [],

    // Heatmap View
    viewedYear: 2026,
    viewedMonth: 9, // October

    // Focus Subjects (Loaded from SQLite database)
    subjects: [],

    // Active Focus Session
    activeTaskName: null,
    activeTaskStartTime: null,
    activeTaskTargetSeconds: null,

    // Preferences
    soundEnabled: true,

    // User Authentication
    user: null,
    authenticated: false
  };

  let state = loadState();

  function loadState() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        const merged = Object.assign({}, defaultState, parsed);
        if (!merged.timer.targetSeconds || merged.timer.targetSeconds > 3 * 3600) {
          merged.timer.targetSeconds = 60 * 60;
        }

        const now = Date.now();
        // If timer was running, compute exact elapsed time since last tick in 0ms!
        if (merged.timer && merged.timer.status === 'running') {
          const lastTime = merged.timer.lastTickTime || merged.timer.startTime || now;
          const elapsedSecs = (now - lastTime) / 1000;
          const currentRemaining = Math.max(
            0,
            (merged.timer.remainingSeconds != null ? merged.timer.remainingSeconds : merged.timer.targetSeconds) - elapsedSecs
          );

          if (currentRemaining <= 0) {
            merged.timer.status = 'idle';
            merged.timer.remainingSeconds = merged.timer.targetSeconds;
            merged.timer._completedWhileAway = true;
          } else {
            merged.timer.status = 'running';
            merged.timer.remainingSeconds = currentRemaining;
            merged.timer.lastTickTime = now;
          }
        } else if (merged.timer && merged.timer.status === 'paused') {
          merged.timer.remainingSeconds = (merged.timer.remainingSeconds != null) ? merged.timer.remainingSeconds : merged.timer.targetSeconds;
        } else {
          merged.timer.status = 'idle';
          merged.timer.remainingSeconds = merged.timer.targetSeconds;
          merged.activeTaskName = null;
        }
        return merged;
      }
    } catch (e) {
      console.warn('StudyArc: Could not read localStorage:', e);
    }
    return JSON.parse(JSON.stringify(defaultState));
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('StudyArc: Could not save to localStorage:', e);
    }
  }

  // =========================================================================
  // SERVER SYNCHRONIZATION & AUTHENTICATION ENGINE
  // =========================================================================

  async function syncWithBackend() {
    try {
      const res = await fetch('/api/state');
      if (res.status === 401) {
        state.authenticated = false;
        state.user = null;
        updateAuthUI();
        return;
      }

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          state.authenticated = true;
          state.user = data.user || null;
          state.subjects = data.subjects || [];
          state.sessions = data.sessions || [];

          const oldActivityStr = JSON.stringify(state.dayActivity);
          const newActivityStr = JSON.stringify(data.dayActivity || {});
          const activityChanged = oldActivityStr !== newActivityStr;

          state.dayActivity = data.dayActivity || {};
          if (data.stats) {
            state.streak = data.stats.streak || 0;
            state.xp = data.stats.xp || 0;
            state.totalFocusSeconds = data.stats.totalFocusSeconds || 0;
          }

          if (data.timer) {
            reconcileServerTimer(data.timer);
          }

          updateAuthUI();
          saveState();
          renderTimer();
          renderStats();
          if (activityChanged) {
            renderHeatmap();
          }

          // Start multi-device real-time SSE stream
          initRealtimeTimerSync();
        }
      }
    } catch (err) {
      console.warn('StudyArc: Backend sync error, using local cache:', err);
    }
  }

  async function checkAuthAndSync() {
    await syncWithBackend();
  }

  let timerEventSource = null;
  let sseReconnectTimer = null;

  function initRealtimeTimerSync() {
    if (!state.authenticated) {
      if (timerEventSource) {
        timerEventSource.close();
        timerEventSource = null;
      }
      return;
    }

    if (timerEventSource && timerEventSource.readyState !== EventSource.CLOSED) {
      return;
    }

    try {
      if (timerEventSource) {
        timerEventSource.close();
      }

      timerEventSource = new EventSource('/api/timer/stream');

      timerEventSource.addEventListener('timer_state', (e) => {
        try {
          const serverTimer = JSON.parse(e.data);
          if (serverTimer) {
            applyLiveServerTimer(serverTimer);
          }
        } catch (err) {
          console.warn('StudyArc: Realtime SSE parse error:', err);
        }
      });

      timerEventSource.onerror = () => {
        if (timerEventSource) {
          timerEventSource.close();
          timerEventSource = null;
        }
        // Resilient auto-reconnect after 4 seconds
        if (!sseReconnectTimer) {
          sseReconnectTimer = setTimeout(() => {
            sseReconnectTimer = null;
            if (state.authenticated) {
              initRealtimeTimerSync();
            }
          }, 4000);
        }
      };
    } catch (err) {
      console.warn('StudyArc: EventSource setup error:', err);
    }
  }

  function applyLiveServerTimer(serverTimer) {
    if (!serverTimer) return;

    // 1. Immediately register & reflect active topic/task across devices without reloading!
    const incomingTask = serverTimer.activeTaskName || null;
    state.activeTaskName = incomingTask;

    if (serverTimer.hasCompleted) {
      const targetDuration = serverTimer.targetSeconds || 3600;
      const minutesCompleted = Math.max(1, Math.round(targetDuration / 60));
      const taskName = incomingTask || 'Focus Session';
      showToast(`Welcome back! Your focus on ${taskName} finished while away. (+${minutesCompleted} XP)`);
      logSession(minutesCompleted, taskName);

      state.timer.status = 'idle';
      state.timer.targetSeconds = targetDuration;
      state.timer.remainingSeconds = targetDuration;
      state.activeTaskName = null;
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      saveState();
      renderAll();
      return;
    }

    if (serverTimer.status === 'running') {
      state.timer.status = 'running';
      state.timer.targetSeconds = serverTimer.targetSeconds || 3600;

      // Exact time synchronization via mathematical delta
      const now = Date.now();
      if (serverTimer.startedAt) {
        const elapsed = (now - Number(serverTimer.startedAt)) / 1000;
        const baseRem = serverTimer.baseRemainingSeconds != null ? serverTimer.baseRemainingSeconds : serverTimer.remainingSeconds;
        const currentRemaining = Math.max(0, baseRem - elapsed);

        // If local is smoothly running within 2 seconds, avoid jitter
        if (state.timer.remainingSeconds == null || Math.abs(state.timer.remainingSeconds - currentRemaining) > 2) {
          state.timer.remainingSeconds = currentRemaining;
        }
      } else {
        state.timer.remainingSeconds = serverTimer.remainingSeconds;
      }

      state.timer.lastTickTime = now;
      if (!timerInterval) {
        timerInterval = setInterval(handleTimerTick, 500);
      }
      saveState();
      renderTimer();
      renderStats();
    } else if (serverTimer.status === 'paused') {
      state.timer.status = 'paused';
      state.timer.targetSeconds = serverTimer.targetSeconds || 3600;
      state.timer.remainingSeconds = serverTimer.remainingSeconds;
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      saveState();
      renderTimer();
      renderStats();
    } else {
      // Idle
      if (state.timer.status !== 'running' || !serverTimer.startedAt) {
        state.timer.status = 'idle';
        state.timer.targetSeconds = serverTimer.targetSeconds || 3600;
        state.timer.remainingSeconds = state.timer.targetSeconds;
        state.activeTaskName = null;
        if (timerInterval) {
          clearInterval(timerInterval);
          timerInterval = null;
        }
        saveState();
        renderTimer();
        renderStats();
      }
    }
  }

  function reconcileServerTimer(serverTimer) {
    applyLiveServerTimer(serverTimer);
  }

  async function syncTimerAction(action, extraPayload = {}) {
    if (!state.authenticated) return;
    try {
      await fetch('/api/timer/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          target_seconds: state.timer.targetSeconds,
          remaining_seconds: Math.round(state.timer.remainingSeconds),
          active_task_name: state.activeTaskName,
          ...extraPayload
        })
      });
    } catch (err) {
      console.warn('StudyArc: Persistent timer sync warning:', err);
    }
  }

  function updateAuthUI() {
    const btnHeaderAuth = document.getElementById('btn-header-auth');
    const headerUserBtn = document.getElementById('header-user-btn');
    const headerUserInitial = document.getElementById('header-user-initial');
    const headerUsernameText = document.getElementById('header-username-text');
    const settingAvatar = document.getElementById('setting-user-avatar');
    const settingUsername = document.getElementById('setting-username-display');
    const authDialog = document.getElementById('auth-dialog');

    if (state.authenticated && state.user) {
      const username = state.user.username || 'User';
      const initial = username.charAt(0).toUpperCase();

      if (btnHeaderAuth) btnHeaderAuth.classList.add('hidden');
      if (headerUserBtn) {
        headerUserBtn.classList.remove('hidden');
        if (headerUserInitial) headerUserInitial.textContent = initial;
        if (headerUsernameText) headerUsernameText.textContent = username;
      }
      if (settingAvatar) settingAvatar.textContent = initial;
      if (settingUsername) settingUsername.textContent = username;

      if (authDialog && authDialog.open) {
        authDialog.close();
      }
    } else {
      if (btnHeaderAuth) btnHeaderAuth.classList.remove('hidden');
      if (headerUserBtn) headerUserBtn.classList.add('hidden');
      if (settingAvatar) settingAvatar.textContent = '?';
      if (settingUsername) settingUsername.textContent = 'Not Signed In';
    }
  }

  function openAuthDialog(mode = 'login') {
    const dialog = document.getElementById('auth-dialog');
    if (!dialog) return;

    switchAuthTab(mode);

    // Clear error messages
    const loginError = document.getElementById('login-error-msg');
    const registerError = document.getElementById('register-error-msg');
    if (loginError) { loginError.textContent = ''; loginError.classList.add('hidden'); }
    if (registerError) { registerError.textContent = ''; registerError.classList.add('hidden'); }

    if (typeof dialog.showModal === 'function' && !dialog.open) {
      dialog.showModal();
    }
  }

  function closeAuthDialog() {
    const dialog = document.getElementById('auth-dialog');
    if (!dialog) return;

    if (!state.authenticated) {
      showToast('Please sign in or create an account to track your sessions.');
      return;
    }

    if (dialog.open) {
      dialog.close();
    }
  }

  function switchAuthTab(tab) {
    const tabLogin = document.getElementById('tab-auth-login');
    const tabRegister = document.getElementById('tab-auth-register');
    const formLogin = document.getElementById('form-auth-login');
    const formRegister = document.getElementById('form-auth-register');
    const modalTitle = document.getElementById('auth-modal-title');
    const modalSub = document.getElementById('auth-modal-sub');

    if (tab === 'login') {
      tabLogin?.classList.add('active');
      tabLogin?.setAttribute('aria-selected', 'true');
      tabRegister?.classList.remove('active');
      tabRegister?.setAttribute('aria-selected', 'false');

      formLogin?.classList.remove('hidden');
      formRegister?.classList.add('hidden');

      if (modalTitle) modalTitle.textContent = 'Welcome to StudyArc';
      if (modalSub) modalSub.textContent = 'Sign in to access your personal study records and sync timer state.';

      setTimeout(() => document.getElementById('login-username')?.focus(), 50);
    } else {
      tabRegister?.classList.add('active');
      tabRegister?.setAttribute('aria-selected', 'true');
      tabLogin?.classList.remove('active');
      tabLogin?.setAttribute('aria-selected', 'false');

      formRegister?.classList.remove('hidden');
      formLogin?.classList.add('hidden');

      if (modalTitle) modalTitle.textContent = 'Create Private Account';
      if (modalSub) modalSub.textContent = 'Set up a secure username and password for isolated study tracking.';

      setTimeout(() => document.getElementById('register-username')?.focus(), 50);
    }
  }

  async function handleLoginSubmit(e) {
    e.preventDefault();
    const usernameInput = document.getElementById('login-username');
    const passwordInput = document.getElementById('login-password');
    const errorEl = document.getElementById('login-error-msg');
    const submitBtn = document.getElementById('btn-login-submit');

    const username = (usernameInput?.value || '').trim();
    const password = passwordInput?.value || '';

    if (!username || !password) {
      if (errorEl) {
        errorEl.textContent = 'Please enter both username and password.';
        errorEl.classList.remove('hidden');
      }
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.querySelector('span').textContent = 'Signing in...';
    }
    if (errorEl) errorEl.classList.add('hidden');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();

      if (res.ok && data.success) {
        state.authenticated = true;
        state.user = data.user;
        updateAuthUI();
        closeAuthDialog();
        showToast(`Welcome back, ${data.user.username}!`);
        await syncWithBackend();
      } else {
        if (errorEl) {
          errorEl.textContent = data.error || 'Invalid username or password.';
          errorEl.classList.remove('hidden');
        }
      }
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = 'Connection error. Please try again.';
        errorEl.classList.remove('hidden');
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.querySelector('span').textContent = 'Sign In';
      }
    }
  }

  async function handleRegisterSubmit(e) {
    e.preventDefault();
    const usernameInput = document.getElementById('register-username');
    const passwordInput = document.getElementById('register-password');
    const confirmInput = document.getElementById('register-confirm');
    const errorEl = document.getElementById('register-error-msg');
    const submitBtn = document.getElementById('btn-register-submit');

    const username = (usernameInput?.value || '').trim();
    const password = passwordInput?.value || '';
    const confirmPassword = confirmInput?.value || '';

    if (errorEl) errorEl.classList.add('hidden');

    if (!username || username.length < 3) {
      if (errorEl) {
        errorEl.textContent = 'Username must be at least 3 characters long.';
        errorEl.classList.remove('hidden');
      }
      return;
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      if (errorEl) {
        errorEl.textContent = 'Username can only contain letters, numbers, and underscores.';
        errorEl.classList.remove('hidden');
      }
      return;
    }

    if (password.length < 6) {
      if (errorEl) {
        errorEl.textContent = 'Password must be at least 6 characters long.';
        errorEl.classList.remove('hidden');
      }
      return;
    }

    if (password !== confirmPassword) {
      if (errorEl) {
        errorEl.textContent = 'Passwords do not match.';
        errorEl.classList.remove('hidden');
      }
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.querySelector('span').textContent = 'Creating account...';
    }

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          confirm_password: confirmPassword
        })
      });
      const data = await res.json();

      if (res.ok && data.success) {
        state.authenticated = true;
        state.user = data.user;
        updateAuthUI();
        closeAuthDialog();
        showToast(`Account created! Welcome, ${data.user.username}!`);
        await syncWithBackend();
      } else {
        if (errorEl) {
          errorEl.textContent = data.error || 'Failed to create account.';
          errorEl.classList.remove('hidden');
        }
      }
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = 'Connection error. Please try again.';
        errorEl.classList.remove('hidden');
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.querySelector('span').textContent = 'Create Account';
      }
    }
  }

  async function handleLogout() {
    if (!confirm('Are you sure you want to sign out of StudyArc?')) return;
    if (timerEventSource) {
      timerEventSource.close();
      timerEventSource = null;
    }
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {
      console.warn('Logout error:', e);
    }
    state.authenticated = false;
    state.user = null;
    state.sessions = [];
    state.dayActivity = {};
    state.subjects = [];
    state.streak = 0;
    state.xp = 0;
    state.totalFocusSeconds = 0;
    state.timer.status = 'idle';
    state.timer.remainingSeconds = state.timer.targetSeconds;
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    saveState();
    renderAll();
    updateAuthUI();
    switchView('focus');
    showToast('Signed out successfully.');
    openAuthDialog('login');
  }

  // =========================================================================
  // HELPER UTILITIES
  // =========================================================================
  function getLocalDateString(dateObj = new Date()) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function formatDigitalTime(totalSecs) {
    const safeSecs = Math.max(0, Math.floor(totalSecs));
    const hrs = Math.floor(safeSecs / 3600);
    const mins = Math.floor((safeSecs % 3600) / 60);
    const secs = safeSecs % 60;
    const secsStr = String(secs).padStart(2, '0');

    if (hrs > 0) {
      const minsStr = String(mins).padStart(2, '0');
      return `${hrs}:${minsStr}:${secsStr}`;
    } else {
      return `${mins}:${secsStr}`;
    }
  }

  function formatHoursMinutes(totalSecs) {
    const totalMins = Math.floor(totalSecs / 60);
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return `${h}h ${m}m`;
  }

  // =========================================================================
  // AUDIO SYNTHESIZER (Web Audio API Chimes)
  // =========================================================================
  let audioContext = null;

  function initAudio() {
    if (!audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) audioContext = new AudioCtx();
    }
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume();
    }
  }

  function playChime(type) {
    if (!state.soundEnabled) return;
    try {
      initAudio();
      if (!audioContext) return;

      const now = audioContext.currentTime;

      if (type === 'complete') {
        // Soft meditative chime: C5 -> G5 -> C6
        const freqs = [523.25, 783.99, 1046.50];
        freqs.forEach((freq, idx) => {
          const osc = audioContext.createOscillator();
          const gain = audioContext.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, now + idx * 0.12);

          gain.gain.setValueAtTime(0.001, now + idx * 0.12);
          gain.gain.linearRampToValueAtTime(0.18, now + idx * 0.12 + 0.04);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.12 + 0.8);

          osc.connect(gain);
          gain.connect(audioContext.destination);
          osc.start(now + idx * 0.12);
          osc.stop(now + idx * 0.12 + 0.85);
        });
      } else if (type === 'start') {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(660, now + 0.08);

        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

        osc.connect(gain);
        gain.connect(audioContext.destination);
        osc.start(now);
        osc.stop(now + 0.19);
      } else if (type === 'reset') {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(320, now);
        osc.frequency.exponentialRampToValueAtTime(180, now + 0.18);

        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

        osc.connect(gain);
        gain.connect(audioContext.destination);
        osc.start(now);
        osc.stop(now + 0.23);
      }
    } catch (e) {
      console.warn('StudyArc audio error:', e);
    }
  }

  // =========================================================================
  // MINIMAL CIRCULAR TIMER ENGINE (MAX 3 HOURS, DRAGGABLE BEAD, HOLD TO RESET)
  // =========================================================================
  let timerInterval = null;
  let isCenterPadHolding = false;
  const MAX_TIMER_SECONDS = 3 * 3600; // 10,800s (3 hours)
  const RADIUS = 172;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS; // ~1080.7078px

  function updateTimerRing(seconds) {
    const arc = document.getElementById('timer-arc');
    const beadGroup = document.getElementById('timer-bead-group');
    if (!arc || !beadGroup) return;

    // Fraction of 3 hours (0 to 1)
    const fraction = Math.max(0, Math.min(1, seconds / MAX_TIMER_SECONDS));

    // Arc stroke-dashoffset (circle is rotated -90deg in SVG, so offset controls drawn arc length)
    const offset = CIRCUMFERENCE * (1 - fraction);
    arc.style.strokeDashoffset = offset;

    // Angle clockwise from 12 o'clock (0 = top, PI/2 = 3 o'clock, PI = 6 o'clock, etc.)
    const angle = fraction * 2 * Math.PI;
    const bx = 210 + RADIUS * Math.sin(angle);
    const by = 210 - RADIUS * Math.cos(angle);

    beadGroup.setAttribute('transform', `translate(${bx.toFixed(2)}, ${by.toFixed(2)})`);
  }

  // =========================================================================
  // CINEMATIC DIAL ENGINE (Zack 3D Depth-of-Field Wheel for numbers)
  // =========================================================================
  const easeInOutQuart = t => t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;

  // =========================================================================
  // CINEMATIC KINETIC DIAL ENGINE (Continuous Follower with Zack 3D Blur)
  // =========================================================================
  class DialColumn {
    constructor(parentEl, initialChar) {
      this.currentVal = parseInt(initialChar, 10) || 0;
      this.targetVal = this.currentVal;
      this.targetPos = this.currentVal;
      this.animating = false;
      this.rafId = null;
      this.lastTime = 0;

      this.col = document.createElement('span');
      this.col.className = 'dial-col';

      this.layoutHolder = document.createElement('span');
      this.layoutHolder.className = 'dial-layout-holder';
      this.layoutHolder.textContent = initialChar;
      this.col.appendChild(this.layoutHolder);

      this.activeLayer = document.createElement('span');
      this.activeLayer.className = 'dial-layer';
      this.activeLayer.textContent = initialChar;
      this.col.appendChild(this.activeLayer);

      this.nextLayer = document.createElement('span');
      this.nextLayer.className = 'dial-layer';
      this.nextLayer.textContent = '';
      this.nextLayer.style.opacity = '0';
      this.col.appendChild(this.nextLayer);

      parentEl.appendChild(this.col);
      renderDialColumn(this, this.currentVal, 0);
    }

    setStatic(digit) {
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this.animating = false;
      this.currentVal = parseInt(digit, 10) || 0;
      this.targetVal = this.currentVal;
      this.targetPos = this.currentVal;
      renderDialColumn(this, this.currentVal, 0);
    }

    animateTo(targetDigit, direction = 1, options = {}) {
      const targetInt = parseInt(targetDigit, 10) || 0;

      // If already targeting this digit, keep smoothly rolling!
      if (this.animating && this.targetVal === targetInt) {
        return;
      }

      // If already static at this exact target, nothing to do
      const currentInt = ((Math.round(this.currentVal) % 10) + 10) % 10;
      if (!this.animating && Math.abs(this.currentVal - Math.round(this.currentVal)) < 0.01 && currentInt === targetInt) {
        return;
      }

      let newTargetPos;
      if (direction >= 0) {
        // Find smallest integer >= currentVal with digit === targetInt
        const base = Math.floor(this.currentVal);
        const curDigit = ((base % 10) + 10) % 10;
        let diff = (targetInt - curDigit + 10) % 10;
        if (diff === 0 && this.currentVal > base + 0.01) {
          diff = 10;
        }
        newTargetPos = base + diff + (options.spins || 0) * 10;
      } else {
        // Find largest integer <= currentVal with digit === targetInt
        const base = Math.ceil(this.currentVal);
        const curDigit = ((base % 10) + 10) % 10;
        let diff = (curDigit - targetInt + 10) % 10;
        if (diff === 0 && this.currentVal < base - 0.01) {
          diff = 10;
        }
        newTargetPos = base - diff - (options.spins || 0) * 10;
      }

      this.targetPos = newTargetPos;
      this.targetVal = targetInt;

      // Start the RAF loop only if not already animating
      if (!this.animating) {
        this.animating = true;
        this.lastTime = performance.now();
        this.rafId = requestAnimationFrame(this.tick.bind(this));
      }
    }

    tick(now) {
      if (!this.animating) return;

      const dt = Math.min(0.04, (now - this.lastTime) / 1000 || 0.016);
      this.lastTime = now;

      const diff = this.targetPos - this.currentVal;
      const dist = Math.abs(diff);

      if (dist < 0.008) {
        const finalDigit = ((Math.round(this.targetPos) % 10) + 10) % 10;
        this.currentVal = finalDigit;
        this.targetPos = finalDigit;
        this.targetVal = finalDigit;
        renderDialColumn(this, finalDigit, 0);
        this.animating = false;
        this.rafId = null;
        return;
      }

      // Dynamic pacing:
      // Single-step adjustments (dist ~ 1): decay ~ 8.5 (smooth ~320ms roll)
      // Fast sweeping or hold drain (dist > 1.2): decay scales up dynamically so it tracks responsively
      const decay = dist <= 1.2 ? 8.5 : Math.min(18, 8.5 + (dist - 1.2) * 1.8);
      const factor = 1 - Math.exp(-decay * dt);
      this.currentVal += diff * factor;

      // Motion blur proportional to velocity (Zack 3D depth-of-field blur)
      const speed = dist * decay;
      const blur = Math.min(6.5, Math.max(0, (speed - 2.5) * 0.22));

      renderDialColumn(this, this.currentVal, blur);

      this.rafId = requestAnimationFrame(this.tick.bind(this));
    }

    destroy() {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.animating = false;
      this.col.remove();
    }
  }

  function renderDialColumn(col, v, maxBlur = 5.5) {
    const base = Math.floor(v);
    const f = v - base; // 0.0 <= f < 1.0
    const d1 = ((base % 10) + 10) % 10;
    const d2 = (d1 + 1) % 10;

    if (f < 0.001) {
      col.layoutHolder.textContent = String(d1);
      col.activeLayer.textContent = String(d1);
      col.activeLayer.style.transform = 'translateY(0%) scale(1)';
      col.activeLayer.style.filter = 'blur(0px)';
      col.activeLayer.style.opacity = '1';
      col.nextLayer.textContent = '';
      col.nextLayer.style.opacity = '0';
      return;
    }

    col.layoutHolder.textContent = String(d1);
    col.activeLayer.textContent = String(d1);
    col.nextLayer.textContent = String(d2);

    // Outgoing layer (d1, moving UP towards -50%)
    const oldY = -50 * f;
    const oldScale = 1 - f;
    const oldBlur = Math.pow(f, 3) * maxBlur;

    col.activeLayer.style.transform = `translateY(${oldY.toFixed(2)}%) scale(${oldScale.toFixed(3)})`;
    col.activeLayer.style.filter = `blur(${oldBlur.toFixed(2)}px)`;
    col.activeLayer.style.opacity = (1 - f).toFixed(3);

    // Incoming layer (d2, moving IN from bottom +50% towards 0%)
    const newY = 50 * (1 - f);
    const newScale = f;
    const newBlur = Math.pow(1 - f, 3) * maxBlur;

    col.nextLayer.style.transform = `translateY(${newY.toFixed(2)}%) scale(${newScale.toFixed(3)})`;
    col.nextLayer.style.filter = `blur(${newBlur.toFixed(2)}px)`;
    col.nextLayer.style.opacity = f.toFixed(3);
  }

  class DialController {
    constructor(containerEl, fixedLength = null) {
      this.container = containerEl;
      this.value = '';
      this.columns = [];
      this.fixedLength = fixedLength;
    }

    setValue(newValStr, animate = true, direction = 1, options = {}) {
      newValStr = String(newValStr);
      const targetLen = this.fixedLength || newValStr.length;

      if (this.columns.length !== targetLen) {
        this.columns.forEach(c => c.destroy());
        this.columns = [];
        if (this.container) this.container.innerHTML = '';
        for (let i = 0; i < targetLen; i++) {
          this.columns.push(new DialColumn(this.container, '0'));
        }
      }

      // If newValStr is shorter than targetLen (e.g. "9" with targetLen 2):
      // The leading column is hidden cleanly without destroying DOM
      const paddedStr = newValStr.padStart(targetLen, '0');
      const hideCount = Math.max(0, targetLen - newValStr.length);

      for (let i = 0; i < targetLen; i++) {
        const col = this.columns[i];
        if (i < hideCount) {
          col.col.style.display = 'none';
        } else {
          col.col.style.display = 'inline-flex';
        }

        const char = paddedStr[i];
        if (animate) {
          col.animateTo(char, direction, options);
        } else {
          col.setStatic(char);
        }
      }

      this.value = newValStr;
    }
  }

  let hoursDial = null;
  let minsDial = null;
  let secsDial = null;
  let lastDigitalSecs = -1;

  function ensureDialControllers() {
    const hoursVal = document.getElementById('timer-hours-val');
    const minsVal = document.getElementById('timer-mins-val');
    const secsVal = document.getElementById('timer-secs-val');

    if (hoursVal && (!hoursDial || hoursDial.container !== hoursVal)) {
      hoursDial = new DialController(hoursVal, 1);
    }
    if (minsVal && (!minsDial || minsDial.container !== minsVal)) {
      minsDial = new DialController(minsVal, 2);
    }
    if (secsVal && (!secsDial || secsDial.container !== secsVal)) {
      secsDial = new DialController(secsVal, 2);
    }
  }

  function updateDigitalDisplay(totalSecs, forceNoAnim = false, options = {}) {
    const digitsEl = document.getElementById('timer-digits');
    if (!digitsEl) return;

    const safeSecs = Math.max(0, Math.floor(totalSecs));
    const hrs = Math.floor(safeSecs / 3600);
    const mins = Math.floor((safeSecs % 3600) / 60);
    const secs = safeSecs % 60;
    const hasHours = hrs > 0;

    // Toggle sub-hour class for seamless animated collapse and scale
    digitsEl.classList.toggle('has-hours', hasHours);
    digitsEl.classList.toggle('is-sub-hour', !hasHours);

    ensureDialControllers();

    // Determine direction and whether to animate:
    // When time decreases (countdown, hold-drain, sliding down): dir = -1 (down)
    // When time increases (sliding up): dir = 1 (up)
    const timeDelta = lastDigitalSecs === -1 ? 0 : (safeSecs - lastDigitalSecs);
    const dir = timeDelta >= 0 ? 1 : -1;
    const shouldAnimate = !forceNoAnim && lastDigitalSecs !== -1 && timeDelta !== 0;
    lastDigitalSecs = safeSecs;

    const dialOptions = { ...options, totalDelta: timeDelta };

    // 1. Hours: only update when hasHours is true
    if (hrs > 0 && hoursDial) {
      hoursDial.setValue(String(hrs), shouldAnimate, dir, dialOptions);
    }

    // 2. Minutes: no leading zero when sub-hour (e.g. "59", "9", "0"), pad to 2 digits when >= 1 hr
    if (minsDial) {
      const minStr = hasHours ? String(mins).padStart(2, '0') : String(mins);
      minsDial.setValue(minStr, shouldAnimate, dir, dialOptions);
    }

    // 3. Seconds: always 2 digits
    if (secsDial) {
      const secStr = String(secs).padStart(2, '0');
      secsDial.setValue(secStr, shouldAnimate, dir, dialOptions);
    }
  }

  function renderTimerDisplay(seconds, options = {}) {
    updateDigitalDisplay(seconds, false, options);
    updateTimerRing(seconds);
  }

  function renderTimer() {
    renderTimerDisplay(state.timer.remainingSeconds);

    const timerSection = document.querySelector('.timer-section');
    const centerPad = document.getElementById('timer-center-pad');
    const headerPill = document.getElementById('header-topic-pill');
    const headerTopicName = document.getElementById('header-topic-name');

    const hasActiveTask = Boolean(state.activeTaskName);

    if (hasActiveTask) {
      timerSection?.classList.add('is-session-locked');

      // Top bar topic pill: visible ONLY when timer is set with a topic
      if (headerPill) {
        headerPill.classList.remove('hidden');
        headerPill.title = state.activeTaskName;
        headerPill.classList.toggle('is-running', state.timer.status === 'running');
        headerPill.classList.toggle('is-paused', state.timer.status === 'paused');
      }
      if (headerTopicName) {
        headerTopicName.textContent = state.activeTaskName;
      }

      if (state.timer.status === 'running') {
        timerSection?.classList.add('is-running');
        timerSection?.classList.remove('is-paused');
        centerPad?.setAttribute('aria-label', `Focusing on ${state.activeTaskName}. Tap to pause, hold 1.2s to save.`);
        document.title = `(${formatDigitalTime(state.timer.remainingSeconds)}) ${state.activeTaskName} • StudyArc`;
      } else if (state.timer.status === 'paused') {
        timerSection?.classList.remove('is-running');
        timerSection?.classList.add('is-paused');
        centerPad?.setAttribute('aria-label', `Paused on ${state.activeTaskName}. Tap to resume, hold 1.2s to save.`);
        document.title = `Paused (${formatDigitalTime(state.timer.remainingSeconds)}) • StudyArc`;
      } else {
        timerSection?.classList.remove('is-running', 'is-paused');
        centerPad?.setAttribute('aria-label', `Ready to focus on ${state.activeTaskName}. Tap to start.`);
        document.title = `StudyArc — Minimal Focus & Habit Tracker`;
      }
    } else {
      timerSection?.classList.remove('is-session-locked', 'is-running', 'is-paused');

      // Top bar topic pill: completely hidden when idle, keeping top bar empty!
      if (headerPill) {
        headerPill.classList.add('hidden');
        headerPill.classList.remove('is-running', 'is-paused');
      }
      if (headerTopicName) {
        headerTopicName.textContent = '';
      }

      centerPad?.setAttribute('aria-label', 'Timer ready. Tap to start, drag bead to adjust.');
      document.title = `StudyArc — Minimal Focus & Habit Tracker`;
    }

    updateTodayLiveStat();
  }

  function updateTodayLiveStat() {
    const todayStatEl = document.getElementById('stat-today-focus');
    const statItemToday = document.getElementById('stat-item-today');
    if (!todayStatEl) return;

    const todayStr = getLocalDateString();
    const loggedMinutes = state.dayActivity[todayStr] || 0;
    const loggedSeconds = loggedMinutes * 60;

    let currentElapsed = 0;
    if (state.timer.status === 'running' || state.timer.status === 'paused') {
      currentElapsed = Math.max(0, state.timer.targetSeconds - state.timer.remainingSeconds);
    }

    const totalSecs = Math.max(0, Math.floor(loggedSeconds + currentElapsed));
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    const secStr = String(secs).padStart(2, '0') + 's';

    todayStatEl.textContent = hrs > 0
      ? `${hrs}h ${String(mins).padStart(2, '0')}m ${secStr}`
      : `${mins}m ${secStr}`;

    if (statItemToday) {
      statItemToday.title = `Today's Focus: ${todayStatEl.textContent} • Click to view Day Record`;
      statItemToday.classList.toggle('is-running', state.timer.status === 'running');
      statItemToday.classList.toggle('is-paused', state.timer.status === 'paused');
    }
  }

  function startTimer() {
    initAudio();
    playChime('start');

    state.timer.status = 'running';
    state.timer.startTime = Date.now();
    state.timer.lastTickTime = Date.now();
    saveState();

    if (!timerInterval) {
      timerInterval = setInterval(handleTimerTick, 500);
    }
    renderTimer();
    syncTimerAction('start', {
      target_seconds: state.timer.targetSeconds,
      remaining_seconds: Math.round(state.timer.remainingSeconds),
      active_task_name: state.activeTaskName
    });
  }

  function pauseTimer() {
    state.timer.status = 'paused';
    state.timer.startTime = null;
    state.timer.lastTickTime = null;
    saveState();

    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    renderTimer();
    syncTimerAction('pause', {
      remaining_seconds: Math.round(state.timer.remainingSeconds)
    });
  }

  let tickCounter = 0;
  function handleTimerTick() {
    if (state.timer.status !== 'running') return;
    if (isCenterPadHolding) return;

    const now = Date.now();
    const deltaSeconds = (now - state.timer.lastTickTime) / 1000;
    state.timer.lastTickTime = now;

    state.timer.remainingSeconds -= deltaSeconds;

    if (state.timer.remainingSeconds <= 0) {
      completeSession();
    } else {
      renderTimer();
    }

    tickCounter++;
    if (tickCounter % 10 === 0) {
      saveState();
    }
  }

  async function logSession(minutesCompleted, subjectName = null) {
    if (minutesCompleted < 1) return;
    const todayStr = getLocalDateString();
    const subj = subjectName || state.activeTaskName || (state.subjects && state.subjects.length > 0 ? state.subjects[0].name : 'Focus Session');
    const now = Date.now();
    const startMs = state.activeTaskStartTime || (now - minutesCompleted * 60000);
    const startD = new Date(startMs);
    const endD = new Date(now);
    const startStr = formatTime(startD);
    const endStr = formatTime(endD);
    const timeRangeStr = `${startStr} – ${endStr}`;

    // Optimistic local update
    state.xp += minutesCompleted;
    state.totalFocusSeconds += minutesCompleted * 60;
    state.dayActivity[todayStr] = (state.dayActivity[todayStr] || 0) + minutesCompleted;

    state.sessions.unshift({
      id: 'sess_' + now,
      date: todayStr,
      durationMinutes: minutesCompleted,
      subject: subj,
      timestamp: now,
      startTime: startStr,
      endTime: endStr,
      timeRange: timeRangeStr,
      xp: minutesCompleted
    });

    updateStreak();
    saveState();
    renderAll();

    // Persist session to SQLite backend
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject_name: subj,
          duration_minutes: minutesCompleted,
          date: todayStr,
          timestamp: now,
          start_time: startStr,
          end_time: endStr
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          if (data.stats) {
            state.streak = data.stats.streak || 0;
            state.xp = data.stats.xp || 0;
            state.totalFocusSeconds = data.stats.totalFocusSeconds || 0;
          }
          if (data.dayActivity) {
            state.dayActivity = data.dayActivity;
          }
          if (data.subjects) {
            state.subjects = data.subjects;
          }
          saveState();
          renderAll();
        }
      }
    } catch (err) {
      console.warn('StudyArc: SQLite sync error:', err);
    }
  }

  function completeSession() {
    state.timer.remainingSeconds = 0;
    pauseTimer();
    playChime('complete');

    const taskName = state.activeTaskName || 'Focus Session';
    const targetDuration = state.activeTaskTargetSeconds || state.timer.targetSeconds;
    const minutesCompleted = Math.max(1, Math.round(targetDuration / 60));
    logSession(minutesCompleted, taskName);

    showToast(`Completed ${minutesCompleted}m focus on ${taskName}! (+${minutesCompleted} XP)`);

    state.activeTaskName = null;
    state.activeTaskStartTime = null;
    state.activeTaskTargetSeconds = null;

    // Reset back to set target duration
    state.timer.remainingSeconds = state.timer.targetSeconds;
    state.timer.status = 'idle';
    saveState();
    renderAll();
  }

  function updateStreak() {
    const today = new Date();
    const todayStr = getLocalDateString(today);

    let currentStreak = 0;
    let checkDate = new Date(today);

    // If today has no activity yet, check starting yesterday
    if (!state.dayActivity[todayStr]) {
      checkDate.setDate(checkDate.getDate() - 1);
    }

    while (true) {
      const dStr = getLocalDateString(checkDate);
      if (state.dayActivity[dStr] && state.dayActivity[dStr] > 0) {
        currentStreak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }

    state.streak = currentStreak;
  }

  // =========================================================================
  // INTERACTIVE BEAD DRAGGING (MAX 3 HOURS, 1 MINUTE RESOLUTION)
  // =========================================================================
  function initBeadDragging() {
    const svg = document.getElementById('timer-svg');
    const beadGroup = document.getElementById('timer-bead-group');
    const centerPad = document.getElementById('timer-center-pad');
    if (!svg || !beadGroup) return;

    let isDragging = false;
    let lastVibrateMin = -1;

    function getMinutesFromPointer(clientX, clientY) {
      const rect = svg.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const dx = clientX - centerX;
      const dy = clientY - centerY;

      // Clockwise angle from 12 o'clock (0 = top, PI/2 = 3 o'clock, PI = 6 o'clock, 3PI/2 = 9 o'clock)
      let angleRad = Math.atan2(dx, -dy);
      if (angleRad < 0) {
        angleRad += 2 * Math.PI;
      }

      const fraction = angleRad / (2 * Math.PI);
      let minutes = Math.round(fraction * 180); // 180 minutes = 3 hours
      if (minutes < 1) minutes = 1;
      if (minutes > 180) minutes = 180;
      return minutes;
    }

    let dragDigitalRaf = null;

    function onPointerMove(e) {
      if (!isDragging) return;
      e.preventDefault();

      const minutes = getMinutesFromPointer(e.clientX, e.clientY);

      // Gentle haptic tick on 15m intervals
      if (minutes % 15 === 0 && minutes !== lastVibrateMin) {
        if (navigator.vibrate) navigator.vibrate(6);
        lastVibrateMin = minutes;
      }

      const newSeconds = minutes * 60;
      state.timer.targetSeconds = newSeconds;
      state.timer.remainingSeconds = newSeconds;
      state.timer.status = 'idle';

      // Ring arc and bead position update IMMEDIATELY for 0-latency tracking
      updateTimerRing(newSeconds);

      // Digital display updates throttled to animation frame so transitions roll without cancellation
      if (!dragDigitalRaf) {
        dragDigitalRaf = requestAnimationFrame(() => {
          dragDigitalRaf = null;
          updateDigitalDisplay(state.timer.remainingSeconds);
        });
      }
    }

    function onPointerUp(e) {
      if (!isDragging) return;
      isDragging = false;
      document.body.classList.remove('is-dragging');
      beadGroup.classList.remove('dragging');

      if (dragDigitalRaf) {
        cancelAnimationFrame(dragDigitalRaf);
        dragDigitalRaf = null;
      }

      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      saveState();
      // On release: ensure digits firmly and gracefully settle on target
      renderTimerDisplay(state.timer.remainingSeconds, { duration: 320 });
      syncTimerAction('adjust', { target_seconds: state.timer.targetSeconds });
    }

    function startDragging(e) {
      if (e.button && e.button !== 0) return; // Only primary mouse button or touch
      e.preventDefault();
      e.stopPropagation();

      // If in an active task session, dragging bead or rim is locked!
      if (state.activeTaskName || state.timer.status !== 'idle') {
        showToast('Timer locked in session. Hold 1.2s to save & exit before changing time.');
        return;
      }

      isDragging = true;
      document.body.classList.add('is-dragging');
      beadGroup.classList.add('dragging');

      const minutes = getMinutesFromPointer(e.clientX, e.clientY);
      const newSeconds = minutes * 60;
      state.timer.targetSeconds = newSeconds;
      state.timer.remainingSeconds = newSeconds;
      state.timer.status = 'idle';
      renderTimerDisplay(newSeconds);

      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    }

    beadGroup.addEventListener('pointerdown', startDragging);

    // Also allow grabbing anywhere on the SVG outer ring (outside center pad)
    svg.addEventListener('pointerdown', (e) => {
      if (state.activeTaskName || state.timer.status !== 'idle') {
        return; // Locked in session
      }
      if (e.target && beadGroup.contains(e.target)) return;
      if (centerPad) {
        const padRect = centerPad.getBoundingClientRect();
        const padCx = padRect.left + padRect.width / 2;
        const padCy = padRect.top + padRect.height / 2;
        const dist = Math.hypot(e.clientX - padCx, e.clientY - padCy);
        if (dist <= padRect.width / 2) {
          return; // Inside center pad: handled by center pad
        }
      }
      startDragging(e);
    });
  }

  // =========================================================================
  // CENTER TIMER PAD: TAP TO START/PAUSE, 2-SECOND HOLD TO RESET
  // =========================================================================
  function initCenterPadInteraction() {
    const pad = document.getElementById('timer-center-pad');
    if (!pad) return;

    // Grace delay: normal clicks last ~80-160ms. Hold drain activates after 220ms
    const HOLD_DELAY_MS = 220;
    const TOTAL_HOLD_MS = 1200; // 1.2-second hold period
    const DRAIN_MS = TOTAL_HOLD_MS - HOLD_DELAY_MS; // 980ms drain

    let holdRaf = null;
    let holdDelayTimer = null;
    let pointerDownTime = 0;
    let drainStartTime = 0;
    let isPointerDown = false;
    let isDraining = false;
    let holdStartRemaining = 0;
    let holdCompleted = false;

    function stepHold(now) {
      if (!isDraining) return;
      const elapsed = now - drainStartTime;
      const progress = Math.min(1, elapsed / DRAIN_MS);

      // 1. The green timer arc visibly drains to empty over DRAIN_MS!
      const visualSeconds = Math.max(0, holdStartRemaining * (1 - progress));
      updateTimerRing(visualSeconds);

      // 2. The countdown numbers visibly decrease with smooth rolling animation in real-time!
      updateDigitalDisplay(visualSeconds);

      if (progress >= 1) {
        // Complete 1.2-second hold: Trigger Save Progress & Exit!
        holdCompleted = true;
        isDraining = false;
        isCenterPadHolding = false;
        document.body.classList.remove('is-holding');
        pad.classList.remove('holding');

        if (navigator.vibrate) navigator.vibrate([40, 50, 40]);
        playChime('reset');

        if (state.activeTaskName) {
          const taskName = state.activeTaskName;
          const targetSecs = state.activeTaskTargetSeconds || state.timer.targetSeconds;
          const elapsedStudy = Math.max(0, targetSecs - holdStartRemaining);
          const minutesLogged = Math.round(elapsedStudy / 60);

          if (minutesLogged >= 1) {
            logSession(minutesLogged, taskName);
            showToast(`Saved ${minutesLogged}m of ${taskName}! (+${minutesLogged} XP)`);
          } else {
            showToast('Focus session ended (less than 1 minute).');
          }
        } else {
          showToast('Timer reset.');
        }

        pauseTimer();
        state.activeTaskName = null;
        state.activeTaskStartTime = null;
        state.activeTaskTargetSeconds = null;

        state.timer.remainingSeconds = state.timer.targetSeconds;
        state.timer.status = 'idle';
        saveState();
        syncTimerAction('reset', { target_seconds: state.timer.targetSeconds });
        renderAll();
        return;
      }

      holdRaf = requestAnimationFrame(stepHold);
    }

    function startHoldDrain() {
      if (!isPointerDown) return;
      isDraining = true;
      drainStartTime = performance.now();
      document.body.classList.add('is-holding');
      pad.classList.add('holding');

      cancelAnimationFrame(holdRaf);
      holdRaf = requestAnimationFrame(stepHold);
    }

    pad.addEventListener('pointerdown', (e) => {
      if (e.button && e.button !== 0) return; // Only primary mouse button or touch
      isPointerDown = true;
      isDraining = false;
      holdCompleted = false;
      isCenterPadHolding = true;
      pointerDownTime = performance.now();
      holdStartRemaining = state.timer.remainingSeconds;

      clearTimeout(holdDelayTimer);
      cancelAnimationFrame(holdRaf);

      // Capture pointer so movement or mouse drift does not interrupt hold/click
      pad.setPointerCapture?.(e.pointerId);

      // Delay before triggering drain animation so clicks NEVER see the drain
      holdDelayTimer = setTimeout(startHoldDrain, HOLD_DELAY_MS);
    });

    function handlePointerRelease(e) {
      if (!isPointerDown) return;
      isPointerDown = false;

      clearTimeout(holdDelayTimer);
      cancelAnimationFrame(holdRaf);

      if (pad.hasPointerCapture?.(e.pointerId)) {
        pad.releasePointerCapture(e.pointerId);
      }

      const wasDraining = isDraining;
      isDraining = false;
      isCenterPadHolding = false;
      document.body.classList.remove('is-holding');
      pad.classList.remove('holding');

      if (holdCompleted) {
        return;
      }

      const pressDuration = performance.now() - pointerDownTime;
      if (!wasDraining && pressDuration < 450) {
        // Clean quick click/tap: toggle Play / Pause / New Task!
        handlePlayPauseAction();
      } else if (wasDraining) {
        // Held partially (>220ms) but released before 1.2s: restore display cleanly
        renderTimerDisplay(state.timer.remainingSeconds, { duration: 340 });
        if (state.timer.status === 'running') {
          state.timer.lastTickTime = Date.now();
        }
      }
    }

    pad.addEventListener('pointerup', handlePointerRelease);
    pad.addEventListener('pointercancel', handlePointerRelease);

    // Prevent default context menu on long press on mobile
    pad.addEventListener('contextmenu', (e) => e.preventDefault());

    // Keyboard accessibility: Space or Enter toggles timer
    pad.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handlePlayPauseAction();
      }
    });
  }

  // =========================================================================
  // TASK FOCUS PROMPT & ACTIONS
  // =========================================================================
  function handlePlayPauseAction() {
    if (state.timer.status === 'running') {
      pauseTimer();
    } else if (state.timer.status === 'paused') {
      // Already has active task session -> Resume directly without prompt!
      startTimer();
    } else {
      // Status is 'idle' -> Prompt for new task name before starting!
      openTaskPromptDialog();
    }
  }

  function openTaskPromptDialog() {
    const dialog = document.getElementById('task-prompt-dialog');
    const input = document.getElementById('input-task-name');
    const durationPill = document.getElementById('task-prompt-duration');
    const chipsContainer = document.getElementById('task-suggestions-chips');
    if (!dialog) return;

    const targetMins = Math.round(state.timer.targetSeconds / 60);
    if (durationPill) {
      durationPill.textContent = `⏱️ ${targetMins} mins`;
    }

    if (input) {
      input.value = '';
    }

    if (chipsContainer) {
      const subjectsList = (state.subjects && state.subjects.length > 0)
        ? state.subjects.map(s => s.name || s)
        : ['Computer Science', 'Mathematics', 'System Architecture', 'Cognitive Science', 'Machine Learning'];

      const uniqueNames = Array.from(new Set(subjectsList)).slice(0, 8);

      chipsContainer.innerHTML = uniqueNames.map(name => `
        <button type="button" class="task-chip" data-name="${escapeHtml(name)}">${escapeHtml(name)}</button>
      `).join('');

      chipsContainer.querySelectorAll('.task-chip').forEach(btn => {
        btn.addEventListener('click', () => {
          if (input) {
            input.value = btn.dataset.name;
            input.focus();
          }
        });
      });
    }

    if (typeof dialog.showModal === 'function' && !dialog.open) {
      dialog.showModal();
      setTimeout(() => input?.focus(), 50);
    }
  }

  function closeTaskPromptDialog() {
    const dialog = document.getElementById('task-prompt-dialog');
    if (dialog && dialog.open) {
      dialog.close();
    }
  }

  function startTaskSession(taskName) {
    const cleanName = (taskName || '').trim() || 'Focus Session';
    state.activeTaskName = cleanName;
    state.activeTaskStartTime = Date.now();
    state.activeTaskTargetSeconds = state.timer.targetSeconds;
    state.timer.remainingSeconds = state.timer.targetSeconds;
    saveState();
    closeTaskPromptDialog();
    startTimer();
    renderTimer();
    showToast(`Focus session started: ${cleanName}`);
  }

  let toastTimeout = null;
  function showToast(message) {
    const toast = document.getElementById('toast-notification');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.remove('hidden');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.classList.add('hidden');
    }, 3200);
  }

  // =========================================================================
  // GITHUB-STYLE MULTI-MONTH ACTIVITY HEATMAP (CALENDAR ACCURATE & EXPANSIVE)
  // =========================================================================
  const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Default general highest focus threshold in a day (4 hours = 240 mins)
  const DEFAULT_PEAK_MINUTES = 240;

  // Multi-tier color stops calibrated for dark mode: from subtle dark jade to peak luminous mint
  const HEATMAP_COLOR_STOPS = [
    { mins: 0,   r: 20,  g: 27,  b: 24  }, // #141B18 (Empty tile)
    { mins: 12,  r: 21,  g: 51,  b: 34  }, // #153322 (Quick 10-15m burst: subtle deep jade)
    { mins: 25,  r: 24,  g: 69,  b: 43  }, // #18452B (25m Pomodoro: light pine)
    { mins: 45,  r: 28,  g: 88,  b: 54  }, // #1C5836 (45m solid focus: forest green)
    { mins: 70,  r: 33,  g: 110, b: 67  }, // #216E43 (~1.1h: medium emerald)
    { mins: 100, r: 40,  g: 136, b: 82  }, // #288852 (~1.6h: rich emerald)
    { mins: 135, r: 50,  g: 164, b: 98  }, // #32A462 (~2.25h: vivid spring mint)
    { mins: 175, r: 66,  g: 194, b: 118 }, // #42C276 (~2.9h: vibrant mint)
    { mins: 210, r: 96,  g: 220, b: 146 }, // #60DC92 (~3.5h: bright electric mint)
    { mins: 240, r: 163, g: 240, b: 186 }  // #A3F0BA (4.0h+ peak highest focus: radiant mint)
  ];

  // Mathematical smooth-step interpolation yielding a distinct, flexible shade per minute
  function getHeatmapCellColor(minutes, customPeak = 240) {
    if (!minutes || minutes <= 0) {
      return { color: 'rgb(20, 27, 24)', level: 0, isPeak: false };
    }

    const peakMins = Math.max(60, customPeak || DEFAULT_PEAK_MINUTES);
    // Scale minutes proportionally to the 240-minute reference stops
    const scaledMins = Math.min(240, (minutes / peakMins) * 240);

    if (scaledMins >= 240 || minutes >= peakMins) {
      const peak = HEATMAP_COLOR_STOPS[HEATMAP_COLOR_STOPS.length - 1];
      return {
        color: `rgb(${peak.r}, ${peak.g}, ${peak.b})`,
        level: 9,
        isPeak: true
      };
    }

    for (let i = 0; i < HEATMAP_COLOR_STOPS.length - 1; i++) {
      const s1 = HEATMAP_COLOR_STOPS[i];
      const s2 = HEATMAP_COLOR_STOPS[i + 1];
      if (scaledMins >= s1.mins && scaledMins <= s2.mins) {
        const t = (scaledMins - s1.mins) / (s2.mins - s1.mins);
        // Smooth easing for natural perceptual step transitions
        const easeT = t * t * (3 - 2 * t);
        const r = Math.round(s1.r + easeT * (s2.r - s1.r));
        const g = Math.round(s1.g + easeT * (s2.g - s1.g));
        const b = Math.round(s1.b + easeT * (s2.b - s1.b));
        const level = Math.min(9, Math.max(1, i + (t > 0.5 ? 1 : 0)));
        return {
          color: `rgb(${r}, ${g}, ${b})`,
          level: level,
          isPeak: scaledMins >= 225
        };
      }
    }

    return { color: 'rgb(20, 27, 24)', level: 0, isPeak: false };
  }

  function createMonthBlock(year, monthIndex) {
    const monthBlock = document.createElement('div');
    monthBlock.className = 'month-block';
    monthBlock.dataset.year = year;
    monthBlock.dataset.month = monthIndex;

    const monthLabel = document.createElement('div');
    monthLabel.className = 'month-label';
    monthLabel.textContent = SHORT_MONTHS[monthIndex];
    monthBlock.appendChild(monthLabel);

    const weeksWrap = document.createElement('div');
    weeksWrap.className = 'month-weeks';

    // Exact days in this month
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

    // Day of the week for day 1 (Monday = 0, Tuesday = 1, ..., Sunday = 6)
    const firstDayOfWeek = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
    const totalSlots = firstDayOfWeek + daysInMonth;
    const numCols = Math.ceil(totalSlots / 7);

    const todayStr = getLocalDateString();

    for (let c = 0; c < numCols; c++) {
      const col = document.createElement('div');
      col.className = 'week-col';

      for (let r = 0; r < 7; r++) {
        const dayNum = c * 7 + r - firstDayOfWeek + 1;
        const cell = document.createElement('div');
        cell.className = 'cell';

        if (dayNum < 1 || dayNum > daysInMonth) {
          // Empty slot before month starts or after month ends: invisible spacer
          cell.classList.add('cell-spacer');
        } else {
          // Exact calendar date
          const cellDate = new Date(year, monthIndex, dayNum);
          const dStr = getLocalDateString(cellDate);
          const mins = state.dayActivity[dStr] || 0;

          // Distinct shade of green calculated continuously per minute
          const colorInfo = getHeatmapCellColor(mins, state.heatmapPeakMinutes || DEFAULT_PEAK_MINUTES);
          cell.style.backgroundColor = colorInfo.color;
          cell.classList.add(`cell-lvl-${colorInfo.level}`);
          if (colorInfo.isPeak) {
            cell.classList.add('cell-peak');
          }

          if (dStr === todayStr) {
            cell.classList.add('is-today');
          }

          cell.dataset.date = dStr;
          cell.dataset.minutes = mins;

          cell.addEventListener('mouseenter', handleCellHover);
          cell.addEventListener('mouseleave', handleCellLeave);
          cell.addEventListener('click', (e) => {
            e.stopPropagation();
            handleCellLeave();
            openDayDialog(dStr);
          });
        }

        col.appendChild(cell);
      }

      weeksWrap.appendChild(col);
    }

    monthBlock.appendChild(weeksWrap);
    return monthBlock;
  }

  function renderHeatmap() {
    const trackEl = document.getElementById('heatmap-track');
    const scrollArea = document.getElementById('heatmap-scroll-area');
    if (!trackEl || !scrollArea) return;

    trackEl.innerHTML = '';

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();

    const yearBadge = document.getElementById('heatmap-year-badge');
    if (yearBadge) {
      yearBadge.textContent = currentYear;
      state.viewedYear = currentYear;
    }

    // 1. Build previous year's 12 months (Jan to Dec) as past history
    for (let m = 0; m < 12; m++) {
      const block = createMonthBlock(currentYear - 1, m);
      trackEl.appendChild(block);
    }

    // 2. Build current year's months up to current month (so current month is the recent month in last place!)
    for (let m = 0; m <= currentMonth; m++) {
      const block = createMonthBlock(currentYear, m);
      trackEl.appendChild(block);
    }

    // By default: scroll to the end so the current month is in the last place and history shows to the left
    requestAnimationFrame(() => {
      scrollHeatmapToEnd(false);
      setTimeout(() => {
        scrollHeatmapToEnd(false);
      }, 60);
    });

    scrollArea.onscroll = () => {
      updateYearBadgeFromScroll();
    };

    setupHeatmapInteraction();
  }

  function scrollHeatmapToEnd(smooth = false) {
    const scrollArea = document.getElementById('heatmap-scroll-area');
    if (!scrollArea) return;
    const maxScroll = Math.max(0, scrollArea.scrollWidth - scrollArea.clientWidth);
    if (smooth) {
      scrollArea.scrollTo({ left: maxScroll, behavior: 'smooth' });
    } else {
      scrollArea.scrollLeft = maxScroll;
    }
    updateYearBadgeFromScroll();
  }

  let heatmapInteractionInitialized = false;
  function setupHeatmapInteraction() {
    if (heatmapInteractionInitialized) return;
    heatmapInteractionInitialized = true;

    const scrollArea = document.getElementById('heatmap-scroll-area');
    if (!scrollArea) return;

    // Smooth horizontal mouse wheel scroll with snappy feel
    scrollArea.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        scrollArea.scrollBy({ left: e.deltaY * 1.5, behavior: 'auto' });
      }
    }, { passive: false });

    // Smooth drag-to-scroll on desktop mouse
    let isDragging = false;
    let startX = 0;
    let startScroll = 0;

    scrollArea.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      startX = e.pageX;
      startScroll = scrollArea.scrollLeft;
      scrollArea.style.scrollSnapType = 'none';
      scrollArea.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      e.preventDefault();
      const dx = (e.pageX - startX) * 1.2;
      scrollArea.scrollLeft = startScroll - dx;
    });

    window.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      scrollArea.style.scrollSnapType = 'x mandatory';
      scrollArea.style.cursor = '';
      document.body.style.userSelect = '';
      updateYearBadgeFromScroll();
    });
  }

  function updateYearBadgeFromScroll() {
    const scrollArea = document.getElementById('heatmap-scroll-area');
    const trackEl = document.getElementById('heatmap-track');
    const yearBadge = document.getElementById('heatmap-year-badge');
    if (!scrollArea || !trackEl || !yearBadge) return;

    const blocks = trackEl.querySelectorAll('.month-block');
    // Sample point at right side of visible viewport (showing current period)
    const sampleX = scrollArea.scrollLeft + Math.min(scrollArea.clientWidth - 40, scrollArea.clientWidth * 0.75);

    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.offsetLeft <= sampleX) {
        const yr = b.dataset.year;
        if (yr && yearBadge.textContent !== yr) {
          yearBadge.textContent = yr;
          state.viewedYear = parseInt(yr, 10);
        }
        break;
      }
    }
  }

  const tooltipEl = document.getElementById('heatmap-tooltip');

  function handleCellHover(e) {
    const cell = e.currentTarget;
    const dateStr = cell.dataset.date;
    const mins = parseInt(cell.dataset.minutes, 10);

    const dateObj = new Date(dateStr + 'T00:00:00');
    const formatted = dateObj.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });

    let focusText = 'No study logged';
    if (mins > 0) {
      if (mins >= 60) {
        const hrs = Math.floor(mins / 60);
        const rem = mins % 60;
        focusText = rem > 0 ? `${mins}m (${hrs}h ${rem}m) focus time` : `${mins}m (${hrs}h) focus time`;
      } else {
        focusText = `${mins}m focus time`;
      }
    }
    tooltipEl.textContent = `${formatted} • ${focusText}`;

    const rect = cell.getBoundingClientRect();
    tooltipEl.style.left = `${rect.left + rect.width / 2}px`;
    tooltipEl.style.top = `${rect.top}px`;
    tooltipEl.classList.remove('hidden');
  }

  function handleCellLeave() {
    tooltipEl.classList.add('hidden');
  }

  function scrollPeriodPrev() {
    const scrollArea = document.getElementById('heatmap-scroll-area');
    if (!scrollArea) return;
    const step = Math.max(240, scrollArea.clientWidth * 0.75);
    scrollArea.scrollBy({ left: -step, behavior: 'smooth' });
  }

  function scrollPeriodNext() {
    const scrollArea = document.getElementById('heatmap-scroll-area');
    if (!scrollArea) return;
    const step = Math.max(240, scrollArea.clientWidth * 0.75);
    scrollArea.scrollBy({ left: step, behavior: 'smooth' });
  }

  // =========================================================================
  // VIEW SWITCHING & STATS RENDERING
  // =========================================================================
  function switchView(viewName) {
    document.querySelectorAll('.view-panel').forEach(p => p.classList.add('hidden'));
    const target = document.getElementById(`view-${viewName}`);
    if (target) target.classList.remove('hidden');

    const btnProfile = document.getElementById('btn-profile');
    if (btnProfile) {
      btnProfile.classList.toggle('active', viewName === 'settings');
    }

    if (viewName === 'focus') {
      requestAnimationFrame(() => scrollHeatmapToEnd(false));
    }
  }

  // =========================================================================
  // AUTOMATIC STATS ODOMETER (Zack Cinematic Multi-Spin Dial)
  // =========================================================================
  function animateOdometer(element, targetVal, duration = 1800) {
    if (!element) return;
    const targetStr = Math.floor(targetVal).toLocaleString();
    element.innerHTML = '';
    element.style.display = 'inline-flex';
    element.style.position = 'relative';
    element.style.verticalAlign = 'baseline';
    element.style.justifyContent = 'center';

    const columns = [];
    for (let i = 0; i < targetStr.length; i++) {
      const char = targetStr[i];
      const isDigit = /\d/.test(char);

      const col = document.createElement('span');
      col.className = 'dial-col';

      const layoutHolder = document.createElement('span');
      layoutHolder.className = 'dial-layout-holder';
      layoutHolder.textContent = isDigit ? '0' : char;
      col.appendChild(layoutHolder);

      const layer1 = document.createElement('span');
      const layer2 = document.createElement('span');
      layer1.className = 'dial-layer';
      layer2.className = 'dial-layer';

      col.appendChild(layer1);
      col.appendChild(layer2);
      element.appendChild(col);

      let totalChanges = 0;
      let delay = 0;

      if (isDigit) {
        const targetDigit = parseInt(char, 10);
        const posFromRight = targetStr.length - 1 - i;
        const spins = Math.min(posFromRight + 1, 2);
        totalChanges = spins * 10 + targetDigit;
        delay = posFromRight * 40;
      } else {
        layer1.textContent = char;
        layer2.style.opacity = '0';
      }

      columns.push({
        activeLayer: layer1,
        nextLayer: layer2,
        isDigit,
        char,
        totalChanges,
        delay
      });
    }

    let startTime = null;
    const maxBlur = 5;

    function step(timestamp) {
      if (!startTime) startTime = timestamp;
      let allDone = true;

      columns.forEach(col => {
        if (!col.isDigit) return;
        const colTime = timestamp - startTime - col.delay;
        if (colTime < 0) {
          col.activeLayer.textContent = '0';
          col.nextLayer.style.opacity = '0';
          allDone = false;
          return;
        }

        const progress = Math.min(colTime / duration, 1);
        if (progress < 1) allDone = false;

        const easedProgress = easeInOutQuart(progress);

        if (progress >= 1) {
          col.activeLayer.textContent = col.char;
          col.activeLayer.style.transform = 'translateY(0%) scale(1)';
          col.activeLayer.style.filter = 'blur(0px)';
          col.activeLayer.style.opacity = '1';
          col.nextLayer.style.opacity = '0';
          return;
        }

        const currentSpin = easedProgress * col.totalChanges;
        const f = currentSpin % 1;
        const currentDigit = Math.floor(currentSpin) % 10;
        const nextDigit = (currentDigit + 1) % 10;

        col.nextLayer.textContent = String(currentDigit);
        col.activeLayer.textContent = String(nextDigit);

        const oldY = -50 * f;
        const oldScale = 1 - f;
        const oldBlur = Math.pow(f, 3) * maxBlur;

        col.nextLayer.style.transform = `translateY(${oldY.toFixed(2)}%) scale(${oldScale.toFixed(3)})`;
        col.nextLayer.style.filter = `blur(${oldBlur.toFixed(2)}px)`;
        col.nextLayer.style.opacity = (1 - f).toFixed(3);

        const newY = 50 * (1 - f);
        const newScale = f;
        const newBlur = Math.pow(1 - f, 3) * maxBlur;

        col.activeLayer.style.transform = `translateY(${newY.toFixed(2)}%) scale(${newScale.toFixed(3)})`;
        col.activeLayer.style.filter = `blur(${newBlur.toFixed(2)}px)`;
        col.activeLayer.style.opacity = f.toFixed(3);
      });

      if (!allDone) {
        requestAnimationFrame(step);
      }
    }

    requestAnimationFrame(step);
  }

  function renderStats() {
    const streakEl = document.getElementById('stat-streak');
    const xpEl = document.getElementById('stat-xp');
    const settingTotalFocusEl = document.getElementById('setting-total-focus');

    if (streakEl) streakEl.textContent = state.streak;
    if (xpEl) xpEl.textContent = state.xp.toLocaleString();
    if (settingTotalFocusEl) settingTotalFocusEl.textContent = formatHoursMinutes(state.totalFocusSeconds);

    updateTodayLiveStat();
  }

  // =========================================================================
  // DAY DETAIL MODAL DIALOG (TODAY & PAST CELL CHRONICLE)
  // =========================================================================
  async function openDayDialog(dateStr) {
    const dialog = document.getElementById('day-detail-dialog');
    if (!dialog) return;

    const todayStr = getLocalDateString();
    const isToday = (dateStr === todayStr);

    const badgeEl = document.getElementById('day-dialog-badge');
    const titleEl = document.getElementById('day-dialog-title');
    const timeEl = document.getElementById('day-pill-time');
    const sessEl = document.getElementById('day-pill-sessions');
    const avgEl = document.getElementById('day-pill-avg');
    const xpEl = document.getElementById('day-pill-xp');
    const countEl = document.getElementById('day-timeline-count');
    const listEl = document.getElementById('day-sessions-list');

    if (badgeEl) badgeEl.textContent = isToday ? "Today's Record" : "Day Record";

    let formattedDate = dateStr;
    try {
      const parts = dateStr.split('-');
      const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      formattedDate = d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    } catch (_) {}
    if (titleEl) titleEl.textContent = formattedDate;

    // Show modal immediately
    if (typeof dialog.showModal === 'function' && !dialog.open) {
      dialog.showModal();
    }

    let dayData = null;
    try {
      const res = await fetch(`/api/day/${dateStr}`);
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.data) {
          dayData = json.data;
        }
      }
    } catch (e) {
      console.warn('StudyArc: Error fetching day data from SQLite:', e);
    }

    if (!dayData) {
      const matching = (state.sessions || []).filter(s => s.date === dateStr);
      let totalMins = 0;
      matching.forEach(s => totalMins += (s.durationMinutes || s.duration_minutes || 0));
      const totalSess = matching.length;
      const avgMins = totalSess > 0 ? Math.round(totalMins / totalSess) : 0;
      const hrs = Math.floor(totalMins / 60);
      const mins = totalMins % 60;
      const formattedTotal = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

      dayData = {
        date: dateStr,
        formattedDate: formattedDate,
        isToday: isToday,
        totalMinutes: totalMins,
        totalTimeFormatted: formattedTotal,
        totalSessions: totalSess,
        avgFocusMinutes: avgMins,
        totalXp: totalMins,
        sessions: matching.map(s => {
          const duration = s.durationMinutes || s.duration_minutes || 0;
          const ts = s.timestamp || Date.now();
          const endD = new Date(ts);
          const startD = new Date(ts - duration * 60000);
          const timeRange = s.timeRange || `${formatTime(startD)} – ${formatTime(endD)}`;
          return {
            id: s.id,
            subject: s.subject || s.subject_name || 'Focus Session',
            color: s.color || '#79D99B',
            durationMinutes: duration,
            timeRange: timeRange,
            xp: duration
          };
        })
      };
    }

    if (timeEl) timeEl.textContent = dayData.totalTimeFormatted || `${dayData.totalMinutes}m`;
    if (sessEl) sessEl.textContent = dayData.totalSessions;
    if (avgEl) avgEl.textContent = `${dayData.avgFocusMinutes}m`;
    if (xpEl) xpEl.textContent = `+${dayData.totalXp} XP`;
    if (countEl) countEl.textContent = `${dayData.totalSessions} session${dayData.totalSessions === 1 ? '' : 's'}`;

    if (listEl) {
      if (!dayData.sessions || dayData.sessions.length === 0) {
        listEl.innerHTML = `
          <div class="day-empty-state">
            <div class="day-empty-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
              </svg>
            </div>
            <div class="day-empty-title">No sessions on this day</div>
            <div class="day-empty-sub">${isToday ? 'Start the timer to record your first focus block today!' : 'Rest day recorded. Zero minutes studied.'}</div>
          </div>
        `;
      } else {
        listEl.innerHTML = dayData.sessions.map(s => `
          <div class="day-session-card" data-session-id="${escapeHtml(s.id)}">
            <div class="day-session-left">
              <span class="day-session-dot" style="background-color: ${s.color || '#79D99B'}; color: ${s.color || '#79D99B'};"></span>
              <div class="day-session-info">
                <span class="day-session-subject">${escapeHtml(s.subject)}</span>
                <span class="day-session-timerange">${escapeHtml(s.timeRange || '')}</span>
              </div>
            </div>
            <div class="day-session-right">
              <span class="day-session-duration">${s.durationMinutes} mins</span>
              <span class="day-session-xp">+${s.xp || s.durationMinutes} XP</span>
              <button class="day-session-delete-btn" data-session-id="${escapeHtml(s.id)}" data-date="${escapeHtml(dayData.date)}" title="Delete session" aria-label="Delete session">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  <line x1="10" y1="11" x2="10" y2="17"></line>
                  <line x1="14" y1="11" x2="14" y2="17"></line>
                </svg>
              </button>
            </div>
          </div>
        `).join('');
      }
    }
  }

  function closeDayDialog() {
    const dialog = document.getElementById('day-detail-dialog');
    if (dialog && dialog.open) {
      dialog.close();
    }
  }

  async function deleteSession(sessionId, dateStr) {
    if (!sessionId) return;

    // Visual feedback on the card being deleted
    const cardEl = document.querySelector(`.day-session-card[data-session-id="${sessionId}"]`);
    if (cardEl) {
      cardEl.classList.add('is-deleting');
    }

    let deletedFromBackend = false;
    let backendPayload = null;

    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        backendPayload = await res.json();
        if (backendPayload.success) {
          deletedFromBackend = true;
          if (backendPayload.stats) {
            state.streak = backendPayload.stats.streak || 0;
            state.xp = backendPayload.stats.xp || 0;
            state.totalFocusSeconds = backendPayload.stats.totalFocusSeconds || 0;
          }
          if (backendPayload.dayActivity) {
            state.dayActivity = backendPayload.dayActivity;
          }
          if (backendPayload.subjects) {
            state.subjects = backendPayload.subjects;
          }
          if (backendPayload.sessions) {
            state.sessions = backendPayload.sessions;
          }
        }
      }
    } catch (err) {
      console.warn('StudyArc: SQLite delete request error:', err);
    }

    // Offline / fallback sync if backend was unavailable or returned non-200
    if (!deletedFromBackend) {
      const idx = (state.sessions || []).findIndex(s =>
        s.id === sessionId ||
        String(s.id) === String(sessionId) ||
        s.id === ('sess_' + sessionId) ||
        ('sess_' + s.id) === sessionId
      );
      let duration = 0;
      if (idx !== -1) {
        duration = state.sessions[idx].durationMinutes || state.sessions[idx].duration_minutes || 0;
        state.sessions.splice(idx, 1);
      }
      if (dateStr && state.dayActivity && state.dayActivity[dateStr] !== undefined) {
        state.dayActivity[dateStr] = Math.max(0, state.dayActivity[dateStr] - duration);
        if (state.dayActivity[dateStr] === 0) {
          delete state.dayActivity[dateStr];
        }
      }
      state.xp = Math.max(0, (state.xp || 0) - duration);
      state.totalFocusSeconds = Math.max(0, (state.totalFocusSeconds || 0) - duration * 60);
      updateStreak();
    }

    saveState();
    renderAll();

    // Re-render the day dialog so timeline and the 4 highlight pills update immediately
    if (dateStr) {
      await openDayDialog(dateStr);
    }

    showToast('Session deleted');
  }

  function formatTime(dateObj) {
    let hours = dateObj.getHours();
    const minutes = String(dateObj.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    return `${hours}:${minutes} ${ampm}`;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
  }

  function renderAll() {
    renderTimer();
    renderStats();
    renderHeatmap();
  }

  // =========================================================================
  // EVENT LISTENERS & SETUP
  // =========================================================================
  function initEvents() {
    // Interactive Draggable Bead & Central Click-to-Play/Hold-to-Reset Pad
    initBeadDragging();
    initCenterPadInteraction();

    // Heatmap Period Navigation
    const prevBtn = document.getElementById('btn-prev-period');
    const nextBtn = document.getElementById('btn-next-period');
    if (prevBtn) prevBtn.addEventListener('click', scrollPeriodPrev);
    if (nextBtn) nextBtn.addEventListener('click', scrollPeriodNext);

    // Navigation Switching (if any nav buttons exist)
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    document.querySelectorAll('.mobile-nav-item').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    // Profile Avatar Button -> Toggle Settings View
    const btnProfile = document.getElementById('btn-profile');
    if (btnProfile) {
      btnProfile.addEventListener('click', () => {
        const settingsPanel = document.getElementById('view-settings');
        const isSettingsActive = settingsPanel && !settingsPanel.classList.contains('hidden');
        switchView(isSettingsActive ? 'focus' : 'settings');
      });
    }

    // Close Settings button -> Return to Focus
    const btnCloseSettings = document.getElementById('btn-close-settings');
    if (btnCloseSettings) {
      btnCloseSettings.addEventListener('click', () => switchView('focus'));
    }

    // Header Brand click -> Return to Focus
    const brandHome = document.getElementById('brand-home');
    if (brandHome) {
      brandHome.addEventListener('click', () => switchView('focus'));
    }

    // Today's Focus item in stats-strip click -> Open Day Record dialog for today
    const statItemToday = document.getElementById('stat-item-today');
    if (statItemToday) {
      statItemToday.addEventListener('click', () => {
        openDayDialog(getLocalDateString());
      });
      statItemToday.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDayDialog(getLocalDateString());
        }
      });
    }

    // Day Sessions List: Delete session action via event delegation
    const daySessionsList = document.getElementById('day-sessions-list');
    if (daySessionsList) {
      daySessionsList.addEventListener('click', async (e) => {
        const btn = e.target.closest('.day-session-delete-btn');
        if (!btn || btn.disabled) return;
        e.preventDefault();
        e.stopPropagation();

        const sessionId = btn.getAttribute('data-session-id');
        const dateStr = btn.getAttribute('data-date');
        if (!sessionId) return;

        btn.disabled = true;
        await deleteSession(sessionId, dateStr);
      });
    }

    // Day Detail Dialog Close Button
    const btnCloseDay = document.getElementById('btn-close-day-dialog');
    if (btnCloseDay) {
      btnCloseDay.addEventListener('click', closeDayDialog);
    }

    // Day Detail Dialog backdrop click light-dismiss fallback
    const dayDialog = document.getElementById('day-detail-dialog');
    if (dayDialog) {
      dayDialog.addEventListener('click', (e) => {
        const rect = dayDialog.getBoundingClientRect();
        const isInDialog = (
          rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
          rect.left <= e.clientX && e.clientX <= rect.left + rect.width
        );
        if (!isInDialog) {
          closeDayDialog();
        }
      });
    }

    // Settings actions
    const focusInput = document.getElementById('setting-focus-mins');
    const soundToggle = document.getElementById('setting-sound-enabled');

    if (focusInput) {
      focusInput.value = Math.round(state.timer.targetSeconds / 60);
      focusInput.addEventListener('change', () => {
        const mins = Math.max(1, Math.min(180, parseInt(focusInput.value, 10) || 60));
        focusInput.value = mins;
        state.timer.targetSeconds = mins * 60;
        if (state.timer.status === 'idle') {
          state.timer.remainingSeconds = mins * 60;
        }
        saveState();
        renderTimer();
      });
    }

    if (soundToggle) {
      soundToggle.checked = state.soundEnabled;
      soundToggle.addEventListener('change', () => {
        state.soundEnabled = soundToggle.checked;
        saveState();
      });
    }

    const btnWipeData = document.getElementById('btn-wipe-data');
    if (btnWipeData) {
      btnWipeData.addEventListener('click', async () => {
        if (confirm('Permanently wipe all session logs, streaks, and XP back to zero in the SQL database?')) {
          try {
            const res = await fetch('/api/reset', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reseed: false })
            });
            if (res.ok) {
              state.xp = 0;
              state.streak = 0;
              state.totalFocusSeconds = 0;
              state.dayActivity = {};
              state.sessions = [];
              state.subjects = [];
              state.timer.targetSeconds = 60 * 60;
              state.timer.remainingSeconds = 60 * 60;
              state.timer.status = 'idle';
              saveState();
              renderAll();
              switchView('focus');
            }
          } catch (e) {
            console.error('Failed to wipe data:', e);
          }
        }
      });
    }

    // Task Prompt Dialog form submission
    const taskForm = document.getElementById('task-prompt-form');
    if (taskForm) {
      taskForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('input-task-name');
        startTaskSession(input ? input.value : '');
      });
    }

    // Task Prompt Dialog Cancel Button
    const btnCancelTask = document.getElementById('btn-cancel-task');
    if (btnCancelTask) {
      btnCancelTask.addEventListener('click', closeTaskPromptDialog);
    }

    // Task Prompt Dialog backdrop click light-dismiss fallback
    const taskDialog = document.getElementById('task-prompt-dialog');
    if (taskDialog) {
      taskDialog.addEventListener('click', (e) => {
        const rect = taskDialog.getBoundingClientRect();
        const isInDialog = (
          rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
          rect.left <= e.clientX && e.clientX <= rect.left + rect.width
        );
        if (!isInDialog) {
          closeTaskPromptDialog();
        }
      });
    }


    // -------------------------------------------------------------------------
    // Authentication & Profile Event Listeners
    // -------------------------------------------------------------------------

    // Header Sign In button
    const btnHeaderAuth = document.getElementById('btn-header-auth');
    if (btnHeaderAuth) {
      btnHeaderAuth.addEventListener('click', () => openAuthDialog('login'));
    }

    // Header User pill button (opens settings)
    const headerUserBtn = document.getElementById('header-user-btn');
    if (headerUserBtn) {
      headerUserBtn.addEventListener('click', () => switchView('settings'));
    }

    // Close Auth Dialog button
    const btnCloseAuth = document.getElementById('btn-close-auth-dialog');
    if (btnCloseAuth) {
      btnCloseAuth.addEventListener('click', closeAuthDialog);
    }

    // Auth Dialog backdrop click light-dismiss fallback (only if already authenticated)
    const authDialog = document.getElementById('auth-dialog');
    if (authDialog) {
      authDialog.addEventListener('click', (e) => {
        const rect = authDialog.getBoundingClientRect();
        const isInDialog = (
          rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
          rect.left <= e.clientX && e.clientX <= rect.left + rect.width
        );
        if (!isInDialog) {
          closeAuthDialog();
        }
      });
    }

    // Tab buttons
    const tabLogin = document.getElementById('tab-auth-login');
    const tabRegister = document.getElementById('tab-auth-register');
    if (tabLogin) tabLogin.addEventListener('click', () => switchAuthTab('login'));
    if (tabRegister) tabRegister.addEventListener('click', () => switchAuthTab('register'));

    const linkSwitchRegister = document.getElementById('link-switch-to-register');
    const linkSwitchLogin = document.getElementById('link-switch-to-login');
    if (linkSwitchRegister) linkSwitchRegister.addEventListener('click', () => switchAuthTab('register'));
    if (linkSwitchLogin) linkSwitchLogin.addEventListener('click', () => switchAuthTab('login'));

    // Form submissions
    const formLogin = document.getElementById('form-auth-login');
    if (formLogin) formLogin.addEventListener('submit', handleLoginSubmit);

    const formRegister = document.getElementById('form-auth-register');
    if (formRegister) formRegister.addEventListener('submit', handleRegisterSubmit);

    // Live password matching feedback
    const pwInput = document.getElementById('register-password');
    const confirmInput = document.getElementById('register-confirm');
    const matchHint = document.getElementById('pw-match-hint');

    function checkPasswordMatch() {
      if (!confirmInput || !matchHint) return;
      const p1 = pwInput?.value || '';
      const p2 = confirmInput.value;
      if (!p2) {
        matchHint.textContent = '';
        matchHint.className = 'auth-field-hint';
        return;
      }
      if (p1 === p2) {
        matchHint.textContent = '✓ Passwords match';
        matchHint.className = 'auth-field-hint match';
      } else {
        matchHint.textContent = '✗ Passwords do not match';
        matchHint.className = 'auth-field-hint mismatch';
      }
    }

    if (pwInput) pwInput.addEventListener('input', checkPasswordMatch);
    if (confirmInput) confirmInput.addEventListener('input', checkPasswordMatch);

    // Show/Hide password toggle buttons
    document.querySelectorAll('.btn-toggle-pw').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.target;
        const input = document.getElementById(targetId);
        if (!input) return;
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        btn.innerHTML = isPassword
          ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`
          : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
      });
    });

    // Logout button
    const btnLogout = document.getElementById('btn-logout');
    if (btnLogout) {
      btnLogout.addEventListener('click', handleLogout);
    }

    // Keyboard Space shortcut to toggle timer / start task
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        handlePlayPauseAction();
      }
    });

    // Keep heatmap snapped to end on window resize
    window.addEventListener('resize', () => {
      scrollHeatmapToEnd(false);
    });

    // Handle tab visibility change (instant resync when coming back to tab, save state when leaving)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (state.authenticated) {
          initRealtimeTimerSync();
        }
        if (state.timer.status === 'running') {
          const now = Date.now();
          const elapsed = (now - (state.timer.lastTickTime || now)) / 1000;
          state.timer.lastTickTime = now;
          state.timer.remainingSeconds = Math.max(0, state.timer.remainingSeconds - elapsed);
          if (state.timer.remainingSeconds <= 0) {
            completeSession();
          } else {
            renderTimer();
          }
        }
      } else {
        if (state.timer.status === 'running') {
          saveState();
        }
      }
    });

    window.addEventListener('beforeunload', () => {
      if (state.timer.status === 'running') {
        saveState();
      }
    });
  }

  // =========================================================================
  // BOOTSTRAP
  // =========================================================================
  document.addEventListener('DOMContentLoaded', async () => {
    initEvents();

    // Check if session completed while user was away / page closed
    if (state.timer && state.timer._completedWhileAway) {
      state.timer._completedWhileAway = false;
      const targetDuration = state.timer.targetSeconds || 3600;
      const minutesCompleted = Math.max(1, Math.round(targetDuration / 60));
      const taskName = state.activeTaskName || 'Focus Session';
      showToast(`Welcome back! Your focus on ${taskName} finished while away. (+${minutesCompleted} XP)`);
      logSession(minutesCompleted, taskName);
      state.timer.status = 'idle';
      state.timer.remainingSeconds = state.timer.targetSeconds;
      state.activeTaskName = null;
      saveState();
    }

    // Immediately start live ticking in 0ms if timer was already running!
    if (state.timer && state.timer.status === 'running' && state.timer.remainingSeconds > 0) {
      if (!timerInterval) {
        timerInterval = setInterval(handleTimerTick, 500);
      }
    }

    renderAll();
    await checkAuthAndSync();
  });

})();
