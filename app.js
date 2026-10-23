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
  const DEFAULT_TIMER_SECONDS = 90 * 60; // 5400s (1 hour 30 mins)
  const defaultState = {
    // Focus Timer State (Max 3 hours = 10,800s, Default 1.5 hours = 5,400s / 1:30:00)
    timer: {
      status: 'idle', // 'idle' | 'running' | 'paused'
      targetSeconds: DEFAULT_TIMER_SECONDS, // 1:30:00 default
      remainingSeconds: DEFAULT_TIMER_SECONDS,
      startTime: null,
      lastTickTime: null
    },

    // Gamification & Progression (Loaded dynamically from SQLite)
    streak: 0,
    xp: 0,
    totalFocusSeconds: 0,
    levelClearHistory: {},

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
  const dayDetailsCache = new Map();

  function loadState() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        const merged = Object.assign({}, defaultState, parsed);
        if (!merged.timer || !merged.timer.targetSeconds || merged.timer.targetSeconds === 3600 || merged.timer.targetSeconds > 3 * 3600) {
          merged.timer = merged.timer || {};
          merged.timer.targetSeconds = DEFAULT_TIMER_SECONDS;
        }

        // The timer is 100% server-authoritative.
        // Never restore a running timer or offline elapsed ticks from stale localStorage.
        merged.timer.status = 'idle';
        merged.timer.remainingSeconds = merged.timer.targetSeconds;
        merged.timer.anchorRemainingSeconds = merged.timer.targetSeconds;
        merged.timer.anchorServerTime = null;
        merged.timer.startTime = null;
        merged.timer.lastTickTime = null;
        delete merged.timer._completedWhileAway;

        return merged;
      }
    } catch (e) {
      console.warn('StudyArc: Could not read localStorage:', e);
    }
    return JSON.parse(JSON.stringify(defaultState));
  }

  function saveState() {
    try {
      // Clean clone: Never persist running timer or volatile timestamps to localStorage
      const persistentState = Object.assign({}, state);
      if (persistentState.timer) {
        persistentState.timer = Object.assign({}, persistentState.timer, {
          status: 'idle',
          startTime: null,
          lastTickTime: null,
          anchorServerTime: null,
          anchorRemainingSeconds: persistentState.timer.targetSeconds
        });
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistentState));
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
        document.documentElement.classList.add('unauthenticated-gate');
        updateAuthUI();
        openAuthDialog('login');
        return;
      }

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          state.authenticated = true;
          state.user = data.user || null;
          document.documentElement.classList.remove('unauthenticated-gate');
          closeAuthDialog(true);
          state.subjects = data.subjects || [];
          state.sessions = data.sessions || [];
          dayDetailsCache.clear();

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

  async function fetchLatestServerTimer() {
    try {
      const res = await fetch(`/api/timer/live?t=${Date.now()}`, {
        headers: { 'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache' }
      });
      if (res.status === 401) return;
      if (res.ok) {
        const data = await res.json();
        if (data && data.success && data.timer) {
          state.authenticated = true;
          const seq = Number(data.timer.sequence || data.timer.version || 0);
          if (seq > lastAppliedSequence) lastAppliedSequence = seq;
          applyLiveServerTimer(data.timer, true);
        }
      }
    } catch (e) {
      console.warn('StudyArc: Quick timer fetch failed:', e);
    }
  }

  // =========================================================================
  // =========================================================================
  // REAL-TIME MULTI-DEVICE SOCKET.IO SYNCHRONIZATION ENGINE v4
  // Architecture: Socket.IO (WebSocket + automatic HTTP long-polling fallback),
  // Monotonic Sequence Deduplication, Server-Authoritative Anchor Clocks,
  // RTT Clock Offset Sync. Works on Render, Heroku, Railway, iOS Safari, etc.
  // =========================================================================

  let sioSocket = null;
  let serverClockOffset = 0;        // (serverTime - clientWallClock) in ms
  let lastAppliedSequence = 0;      // Monotonic server sequence counter

  // 1. Same-device multi-tab instantaneous 0ms sync via BroadcastChannel
  let timerBroadcastChannel = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      timerBroadcastChannel = new BroadcastChannel('studyarc_timer_sync');
      timerBroadcastChannel.onmessage = (event) => {
        if (event && event.data && event.data.timer) {
          applyLiveServerTimer(event.data.timer, false);
        }
      };
    }
  } catch (e) {
    console.warn('StudyArc: BroadcastChannel unsupported:', e);
  }

  function broadcastLocalTimer(timerState) {
    if (timerBroadcastChannel && timerState) {
      try {
        timerBroadcastChannel.postMessage({ type: 'TIMER_SYNC', timer: timerState });
      } catch (e) {}
    }
  }

  // 2. Socket.IO persistent connection with automatic WebSocket + long-polling fallback
  function connectTimerSocket() {
    if (!state.authenticated) return;
    if (sioSocket && sioSocket.connected) return;
    if (typeof io !== 'function') {
      console.warn('StudyArc: Socket.IO library not loaded, using HTTP fallback');
      return;
    }

    // Disconnect stale instance if any
    if (sioSocket) {
      try { sioSocket.disconnect(); } catch (_) {}
      sioSocket = null;
    }

    sioSocket = io({
      // Auto-detect URL from current page
      path: '/socket.io',
      transports: ['websocket', 'polling'],  // Try WebSocket first, fallback to polling
      reconnection: true,
      reconnectionDelay: 300,
      reconnectionDelayMax: 3000,
      reconnectionAttempts: Infinity,
      timeout: 10000,
      withCredentials: true
    });

    sioSocket.on('connect', () => {
      console.log('StudyArc: Socket.IO connected via', sioSocket.io.engine.transport.name);
      // Measure clock offset immediately
      sendSocketPing();

      // Socket.IO upgrades polling→websocket automatically, log it
      sioSocket.io.engine.on('upgrade', (transport) => {
        console.log('StudyArc: Transport upgraded to', transport.name);
      });
    });

    // Server sends initial full state on connect
    sioSocket.on('timer_init', (data) => {
      if (data && data.serverTime) {
        const measuredOffset = data.serverTime - Date.now();
        if (serverClockOffset === 0) serverClockOffset = measuredOffset;
      }
      if (data && data.timer) {
        applyLiveServerTimer(data.timer, false);
        broadcastLocalTimer(data.timer);
      }
    });

    // Real-time timer updates from any device
    sioSocket.on('timer_update', (data) => {
      if (data && data.serverTime) {
        const measuredOffset = data.serverTime - Date.now();
        if (serverClockOffset === 0) serverClockOffset = measuredOffset;
      }
      if (data && data.timer) {
        applyLiveServerTimer(data.timer, false);
        broadcastLocalTimer(data.timer);
      }
    });

    // Clock offset measurement response
    sioSocket.on('pong_server', (data) => {
      if (data && data.clientTime && data.serverTime) {
        const now = Date.now();
        const rtt = Math.max(1, now - data.clientTime);
        const measuredOffset = data.serverTime - (data.clientTime + rtt / 2);
        serverClockOffset = (serverClockOffset === 0)
          ? measuredOffset
          : (0.75 * serverClockOffset + 0.25 * measuredOffset);
      }
    });

    sioSocket.on('disconnect', (reason) => {
      console.log('StudyArc: Socket.IO disconnected:', reason);
    });

    sioSocket.on('connect_error', (err) => {
      console.warn('StudyArc: Socket.IO connect error:', err.message);
    });
  }

  function sendSocketPing() {
    if (sioSocket && sioSocket.connected) {
      sioSocket.emit('ping_server', { clientTime: Date.now() });
    }
  }

  function handleTabAwakeOrFocus() {
    if (!state.authenticated) return;
    if (!sioSocket || !sioSocket.connected) {
      connectTimerSocket();
    } else {
      sendSocketPing();
      sioSocket.emit('get_state');
    }
    recalculateRemainingSeconds();
    renderTimer();
  }

  function initRealtimeTimerSync() {
    if (!state.authenticated) return;
    connectTimerSocket();
  }

  /**
   * Monotonic server-authoritative anchor calculation.
   * Eliminates clock drift and freeze on inactive tabs or backgrounded mobile devices.
   */
  function recalculateRemainingSeconds() {
    if (state.timer.status !== 'running') {
      return state.timer.remainingSeconds;
    }
    const anchorServerTime = state.timer.anchorServerTime;
    const anchorRemaining = Number(state.timer.anchorRemainingSeconds != null ? state.timer.anchorRemainingSeconds : state.timer.remainingSeconds);

    if (!anchorServerTime) {
      return anchorRemaining;
    }

    const estimatedServerNow = Date.now() + serverClockOffset;
    const elapsed = Math.max(0, (estimatedServerNow - anchorServerTime) / 1000);
    const calculated = Math.max(0, anchorRemaining - elapsed);
    state.timer.remainingSeconds = calculated;
    return calculated;
  }

  /**
   * Applies live server state across all devices immediately.
   * Monotonic sequence deduplication prevents stale responses from rolling back state.
   */
  function applyLiveServerTimer(serverTimer, isDirectResponse = false) {
    if (!serverTimer) return;

    const seq = Number(serverTimer.sequence || serverTimer.version || 0);

    // Dedup: skip if we already applied this exact sequence or a newer one
    if (!isDirectResponse && seq > 0 && seq <= lastAppliedSequence) {
      return;
    }

    if (seq > lastAppliedSequence) {
      lastAppliedSequence = seq;
    }

    // 1. Task name sync across devices
    state.activeTaskName = serverTimer.activeTaskName || null;

    // 2. Handle completed-while-away
    if (serverTimer.hasCompleted) {
      const taskName = serverTimer.activeTaskName || state.activeTaskName || (state.subjects && state.subjects.length > 0 ? state.subjects[0].name : 'Focus Session');
      const targetDuration = serverTimer.targetSeconds || DEFAULT_TIMER_SECONDS;
      const minutesCompleted = Math.max(1, Math.round(targetDuration / 60));
      const streakBonus = Math.max(0, state.streak || 0);
      spawnRewardPills(minutesCompleted, minutesCompleted, streakBonus);
      logSession(minutesCompleted, taskName);

      state.timer.status = 'idle';
      state.timer.targetSeconds = targetDuration;
      state.timer.remainingSeconds = targetDuration;
      state.timer.anchorRemainingSeconds = targetDuration;
      state.timer.anchorServerTime = null;
      state.activeTaskName = null;
      state.activeTaskStartTime = null;
      state.activeTaskTargetSeconds = null;
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
      saveState();
      renderAll();
      return;
    }

    // 3. PAUSE SYNC (Immediate, zero-calculation!)
    if (serverTimer.status === 'paused') {
      state.timer.status = 'paused';
      state.timer.targetSeconds = serverTimer.targetSeconds || DEFAULT_TIMER_SECONDS;
      state.timer.remainingSeconds = Number(serverTimer.remainingSeconds != null ? serverTimer.remainingSeconds : state.timer.remainingSeconds);
      state.timer.anchorRemainingSeconds = state.timer.remainingSeconds;
      state.timer.anchorServerTime = null;
      state.timer.lastTickTime = null;
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      saveState();
      renderTimer();
      renderStats();
      return;
    }

    // 4. IDLE / RESET SYNC (Immediate, zero-calculation!)
    if (serverTimer.status === 'idle') {
      state.timer.status = 'idle';
      state.timer.targetSeconds = serverTimer.targetSeconds || DEFAULT_TIMER_SECONDS;
      state.timer.remainingSeconds = state.timer.targetSeconds;
      state.timer.anchorRemainingSeconds = state.timer.targetSeconds;
      state.timer.anchorServerTime = null;
      state.timer.lastTickTime = null;
      state.activeTaskName = null;
      state.activeTaskStartTime = null;
      state.activeTaskTargetSeconds = null;
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      saveState();
      renderTimer();
      renderStats();
      return;
    }

    // 5. RUNNING SYNC (Immediate play/resume!)
    if (serverTimer.status === 'running') {
      state.timer.status = 'running';
      state.timer.targetSeconds = serverTimer.targetSeconds || DEFAULT_TIMER_SECONDS;
      state.timer.anchorRemainingSeconds = Number(serverTimer.remainingSeconds != null ? serverTimer.remainingSeconds : DEFAULT_TIMER_SECONDS);
      state.timer.anchorServerTime = serverTimer.startedAt ? Number(serverTimer.startedAt) : (Date.now() + serverClockOffset);
      state.timer.lastTickTime = Date.now();
      state.activeTaskTargetSeconds = state.timer.targetSeconds;

      recalculateRemainingSeconds();

      if (!timerInterval) {
        timerInterval = setInterval(handleTimerTick, 250);
      }
      saveState();
      renderTimer();
      renderStats();
    }
  }

  function reconcileServerTimer(serverTimer) {
    applyLiveServerTimer(serverTimer, false);
  }

  async function syncTimerAction(action, extraPayload = {}) {
    if (!state.authenticated) return;

    const payload = {
      action,
      target_seconds: state.timer.targetSeconds,
      remaining_seconds: Math.round(state.timer.remainingSeconds),
      active_task_name: state.activeTaskName,
      ...extraPayload
    };

    // 0ms instant broadcast to other open tabs on this machine
    broadcastLocalTimer({
      status: state.timer.status,
      targetSeconds: state.timer.targetSeconds,
      remainingSeconds: Math.round(state.timer.remainingSeconds),
      activeTaskName: state.activeTaskName,
      startedAt: state.timer.anchorServerTime || (Date.now() + serverClockOffset),
      sequence: lastAppliedSequence + 1
    });

    // 1. Instant Socket.IO emit (<1ms)
    if (sioSocket && sioSocket.connected) {
      sioSocket.emit('timer_action', payload);
      return;
    }

    // 2. HTTP POST fallback if socket is reconnecting
    try {
      const res = await fetch('/api/timer/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.success && data.timer) {
          applyLiveServerTimer(data.timer, true);
          broadcastLocalTimer(data.timer);
        }
      }
    } catch (err) {
      console.warn('StudyArc: Timer sync warning:', err);
    }
  }

  function updateAuthUI() {
    const btnHeaderAuth = document.getElementById('btn-header-auth');
    const headerUserInitial = document.getElementById('header-user-initial');
    const profileBtn = document.getElementById('btn-profile');
    const profileSvg = profileBtn ? profileBtn.querySelector('.profile-avatar-default-icon') : null;
    const settingAvatar = document.getElementById('setting-user-avatar');
    const settingUsername = document.getElementById('setting-username-display');
    const authDialog = document.getElementById('auth-dialog');

    if (state.authenticated && state.user) {
      document.documentElement.classList.remove('unauthenticated-gate');
      const username = state.user.username || 'User';
      const initial = username.charAt(0).toUpperCase();

      if (btnHeaderAuth) btnHeaderAuth.classList.add('hidden');
      if (headerUserInitial) {
        headerUserInitial.textContent = initial;
        headerUserInitial.classList.remove('hidden');
      }
      if (profileSvg) profileSvg.classList.add('hidden');
      if (profileBtn) profileBtn.title = `${username} • Settings & Preferences`;
      if (settingAvatar) settingAvatar.textContent = initial;
      if (settingUsername) settingUsername.textContent = username;

      if (authDialog && authDialog.open) {
        authDialog.close();
      }
    } else {
      document.documentElement.classList.add('unauthenticated-gate');
      if (btnHeaderAuth) btnHeaderAuth.classList.remove('hidden');
      if (headerUserInitial) headerUserInitial.classList.add('hidden');
      if (profileSvg) profileSvg.classList.remove('hidden');
      if (profileBtn) profileBtn.title = 'Settings & Preferences';
      if (settingAvatar) settingAvatar.textContent = '?';
      if (settingUsername) settingUsername.textContent = 'Not Signed In';
    }
  }

  function getFaceHeight(faceEl) {
    if (!faceEl) return 380;
    return Math.max(faceEl.scrollHeight, faceEl.offsetHeight, 360);
  }

  function updateAuthCardHeight(mode) {
    const scene = document.getElementById('auth-card-scene');
    if (!scene) return;
    const isSignup = mode !== undefined
      ? (mode === 'signup' || mode === 'register')
      : scene.classList.contains('is-flipped');
    const targetFace = isSignup
      ? document.getElementById('auth-card-back')
      : document.getElementById('auth-card-front');
    if (targetFace) {
      const h = getFaceHeight(targetFace);
      scene.style.height = `${h}px`;
    }
  }

  function flipAuthCard(mode = 'signup', animate = true) {
    const scene = document.getElementById('auth-card-scene');
    if (!scene) return;

    const isSignup = (mode === 'signup' || mode === 'register');
    const targetFace = isSignup
      ? document.getElementById('auth-card-back')
      : document.getElementById('auth-card-front');

    // On-the-fly card height shift (measures target card and transitions simultaneously)
    if (targetFace) {
      const targetH = getFaceHeight(targetFace);
      scene.style.height = `${targetH}px`;
    }

    if (isSignup) {
      scene.classList.add('is-flipped');
      setTimeout(() => {
        document.getElementById('register-username')?.focus();
      }, animate ? 300 : 0);
    } else {
      scene.classList.remove('is-flipped');
      setTimeout(() => {
        document.getElementById('login-username')?.focus();
      }, animate ? 300 : 0);
    }
  }

  function shakeAuthCard() {
    const scene = document.getElementById('auth-card-scene');
    if (!scene) return;
    scene.classList.remove('auth-shake');
    void scene.offsetWidth;
    scene.classList.add('auth-shake');
    setTimeout(() => {
      scene.classList.remove('auth-shake');
    }, 400);
  }

  function openAuthDialog(mode = 'login') {
    const dialog = document.getElementById('auth-dialog');
    if (!dialog) return;

    // Clear error messages
    const loginError = document.getElementById('login-error-msg');
    const registerError = document.getElementById('register-error-msg');
    if (loginError) { loginError.textContent = ''; loginError.classList.add('hidden'); }
    if (registerError) { registerError.textContent = ''; registerError.classList.add('hidden'); }

    if (typeof dialog.showModal === 'function' && !dialog.open) {
      dialog.showModal();
    }

    if (window.AuthModalDots && typeof window.AuthModalDots.start === 'function') {
      window.AuthModalDots.start();
    }

    // Set flip state
    const isSignup = (mode === 'register' || mode === 'signup');
    flipAuthCard(isSignup ? 'signup' : 'login', false);

    requestAnimationFrame(() => {
      updateAuthCardHeight(isSignup ? 'signup' : 'login');
      if (window.AuthModalDots && typeof window.AuthModalDots.resize === 'function') {
        window.AuthModalDots.resize();
      }
    });
  }

  function closeAuthDialog(force = false) {
    const dialog = document.getElementById('auth-dialog');
    if (!dialog) return;

    if (!state.authenticated && !force) {
      return;
    }

    if (dialog.open) {
      dialog.close();
      if (window.AuthModalDots && typeof window.AuthModalDots.stop === 'function') {
        window.AuthModalDots.stop();
      }
    }
  }

  function switchAuthTab(tab) {
    flipAuthCard(tab === 'login' ? 'login' : 'signup');
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
        updateAuthCardHeight('login');
        shakeAuthCard();
      }
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.querySelector('span').textContent = 'Signing in...';
    }
    if (errorEl) {
      errorEl.classList.add('hidden');
      updateAuthCardHeight('login');
    }

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
        document.documentElement.classList.remove('unauthenticated-gate');
        updateAuthUI();
        closeAuthDialog(true);
        await syncWithBackend();
      } else {
        if (errorEl) {
          errorEl.textContent = data.error || 'Invalid username or password.';
          errorEl.classList.remove('hidden');
          updateAuthCardHeight('login');
          shakeAuthCard();
        }
      }
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = 'Connection error. Please try again.';
        errorEl.classList.remove('hidden');
        updateAuthCardHeight('login');
        shakeAuthCard();
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

    if (errorEl) {
      errorEl.classList.add('hidden');
      updateAuthCardHeight('signup');
    }

    if (!username || username.length < 3) {
      if (errorEl) {
        errorEl.textContent = 'Username must be at least 3 characters long.';
        errorEl.classList.remove('hidden');
        updateAuthCardHeight('signup');
        shakeAuthCard();
      }
      return;
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      if (errorEl) {
        errorEl.textContent = 'Username can only contain letters, numbers, and underscores.';
        errorEl.classList.remove('hidden');
        updateAuthCardHeight('signup');
        shakeAuthCard();
      }
      return;
    }

    if (password.length < 6) {
      if (errorEl) {
        errorEl.textContent = 'Password must be at least 6 characters long.';
        errorEl.classList.remove('hidden');
        updateAuthCardHeight('signup');
        shakeAuthCard();
      }
      return;
    }

    if (password !== confirmPassword) {
      if (errorEl) {
        errorEl.textContent = 'Passwords do not match.';
        errorEl.classList.remove('hidden');
        updateAuthCardHeight('signup');
        shakeAuthCard();
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
        document.documentElement.classList.remove('unauthenticated-gate');
        updateAuthUI();
        closeAuthDialog(true);
        await syncWithBackend();
      } else {
        if (errorEl) {
          errorEl.textContent = data.error || 'Failed to create account.';
          errorEl.classList.remove('hidden');
          updateAuthCardHeight('signup');
          shakeAuthCard();
        }
      }
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = 'Connection error. Please try again.';
        errorEl.classList.remove('hidden');
        updateAuthCardHeight('signup');
        shakeAuthCard();
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.querySelector('span').textContent = 'Create Account';
      }
    }
  }

  async function handleLogout() {
    if (sioSocket) {
      try { sioSocket.disconnect(); } catch (_) {}
      sioSocket = null;
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
    state.levelClearHistory = {};
    state.timer.status = 'idle';
    state.timer.remainingSeconds = state.timer.targetSeconds;
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
    saveState();
    renderAll();
    updateAuthUI();
    switchView('focus');
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

  function formatCompactNumber(num) {
    if (num === null || num === undefined || isNaN(num)) return '0';
    const val = Number(num);
    const sign = val < 0 ? '-' : '';
    const abs = Math.abs(val);

    if (abs < 1000) return `${sign}${abs}`;

    const tiers = [
      { threshold: 1e9, suffix: 'B' },
      { threshold: 1e6, suffix: 'M' },
      { threshold: 1e3, suffix: 'K' },
    ];

    for (const { threshold, suffix } of tiers) {
      if (abs >= threshold) {
        const scaled = abs / threshold;
        let formatted;
        if (scaled >= 100) {
          formatted = Math.floor(scaled).toString();
        } else {
          const rounded = Math.round(scaled * 10) / 10;
          formatted = rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1);
        }
        return `${sign}${formatted}${suffix}`;
      }
    }
    return `${sign}${abs}`;
  }

  function adjustStatFontFit() {
    const items = [
      { id: 'stat-streak', maxLen: 4, shrinkLen: 6 },
      { id: 'stat-xp', maxLen: 4, shrinkLen: 6 },
      { id: 'stat-today-focus', maxLen: 8, shrinkLen: 10 }
    ];

    for (const item of items) {
      const el = document.getElementById(item.id);
      if (!el) continue;
      const len = (el.textContent || '').trim().length;
      if (len > item.shrinkLen) {
        el.style.fontSize = item.id === 'stat-today-focus' ? '0.62rem' : '0.72rem';
      } else if (len > item.maxLen) {
        el.style.fontSize = item.id === 'stat-today-focus' ? '0.68rem' : '0.80rem';
      } else {
        el.style.fontSize = '';
      }
    }
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

      // Keep AmbientAura and body synchronized with timer running/amber state
      const isRunning = state.timer.status === 'running';
      document.body.classList.toggle('is-timer-amber', !isRunning);
      document.body.classList.toggle('is-timer-paused', state.timer.status === 'paused');
      window.AmbientAura?.setTimerStatus(state.timer.status);

      if (isRunning) {
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
      document.body.classList.add('is-timer-amber');
      document.body.classList.remove('is-timer-paused');
      window.AmbientAura?.setTimerStatus('idle');
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

    adjustStatFontFit();
  }

  function startTimer() {
    initAudio();
    playChime('start');

    state.timer.status = 'running';
    state.timer.anchorRemainingSeconds = state.timer.remainingSeconds;
    state.timer.anchorServerTime = Date.now() + serverClockOffset;
    state.timer.lastTickTime = Date.now();
    saveState();

    if (!timerInterval) {
      timerInterval = setInterval(handleTimerTick, 250);
    }
    renderTimer();
    syncTimerAction('start', {
      target_seconds: state.timer.targetSeconds,
      remaining_seconds: Math.round(state.timer.remainingSeconds),
      active_task_name: state.activeTaskName
    });
  }

  function resumeTimer() {
    initAudio();
    playChime('start');

    state.timer.status = 'running';
    state.timer.anchorRemainingSeconds = state.timer.remainingSeconds;
    state.timer.anchorServerTime = Date.now() + serverClockOffset;
    state.timer.lastTickTime = Date.now();
    saveState();

    if (!timerInterval) {
      timerInterval = setInterval(handleTimerTick, 250);
    }
    renderTimer();
    syncTimerAction('resume', {
      target_seconds: state.timer.targetSeconds,
      remaining_seconds: Math.round(state.timer.remainingSeconds),
      active_task_name: state.activeTaskName
    });
  }

  function pauseTimer() {
    state.timer.status = 'paused';
    state.timer.anchorServerTime = null;
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

    const remaining = recalculateRemainingSeconds();

    if (remaining <= 0) {
      completeSession();
    } else if (!document.hidden) {
      renderTimer();
    }

    tickCounter++;
    if (tickCounter % 20 === 0 && !document.hidden) {
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
    dayDetailsCache.delete(todayStr);

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
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    playChime('complete');

    const prevLevel = getLevelInfo(state.xp).level;
    const taskName = state.activeTaskName || 'Focus Session';
    const targetDuration = state.activeTaskTargetSeconds || state.timer.targetSeconds;
    const minutesCompleted = Math.max(1, Math.round(targetDuration / 60));
    logSession(minutesCompleted, taskName);

    const newLevelInfo = getLevelInfo(state.xp);
    const streakBonus = Math.max(0, state.streak || 0);
    spawnRewardPills(minutesCompleted, minutesCompleted, streakBonus);

    if (newLevelInfo.level > prevLevel) {
      state.levelClearHistory = state.levelClearHistory || {};
      state.levelClearHistory[newLevelInfo.level] = {
        date: todayStr,
        timestamp: Date.now()
      };
      saveState();
      setTimeout(() => {
        spawnFlyingPill(`🎉 Lv. ${newLevelInfo.level}!`, { extraClass: 'pill-xp', lane: 'center' });
        showToast(`Level Up! Reached Level ${newLevelInfo.level}: ${newLevelInfo.title}! ✨`);
      }, 550);
    }

    state.activeTaskName = null;
    state.activeTaskStartTime = null;
    state.activeTaskTargetSeconds = null;

    // Reset back to set target duration
    state.timer.remainingSeconds = state.timer.targetSeconds;
    state.timer.status = 'idle';
    saveState();
    syncTimerAction('complete', { target_seconds: state.timer.targetSeconds });
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

      // Accelerate background ambient aura and constellation particles as hold progresses!
      window.AmbientAura?.setHoldProgress(progress);

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
        window.AmbientAura?.onReset?.();
        window.AmbientAura?.setHolding(false);
        window.AmbientAura?.setHoldProgress(0);

        if (navigator.vibrate) navigator.vibrate([40, 50, 40]);
        playChime('reset');

        const taskName = state.activeTaskName || 'Focus Session';
        const targetSecs = state.activeTaskTargetSeconds || state.timer.targetSeconds || DEFAULT_TIMER_SECONDS;
        const elapsedStudy = Math.max(0, targetSecs - holdStartRemaining);

        // Strict 1-minute rule: discard session if < 60s, save if >= 60s
        if (elapsedStudy >= 60) {
          const minutesLogged = Math.round(elapsedStudy / 60);
          logSession(minutesLogged, taskName);
          const streakBonus = Math.max(0, state.streak || 0);
          spawnRewardPills(minutesLogged, minutesLogged, streakBonus);
        } else if (state.activeTaskName) {
          spawnFlyingPill('Session Ended');
        } else {
          spawnFlyingPill('Timer Reset');
        }

        if (timerInterval) {
          clearInterval(timerInterval);
          timerInterval = null;
        }
        state.activeTaskName = null;
        state.activeTaskStartTime = null;
        state.activeTaskTargetSeconds = null;

        // Reset timer back to fixed 1:30:00 default in stopped/paused state
        state.timer.targetSeconds = DEFAULT_TIMER_SECONDS;
        state.timer.remainingSeconds = DEFAULT_TIMER_SECONDS;
        state.timer.anchorRemainingSeconds = DEFAULT_TIMER_SECONDS;
        state.timer.anchorServerTime = null;
        state.timer.lastTickTime = null;
        state.timer.status = 'idle';
        saveState();
        syncTimerAction('reset', { target_seconds: DEFAULT_TIMER_SECONDS });
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
      window.AmbientAura?.setHolding(true);
      window.AmbientAura?.setHoldProgress(0.08);

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
      holdStartRemaining = recalculateRemainingSeconds();

      clearTimeout(holdDelayTimer);
      cancelAnimationFrame(holdRaf);

      // Deselect any accidental active text selection immediately
      if (window.getSelection) {
        try {
          window.getSelection().removeAllRanges();
        } catch (_) {}
      }

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
      window.AmbientAura?.setHolding(false);
      window.AmbientAura?.setHoldProgress(0);

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

    // Prevent default context menu & text selection on long press on mobile
    pad.addEventListener('contextmenu', (e) => e.preventDefault());
    pad.addEventListener('selectstart', (e) => e.preventDefault());

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
      resumeTimer();
    } else {
      // Status is 'idle' -> Prompt for new task name before starting!
      openTaskPromptDialog();
    }
  }

  function openTaskPromptDialog() {
    const modal = document.getElementById('task-prompt-modal');
    const input = document.getElementById('input-task-name');
    const durationPill = document.getElementById('task-prompt-duration');
    const chipsContainer = document.getElementById('task-suggestions-chips');
    if (!modal) return;

    // Deselect any active text selection across document
    if (window.getSelection) {
      try {
        window.getSelection().removeAllRanges();
      } catch (_) {}
    }

    const centerPad = document.getElementById('timer-center-pad');
    centerPad?.blur?.();

    const targetMins = Math.round(state.timer.targetSeconds / 60);
    if (durationPill) {
      durationPill.textContent = `${targetMins}m Focus`;
    }

    if (input) {
      input.value = '';
    }

    if (chipsContainer) {
      // Gather up to 4 most recent unique subjects (from sessions, then saved subjects, then clean defaults)
      const recentUnique = [];
      const seen = new Set();

      const sessionList = (state.sessions && state.sessions.length > 0) ? state.sessions : [];
      for (const s of sessionList) {
        const name = (s.subject || s.subject_name || s.subjectName || '').trim();
        if (name && !seen.has(name.toLowerCase())) {
          seen.add(name.toLowerCase());
          recentUnique.push(name);
          if (recentUnique.length >= 4) break;
        }
      }

      if (recentUnique.length < 4 && state.subjects && state.subjects.length > 0) {
        for (const subj of state.subjects) {
          const name = (typeof subj === 'string' ? subj : (subj.name || subj.title || '')).trim();
          if (name && !seen.has(name.toLowerCase())) {
            seen.add(name.toLowerCase());
            recentUnique.push(name);
            if (recentUnique.length >= 4) break;
          }
        }
      }

      const defaultSuggestions = ['Deep Work', 'Mathematics', 'Reading', 'Coding'];
      for (const def of defaultSuggestions) {
        if (recentUnique.length >= 4) break;
        if (!seen.has(def.toLowerCase())) {
          seen.add(def.toLowerCase());
          recentUnique.push(def);
        }
      }

      const final4 = recentUnique.slice(0, 4);

      chipsContainer.innerHTML = final4.map(name => `
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

    // Open the simple fixed overlay modal
    modal.classList.remove('hidden');

    // Automatically trigger on-screen mobile keyboard by focusing synchronously within user gesture
    if (input) {
      input.focus();
      try {
        const len = input.value.length;
        input.setSelectionRange(len, len);
      } catch (_) {}
      requestAnimationFrame(() => {
        input.focus();
      });
    }
  }

  function closeTaskPromptDialog() {
    const modal = document.getElementById('task-prompt-modal');
    const input = document.getElementById('input-task-name');

    if (input) {
      try {
        input.setSelectionRange?.(0, 0);
      } catch (_) {}
      input.blur();
    }

    if (window.getSelection) {
      try {
        window.getSelection().removeAllRanges();
      } catch (_) {}
    }

    if (modal) {
      modal.classList.add('hidden');
    }

    const centerPad = document.getElementById('timer-center-pad');
    centerPad?.blur?.();
    document.activeElement?.blur?.();

    // Async cleanup to prevent browser dialog-dismiss focus bounce onto timer numbers
    setTimeout(() => {
      if (window.getSelection) {
        try {
          window.getSelection().removeAllRanges();
        } catch (_) {}
      }
      centerPad?.blur?.();
      if (document.activeElement === centerPad) {
        centerPad.blur();
      }
    }, 15);
  }

  function startTaskSession(taskName) {
    const cleanName = (taskName || '').trim() || 'Focus Session';
    const input = document.getElementById('input-task-name');

    if (input) {
      try {
        input.setSelectionRange?.(0, 0);
      } catch (_) {}
      input.blur();
    }

    if (window.getSelection) {
      try {
        window.getSelection().removeAllRanges();
      } catch (_) {}
    }

    state.activeTaskName = cleanName;
    state.activeTaskStartTime = Date.now();
    state.activeTaskTargetSeconds = state.timer.targetSeconds;
    state.timer.remainingSeconds = state.timer.targetSeconds;
    saveState();
    closeTaskPromptDialog();
    startTimer();
    renderTimer();
    spawnFlyingPill('Session Started');

    const centerPad = document.getElementById('timer-center-pad');
    centerPad?.blur?.();
    document.activeElement?.blur?.();
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
  // VIDEO-GAME STYLE FLOATING / FLYING PILL NOTIFICATIONS (FROM TIMER NUMERALS)
  // =========================================================================
  let lastPillTime = 0;
  let autoLaneIndex = 0;
  const AUTO_LANES = ['center', 'left', 'right'];

  function getAutoPillLane() {
    const now = Date.now();
    if (now - lastPillTime > 1200) {
      autoLaneIndex = 0;
      lastPillTime = now;
      return 'center';
    }
    autoLaneIndex = (autoLaneIndex + 1) % AUTO_LANES.length;
    lastPillTime = now;
    return AUTO_LANES[autoLaneIndex];
  }

  function spawnFlyingPill(text, options = {}) {
    const layer = document.getElementById('timer-flying-pills-layer');
    if (!layer) return;

    const pill = document.createElement('div');
    pill.className = 'flying-pill';
    if (options.extraClass) pill.classList.add(options.extraClass);
    pill.textContent = text;

    // Determine directional corridor / lane: 'left' | 'center' | 'right'
    const lane = options.lane || getAutoPillLane();

    let startX = 0;
    let midX = 0;
    let drift1X = 0;
    let drift2X = 0;
    let endX = 0;

    let startRot = 0;
    let midRot = 0;
    let drift1Rot = 0;
    let drift2Rot = 0;
    let endRot = 0;

    let totalRise = 112;
    let duration = 1400;

    const startY = (Math.random() - 0.5) * 8; // Subtle vertical jitter (-4px to +4px)

    if (lane === 'left') {
      // Sweeps strongly towards upper-left: strictly negative X corridor
      startX = -36 + (Math.random() - 0.5) * 8;
      midX = startX - (22 + (Math.random() - 0.5) * 6);
      drift1X = startX - (48 + (Math.random() - 0.5) * 8);
      drift2X = startX - (68 + (Math.random() - 0.5) * 8);
      endX = startX - (84 + (Math.random() - 0.5) * 8);

      startRot = -3 + (Math.random() - 0.5) * 2;
      midRot = -9 + (Math.random() - 0.5) * 3;
      drift1Rot = -7 + (Math.random() - 0.5) * 2;
      drift2Rot = -4 + (Math.random() - 0.5) * 2;
      endRot = -2 + (Math.random() - 0.5) * 2;

      totalRise = 110 + Math.random() * 12;
      duration = 1380 + Math.random() * 80;
    } else if (lane === 'right') {
      // Sweeps strongly towards upper-right: strictly positive X corridor
      startX = 36 + (Math.random() - 0.5) * 8;
      midX = startX + (22 + (Math.random() - 0.5) * 6);
      drift1X = startX + (48 + (Math.random() - 0.5) * 8);
      drift2X = startX + (68 + (Math.random() - 0.5) * 8);
      endX = startX + (84 + (Math.random() - 0.5) * 8);

      startRot = 3 + (Math.random() - 0.5) * 2;
      midRot = 9 + (Math.random() - 0.5) * 3;
      drift1Rot = 7 + (Math.random() - 0.5) * 2;
      drift2Rot = 4 + (Math.random() - 0.5) * 2;
      endRot = 2 + (Math.random() - 0.5) * 2;

      totalRise = 110 + Math.random() * 12;
      duration = 1380 + Math.random() * 80;
    } else {
      // 'center' lane: ascends straight up through the middle, lofting higher
      startX = (Math.random() - 0.5) * 6;
      midX = (Math.random() - 0.5) * 4;
      drift1X = (Math.random() - 0.5) * 6;
      drift2X = (Math.random() - 0.5) * 6;
      endX = (Math.random() - 0.5) * 6;

      startRot = (Math.random() - 0.5) * 2;
      midRot = 2.5 + (Math.random() - 0.5) * 1.5;
      drift1Rot = -2.5 + (Math.random() - 0.5) * 1.5;
      drift2Rot = 1.5 + (Math.random() - 0.5) * 1.5;
      endRot = 0;

      totalRise = 142 + Math.random() * 12; // Reaches ~30px higher elevation
      duration = 1460 + Math.random() * 80;
    }

    pill.style.setProperty('--start-x', `${startX.toFixed(1)}px`);
    pill.style.setProperty('--start-y', `${startY.toFixed(1)}px`);
    pill.style.setProperty('--mid-x', `${midX.toFixed(1)}px`);
    pill.style.setProperty('--mid-y', `${(startY - totalRise * 0.32).toFixed(1)}px`);
    pill.style.setProperty('--drift1-x', `${drift1X.toFixed(1)}px`);
    pill.style.setProperty('--drift1-y', `${(startY - totalRise * 0.58).toFixed(1)}px`);
    pill.style.setProperty('--drift2-x', `${drift2X.toFixed(1)}px`);
    pill.style.setProperty('--drift2-y', `${(startY - totalRise * 0.82).toFixed(1)}px`);
    pill.style.setProperty('--end-x', `${endX.toFixed(1)}px`);
    pill.style.setProperty('--end-y', `${(startY - totalRise).toFixed(1)}px`);

    pill.style.setProperty('--start-rot', `${startRot.toFixed(1)}deg`);
    pill.style.setProperty('--mid-rot', `${midRot.toFixed(1)}deg`);
    pill.style.setProperty('--drift1-rot', `${drift1Rot.toFixed(1)}deg`);
    pill.style.setProperty('--drift2-rot', `${drift2Rot.toFixed(1)}deg`);
    pill.style.setProperty('--end-rot', `${endRot.toFixed(1)}deg`);
    pill.style.setProperty('--fly-duration', `${Math.round(duration)}ms`);

    layer.appendChild(pill);

    pill.addEventListener('animationend', () => {
      pill.remove();
    });
  }

  function spawnRewardPills(minutes, xp, streakBonus = 0) {
    const pills = [];
    if (streakBonus > 0) {
      // 3 pills: Left wing (+minutes), Center-high crown (+XP), Right wing (+Streak Bonus)
      pills.push({ text: `+${minutes}m`, class: 'pill-green', lane: 'left' });
      pills.push({ text: `+${xp} XP`, class: 'pill-xp', lane: 'center' });
      pills.push({ text: `+${streakBonus} SB`, class: 'pill-sb', lane: 'right' });
    } else {
      // 2 pills: Symmetrical V-wings (Left and Right)
      pills.push({ text: `+${minutes}m`, class: 'pill-green', lane: 'left' });
      pills.push({ text: `+${xp} XP`, class: 'pill-xp', lane: 'right' });
    }

    pills.forEach((p, i) => {
      setTimeout(() => {
        spawnFlyingPill(p.text, { extraClass: p.class, lane: p.lane });
      }, i * 90);
    });
  }

  // =========================================================================
  // GITHUB-STYLE MULTI-MONTH ACTIVITY HEATMAP (CALENDAR ACCURATE & EXPANSIVE)
  // =========================================================================
  const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Default general highest focus threshold in a day (4 hours = 240 mins)
  const DEFAULT_PEAK_MINUTES = 240;

  // Multi-tier color stops calibrated for dark mode: from deep obsidian pine to peak radiant neon green
  const HEATMAP_COLOR_STOPS = [
    { mins: 0,   r: 18,  g: 24,  b: 21  }, // #121815 (Empty tile)
    { mins: 12,  r: 13,  g: 46,  b: 24  }, // #0D2E18 (Quick 10-15m burst: subtle deep pine)
    { mins: 25,  r: 15,  g: 61,  b: 32  }, // #0F3D20 (25m Pomodoro: rich deep green)
    { mins: 45,  r: 19,  g: 79,  b: 42  }, // #134F2A (45m solid focus: forest green)
    { mins: 70,  r: 23,  g: 100, b: 53  }, // #176435 (~1.1h: deep emerald)
    { mins: 100, r: 27,  g: 124, b: 66  }, // #1B7C42 (~1.6h: rich green)
    { mins: 135, r: 31,  g: 152, b: 81  }, // #1F9851 (~2.25h: vivid green)
    { mins: 175, r: 36,  g: 184, b: 98  }, // #24B862 (~2.9h: bold electric green)
    { mins: 210, r: 16,  g: 224, b: 104 }, // #10E068 (~3.5h: luminous neon green)
    { mins: 240, r: 78,  g: 250, b: 143 }  // #4EFA8F (4.0h+ peak highest focus: radiant neon green)
  ];

  // Mathematical smooth-step interpolation yielding a distinct, flexible shade per minute
  function getHeatmapCellColor(minutes, customPeak = 240) {
    if (!minutes || minutes <= 0) {
      return { color: 'rgb(18, 24, 21)', level: 0, isPeak: false };
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

    return { color: 'rgb(18, 24, 21)', level: 0, isPeak: false };
  }

  function createMonthBlock(year, monthIndex, isFirstInGroup = false) {
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

    // If month starts mid-week (Tue-Sun), offset spacer column so gap is measured purely between valid cells
    if (!isFirstInGroup && firstDayOfWeek > 0) {
      monthBlock.classList.add('month-interlocked');
    }

    const todayStr = getLocalDateString();
    const now = new Date();
    const isCurrentMonth = (year === now.getFullYear() && monthIndex === now.getMonth());

    for (let c = 0; c < numCols; c++) {
      const col = document.createElement('div');
      col.className = 'week-col';
      if (c === numCols - 1) {
        col.classList.add('last-month-col');
      }

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

    function createYearGroup(year, startMonth, endMonth) {
      const yearGroup = document.createElement('div');
      yearGroup.className = 'year-group';
      yearGroup.dataset.year = year;

      const stickyHeader = document.createElement('div');
      stickyHeader.className = 'year-sticky-header';
      const badge = document.createElement('span');
      badge.className = 'year-sticky-badge';
      badge.textContent = year;
      stickyHeader.appendChild(badge);
      yearGroup.appendChild(stickyHeader);

      const monthsWrap = document.createElement('div');
      monthsWrap.className = 'year-months-wrap';

      for (let m = startMonth; m <= endMonth; m++) {
        const isFirst = (m === startMonth);
        const block = createMonthBlock(year, m, isFirst);
        monthsWrap.appendChild(block);
      }

      yearGroup.appendChild(monthsWrap);
      return yearGroup;
    }

    // 1. Build previous year's 12 months (Jan to Dec) as past history
    trackEl.appendChild(createYearGroup(currentYear - 1, 0, 11));

    // 2. Build current year's months up to current month (so current month is in last place!)
    trackEl.appendChild(createYearGroup(currentYear, 0, currentMonth));

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
    if (!scrollArea || !trackEl) return;

    const yearGroups = trackEl.querySelectorAll('.year-group');
    const sampleX = scrollArea.scrollLeft + Math.min(scrollArea.clientWidth - 40, scrollArea.clientWidth * 0.75);

    for (let i = yearGroups.length - 1; i >= 0; i--) {
      const g = yearGroups[i];
      if (g.offsetLeft <= sampleX) {
        const yr = g.dataset.year;
        if (yr) {
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

    const focusMins = isNaN(mins) ? 0 : mins;
    tooltipEl.textContent = `${formatted} • ${focusMins}m`;

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
      window.AmbientAura?.updateTimerCenter?.();
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

  // =========================================================================
  // RPG PROGRESSION SYSTEM (1,000 LEVELS & 100 TIERS)
  // =========================================================================
  const RPG_TIERS = [
    'Novice', 'Trainee', 'Apprentice', 'Initiate', 'Recruit',
    'Scout', 'Pathfinder', 'Adventurer', 'Explorer', 'Pioneer',
    'Iron Initiate', 'Iron Guard', 'Iron Vanguard', 'Iron Knight',
    'Bronze Striker', 'Bronze Warrior', 'Bronze Knight', 'Bronze Champion',
    'Silver Scout', 'Silver Guard', 'Silver Knight', 'Silver Champion',
    'Gold Striker', 'Gold Warrior', 'Gold Knight', 'Gold Paladin', 'Gold Champion',
    'Platinum Scout', 'Platinum Knight', 'Platinum Paladin', 'Platinum Champion',
    'Diamond Striker', 'Diamond Guard', 'Diamond Knight', 'Diamond Vanguard', 'Diamond Champion',
    'Emerald Ranger', 'Emerald Warrior', 'Emerald Knight', 'Emerald Champion',
    'Ruby Berserker', 'Ruby Slayer', 'Ruby Knight', 'Ruby Champion',
    'Sapphire Scout', 'Sapphire Guardian', 'Sapphire Knight', 'Sapphire Champion',
    'Obsidian Striker', 'Obsidian Knight', 'Obsidian Vanguard', 'Obsidian Champion',
    'Shadow Scout', 'Shadow Blade', 'Shadow Knight', 'Shadow Master',
    'Ranger Elite', 'Hunter Master', 'Assassin Elite', 'Duelist Champion',
    'Gladiator Warlord', 'Berserker Champion', 'Paladin Commander', 'Templar Knight',
    'Crusader Champion', 'Battlemage', 'Spellblade Master', 'Stormcaller',
    'Frost Knight', 'Flame Knight', 'Thunder Vanguard', 'Void Walker',
    'Void Slayer', 'Dragon Knight', 'Dragon Slayer', 'Titan Slayer',
    'Colossus Guard', 'Juggernaut', 'Warlord', 'High Commander',
    'Grand Marshal', 'Vanguard Sovereign', 'Hero', 'Veteran Hero',
    'Apex Champion', 'Grandmaster', 'High Grandmaster', 'Mythic Knight',
    'Mythic Champion', 'Mythic Warlord', 'Legend', 'Apex Legend',
    'Demigod', 'Immortal', 'Celestial Knight', 'Ascendant',
    'Transcendent', 'Archon', 'Sovereign', 'The Absolute'
  ];

  const ROMAN_NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

  const RPG_LEVELS = (() => {
    const list = [];
    let cum = 0;
    for (let lvl = 1; lvl <= 1000; lvl++) {
      const tierIdx = Math.floor((lvl - 1) / 10);
      const tier = RPG_TIERS[tierIdx] || 'The Absolute';
      const sub = ROMAN_NUMERALS[(lvl - 1) % 10];
      const title = `${tier} ${sub}`;
      const xpReq = Math.max(50, Math.round((50 + 8 * (lvl - 1) + 0.15 * Math.pow(lvl, 1.3)) / 5) * 5);
      const minXp = cum;
      const maxXp = cum + xpReq;
      cum = maxXp;
      list.push({
        level: lvl,
        title: title,
        tier: tier,
        tierIndex: tierIdx + 1,
        xpRequired: xpReq,
        minXp: minXp,
        maxXp: maxXp
      });
    }
    return list;
  })();

  function getLevelInfo(totalXp) {
    const xp = Math.max(0, Math.floor(totalXp || 0));
    for (let i = 0; i < RPG_LEVELS.length; i++) {
      const l = RPG_LEVELS[i];
      if (xp < l.maxXp || l.level === 1000) {
        const currentLevelXp = Math.max(0, xp - l.minXp);
        const xpRequired = l.xpRequired;
        const progressPercent = Math.min(100, Math.max(0, (currentLevelXp / xpRequired) * 100));
        return {
          level: l.level,
          title: l.title,
          tier: l.tier,
          tierIndex: l.tierIndex,
          currentLevelXp: currentLevelXp,
          xpRequired: xpRequired,
          progressPercent: progressPercent,
          totalXp: xp,
          isMax: l.level === 1000 && xp >= l.maxXp
        };
      }
    }
    const maxL = RPG_LEVELS[RPG_LEVELS.length - 1];
    return {
      level: maxL.level,
      title: maxL.title,
      tier: maxL.tier,
      tierIndex: maxL.tierIndex,
      currentLevelXp: maxL.xpRequired,
      xpRequired: maxL.xpRequired,
      progressPercent: 100,
      totalXp: xp,
      isMax: true
    };
  }

  function renderStats() {
    const streakEl = document.getElementById('stat-streak');
    const xpEl = document.getElementById('stat-xp');
    const levelNumEl = document.getElementById('stat-level-num');
    const levelNameEl = document.getElementById('stat-level-name');
    const xpFractionEl = document.getElementById('stat-xp-fraction');
    const xpBarFillEl = document.getElementById('stat-xp-bar-fill');
    const xpItemEl = document.getElementById('stat-item-xp');
    const settingTotalFocusEl = document.getElementById('setting-total-focus');

    if (streakEl) {
      streakEl.textContent = formatCompactNumber(state.streak);
      streakEl.title = `${Number(state.streak || 0).toLocaleString()} Day Streak`;
    }

    const lvlInfo = getLevelInfo(state.xp);

    if (xpEl) {
      xpEl.textContent = formatCompactNumber(state.xp);
    }
    if (levelNumEl) {
      levelNumEl.textContent = `Lv. ${lvlInfo.level}`;
    }
    if (levelNameEl) {
      levelNameEl.textContent = lvlInfo.title;
    }
    if (xpFractionEl) {
      xpFractionEl.textContent = `${formatCompactNumber(lvlInfo.currentLevelXp)} / ${formatCompactNumber(lvlInfo.xpRequired)} XP`;
    }
    if (xpBarFillEl) {
      xpBarFillEl.style.width = `${lvlInfo.progressPercent.toFixed(1)}%`;
    }
    if (xpItemEl) {
      xpItemEl.title = `Level ${lvlInfo.level}: ${lvlInfo.title} (${lvlInfo.tier})\nCollected: ${lvlInfo.currentLevelXp.toLocaleString()} / ${lvlInfo.xpRequired.toLocaleString()} XP (${lvlInfo.progressPercent.toFixed(1)}%)\nTotal Studied: ${Number(state.xp || 0).toLocaleString()} XP`;
    }

    if (settingTotalFocusEl) {
      settingTotalFocusEl.textContent = formatHoursMinutes(state.totalFocusSeconds);
    }

    updateTodayLiveStat();
    adjustStatFontFit();

    const levelsDlg = document.getElementById('levels-dialog');
    if (levelsDlg && levelsDlg.open) {
      renderLevelsDialogDOM();
    }
  }

  // =========================================================================
  // DAY DETAIL MODAL DIALOG (TODAY & PAST CELL CHRONICLE)
  // =========================================================================
  let currentDialogDate = null;

  function formatDayDateHeader(dateStr) {
    try {
      const parts = dateStr.split('-');
      const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    } catch (_) {
      return dateStr;
    }
  }

  function getDayDataFromClient(dateStr) {
    // 1. Check in-memory cache first
    if (dayDetailsCache.has(dateStr)) {
      return dayDetailsCache.get(dateStr);
    }

    const todayStr = getLocalDateString();
    const isToday = (dateStr === todayStr);
    const formattedDate = formatDayDateHeader(dateStr);
    const activityMins = (state.dayActivity && state.dayActivity[dateStr]) || 0;

    // 2. Zero-minute day: 100% complete rest day, no network needed
    if (activityMins === 0) {
      const emptyData = {
        date: dateStr,
        formattedDate,
        isToday,
        totalMinutes: 0,
        totalTimeFormatted: '0m',
        totalSessions: 0,
        avgFocusMinutes: 0,
        totalXp: 0,
        sessions: []
      };
      dayDetailsCache.set(dateStr, emptyData);
      return emptyData;
    }

    // 3. Check if state.sessions has all records for this date
    const matching = (state.sessions || []).filter(s => s.date === dateStr);
    let matchingMins = 0;
    matching.forEach(s => matchingMins += (s.durationMinutes || s.duration_minutes || 0));

    // If the sum of durations in state.sessions matches known dayActivity minutes, we have all records!
    if (matchingMins >= activityMins && matching.length > 0) {
      const totalSess = matching.length;
      const avgMins = Math.round(matchingMins / totalSess);
      const hrs = Math.floor(matchingMins / 60);
      const mins = matchingMins % 60;
      const formattedTotal = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

      const sortedMatching = [...matching].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      const fullData = {
        date: dateStr,
        formattedDate,
        isToday,
        totalMinutes: matchingMins,
        totalTimeFormatted: formattedTotal,
        totalSessions: totalSess,
        avgFocusMinutes: avgMins,
        totalXp: matchingMins,
        sessions: sortedMatching.map(s => {
          const duration = s.durationMinutes || s.duration_minutes || 0;
          const ts = s.timestamp || Date.now();
          const endD = new Date(ts);
          const startD = new Date(ts - duration * 60000);
          const timeRange = s.timeRange || `${formatTime(startD)} – ${formatTime(endD)}`;
          return {
            id: s.id,
            subject: s.subject || s.subject_name || 'Focus Session',
            color: s.color || '#10E068',
            durationMinutes: duration,
            timeRange: timeRange,
            xp: duration
          };
        })
      };
      dayDetailsCache.set(dateStr, fullData);
      return fullData;
    }

    return null;
  }

  function renderDayDialogDOM(dayData) {
    const badgeEl = document.getElementById('day-dialog-badge');
    const titleEl = document.getElementById('day-dialog-title');
    const timeEl = document.getElementById('day-pill-time');
    const sessEl = document.getElementById('day-pill-sessions');
    const avgEl = document.getElementById('day-pill-avg');
    const xpEl = document.getElementById('day-pill-xp');
    const countEl = document.getElementById('day-timeline-count');
    const listEl = document.getElementById('day-sessions-list');

    if (badgeEl) badgeEl.textContent = dayData.isToday ? "Today's Record" : "Day Record";
    if (titleEl) titleEl.textContent = dayData.formattedDate || dayData.date;
    if (timeEl) timeEl.textContent = dayData.totalTimeFormatted || `${dayData.totalMinutes || 0}m`;
    if (sessEl) sessEl.textContent = dayData.totalSessions || 0;
    if (avgEl) avgEl.textContent = `${dayData.avgFocusMinutes || 0}m`;
    if (xpEl) xpEl.textContent = `+${formatCompactNumber(dayData.totalXp || 0)} XP`;
    if (countEl) {
      const sessCount = dayData.totalSessions || 0;
      countEl.textContent = `${sessCount} session${sessCount === 1 ? '' : 's'}`;
    }

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
            <div class="day-empty-sub">${dayData.isToday ? 'Start the timer to record your first focus block today!' : 'Rest day recorded. Zero minutes studied.'}</div>
          </div>
        `;
      } else {
        listEl.innerHTML = dayData.sessions.map(s => `
          <div class="day-session-card" data-session-id="${escapeHtml(s.id)}" data-duration="${s.durationMinutes}">
            <div class="day-session-left">
              <div class="day-session-timeline">
                <span class="day-session-track-line"></span>
                <span class="day-session-track-node"></span>
              </div>
              <div class="day-session-orb-wrapper">
                <span class="day-session-orb" style="background-color: ${s.color || '#00ff87'};"></span>
              </div>
              <div class="day-session-info">
                <span class="day-session-subject">${escapeHtml(s.subject)}</span>
                <span class="day-session-timerange">${escapeHtml(s.timeRange || '')}</span>
              </div>
            </div>
            <div class="day-session-right">
              <div class="day-session-duration">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                <span>${s.durationMinutes} mins</span>
              </div>
              <span class="day-session-xp">+${formatCompactNumber(s.xp || s.durationMinutes)} XP</span>
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
    initShellLenis();
    setTimeout(() => { dayLenis?.resize(); }, 30);
  }

  function renderDayDialogSkeleton(dateStr) {
    const todayStr = getLocalDateString();
    const isToday = (dateStr === todayStr);
    const formattedDate = formatDayDateHeader(dateStr);
    const activityMins = (state.dayActivity && state.dayActivity[dateStr]) || 0;
    const hrs = Math.floor(activityMins / 60);
    const mins = activityMins % 60;
    const formattedTotal = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

    const badgeEl = document.getElementById('day-dialog-badge');
    const titleEl = document.getElementById('day-dialog-title');
    const timeEl = document.getElementById('day-pill-time');
    const sessEl = document.getElementById('day-pill-sessions');
    const avgEl = document.getElementById('day-pill-avg');
    const xpEl = document.getElementById('day-pill-xp');
    const countEl = document.getElementById('day-timeline-count');
    const listEl = document.getElementById('day-sessions-list');

    if (badgeEl) badgeEl.textContent = isToday ? "Today's Record" : "Day Record";
    if (titleEl) titleEl.textContent = formattedDate;
    if (timeEl) timeEl.textContent = activityMins > 0 ? formattedTotal : '...';
    if (sessEl) sessEl.textContent = '...';
    if (avgEl) avgEl.textContent = '...';
    if (xpEl) xpEl.textContent = activityMins > 0 ? `+${formatCompactNumber(activityMins)} XP` : '...';
    if (countEl) countEl.textContent = 'Loading...';
    if (listEl) {
      listEl.innerHTML = `
        <div class="day-session-skeleton"></div>
        <div class="day-session-skeleton" style="opacity: 0.6;"></div>
      `;
    }
  }

  async function openDayDialog(dateStr) {
    const dialog = document.getElementById('day-detail-dialog');
    if (!dialog) return;

    currentDialogDate = dateStr;

    // 1. Instant Synchronous Resolution: Cache, Zero-Minute Rest Day, or Already in state.sessions
    let dayData = getDayDataFromClient(dateStr);
    if (dayData) {
      renderDayDialogDOM(dayData);
      if (typeof dialog.showModal === 'function' && !dialog.open) {
        dialog.showModal();
      }
      globalLenis?.stop();
      initShellLenis();
      setTimeout(() => { dayLenis?.resize(); }, 40);
      return;
    }

    // 2. Fallback for older dates outside recent memory:
    // Pre-populate with known activity stats & skeleton feed immediately so NO PREVIOUS DAY DATA IS EVER SHOWN
    renderDayDialogSkeleton(dateStr);
    if (typeof dialog.showModal === 'function' && !dialog.open) {
      dialog.showModal();
    }
    globalLenis?.stop();
    initShellLenis();
    setTimeout(() => { dayLenis?.resize(); }, 40);

    // 3. Fetch full session details from SQLite/Postgres backend
    try {
      const res = await fetch(`/api/day/${dateStr}`);
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.data) {
          dayData = json.data;
          dayDetailsCache.set(dateStr, dayData);
        }
      }
    } catch (e) {
      console.warn('StudyArc: Error fetching day data from backend:', e);
    }

    // 4. Ensure user hasn't switched to another date before applying
    if (currentDialogDate === dateStr) {
      if (!dayData) {
        dayData = getDayDataFromClient(dateStr) || {
          date: dateStr,
          formattedDate: formatDayDateHeader(dateStr),
          isToday: dateStr === getLocalDateString(),
          totalMinutes: 0,
          totalTimeFormatted: '0m',
          totalSessions: 0,
          avgFocusMinutes: 0,
          totalXp: 0,
          sessions: []
        };
      }
      renderDayDialogDOM(dayData);
    }
  }

  function closeDayDialog() {
    currentDialogDate = null;
    const dialog = document.getElementById('day-detail-dialog');
    if (dialog && dialog.open) {
      dialog.close();
    }
    globalLenis?.start();
  }

  // =========================================================================
  // RPG LEVEL & MASTERY MODAL DIALOG
  // =========================================================================
  let showAllLevelsView = false;

  function calculateLevelClearDates() {
    const dates = Object.assign({}, state.levelClearHistory || {});
    const sessions = (state.sessions || []).slice();
    sessions.sort((a, b) => {
      const tA = a.timestamp || (a.date ? new Date(a.date).getTime() : 0);
      const tB = b.timestamp || (b.date ? new Date(b.date).getTime() : 0);
      return tA - tB;
    });

    let cum = 0;
    let nextLvlIdx = 0;
    for (const s of sessions) {
      cum += Number(s.xp || s.durationMinutes || 0);
      while (nextLvlIdx < RPG_LEVELS.length && cum >= RPG_LEVELS[nextLvlIdx].maxXp) {
        const l = RPG_LEVELS[nextLvlIdx];
        if (!dates[l.level]) {
          dates[l.level] = {
            date: s.date,
            timestamp: s.timestamp,
            formatted: s.date ? formatDayDateHeader(s.date) : 'Cleared'
          };
        }
        nextLvlIdx++;
      }
    }

    const currentLvl = getLevelInfo(state.xp).level;
    for (let i = 0; i < currentLvl - 1; i++) {
      const l = RPG_LEVELS[i];
      if (!dates[l.level]) {
        dates[l.level] = {
          formatted: 'Milestone Cleared'
        };
      }
    }
    return dates;
  }

  let activeLevelsScroller = null;
  let activeJourneyCleanup = null;

  function resetLevelsContainer(cleanDOM = false) {
    const feedList = document.getElementById('levels-feed-list');

    // 1. Destroy and clean up any active scrollers, RAF loops, or scroll listeners
    if (activeJourneyCleanup) {
      try { activeJourneyCleanup(); } catch (e) {}
      activeJourneyCleanup = null;
    }
    if (activeLevelsScroller) {
      try { activeLevelsScroller.destroy(); } catch (e) {}
      activeLevelsScroller = null;
    }

    // 2. Halt and reset smooth scrolling (Lenis) momentum immediately
    if (typeof levelsLenis !== 'undefined' && levelsLenis) {
      try {
        levelsLenis.stop();
        levelsLenis.scrollTo(0, { immediate: true, force: true });
        levelsLenis.scroll = 0;
        levelsLenis.targetScroll = 0;
        levelsLenis.velocity = 0;
      } catch (e) {}
    }

    // 3. Reset DOM container scroll positions
    if (feedList) {
      feedList.scrollTop = 0;
      feedList.scrollLeft = 0;
      if (cleanDOM) {
        feedList.innerHTML = '';
      }
    }
  }

  function openLevelsDialog() {
    const dialog = document.getElementById('levels-dialog');
    if (!dialog) return;

    // Clear any text selection that may have occurred
    if (window.getSelection) {
      window.getSelection().removeAllRanges();
    }

    // Reset container as soon as we leave or start, starting fresh from beginning
    resetLevelsContainer(true);
    showAllLevelsView = false;
    renderLevelsDialogDOM();

    if (typeof dialog.showModal === 'function' && !dialog.open) {
      dialog.showModal();
    }

    // Direct focus to the close button so browser never text-selects "All Levels"
    const closeBtn = document.getElementById('btn-close-levels-dialog');
    if (closeBtn) {
      try { closeBtn.focus({ preventScroll: true }); } catch (e) {}
    } else if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }

    globalLenis?.stop();
    initShellLenis();
    if (typeof levelsLenis !== 'undefined' && levelsLenis) {
      levelsLenis.scrollTo(0, { immediate: true, force: true });
      levelsLenis.resize();
      levelsLenis.start();
    }
    setTimeout(() => { levelsLenis?.resize(); }, 40);
  }

  function closeLevelsDialog() {
    const dialog = document.getElementById('levels-dialog');
    if (dialog && dialog.open) {
      dialog.close();
    }
    // Reset container as soon as we leave, as if starting from beginning
    resetLevelsContainer(true);
    showAllLevelsView = false;
    globalLenis?.start();
  }

  class VirtualLevelsScroller {
    constructor({
      container,
      virtualItems,
      tierHeaderIndices,
      renderCard,
      renderTierHeader,
      headingEl,
      isCatalogMode,
      currentLevel
    }) {
      this.container = container;
      this.virtualItems = virtualItems;
      this.tierHeaderIndices = tierHeaderIndices;
      this.renderCard = renderCard;
      this.renderTierHeader = renderTierHeader;
      this.headingEl = headingEl;
      this.isCatalogMode = isCatalogMode;
      this.currentLevel = currentLevel;

      this.mountedElements = new Map();
      this.totalHeight = 0;
      this.itemOffsets = new Float64Array(virtualItems.length);
      for (let i = 0; i < virtualItems.length; i++) {
        this.itemOffsets[i] = this.totalHeight;
        this.totalHeight += virtualItems[i].height;
      }

      this.container.innerHTML = '';

      this.topSpacer = document.createElement('div');
      this.topSpacer.className = 'levels-spacer-top';
      this.topSpacer.style.height = '0px';
      this.topSpacer.style.display = 'none';

      this.bottomSpacer = document.createElement('div');
      this.bottomSpacer.className = 'levels-spacer-bottom';
      this.bottomSpacer.style.height = `${this.totalHeight}px`;

      this.container.appendChild(this.topSpacer);
      this.container.appendChild(this.bottomSpacer);

      this.rafId = null;
      this.animRafId = null;
      this.onScroll = this.onScroll.bind(this);
      this.container.addEventListener('scroll', this.onScroll, { passive: true });

      if (typeof levelsLenis !== 'undefined' && levelsLenis) {
        this.lenisHandler = () => {
          this.updateWindow(false);
        };
        levelsLenis.on('scroll', this.lenisHandler);
      }

      this.updateWindow(true);
    }

    destroy() {
      this.container.removeEventListener('scroll', this.onScroll);
      if (typeof levelsLenis !== 'undefined' && levelsLenis && this.lenisHandler) {
        try { levelsLenis.off('scroll', this.lenisHandler); } catch (e) {}
      }
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      if (this.animRafId) {
        cancelAnimationFrame(this.animRafId);
        this.animRafId = null;
      }
      this.mountedElements.clear();
    }

    onScroll() {
      if (this.rafId) return;
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.updateWindow(false);
      });
    }

    getVisibleRange(scrollTop, viewportHeight) {
      // In Catalog mode (All Levels), use focused buffer (140px) so items animate right as they enter view area
      // In My Journey mode, use generous buffer (360px) so items are pre-loaded immediately without delay
      const buffer = this.isCatalogMode ? 140 : 360;
      const minY = Math.max(0, scrollTop - buffer);
      const maxY = scrollTop + viewportHeight + buffer;

      let startIndex = 0;
      let endIndex = this.virtualItems.length - 1;

      let low = 0, high = this.virtualItems.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (this.itemOffsets[mid] + this.virtualItems[mid].height >= minY) {
          startIndex = mid;
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }

      low = startIndex; high = this.virtualItems.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (this.itemOffsets[mid] <= maxY) {
          endIndex = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      return { startIndex, endIndex };
    }

    updateWindow(isInitial = false) {
      if (this.virtualItems.length === 0) return;

      const scrollTop = this.container.scrollTop;
      const viewportHeight = this.container.clientHeight || (this.isCatalogMode ? 520 : 360);
      const { startIndex, endIndex } = this.getVisibleRange(scrollTop, viewportHeight);

      // Identify active tier for sticky header & heading display
      const firstItem = this.virtualItems[startIndex];
      const activeTierIdx = firstItem.type === 'tier' ? firstItem.tierIndex : firstItem.level.tierIndex;
      const activeTierName = firstItem.type === 'tier' ? firstItem.tier : firstItem.level.tier;

      if (this.headingEl && activeTierName) {
        this.headingEl.textContent = `Tier ${activeTierIdx}: ${activeTierName}`;
      }

      // Check if the current tier header should be pinned above the visible cards
      const activeTierHeaderIdx = this.tierHeaderIndices[activeTierIdx];
      let pinHeaderIdx = null;
      if (activeTierHeaderIdx !== undefined && activeTierHeaderIdx < startIndex) {
        pinHeaderIdx = activeTierHeaderIdx;
      }

      const neededIndices = new Set();
      if (pinHeaderIdx !== null) neededIndices.add(pinHeaderIdx);
      for (let i = startIndex; i <= endIndex; i++) {
        neededIndices.add(i);
      }

      // 1. Remove elements that leave the view range on both sides (scrolling down and scrolling up)
      for (const [idx, el] of this.mountedElements.entries()) {
        if (!neededIndices.has(idx)) {
          el.remove();
          this.mountedElements.delete(idx);
        }
      }

      // 2. Mount new or reappearing items into correct DOM position
      const sortedIndices = Array.from(neededIndices).sort((a, b) => a - b);

      for (let i = 0; i < sortedIndices.length; i++) {
        const idx = sortedIndices[i];
        if (this.mountedElements.has(idx)) continue;

        const item = this.virtualItems[idx];
        let el;
        if (item.type === 'tier') {
          el = this.renderTierHeader(item);
        } else {
          el = this.renderCard(item.level);
        }

        // Find correct anchor in DOM
        let anchor = this.bottomSpacer;
        for (let j = i + 1; j < sortedIndices.length; j++) {
          if (this.mountedElements.has(sortedIndices[j])) {
            anchor = this.mountedElements.get(sortedIndices[j]);
            break;
          }
        }

        this.container.insertBefore(el, anchor);
        this.mountedElements.set(idx, el);
      }

      // 3. Update top and bottom spacers to maintain exact scroll height
      let topSpacerHeight = this.itemOffsets[startIndex];
      if (pinHeaderIdx !== null) {
        topSpacerHeight = Math.max(0, topSpacerHeight - this.virtualItems[pinHeaderIdx].height);
      }
      const bottomSpacerHeight = Math.max(0, this.totalHeight - (this.itemOffsets[endIndex] + this.virtualItems[endIndex].height));

      if (topSpacerHeight > 0) {
        this.topSpacer.style.display = 'block';
        this.topSpacer.style.height = `${topSpacerHeight}px`;
      } else {
        this.topSpacer.style.display = 'none';
        this.topSpacer.style.height = '0px';
      }

      if (bottomSpacerHeight > 0) {
        this.bottomSpacer.style.display = 'block';
        this.bottomSpacer.style.height = `${bottomSpacerHeight}px`;
      } else {
        this.bottomSpacer.style.display = 'none';
        this.bottomSpacer.style.height = '0px';
      }

      // 4. Trigger animations:
      // - ALL LEVELS: The beloved original delayed entrance with cascade as cards reach view threshold
      // - MY JOURNEY: Immediate, zero-delay load for lightning-fast responsiveness
      const viewTop = scrollTop;
      const viewBottom = scrollTop + viewportHeight;
      const toAnimate = [];

      for (const [idx, el] of this.mountedElements.entries()) {
        if (el.classList.contains('visible')) continue;

        const itemTop = this.itemOffsets[idx];
        const itemBottom = itemTop + this.virtualItems[idx].height;

        let isEnteringView = false;
        if (this.isCatalogMode) {
          // All Levels: The original view-boundary trigger
          isEnteringView = (idx === pinHeaderIdx) || (
            itemBottom >= viewTop - 10 && itemTop <= viewBottom + 25
          );
        } else {
          // My Journey: Broad pre-trigger for instantaneous, zero-delay load
          isEnteringView = (idx === pinHeaderIdx) || (
            itemBottom >= viewTop - 100 && itemTop <= viewBottom + 300
          );
        }

        if (isEnteringView) {
          toAnimate.push(el);
        }
      }

      if (toAnimate.length > 0) {
        if (this.animRafId) {
          cancelAnimationFrame(this.animRafId);
          this.animRafId = null;
        }
        this.animRafId = requestAnimationFrame(() => {
          this.animRafId = null;
          toAnimate.forEach((el, i) => {
            if (this.isCatalogMode) {
              void el.offsetWidth; // Force reflow for the signature delayed multi-effect transition
              const delay = Math.min((i % 5) * 35, 140);
              el.style.transitionDelay = `${delay}ms`;
            } else {
              el.style.transitionDelay = '0ms';
            }
            el.classList.add('visible');
          });
        });
      }
    }

    scrollToLevel(targetLevel, immediate = false) {
      const vIdx = this.virtualItems.findIndex(it => it.type === 'level' && it.level.level === targetLevel);
      if (vIdx !== -1) {
        const targetScroll = Math.max(0, this.itemOffsets[vIdx] - 120);
        if (typeof levelsLenis !== 'undefined' && levelsLenis) {
          levelsLenis.scrollTo(targetScroll, { immediate });
        } else {
          this.container.scrollTop = targetScroll;
        }
        this.updateWindow(false);
      }
    }
  }

  function renderLevelsDialogDOM() {
    const dialog = document.getElementById('levels-dialog');
    if (!dialog) return;

    const shell = document.getElementById('levels-dialog-shell');
    if (shell) {
      shell.classList.toggle('is-catalog-mode', showAllLevelsView);
    }

    const lvlInfo = getLevelInfo(state.xp);
    const clearDates = calculateLevelClearDates();

    // 1. My Journey View Header & Metric cards
    const titleEl = document.getElementById('levels-dialog-title');
    const badgeEl = document.getElementById('levels-dialog-badge');
    const toggleBtnText = document.getElementById('toggle-levels-text');

    if (titleEl) {
      titleEl.textContent = `Level ${lvlInfo.level} — ${lvlInfo.title}`;
    }
    if (badgeEl) {
      badgeEl.textContent = `Tier ${lvlInfo.tierIndex}: ${lvlInfo.tier}`;
    }
    if (toggleBtnText) {
      toggleBtnText.textContent = 'All Levels';
    }

    // 3 Metric Cards
    const pillLevel = document.getElementById('levels-pill-level');
    const pillTier = document.getElementById('levels-pill-tier');
    const pillNext = document.getElementById('levels-pill-next');

    if (pillLevel) pillLevel.textContent = `Lv. ${lvlInfo.level}`;
    if (pillTier) pillTier.textContent = lvlInfo.tier;
    if (pillNext) {
      if (lvlInfo.isMax) {
        pillNext.textContent = 'Max Rank';
      } else {
        const remaining = Math.max(0, lvlInfo.xpRequired - lvlInfo.currentLevelXp);
        pillNext.textContent = `${formatCompactNumber(remaining)} XP`;
      }
    }

    // Progress Bar Card
    const progressFractionEl = document.getElementById('levels-progress-fraction');
    const progressPercentEl = document.getElementById('levels-progress-percent');
    const barFillEl = document.getElementById('levels-bar-fill');
    const totalXpEl = document.getElementById('levels-total-xp');

    if (progressFractionEl) {
      progressFractionEl.textContent = `${formatCompactNumber(lvlInfo.currentLevelXp)} / ${formatCompactNumber(lvlInfo.xpRequired)} XP (${lvlInfo.progressPercent.toFixed(1)}%)`;
    }
    if (progressPercentEl) {
      progressPercentEl.textContent = lvlInfo.isMax ? 'MAX' : `${lvlInfo.progressPercent.toFixed(0)}%`;
    }
    if (barFillEl) {
      barFillEl.style.width = `${lvlInfo.progressPercent.toFixed(1)}%`;
    }
    if (totalXpEl) {
      totalXpEl.textContent = `${Number(state.xp || 0).toLocaleString()} XP`;
    }

    // 2. Feed List and Heading
    const headingEl = document.getElementById('levels-feed-heading');
    const countEl = document.getElementById('levels-feed-count');
    const feedList = document.getElementById('levels-feed-list');
    if (!feedList) return;

    if (activeLevelsScroller) {
      activeLevelsScroller.destroy();
      activeLevelsScroller = null;
    }
    if (activeJourneyCleanup) {
      activeJourneyCleanup();
      activeJourneyCleanup = null;
    }

    let itemsToRender = [];
    if (showAllLevelsView) {
      if (headingEl) headingEl.textContent = 'Tier 1: Novice';
      if (countEl) countEl.textContent = '1,000 Levels • 100 Tiers';
      itemsToRender = RPG_LEVELS;
    } else {
      if (headingEl) headingEl.textContent = `Tier ${lvlInfo.tierIndex}: ${lvlInfo.tier}`;
      const clearedCount = Math.max(0, lvlInfo.level - 1);
      if (countEl) countEl.textContent = `${clearedCount} Cleared • Lv. ${lvlInfo.level}`;
      const maxPreview = Math.min(RPG_LEVELS.length, lvlInfo.level);
      itemsToRender = RPG_LEVELS.slice(0, maxPreview).slice().reverse();
    }

    const virtualItems = [];
    const tierHeaderIndices = {};
    let lastTierIndex = -1;

    itemsToRender.forEach((l) => {
      if (l.tierIndex !== lastTierIndex) {
        lastTierIndex = l.tierIndex;
        tierHeaderIndices[l.tierIndex] = virtualItems.length;
        virtualItems.push({
          type: 'tier',
          tierIndex: l.tierIndex,
          tier: l.tier,
          height: 48
        });
      }
      virtualItems.push({
        type: 'level',
        level: l,
        height: 60
      });
    });

    const renderCard = (l) => {
      const isCleared = l.level < lvlInfo.level || (l.level === 1000 && lvlInfo.isMax);
      const isCurrent = l.level === lvlInfo.level && !lvlInfo.isMax;
      const isLocked = l.level > lvlInfo.level;

      const card = document.createElement('div');
      card.className = `level-card ${isCurrent ? 'is-current' : ''} ${isLocked ? 'is-locked' : ''} ${showAllLevelsView && isCurrent ? 'is-user-current' : ''}`;
      card.setAttribute('data-level', l.level);
      if (isCurrent) {
        card.setAttribute('data-current-level', 'true');
      }

      let subtitle = '';
      let badgeHtml = '';

      if (showAllLevelsView) {
        subtitle = `Requires +${formatCompactNumber(l.xpRequired)} XP • Total: ${formatCompactNumber(l.maxXp)} XP`;
        if (isCurrent) {
          badgeHtml = `<span class="level-badge-status level-badge-current">Your Rank</span>`;
        } else {
          badgeHtml = `<span class="level-badge-status level-badge-catalog">${formatCompactNumber(l.xpRequired)} XP</span>`;
        }
      } else {
        if (isCleared) {
          const clearRecord = clearDates[l.level];
          const dateStr = clearRecord?.formatted || (clearRecord?.date ? formatDayDateHeader(clearRecord.date) : 'Cleared Milestone');
          subtitle = `Cleared on ${dateStr} • ${formatCompactNumber(l.xpRequired)} XP`;
          badgeHtml = `<span class="level-badge-status level-badge-cleared">Cleared ✓</span>`;
        } else if (isCurrent) {
          const remaining = Math.max(0, l.xpRequired - lvlInfo.currentLevelXp);
          subtitle = `Current Level • ${formatCompactNumber(lvlInfo.currentLevelXp)} / ${formatCompactNumber(l.xpRequired)} XP (${remaining} XP to next)`;
          badgeHtml = `<span class="level-badge-status level-badge-current">${lvlInfo.progressPercent.toFixed(0)}%</span>`;
        } else {
          const diff = Math.max(0, l.minXp - state.xp);
          subtitle = `Unlocks at ${formatCompactNumber(l.minXp)} XP total (${formatCompactNumber(diff)} XP needed)`;
          badgeHtml = `<span class="level-badge-status level-badge-locked">${formatCompactNumber(l.xpRequired)} XP</span>`;
        }
      }

      card.innerHTML = `
        <div class="level-left">
          <div class="level-timeline">
            <span class="level-track-line"></span>
            <span class="level-track-node"></span>
          </div>
          <div class="level-orb-wrapper">
            <span class="level-orb"></span>
          </div>
          <div class="level-info">
            <div class="level-title-row">
              <span class="level-item-lvl">Lv. ${l.level}</span>
              <span class="level-item-name">${escapeHtml(l.title)}</span>
            </div>
            <span class="level-item-subtitle">${subtitle}</span>
          </div>
        </div>
        <div class="level-right">
          ${badgeHtml}
        </div>
      `;
      return card;
    };

    const renderTierHeader = (item) => {
      const tierStartLvl = (item.tierIndex - 1) * 10 + 1;
      const tierEndLvl = item.tierIndex * 10;
      const tierHdr = document.createElement('div');
      tierHdr.className = 'level-tier-sticky-header';
      tierHdr.setAttribute('data-tier-name', item.tier);
      tierHdr.setAttribute('data-tier-idx', item.tierIndex);
      tierHdr.innerHTML = `
        <div class="level-tier-sticky-left">
          <span class="level-tier-badge">Tier ${item.tierIndex}</span>
          <span class="level-tier-name">${escapeHtml(item.tier)}</span>
        </div>
        <span class="level-tier-range">Lv. ${tierStartLvl} – ${tierEndLvl}</span>
      `;
      return tierHdr;
    };

    if (showAllLevelsView) {
      // 1,000 Levels Codex Catalog: Uses the Virtual Scroller with the beloved 0.8s delayed calorie-tracker animation
      activeLevelsScroller = new VirtualLevelsScroller({
        container: feedList,
        virtualItems,
        tierHeaderIndices,
        renderCard,
        renderTierHeader,
        headingEl,
        isCatalogMode: true,
        currentLevel: lvlInfo.level
      });

      initShellLenis();
      if (typeof levelsLenis !== 'undefined' && levelsLenis) {
        levelsLenis.scrollTo(0, { immediate: true, force: true });
        levelsLenis.resize();
        levelsLenis.start();
      }
      setTimeout(() => { levelsLenis?.resize(); }, 40);
    } else {
      // My Journey: Permanent solid DOM rendering with smooth Calorie Tracker entrance animation
      feedList.innerHTML = '';
      feedList.scrollTop = 0;
      feedList.scrollLeft = 0;

      const fragment = document.createDocumentFragment();
      const tierHeadersList = [];
      const journeyElements = [];
      let journeyLastTier = -1;

      itemsToRender.forEach((l) => {
        if (l.tierIndex !== journeyLastTier) {
          journeyLastTier = l.tierIndex;
          const tierHdr = renderTierHeader({
            type: 'tier',
            tierIndex: l.tierIndex,
            tier: l.tier
          });
          fragment.appendChild(tierHdr);
          tierHeadersList.push({ el: tierHdr, tierIndex: l.tierIndex, tier: l.tier });
          journeyElements.push(tierHdr);
        }
        const card = renderCard(l);
        fragment.appendChild(card);
        journeyElements.push(card);
      });

      feedList.appendChild(fragment);

      const updateJourneyTierHeading = () => {
        const scrollTop = feedList.scrollTop;
        let activeTier = lvlInfo.tierIndex;
        let activeName = lvlInfo.tier;
        for (let i = 0; i < tierHeadersList.length; i++) {
          if (tierHeadersList[i].el.offsetTop <= scrollTop + 35) {
            activeTier = tierHeadersList[i].tierIndex;
            activeName = tierHeadersList[i].tier;
          }
        }
        if (headingEl && activeName) {
          headingEl.textContent = `Tier ${activeTier}: ${activeName}`;
        }
      };

      // Bidirectional Re-appearing Calorie Tracker Animation Engine:
      // Dynamically animates cards when scrolling down (swoop from bottom)
      // and when scrolling up (swoop from top), resetting smoothly off-screen.
      let lastScrollTop = 0;
      let scrollDirection = 'down';
      const HYSTERESIS = 160;
      let journeyRaf = null;

      const updateReappearingCards = (isInitial = false) => {
        const scrollTop = feedList.scrollTop;
        const viewportHeight = feedList.clientHeight || 360;

        if (!isInitial) {
          if (scrollTop > lastScrollTop + 1) {
            scrollDirection = 'down';
          } else if (scrollTop < lastScrollTop - 1) {
            scrollDirection = 'up';
          }
        }
        lastScrollTop = scrollTop;

        const viewTop = scrollTop;
        const viewBottom = scrollTop + viewportHeight;

        const newlyRevealed = [];

        for (let i = 0; i < journeyElements.length; i++) {
          const el = journeyElements[i];
          const elTop = el.offsetTop;
          const elHeight = el.offsetHeight || 60;
          const elBottom = elTop + elHeight;

          const isInsideView = (elBottom >= viewTop - 25) && (elTop <= viewBottom + 25);
          const isFarAbove = elBottom < (viewTop - HYSTERESIS);
          const isFarBelow = elTop > (viewBottom + HYSTERESIS);

          if (isInsideView) {
            if (!el.classList.contains('visible')) {
              el.classList.remove('enter-top', 'enter-bottom');
              el.classList.add(scrollDirection === 'up' ? 'enter-top' : 'enter-bottom');
              newlyRevealed.push(el);
            }
          } else if (isFarAbove) {
            if (el.classList.contains('visible') || !el.classList.contains('enter-top')) {
              el.classList.remove('visible', 'enter-bottom');
              el.classList.add('enter-top');
              el.style.transitionDelay = '0ms';
            }
          } else if (isFarBelow) {
            if (el.classList.contains('visible') || !el.classList.contains('enter-bottom')) {
              el.classList.remove('visible', 'enter-top');
              el.classList.add('enter-bottom');
              el.style.transitionDelay = '0ms';
            }
          }
        }

        if (newlyRevealed.length > 0) {
          if (scrollDirection === 'up') {
            newlyRevealed.reverse();
          }
          newlyRevealed.forEach((el, index) => {
            void el.offsetWidth;
            const delay = Math.min(index * 35, 140);
            el.style.transitionDelay = `${delay}ms`;
            el.classList.add('visible');
          });
        }
      };

      const onJourneyScroll = () => {
        updateJourneyTierHeading();
        if (journeyRaf) return;
        journeyRaf = requestAnimationFrame(() => {
          journeyRaf = null;
          updateReappearingCards(false);
        });
      };

      feedList.addEventListener('scroll', onJourneyScroll, { passive: true });
      initShellLenis();
      if (typeof levelsLenis !== 'undefined' && levelsLenis) {
        levelsLenis.on('scroll', onJourneyScroll);
        levelsLenis.scrollTo(0, { immediate: true, force: true });
        levelsLenis.resize();
        levelsLenis.start();
      }

      // Initial synchronous trigger + RAF + resize pass
      updateReappearingCards(true);
      requestAnimationFrame(() => {
        updateReappearingCards(false);
      });

      setTimeout(() => {
        levelsLenis?.resize();
        updateReappearingCards(false);
      }, 40);

      activeJourneyCleanup = () => {
        if (journeyRaf) {
          cancelAnimationFrame(journeyRaf);
          journeyRaf = null;
        }
        feedList.removeEventListener('scroll', onJourneyScroll);
        if (typeof levelsLenis !== 'undefined' && levelsLenis) {
          try { levelsLenis.off('scroll', onJourneyScroll); } catch (e) {}
        }
      };
    }
  }

  function deleteSession(sessionId, dateStr) {
    if (!sessionId) return;

    const cardEl = document.querySelector(`.day-session-card[data-session-id="${sessionId}"]`);

    // 1. Identify session duration from client state or card dataset
    const idx = (state.sessions || []).findIndex(s =>
      s.id === sessionId ||
      String(s.id) === String(sessionId) ||
      s.id === ('sess_' + sessionId) ||
      ('sess_' + s.id) === String(sessionId)
    );
    let duration = 0;
    if (idx !== -1) {
      duration = state.sessions[idx].durationMinutes || state.sessions[idx].duration_minutes || 0;
      state.sessions.splice(idx, 1);
    } else if (cardEl) {
      duration = parseInt(cardEl.dataset.duration || cardEl.querySelector('.day-session-duration')?.textContent || '0', 10) || 0;
    }

    // 2. Update day activity and gamification stats immediately
    if (dateStr && state.dayActivity && state.dayActivity[dateStr] !== undefined) {
      state.dayActivity[dateStr] = Math.max(0, state.dayActivity[dateStr] - duration);
      if (state.dayActivity[dateStr] === 0) {
        delete state.dayActivity[dateStr];
      }
    }
    state.xp = Math.max(0, (state.xp || 0) - duration);
    state.totalFocusSeconds = Math.max(0, (state.totalFocusSeconds || 0) - duration * 60);
    updateStreak();

    // 3. Update or invalidate dayDetailsCache
    if (dateStr && dayDetailsCache.has(dateStr)) {
      const cached = dayDetailsCache.get(dateStr);
      if (cached && Array.isArray(cached.sessions)) {
        cached.sessions = cached.sessions.filter(s =>
          s.id !== sessionId && String(s.id) !== String(sessionId) &&
          s.id !== ('sess_' + sessionId) && ('sess_' + s.id) !== String(sessionId)
        );
        cached.totalMinutes = Math.max(0, (cached.totalMinutes || 0) - duration);
        cached.totalSessions = cached.sessions.length;
        cached.avgFocusMinutes = cached.totalSessions > 0 ? Math.round(cached.totalMinutes / cached.totalSessions) : 0;
        const hrs = Math.floor(cached.totalMinutes / 60);
        const mins = cached.totalMinutes % 60;
        cached.totalTimeFormatted = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
        cached.totalXp = cached.totalMinutes;
        dayDetailsCache.set(dateStr, cached);
      } else {
        dayDetailsCache.delete(dateStr);
      }
    } else if (dateStr) {
      dayDetailsCache.delete(dateStr);
    }

    // 4. Update open modal pills and count synchronously
    const timeEl = document.getElementById('day-pill-time');
    const sessEl = document.getElementById('day-pill-sessions');
    const avgEl = document.getElementById('day-pill-avg');
    const xpEl = document.getElementById('day-pill-xp');
    const countEl = document.getElementById('day-timeline-count');
    const listEl = document.getElementById('day-sessions-list');

    let dayTotalMins = 0;
    let dayTotalSess = 0;
    let dayAvgMins = 0;

    if (dateStr && dayDetailsCache.has(dateStr)) {
      const c = dayDetailsCache.get(dateStr);
      dayTotalMins = c.totalMinutes || 0;
      dayTotalSess = c.totalSessions || 0;
      dayAvgMins = c.avgFocusMinutes || 0;
    } else {
      const matching = (state.sessions || []).filter(s => s.date === dateStr);
      matching.forEach(s => dayTotalMins += (s.durationMinutes || s.duration_minutes || 0));
      dayTotalSess = matching.length;
      dayAvgMins = dayTotalSess > 0 ? Math.round(dayTotalMins / dayTotalSess) : 0;
    }

    const hrs = Math.floor(dayTotalMins / 60);
    const mins = dayTotalMins % 60;
    const formattedTotal = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

    if (timeEl) timeEl.textContent = formattedTotal;
    if (sessEl) sessEl.textContent = dayTotalSess;
    if (avgEl) avgEl.textContent = `${dayAvgMins}m`;
    if (xpEl) xpEl.textContent = `+${formatCompactNumber(dayTotalMins)} XP`;
    if (countEl) countEl.textContent = `${dayTotalSess} session${dayTotalSess === 1 ? '' : 's'}`;

    saveState();
    renderStats();
    renderHeatmap();
    updateTodayLiveStat();

    // 5. Exact dismiss animation from Taski:
    // Lock measured natural height, then double-rAF to transition height to 0, margin-bottom to -0.65rem,
    // transform translateX(-50%) scale(0.85), opacity to 0, and red tint
    if (cardEl) {
      cardEl.style.pointerEvents = 'none';
      cardEl.style.overflow = 'hidden';

      const h = cardEl.offsetHeight;
      cardEl.style.height = h + 'px';

      const dot = cardEl.querySelector('.day-session-orb') || cardEl.querySelector('.day-session-dot');
      if (dot) {
        dot.style.transition = 'background-color 0.2s, box-shadow 0.2s';
        dot.style.backgroundColor = '#ef4444';
        dot.style.boxShadow = '0 0 8px #ef4444';
      }
      const trackNode = cardEl.querySelector('.day-session-track-node');
      if (trackNode) {
        trackNode.style.transition = 'background-color 0.2s, box-shadow 0.2s';
        trackNode.style.backgroundColor = '#ef4444';
        trackNode.style.boxShadow = '0 0 8px #ef4444';
      }
      const subj = cardEl.querySelector('.day-session-subject');
      if (subj) {
        subj.style.transition = 'color 0.2s';
        subj.style.color = '#fca5a5';
      }

      // Double-rAF batching: set transition in frame 1, animate in frame 2
      requestAnimationFrame(() => {
        cardEl.style.transition = 'transform 0.28s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease-out, height 0.28s cubic-bezier(0.22, 1, 0.36, 1), margin-bottom 0.28s cubic-bezier(0.22, 1, 0.36, 1), padding 0.28s cubic-bezier(0.22, 1, 0.36, 1), border-width 0.22s ease-out, background 0.2s, border-color 0.2s';

        requestAnimationFrame(() => {
          cardEl.style.transform = 'translateX(-50%) scale(0.85)';
          cardEl.style.opacity = '0';
          cardEl.style.height = '0px';
          cardEl.style.marginBottom = '-0.55rem';
          cardEl.style.paddingTop = '0px';
          cardEl.style.paddingBottom = '0px';
          cardEl.style.borderTopWidth = '0px';
          cardEl.style.borderBottomWidth = '0px';
          cardEl.style.background = 'rgba(239, 68, 68, 0.18)';
          cardEl.style.borderColor = 'rgba(239, 68, 68, 0.45)';
        });
      });

      let cleanedUp = false;
      const finishDismiss = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (cardEl && cardEl.parentNode) {
          cardEl.remove();
        }
        if (dayTotalSess === 0 && listEl) {
          const isToday = (dateStr === getLocalDateString());
          listEl.innerHTML = `
            <div class="day-empty-state" style="animation: dialog-pop-in 240ms cubic-bezier(0.16, 1, 0.3, 1) forwards;">
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
        }
      };

      cardEl.addEventListener('transitionend', function handler(e) {
        if (e.propertyName !== 'height') return;
        cardEl.removeEventListener('transitionend', handler);
        finishDismiss();
      });
      setTimeout(finishDismiss, 350);
    }

    // 6. Fire backend deletion in the background (non-blocking)
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    }).then(async (res) => {
      if (res.ok) {
        const backendPayload = await res.json();
        if (backendPayload && backendPayload.success) {
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
          saveState();
          renderStats();
          renderHeatmap();
        }
      }
    }).catch((err) => {
      console.warn('StudyArc: Background session deletion notice:', err);
    });
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
    updateAuthUI();
    renderTimer();
    renderStats();
    renderHeatmap();
  }

  // =========================================================================
  // EVENT LISTENERS & SETUP
  // =========================================================================
  function initEvents() {
    // Disable accidental mobile long-press text selection across the website (excluding text inputs)
    document.addEventListener('selectstart', (e) => {
      if (e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable="true"], .selectable-text')) {
        return;
      }
      e.preventDefault();
    });

    // Prevent long-press contextmenu / text selection callout on the timer and general UI
    document.addEventListener('contextmenu', (e) => {
      if (e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable="true"], .selectable-text')) {
        return;
      }
      if (document.body.classList.contains('is-holding') || (e.target && e.target.closest && e.target.closest('#timer-center-pad, .timer-wrapper, .timer-section, .view-panel'))) {
        e.preventDefault();
      }
    });

    // -------------------------------------------------------------------------
    // ANTI-SCROLL & ANTI-ZOOM SHIELDING (Zero vertical scrolling, zero pinch/double-tap zoom)
    // -------------------------------------------------------------------------
    // 1. Prevent iOS Safari gesture pinch zoom
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('gesturechange', (e) => e.preventDefault());
    document.addEventListener('gestureend', (e) => e.preventDefault());

    // 2. Prevent multi-finger pinch zoom on mobile
    document.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches.length > 1) {
        e.preventDefault();
      }
    }, { passive: false });

    // 3. Prevent double-tap to zoom
    let lastTouchEndTime = 0;
    document.addEventListener('touchend', (e) => {
      const now = performance.now();
      if (now - lastTouchEndTime <= 320) {
        if (!e.target.closest('input, textarea, [contenteditable="true"]')) {
          e.preventDefault();
        }
      }
      lastTouchEndTime = now;
    }, { passive: false });

    // 4. Prevent vertical document scroll, bounce, and rubberbanding on mobile
    document.addEventListener('touchmove', (e) => {
      if (e.target && e.target.closest && e.target.closest('#view-settings, .panel-inner, .day-detail-dialog, .heatmap-scroll-area')) {
        return;
      }
      e.preventDefault();
    }, { passive: false });

    // 5. Prevent desktop Ctrl+Wheel or Ctrl +/- zooming
    window.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
      }
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')) {
        e.preventDefault();
      }
    });

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
        if (typeof btn.blur === 'function') {
          btn.blur();
        }
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

    // RPG Levels Dialog: Open via clicking or Enter on XP pill
    const statItemXp = document.getElementById('stat-item-xp');
    if (statItemXp) {
      statItemXp.addEventListener('click', (e) => {
        e.stopPropagation();
        openLevelsDialog();
      });
      statItemXp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openLevelsDialog();
        }
      });
    }

    // RPG Levels Dialog: Close button (Journey Header)
    const btnCloseLevels = document.getElementById('btn-close-levels-dialog');
    if (btnCloseLevels) {
      btnCloseLevels.addEventListener('click', closeLevelsDialog);
    }

    // RPG Levels Dialog: Close button (Catalog Header)
    const btnCloseCatalog = document.getElementById('btn-close-levels-catalog');
    if (btnCloseCatalog) {
      btnCloseCatalog.addEventListener('click', closeLevelsDialog);
    }

    // RPG Levels Dialog: Switch to All Levels catalog view
    const btnToggleAllLevels = document.getElementById('btn-toggle-all-levels');
    if (btnToggleAllLevels) {
      btnToggleAllLevels.addEventListener('click', () => {
        if (window.getSelection) window.getSelection().removeAllRanges();
        resetLevelsContainer(true);
        showAllLevelsView = true;
        renderLevelsDialogDOM();
      });
    }

    // RPG Levels Dialog: Back to My Journey view
    const btnBackToJourney = document.getElementById('btn-back-to-journey');
    if (btnBackToJourney) {
      btnBackToJourney.addEventListener('click', () => {
        if (window.getSelection) window.getSelection().removeAllRanges();
        resetLevelsContainer(true);
        showAllLevelsView = false;
        renderLevelsDialogDOM();
      });
    }

    // RPG Levels Dialog: backdrop click & native cancel/close light-dismiss fallback
    const levelsDialog = document.getElementById('levels-dialog');
    if (levelsDialog) {
      levelsDialog.addEventListener('click', (e) => {
        const rect = levelsDialog.getBoundingClientRect();
        const isInDialog = (
          rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
          rect.left <= e.clientX && e.clientX <= rect.left + rect.width
        );
        if (!isInDialog) {
          closeLevelsDialog();
        }
      });
      levelsDialog.addEventListener('cancel', () => {
        closeLevelsDialog();
      });
    }

    // Settings actions
    const soundToggle = document.getElementById('setting-sound-enabled');

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
              dayDetailsCache.clear();
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

    // Task Prompt Modal Backdrop click
    const taskBackdrop = document.getElementById('task-prompt-backdrop');
    if (taskBackdrop) {
      taskBackdrop.addEventListener('click', closeTaskPromptDialog);
    }

    // Escape key handling
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!state.authenticated) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const modal = document.getElementById('task-prompt-modal');
        if (modal && !modal.classList.contains('hidden')) {
          closeTaskPromptDialog();
        }
      }
    });

    // Automatic cleanup of focus outline and selections whenever any dialog closes
    document.querySelectorAll('dialog').forEach(dlg => {
      const handleDialogDismiss = () => {
        if (window.getSelection) {
          try {
            window.getSelection().removeAllRanges();
          } catch (_) {}
        }
        const centerPad = document.getElementById('timer-center-pad');
        centerPad?.blur?.();
        document.activeElement?.blur?.();
        globalLenis?.start();
        setTimeout(() => {
          if (window.getSelection) {
            try {
              window.getSelection().removeAllRanges();
            } catch (_) {}
          }
          centerPad?.blur?.();
          if (document.activeElement === centerPad) {
            centerPad.blur();
          }
        }, 15);
      };

      dlg.addEventListener('close', handleDialogDismiss);
      dlg.addEventListener('cancel', handleDialogDismiss);
    });


    // -------------------------------------------------------------------------
    // Authentication & Profile Event Listeners
    // -------------------------------------------------------------------------

    // Header Sign In button
    const btnHeaderAuth = document.getElementById('btn-header-auth');
    if (btnHeaderAuth) {
      btnHeaderAuth.addEventListener('click', () => openAuthDialog('login'));
    }


    // 3D Flip Card switch buttons ("Create account ->" & "Sign in ->")
    const btnFlipToSignup = document.getElementById('btn-flip-to-signup');
    if (btnFlipToSignup) {
      btnFlipToSignup.addEventListener('click', () => flipAuthCard('signup'));
    }
    const btnFlipToSignin = document.getElementById('btn-flip-to-signin');
    if (btnFlipToSignin) {
      btnFlipToSignin.addEventListener('click', () => flipAuthCard('login'));
    }

    // Auth Dialog: strictly uncloseable when unauthenticated
    const authDialog = document.getElementById('auth-dialog');
    if (authDialog) {
      authDialog.addEventListener('cancel', (e) => {
        if (!state.authenticated) {
          e.preventDefault();
        }
      });

      authDialog.addEventListener('click', (e) => {
        if (!state.authenticated) {
          e.stopPropagation();
          return;
        }
        const rect = authDialog.getBoundingClientRect();
        const isInDialog = (
          rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
          rect.left <= e.clientX && e.clientX <= rect.left + rect.width
        );
        if (!isInDialog) {
          closeAuthDialog(false);
        }
      });
    }

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

    // Handle tab visibility change & wakeup (instant resync when unlocking or switching back)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        handleTabAwakeOrFocus();
      }
    });
    window.addEventListener('focus', () => {
      handleTabAwakeOrFocus();
    });
    window.addEventListener('pageshow', () => {
      handleTabAwakeOrFocus();
    });
    window.addEventListener('online', () => {
      handleTabAwakeOrFocus();
    });
  }

  // =========================================================================
  // LENIS SMOOTH SCROLLING (Global Page & Dialog Shells)
  // =========================================================================
  let globalLenis = null;
  let levelsLenis = null;
  let dayLenis = null;

  function initLenis() {
    if (typeof Lenis === 'undefined') return;

    try {
      globalLenis = new Lenis({
        autoRaf: true,
        smoothWheel: true,
        duration: 1.1,
        easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      });
      window.lenis = globalLenis;
    } catch (e) {
      console.warn('StudyArc: Could not initialize window Lenis:', e);
    }

    initShellLenis();
  }

  function initShellLenis() {
    if (typeof Lenis === 'undefined') return;

    const levelsFeed = document.getElementById('levels-feed-list');
    if (levelsFeed && !levelsLenis) {
      try {
        levelsLenis = new Lenis({
          wrapper: levelsFeed,
          content: levelsFeed,
          eventsTarget: levelsFeed,
          autoRaf: true,
          smoothWheel: true,
          duration: 0.85,
          easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        });
        window.levelsLenis = levelsLenis;
      } catch (e) {
        console.warn('StudyArc: Error initializing levelsLenis:', e);
      }
    }

    const dayFeed = document.getElementById('day-sessions-list');
    if (dayFeed && !dayLenis) {
      try {
        dayLenis = new Lenis({
          wrapper: dayFeed,
          content: dayFeed,
          eventsTarget: dayFeed,
          autoRaf: true,
          smoothWheel: true,
          duration: 0.85,
          easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        });
        window.dayLenis = dayLenis;
      } catch (e) {
        console.warn('StudyArc: Error initializing dayLenis:', e);
      }
    }
  }

  // =========================================================================
  // BOOTSTRAP (Safe for both pre-parsed and async/cached script execution)
  // =========================================================================
  let appBootstrapped = false;
  async function bootstrapApp() {
    if (appBootstrapped) return;
    appBootstrapped = true;

    initLenis();
    initEvents();
    renderAll();

    // If user is not authenticated, greet them immediately with the Neon Green Sign-In modal
    if (!state.authenticated || !state.user) {
      document.documentElement.classList.add('unauthenticated-gate');
      openAuthDialog('login');
    } else {
      document.documentElement.classList.remove('unauthenticated-gate');
    }

    // Immediately fetch real-time server timer state in <5ms from RAM cache
    fetchLatestServerTimer();

    // Full authentication and state sync (subjects, history, stats)
    await checkAuthAndSync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapApp);
  } else {
    bootstrapApp();
  }

})();
