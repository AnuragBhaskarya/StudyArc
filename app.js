/**
 * STUDYARK — CLIENT LOGIC & ENGINE
 * Architecture: Clean Vanilla JS, accurate time delta timer,
 * Web Audio synthesizer, dynamic calendar heatmap, and reactive localStorage.
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'studyark_store_v1';

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

    // Activity Records & Sessions (Loaded from SQLite database)
    dayActivity: {},
    sessions: [],

    // Heatmap View
    viewedYear: new Date().getFullYear(),
    viewedMonth: new Date().getMonth(),

    // Focus Subjects (Loaded from SQLite database)
    subjects: [],

    // Active Focus Session
    activeTaskName: null,
    activeTaskStartTime: null,
    activeTaskTargetSeconds: null,
    activeSessionIntervals: [],

    // Preferences
    soundEnabled: true,
    auraEnabled: true,

    // User Authentication & Profile
    user: null,
    authenticated: false,
    userCreatedAt: null
  };

  let state = loadState();
  const dayDetailsCache = new Map();
  const sessionLookupCache = new Map();

  // =========================================================================
  // ONE-SHOT BOOT / HOME INTRO STATE
  // The loader is painted by the initial HTML. These flags make sure the
  // entrance sequence can only run for a real page load (or a successful
  // sign-in), never for ordinary renders or background state updates.
  // =========================================================================
  const APP_LOADER_MIN_VISIBLE_MS = 560;
  const APP_LOADER_FADE_MS = 450;
  let appLoaderShownAt = Number(window.__studyArkLoaderShownAt) || Number(window.__studyArcLoaderShownAt) || performance.now();
  let homeIntroPlayed = false;
  let homeIntroRunning = false;
  let homeIntroGeneration = 0;
  let homeIntroTimers = new Set();
  let homeIntroDialActive = false;
  let homeIntroDialRaf = null;
  let currentAuthSequence = 0;

  // Central high-speed precomputed cache & indices for zero-lag 60/120fps modal opens
  const sessionDataIndex = {
    dirty: true,
    byDate: new Map(),           // dateStr -> Array<session>
    sortedAsc: null,             // Pre-sorted ascending (for level calculation)
    sortedDesc: null,            // Pre-sorted descending (for history feed)
    levelClearDates: null,       // Cached level clear dates dictionary
    historyScrollerData: null,   // Pre-built { virtualItems, dateHeaderIndices, stats }
    dateHeaderCache: new Map(),  // dateStr -> "Fri, Oct 23, 2026"
    shortBadgeCache: new Map(),  // dateStr -> "TODAY", "YESTERDAY", "OCT 23"
  };

  function invalidateSessionIndex() {
    sessionDataIndex.dirty = true;
    sessionDataIndex.sortedAsc = null;
    sessionDataIndex.sortedDesc = null;
    sessionDataIndex.levelClearDates = null;
    sessionDataIndex.historyScrollerData = null;
    sessionDataIndex.byDate.clear();
  }

  // The initial /api/state payload already contains the full session archive.
  // Only refresh it in the background when it may actually be stale.
  const HISTORY_ARCHIVE_TTL_MS = 30000;
  let historyArchiveFetchedAt = 0;
  let historyArchiveRefreshPending = false;

  function loadState() {
    try {
      let data = localStorage.getItem(STORAGE_KEY);
      if (!data) {
        // Fallback from legacy StudyArk storage
        data = localStorage.getItem('studyarc_store_v1');
      }
      if (data) {
        const parsed = JSON.parse(data);
        const merged = Object.assign({}, defaultState, parsed);

        // Cleared level dates are always derived from the surviving sessions.
        // Drop the legacy local-only level-up ledger so stale dates can never
        // be shown after old sessions are deleted.
        delete merged.levelClearHistory;
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
      console.warn('StudyArk: Could not read localStorage:', e);
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
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(persistentState));
      } catch (storageErr) {
        // Fallback if localStorage quota is exceeded on very large accounts (e.g. 5,000+ sessions):
        // Keep the most recent 1,500 sessions locally for offline fast-start; server maintains complete history.
        if (persistentState.sessions && persistentState.sessions.length > 1500) {
          try {
            const fallbackState = Object.assign({}, persistentState, {
              sessions: persistentState.sessions.slice(0, 1500)
            });
            localStorage.setItem(STORAGE_KEY, JSON.stringify(fallbackState));
          } catch (innerErr) {
            console.warn('StudyArk: Could not save trimmed state to localStorage:', innerErr);
          }
        } else {
          console.warn('StudyArk: Could not save to localStorage:', storageErr);
        }
      }
    } catch (e) {
      console.warn('StudyArk: Could not prepare state for saveState:', e);
    }
  }

  // The session archive can be large, so serializing it is the one genuinely
  // expensive part of finishing a focus block. Coalesce those writes and let
  // the reset animation finish first; the server already receives the session
  // immediately, so the local cache cannot lose data.
  let deferredPersistTimer = null;
  function scheduleStatePersistence(delay = 120) {
    if (deferredPersistTimer !== null) {
      clearTimeout(deferredPersistTimer);
    }
    deferredPersistTimer = setTimeout(() => {
      deferredPersistTimer = null;
      if (resetVisualActive) {
        scheduleStatePersistence(120);
        return;
      }
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => {
          if (resetVisualActive) {
            scheduleStatePersistence(150);
            return;
          }
          saveState();
        }, { timeout: 900 });
      } else {
        saveState();
      }
    }, Math.max(0, delay));
  }

  // =========================================================================
  // SERVER SYNCHRONIZATION & AUTHENTICATION ENGINE
  // =========================================================================

  async function syncWithBackend(options = {}) {
    const suppressAuthDialog = Boolean(options.suppressAuthDialog);
    const seq = currentAuthSequence;
    try {
      const localDate = getLocalDateString();
      const res = await fetch(`/api/state?date=${encodeURIComponent(localDate)}`, {
        headers: { 'X-Client-Date': localDate }
      });
      if (seq !== currentAuthSequence) {
        return { stale: true, authenticated: Boolean(state.authenticated && state.user) };
      }

      if (res.status === 401) {
        if (state.authenticated) {
          state.authenticated = false;
          state.user = null;
          saveState();
        }
        document.documentElement.classList.add('unauthenticated-gate');
        updateAuthUI();
        if (!suppressAuthDialog) openAuthDialog('login');
        return { authenticated: false, authRequired: true };
      }

      if (res.ok) {
        const data = await res.json();
        if (seq !== currentAuthSequence) {
          return { stale: true, authenticated: Boolean(state.authenticated && state.user) };
        }
        if (data.success) {
          state.authenticated = true;
          state.user = data.user || null;
          state.userCreatedAt = data.userCreatedAt || state.userCreatedAt || null;
          document.documentElement.classList.remove('unauthenticated-gate');
          closeAuthDialog(true);
          state.subjects = data.subjects || [];
          state.sessions = data.sessions || [];
          historyArchiveFetchedAt = Date.now();
          dayDetailsCache.clear();
          invalidateSessionIndex();

          const oldActivityStr = JSON.stringify(state.dayActivity);
          const newActivityStr = JSON.stringify(data.dayActivity || {});
          const activityChanged = oldActivityStr !== newActivityStr;

          state.dayActivity = data.dayActivity || {};
          if (data.stats) {
            state.streak = data.stats.streak || 0;
            state.xp = data.stats.xp || 0;
            state.totalFocusSeconds = data.stats.totalFocusSeconds || 0;
          }

          if (data.preferences && typeof data.preferences.auraEnabled !== 'undefined') {
            state.auraEnabled = !!data.preferences.auraEnabled;
          }
          applyAuraPreference();

          if (data.timer) {
            reconcileServerTimer(data.timer);
          }

          updateAuthUI();
          saveState();
          renderTimer();
          renderStats();
          refreshOpenHistoryDialog();
          if (activityChanged) {
            renderHeatmap();
          }

          // History indexes are built lazily when a history view first asks
          // for them. Eager warmup created a long task after every sync.

          // Start multi-device real-time SSE stream
          initRealtimeTimerSync();
          return { authenticated: true, authRequired: false };
        }
      }
      return { authenticated: Boolean(state.authenticated && state.user), authRequired: false };
    } catch (err) {
      console.warn('StudyArk: Backend sync error, using local cache:', err);
      return { authenticated: Boolean(state.authenticated && state.user), authRequired: false, error: true };
    }
  }

  async function checkAuthAndSync(options = {}) {
    return syncWithBackend(options);
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
      console.warn('StudyArk: Quick timer fetch failed:', e);
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
  const myClientId = 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  let serverClockOffset = 0;        // (serverTime - clientWallClock) in ms
  let bestRtt = Infinity;           // Lowest RTT sample seen (Cristian's Algorithm)
  let lastAppliedSequence = 0;      // Monotonic server sequence counter
  let lastRenderedSeconds = null;   // Monotonic display guard for running countdown

  // 1. Same-device multi-tab instantaneous 0ms sync via BroadcastChannel
  let timerBroadcastChannel = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      timerBroadcastChannel = new BroadcastChannel('studyark_timer_sync');
      timerBroadcastChannel.onmessage = (event) => {
        if (event && event.data && event.data.timer) {
          applyLiveServerTimer(event.data.timer, false);
        }
      };
    }
  } catch (e) {
    console.warn('StudyArk: BroadcastChannel unsupported:', e);
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
      console.warn('StudyArk: Socket.IO library not loaded, using HTTP fallback');
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
      console.log('StudyArk: Socket.IO connected via', sioSocket.io.engine.transport.name);
      // Measure clock offset immediately with spaced burst to lock in minimum RTT
      sendSocketPing();
      setTimeout(sendSocketPing, 400);
      setTimeout(sendSocketPing, 1000);

      // Socket.IO upgrades polling→websocket automatically, log it
      sioSocket.io.engine.on('upgrade', (transport) => {
        console.log('StudyArk: Transport upgraded to', transport.name);
        sendSocketPing();
      });
    });

    // Server sends initial full state on connect
    sioSocket.on('timer_init', (data) => {
      if (data && data.timer) {
        applyLiveServerTimer(data.timer, false);
        broadcastLocalTimer(data.timer);
      }
    });

    // Real-time timer updates from any device
    sioSocket.on('timer_update', (data) => {
      if (data && data.timer) {
        applyLiveServerTimer(data.timer, false);
        broadcastLocalTimer(data.timer);
      }
    });

    // Account-scoped preference updates from another device/tab
    sioSocket.on('preferences_update', (data) => {
      const prefs = data && data.preferences;
      if (!prefs || typeof prefs.auraEnabled === 'undefined') return;
      state.auraEnabled = !!prefs.auraEnabled;
      saveState();
      applyAuraPreference();
    });

    // Clock offset measurement response (Cristian's algorithm with min-RTT filter)
    sioSocket.on('pong_server', (data) => {
      if (data && data.clientTime && data.serverTime) {
        const now = Date.now();
        const rtt = Math.max(1, now - data.clientTime);
        const measuredOffset = data.serverTime - (data.clientTime + rtt / 2);

        // Samples with lower RTT experience less network queuing jitter and deliver mathematically superior precision
        if (rtt <= bestRtt || serverClockOffset === 0) {
          bestRtt = rtt;
          serverClockOffset = measuredOffset;
        } else if (rtt < bestRtt * 1.5) {
          serverClockOffset = 0.85 * serverClockOffset + 0.15 * measuredOffset;
        }
      }
    });

    sioSocket.on('disconnect', (reason) => {
      console.log('StudyArk: Socket.IO disconnected:', reason);
    });

    sioSocket.on('connect_error', (err) => {
      console.warn('StudyArk: Socket.IO connect error:', err.message);
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
      lastRenderedSeconds = null;
      return state.timer.remainingSeconds;
    }
    const anchorServerTime = state.timer.anchorServerTime;
    const anchorRemaining = Number(state.timer.anchorRemainingSeconds != null ? state.timer.anchorRemainingSeconds : state.timer.remainingSeconds);

    if (!anchorServerTime) {
      return anchorRemaining;
    }

    const estimatedServerNow = Date.now() + serverClockOffset;
    const elapsed = Math.max(0, (estimatedServerNow - anchorServerTime) / 1000);
    let calculated = Math.max(0, anchorRemaining - elapsed);

    // Monotonic display guard: during running countdown, the timer can NEVER tick upwards due to network jitter
    if (lastRenderedSeconds !== null && calculated > lastRenderedSeconds) {
      calculated = lastRenderedSeconds;
    } else {
      lastRenderedSeconds = calculated;
    }

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

    // Echo suppression for the originating client:
    // If this update was initiated by this client instance, our local state is already authoritative.
    // Overwriting it with a network-delayed echo causes jitter and time-travel jumps.
    if (!isDirectResponse && serverTimer.originClientId && serverTimer.originClientId === myClientId) {
      return;
    }

    // The reset echo arrives while the local 0:00 -> target transition is
    // still playing. State is already correct locally, so accepting the echo
    // would snap the digits and pay for another large localStorage write.
    // The same no-op check also absorbs late idle echoes after the animation.
    const idleTargetMatches =
      Math.abs(Number(serverTimer.targetSeconds || 0) - Number(state.timer.targetSeconds || 0)) < 0.5;
    if (
      !serverTimer.hasCompleted &&
      serverTimer.status === 'idle' &&
      !serverTimer.activeTaskName &&
      idleTargetMatches &&
      (resetVisualActive || (state.timer.status === 'idle' && !state.activeTaskName))
    ) {
      return;
    }

    // A completion echo must not restore a task name that the local
    // zero-hold animation already cleared for this completion.
    if (serverTimer.hasCompleted && resetVisualActive) return;

    // 1. Task name sync across devices
    state.activeTaskName = serverTimer.activeTaskName || null;

    // 2. Handle completed-while-away
    if (serverTimer.hasCompleted) {
      // A local completion/reset already owns the zero-hold animation.
      if (resetVisualActive) return;
      const taskName = serverTimer.activeTaskName || state.activeTaskName || (state.subjects && state.subjects.length > 0 ? state.subjects[0].name : 'Focus Session');
      const targetDuration = serverTimer.targetSeconds || DEFAULT_TIMER_SECONDS;
      const minutesCompleted = Math.max(1, Math.round(targetDuration / 60));
      const sessionStartTime = state.activeTaskStartTime;
      logSession(minutesCompleted, taskName, {
        render: false,
        persist: false,
        startTime: sessionStartTime,
        deferUIDelay: false
      });
      const streakBonus = Math.max(0, state.streak || 0);
      spawnRewardPills(minutesCompleted, minutesCompleted, streakBonus);

      state.timer.status = 'idle';
      state.timer.targetSeconds = targetDuration;
      state.timer.remainingSeconds = targetDuration;
      state.timer.anchorRemainingSeconds = targetDuration;
      state.timer.anchorServerTime = null;
      state.activeTaskName = null;
      state.activeTaskStartTime = null;
      state.activeTaskTargetSeconds = null;
      state.activeSessionIntervals = [];
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
      saveState();
      renderTimer();
      scheduleSessionUIUpdate(380);
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
      state.activeTaskTargetSeconds = state.timer.targetSeconds;
      if (serverTimer.sessionStartedAt) {
        state.activeTaskStartTime = serverTimer.sessionStartedAt;
      }
      if (Array.isArray(serverTimer.intervals)) {
        state.activeSessionIntervals = serverTimer.intervals;
      }
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
      state.activeSessionIntervals = [];
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      saveState();
      renderTimer();
      // The reset echo can arrive while the digits are still crossfading.
      // Stats are not part of the timer, so let them settle afterwards.
      scheduleSessionUIUpdate(380);
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
      if (serverTimer.sessionStartedAt) {
        state.activeTaskStartTime = serverTimer.sessionStartedAt;
      }
      if (Array.isArray(serverTimer.intervals)) {
        state.activeSessionIntervals = serverTimer.intervals;
      }

      // A +30m adjustment raises the remaining anchor. Clear the monotonic
      // guard so the received jump is not clamped back to the old countdown.
      lastRenderedSeconds = null;
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
      origin_client_id: myClientId,
      ...extraPayload
    };

    // 0ms instant broadcast to other open tabs on this machine
    broadcastLocalTimer({
      status: state.timer.status,
      targetSeconds: state.timer.targetSeconds,
      remainingSeconds: Math.round(state.timer.remainingSeconds),
      activeTaskName: state.activeTaskName,
      startedAt: state.timer.anchorServerTime || (Date.now() + serverClockOffset),
      sequence: lastAppliedSequence + 1,
      originClientId: myClientId
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
      console.warn('StudyArk: Timer sync warning:', err);
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

    // The blurred backdrop over a live full-screen animation is expensive to
    // recomposite. Pause the ambient stream while the auth gate is open.
    pauseAmbientCanvas();

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

    try {
      if (typeof dialog.close === 'function') dialog.close();
    } catch (_) {}
    dialog.removeAttribute('open');
    if (window.AuthModalDots && typeof window.AuthModalDots.stop === 'function') {
      window.AuthModalDots.stop();
    }

    // Resume the ambient stream only when no other modal is still open.
    resumeAmbientCanvas();
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
        currentAuthSequence++;
        state.authenticated = true;
        state.user = data.user;
        saveState();
        homeIntroPlayed = false;
        homeIntroRunning = false;
        // Cover the app while the freshly authenticated state is fetched, then
        // hand over to the same one-shot entrance used on a normal page load.
        prepareAppLoaderForIntro('Syncing your progress', { immediate: true });
        document.documentElement.classList.remove('unauthenticated-gate');
        closeAuthDialog(true);
        updateAuthUI();
        await revealAfterSignIn();
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
        currentAuthSequence++;
        state.authenticated = true;
        state.user = data.user;
        saveState();
        homeIntroPlayed = false;
        homeIntroRunning = false;
        // A new account gets the exact same loader + entrance treatment as a
        // returning account, once its server state is in place.
        prepareAppLoaderForIntro('Syncing your progress', { immediate: true });
        document.documentElement.classList.remove('unauthenticated-gate');
        closeAuthDialog(true);
        updateAuthUI();
        await revealAfterSignIn();
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
    cancelHomeIntro();
    // A deliberate sign-in after signing out is another allowed entrance.
    homeIntroPlayed = false;
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
    state.userCreatedAt = null;
    state.sessions = [];
    dayDetailsCache.clear();
    invalidateSessionIndex();
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
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
    currentAuthSequence++;
    saveState();
    matrixStreamEngine?.stop();
    document.documentElement.classList.add('unauthenticated-gate', 'intro-aura-hidden');
    document.documentElement.classList.remove('app-booting');
    clearLoaderFailsafe();
    hideAppLoader({ immediate: true });
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

  function formatDateLocal(dateObj = new Date()) {
    return getLocalDateString(dateObj);
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

  function formatDetailedDuration(totalSecs) {
    const s = Math.max(0, Math.round(Number(totalSecs) || 0));
    if (s === 0) return '0m';
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const remS = s % 60;
    if (s < 3600) {
      return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
    }
    const h = Math.floor(s / 3600);
    const remM = Math.floor((s % 3600) / 60);
    if (remM === 0 && remS === 0) return `${h}h`;
    if (remS === 0) return `${h}h ${remM}m`;
    if (remM === 0) return `${h}h ${remS}s`;
    return `${h}h ${remM}m ${remS}s`;
  }

  function formatShortDate(d) {
    if (!(d instanceof Date) || isNaN(d)) return '';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getMonth()]} ${d.getDate()}`;
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
      { id: 'stat-today-focus', maxLen: 8, shrinkLen: 10 },
      { id: 'stat-total-focus', maxLen: 8, shrinkLen: 10 }
    ];

    for (const item of items) {
      const el = document.getElementById(item.id);
      if (!el) continue;
      const len = (el.textContent || '').trim().length;
      const targetSize = (len > item.shrinkLen)
        ? ((item.id === 'stat-today-focus' || item.id === 'stat-total-focus') ? '0.62rem' : '0.72rem')
        : (len > item.maxLen)
          ? ((item.id === 'stat-today-focus' || item.id === 'stat-total-focus') ? '0.68rem' : '0.80rem')
          : '';
      if (el.style.fontSize !== targetSize) {
        el.style.fontSize = targetSize;
      }
    }
  }

  // =========================================================================
  // AUDIO SYNTHESIZER (Web Audio API Chimes with Auto-Sleep)
  // =========================================================================
  let audioContext = null;
  let audioSuspendTimer = null;

  function scheduleAudioSuspend() {
    clearTimeout(audioSuspendTimer);
    audioSuspendTimer = setTimeout(() => {
      if (audioContext && audioContext.state === 'running') {
        audioContext.suspend().catch(() => {});
      }
    }, 2500);
  }

  function initAudio() {
    if (!audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) audioContext = new AudioCtx();
    }
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
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

      scheduleAudioSuspend();
    } catch (e) {
      console.warn('StudyArk audio error:', e);
    }
  }

  // =========================================================================
  // MINIMAL CIRCULAR TIMER ENGINE (MAX 3 HOURS, DRAGGABLE BEAD, HOLD TO RESET)
  // =========================================================================
  let timerInterval = null;
  let isCenterPadHolding = false;
  const MAX_TIMER_SECONDS = 3 * 3600; // 10,800s (3 hours)
  const MIN_ACTIVE_SESSION_SECONDS = 30 * 60; // Live sessions never drop below 30m
  const RADIUS = 172;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS; // ~1080.7078px

  // Hold-to-reset timing. The final 30 seconds are shown one-by-one at a
  // 60 Hz cadence; everything above that is a smooth decelerating sweep.
  const HOLD_DELAY_MS = 220;
  const HOLD_TOTAL_MS = 1200;
  const HOLD_DRAIN_MS = HOLD_TOTAL_MS - HOLD_DELAY_MS;
  const RESET_TAIL_SECONDS = 30;
  const RESET_TAIL_STEP_MS = 1000 / 60;
  const RESET_ZERO_HOLD_MS = 200;
  const RESET_RETURN_MS = 460;

  // While a reset is being painted, server echoes must not snap the display
  // back to the target before the zero hold / refill animation has played.
  let resetVisualActive = false;
  let resetZeroTimer = null;
  let resetReturnRaf = null;
  let resetFinishTimer = null;
  let resetReturnToken = 0;

  let timerArcEl = null;
  let timerBeadGroupEl = null;

  function updateTimerRing(seconds, options = {}) {
    // The one-shot home intro owns the arc while it fills from zero. Timer
    // ticks and other render paths must not snap it to the live value.
    if (homeIntroDialActive && !options.intro) return;

    if (!timerArcEl || !timerArcEl.isConnected) {
      timerArcEl = document.getElementById('timer-arc');
    }
    if (!timerBeadGroupEl || !timerBeadGroupEl.isConnected) {
      timerBeadGroupEl = document.getElementById('timer-bead-group');
    }
    if (!timerArcEl || !timerBeadGroupEl) return;

    // Fraction of 3 hours (0 to 1)
    const fraction = Math.max(0, Math.min(1, seconds / MAX_TIMER_SECONDS));

    // Arc stroke-dashoffset (circle is rotated -90deg in SVG, so offset controls drawn arc length)
    const offset = CIRCUMFERENCE * (1 - fraction);
    timerArcEl.style.strokeDashoffset = offset;

    // Angle clockwise from 12 o'clock (0 = top, PI/2 = 3 o'clock, PI = 6 o'clock, etc.)
    const angle = fraction * 2 * Math.PI;
    const bx = 210 + RADIUS * Math.sin(angle);
    const by = 210 - RADIUS * Math.cos(angle);

    timerBeadGroupEl.setAttribute('transform', `translate(${bx.toFixed(2)}, ${by.toFixed(2)})`);
  }

  // =========================================================================
  // HEADER QUICK-DURATION PRESETS (25m / 1h / 2h / 3h)
  // Clicking a pill glides the rim & bead to the new duration, then opens
  // the normal task-prompt dialog so a session can be named and started.
  // =========================================================================
  const TIMER_PRESET_ANIM_MS = 480;
  let presetAnimationRaf = null;
  let presetAnimationToken = 0;
  let pendingPromptKeyboardInput = null;
  let timerAdjustmentFeedbackTimer = null;
  let headerPresetResizeObserver = null;
  let headerPresetSwapTimer = null;

  function isIosLikeDevice() {
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    // iPadOS 13+ reports itself as desktop Mac but reports touch points.
    return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
  }

  // iOS only raises the keyboard for focus() that happens inside the original
  // tap. The preset animation delays the prompt by 480ms, so prime the
  // keyboard synchronously and keep it up until the real prompt input takes
  // focus. The keyboard therefore starts rising during the rim glide and is
  // fully up by the time the prompt appears.
  function primePromptKeyboard() {
    if (pendingPromptKeyboardInput) {
      try {
        pendingPromptKeyboardInput.focus({ preventScroll: true });
      } catch (_) {
        pendingPromptKeyboardInput.focus();
      }
      return;
    }
    if (!isIosLikeDevice()) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('aria-hidden', 'true');
    input.setAttribute('tabindex', '-1');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;margin:0;border:0;outline:none;opacity:0;font-size:16px;caret-color:transparent;pointer-events:none;';
    document.body.appendChild(input);
    pendingPromptKeyboardInput = input;

    try {
      input.focus({ preventScroll: true });
    } catch (_) {
      input.focus();
    }
  }

  function dismissPendingPromptKeyboard(blur) {
    const input = pendingPromptKeyboardInput;
    if (!input) return;
    pendingPromptKeyboardInput = null;
    if (blur) {
      try { input.blur(); } catch (_) {}
    }
    // Let the real prompt input finish taking focus before removing the primer.
    setTimeout(() => input.remove(), 400);
  }

  function isTimerSessionActive() {
    return Boolean(state.activeTaskName) || state.timer.status === 'running' || state.timer.status === 'paused';
  }

  function isTimerPresetLocked() {
    return isTimerSessionActive();
  }

  function cancelTimerPresetAnimation(dismissKeyboard = true) {
    presetAnimationToken += 1;
    document.body.classList.remove('is-preset-animating');
    if (dismissKeyboard) dismissPendingPromptKeyboard(true);

    if (presetAnimationRaf === null) return false;

    cancelAnimationFrame(presetAnimationRaf);
    presetAnimationRaf = null;

    // Settle the rim & digits on the last committed state
    renderTimerDisplay(state.timer.remainingSeconds, { duration: 320 });
    return true;
  }

  function getHeaderPresetParts() {
    return {
      group: document.getElementById('header-presets'),
      idleGroup: document.getElementById('header-preset-idle'),
      sessionGroup: document.getElementById('header-preset-session')
    };
  }

  function measureHeaderPresetWidth() {
    const { group, idleGroup, sessionGroup } = getHeaderPresetParts();
    if (!group || !idleGroup || !sessionGroup) return 0;
    const activeGroup = group.classList.contains('is-session-mode') ? sessionGroup : idleGroup;
    // offsetWidth ignores the crossfade scale, so the swap measures the real
    // layout width instead of the shrunken mid-animation bounds.
    return Math.ceil(activeGroup.offsetWidth || activeGroup.scrollWidth || 0);
  }

  function applyHeaderPresetWidth() {
    const { group } = getHeaderPresetParts();
    if (!group) return;
    const width = measureHeaderPresetWidth();
    if (width > 0) group.style.width = `${width}px`;
  }

  function settleHeaderPresetWidth() {
    const { group } = getHeaderPresetParts();
    if (!group) return;
    group.classList.add('is-settling');
    applyHeaderPresetWidth();
    void group.offsetWidth;
    group.classList.remove('is-settling');
  }

  function updateHeaderPresetMode() {
    const { group, idleGroup, sessionGroup } = getHeaderPresetParts();
    if (!group || !idleGroup || !sessionGroup) return;

    const sessionMode = isTimerSessionActive();
    const changed = group.classList.contains('is-session-mode') !== sessionMode;

    if (changed) {
      group.classList.toggle('is-session-mode', sessionMode);

      // One-shot entrance animation for the two live adjusters. Removing the
      // class afterwards keeps later feedback bumps from re-triggering it.
      group.classList.add('is-swapping-in');
      clearTimeout(headerPresetSwapTimer);
      headerPresetSwapTimer = setTimeout(() => {
        headerPresetSwapTimer = null;
        group.classList.remove('is-swapping-in');
      }, 900);
    }
    group.dataset.mode = sessionMode ? 'session' : 'idle';

    // Keep the inactive group out of the tab order and accessibility tree.
    idleGroup.setAttribute('aria-hidden', sessionMode ? 'true' : 'false');
    sessionGroup.setAttribute('aria-hidden', sessionMode ? 'false' : 'true');
    idleGroup.inert = sessionMode;
    sessionGroup.inert = !sessionMode;

    if (!group.classList.contains('is-preset-ready')) {
      // First paint: lock in the idle width without animating from zero.
      group.classList.add('is-preset-ready');
      settleHeaderPresetWidth();
      return;
    }

    // The group class change and width change land in the same task, so the
    // browser animates the container while both pill groups crossfade.
    applyHeaderPresetWidth();
  }

  function updateTimerPresetUI() {
    const { group, idleGroup, sessionGroup } = getHeaderPresetParts();
    if (!group) return;

    const locked = isTimerPresetLocked();
    const sessionMode = isTimerSessionActive();
    const target = Math.round(state.timer.targetSeconds || 0);
    const currentRemaining = Math.max(0, Number(state.timer.remainingSeconds) || 0);
    const elapsedSeconds = Math.max(0, target - currentRemaining);

    idleGroup?.querySelectorAll('.header-preset-pill').forEach((btn) => {
      const seconds = Number(btn.dataset.seconds) || 0;
      const isActive = !locked && seconds === target;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      btn.disabled = locked;
    });

    const canAdjust = sessionMode && !resetVisualActive && !isCenterPadHolding;
    sessionGroup?.querySelectorAll('.header-adjust-pill').forEach((btn) => {
      const delta = Number(btn.dataset.adjustSeconds) || 0;
      const atMax = delta > 0 && target >= MAX_TIMER_SECONDS;
      const atMin = delta < 0 && target <= MIN_ACTIVE_SESSION_SECONDS;
      const nextTarget = delta < 0
        ? Math.max(MIN_ACTIVE_SESSION_SECONDS, target - Math.abs(delta))
        : Math.min(MAX_TIMER_SECONDS, target + delta);
      // A reduction must never consume all studied time, because that would
      // end the session. Keep the button inert when it cannot be safe.
      const wouldEnd = delta < 0 && nextTarget - elapsedSeconds <= 0;
      btn.disabled = !canAdjust || atMax || atMin || wouldEnd;

      if (atMax) {
        btn.title = 'Maximum session length is 3 hours';
      } else if (atMin) {
        btn.title = 'Minimum session length is 30 minutes';
      } else if (wouldEnd) {
        btn.title = 'Not enough remaining time to reduce by 30 minutes';
      } else {
        const verb = delta > 0 ? 'Extend' : 'Reduce';
        const bound = delta > 0 ? 'max 3 hours' : 'min 30 minutes';
        btn.title = `${verb} this session by 30 minutes (${bound})`;
      }
    });

    updateHeaderPresetMode();
  }

  function restartAdjustButtonFeedback(button) {
    if (!button) return;

    // If the entrance animation is still active, retire it before swapping in
    // the bump animation so removing .is-bumped cannot restart the entrance.
    const group = document.getElementById('header-presets');
    if (group?.classList.contains('is-swapping-in')) {
      group.classList.remove('is-swapping-in');
      clearTimeout(headerPresetSwapTimer);
      headerPresetSwapTimer = null;
    }

    button.classList.remove('is-bumped');
    void button.offsetWidth;
    button.classList.add('is-bumped');
    clearTimeout(button._adjustFeedbackTimer);
    button._adjustFeedbackTimer = setTimeout(() => {
      button.classList.remove('is-bumped');
      button._adjustFeedbackTimer = null;
    }, 560);
  }

  function flashTimerAdjustment(deltaSeconds, sourceButton) {
    document.body.classList.remove('is-timer-adjusting', 'is-timer-adjusting-up', 'is-timer-adjusting-down');
    void document.body.offsetWidth;
    document.body.classList.add(
      'is-timer-adjusting',
      deltaSeconds > 0 ? 'is-timer-adjusting-up' : 'is-timer-adjusting-down'
    );

    clearTimeout(timerAdjustmentFeedbackTimer);
    timerAdjustmentFeedbackTimer = setTimeout(() => {
      timerAdjustmentFeedbackTimer = null;
      document.body.classList.remove('is-timer-adjusting', 'is-timer-adjusting-up', 'is-timer-adjusting-down');
    }, 560);

    restartAdjustButtonFeedback(sourceButton);
  }

  function adjustActiveSession(deltaSeconds, sourceButton = null) {
    if (!deltaSeconds || !isTimerSessionActive()) return;
    if (resetVisualActive || isCenterPadHolding || presetAnimationRaf !== null) return;

    const isRunning = state.timer.status === 'running';
    const currentTarget = Math.max(0, Math.round(Number(state.timer.targetSeconds) || 0));
    const currentRemaining = isRunning
      ? Math.max(0, recalculateRemainingSeconds())
      : Math.max(0, Number(state.timer.remainingSeconds) || 0);

    // Live sessions have a hard 30-minute floor. A session that is already at
    // or below 30m cannot be reduced further (it can still be extended).
    if (deltaSeconds < 0 && currentTarget <= MIN_ACTIVE_SESSION_SECONDS) {
      restartAdjustButtonFeedback(sourceButton);
      return;
    }

    // Move the target duration in exact 30-minute steps, bounded to 30m..3h.
    // A reduction never increases the target when the floor is reached.
    const nextTarget = deltaSeconds < 0
      ? Math.max(MIN_ACTIVE_SESSION_SECONDS, currentTarget + deltaSeconds)
      : Math.min(MAX_TIMER_SECONDS, currentTarget + deltaSeconds);

    if (nextTarget === currentTarget) {
      // Already at the hard bound: keep the tap tactile without touching time.
      restartAdjustButtonFeedback(sourceButton);
      return;
    }

    // Studied time is immutable while extending/reducing. Target and remaining
    // move together, so the live elapsed clock and earned XP never jump.
    const elapsedSeconds = Math.max(0, currentTarget - currentRemaining);
    const nextRemaining = nextTarget - elapsedSeconds;

    if (nextRemaining <= 0) {
      // Reduction would consume all studied time and end the session. Live
      // adjustments must never complete a session, so leave it untouched.
      restartAdjustButtonFeedback(sourceButton);
      return;
    }

    const serverNow = Date.now() + serverClockOffset;

    state.timer.targetSeconds = nextTarget;
    state.activeTaskTargetSeconds = nextTarget;
    state.timer.remainingSeconds = nextRemaining;
    state.timer.anchorRemainingSeconds = nextRemaining;
    state.timer.anchorServerTime = isRunning ? serverNow : null;
    state.timer.lastTickTime = isRunning ? Date.now() : null;

    if (isRunning) {
      // Remaining time just jumped upward. Clear the monotonic guard so the
      // next countdown calculation is allowed to follow the new anchor.
      lastRenderedSeconds = null;
    }

    saveState();
    flashTimerAdjustment(deltaSeconds, sourceButton);
    renderTimer();

    syncTimerAction('adjust', {
      target_seconds: nextTarget,
      remaining_seconds: Math.round(nextRemaining),
      active_task_name: state.activeTaskName
    });
  }

  function selectTimerPreset(targetSeconds) {
    if (isTimerPresetLocked()) return;
    if (homeIntroDialActive) finishHomeIntroDial();

    const target = Math.max(60, Math.min(MAX_TIMER_SECONDS, Math.round(targetSeconds)));
    if (!target) return;

    cancelTimerPresetAnimation(false);

    const startSeconds = Math.max(0, Number(state.timer.remainingSeconds) || 0);

    state.timer.targetSeconds = target;
    state.timer.remainingSeconds = target;
    state.timer.anchorRemainingSeconds = target;
    state.timer.anchorServerTime = null;
    state.timer.lastTickTime = null;
    state.timer.status = 'idle';
    saveState();
    updateTimerPresetUI();
    syncTimerAction('adjust', { target_seconds: target, remaining_seconds: target });

    const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (prefersReducedMotion || Math.abs(target - startSeconds) < 1) {
      updateDigitalDisplay(target);
      updateTimerRing(target);
      openTaskPromptDialog();
      return;
    }

    // iOS will only raise the keyboard for focus() inside the tap, so open the
    // keyboard now and let it settle while the rim glides. The task prompt then
    // opens when the animation lands, with the keyboard already up.
    primePromptKeyboard();

    // Roll the digits toward the new duration while the rim & bead sweep across
    updateDigitalDisplay(target);

    const token = ++presetAnimationToken;
    const startTime = performance.now();
    const delta = target - startSeconds;

    document.body.classList.add('is-preset-animating');

    const stepPresetAnimation = (now) => {
      if (token !== presetAnimationToken) return;

      const progress = Math.min(1, (now - startTime) / TIMER_PRESET_ANIM_MS);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic

      updateTimerRing(startSeconds + delta * eased);

      if (progress >= 1) {
        presetAnimationRaf = null;
        document.body.classList.remove('is-preset-animating');
        updateTimerRing(target);
        updateDigitalDisplay(target);
        openTaskPromptDialog();
        return;
      }

      presetAnimationRaf = requestAnimationFrame(stepPresetAnimation);
    };

    presetAnimationRaf = requestAnimationFrame(stepPresetAnimation);
  }

  function initHeaderPresets() {
    const { group, idleGroup, sessionGroup } = getHeaderPresetParts();
    if (!group) return;

    group.addEventListener('click', (e) => {
      if (!e.target.closest) return;

      const adjustBtn = e.target.closest('.header-adjust-pill');
      if (adjustBtn) {
        if (adjustBtn.disabled) return;
        e.preventDefault();
        adjustActiveSession(Number(adjustBtn.dataset.adjustSeconds) || 0, adjustBtn);
        return;
      }

      const btn = e.target.closest('.header-preset-pill');
      if (!btn || btn.disabled) return;
      e.preventDefault();
      selectTimerPreset(Number(btn.dataset.seconds) || 0);
    });

    // Pill sizes change with the responsive breakpoints and once the web font
    // settles. Keep the animated container exactly as wide as the active set.
    if (typeof ResizeObserver === 'function' && idleGroup && sessionGroup) {
      headerPresetResizeObserver = new ResizeObserver(() => {
        const { group: currentGroup } = getHeaderPresetParts();
        if (!currentGroup || !currentGroup.classList.contains('is-preset-ready')) return;
        settleHeaderPresetWidth();
      });
      headerPresetResizeObserver.observe(idleGroup);
      headerPresetResizeObserver.observe(sessionGroup);
    }

    window.addEventListener('resize', () => {
      if (group.classList.contains('is-preset-ready')) settleHeaderPresetWidth();
    });

    updateTimerPresetUI();
  }

  // =========================================================================
  // SHARED EASING CURVES
  // =========================================================================
  const easeInOutQuart = t => t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;

  // =========================================================================
  // COMPOSITOR-FRIENDLY DIGIT DIAL
  // =========================================================================
  // A digit change crossfades two layers using only transform + opacity:
  // the outgoing digit scales down and fades, the incoming digit scales up
  // from the same smaller size and fades in. There is deliberately no
  // translateY slide and no per-frame blur/filter work, so the whole
  // transition runs on the compositor and cannot jitter the main thread.
  const DIAL_TRANSITION_MS = 360;
  const DIAL_OUT_SCALE = 0.15;
  const DIAL_IN_SCALE = 0.15;
  const DIAL_EASE = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)';

  function dialPrefersReducedMotion() {
    return typeof window !== 'undefined' && window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  class DialColumn {
    constructor(parentEl, initialChar) {
      const initial = String(parseInt(initialChar, 10) || 0);
      this.currentDigit = initial;
      this.targetDigit = null;
      this.pendingDigit = null;
      this.isTransitioning = false;
      this.transitionToken = 0;
      this.animations = [];
      this.finishTimer = null;
      this.rapidSettled = true;

      this.col = document.createElement('span');
      this.col.className = 'dial-col';

      this.layoutHolder = document.createElement('span');
      this.layoutHolder.className = 'dial-layout-holder';
      this.layoutHolder.textContent = initial;
      this.col.appendChild(this.layoutHolder);

      this.activeLayer = document.createElement('span');
      this.activeLayer.className = 'dial-layer';
      this.activeLayer.textContent = initial;
      this.activeLayer.style.transform = 'scale(1)';
      this.activeLayer.style.opacity = '1';
      this.col.appendChild(this.activeLayer);

      this.nextLayer = document.createElement('span');
      this.nextLayer.className = 'dial-layer';
      this.nextLayer.textContent = '';
      this.nextLayer.style.transform = `scale(${DIAL_IN_SCALE})`;
      this.nextLayer.style.opacity = '0';
      this.col.appendChild(this.nextLayer);

      parentEl.appendChild(this.col);
    }

    _setLayer(layer, digit, scale, opacity) {
      if (layer.textContent !== digit) layer.textContent = digit;
      layer.style.transform = `scale(${scale})`;
      layer.style.opacity = String(opacity);
    }

    _cancelAnimations() {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
      for (let i = 0; i < this.animations.length; i++) {
        try { this.animations[i].cancel(); } catch (e) {}
      }
      this.animations = [];
    }

    _settle(digit) {
      this._cancelAnimations();
      this.transitionToken++;
      this.currentDigit = digit;
      this.targetDigit = null;
      this.pendingDigit = null;
      this.isTransitioning = false;
      this._setLayer(this.activeLayer, digit, 1, 1);
      this._setLayer(this.nextLayer, '', DIAL_IN_SCALE, 0);
      this.layoutHolder.textContent = digit;
      this.rapidSettled = true;
    }

    setStatic(digit) {
      const next = String(parseInt(digit, 10) || 0);
      if (!this.isTransitioning && this.currentDigit === next) return;

      // Rapid hold/scrub updates have no transition in flight. After the
      // first snap, changing only the visible glyph avoids rewriting two
      // transforms + opacities per column on every animation frame.
      if (this.rapidSettled && !this.isTransitioning) {
        this.currentDigit = next;
        if (this.activeLayer.textContent !== next) {
          this.activeLayer.textContent = next;
        }
        return;
      }

      this._settle(next);
    }

    animateTo(targetDigit, direction = 1, options = {}) {
      const next = String(parseInt(targetDigit, 10) || 0);

      // Hold-to-reset and bead scrubbing update the display much faster than
      // a transition can finish. Snapping those values keeps the digits
      // locked to the ring and avoids a permanent crossfade backlog.
      if (options.rapid || dialPrefersReducedMotion()) {
        this.setStatic(next);
        return;
      }

      if (this.isTransitioning) {
        // The finish event can be delayed while a tab is throttled. If the
        // animation has already reached its end, settle it now instead of
        // queueing behind a stale transition.
        if (this.animations.length && this.animations.every(a => a.playState === 'finished')) {
          this._settle(this.targetDigit ?? this.currentDigit);
        } else {
          if (next !== this.targetDigit) this.pendingDigit = next;
          return;
        }
      }

      if (next === this.currentDigit) return;
      this._startTransition(next, options);
    }

    _startTransition(next, options = {}) {
      const outgoing = this.activeLayer;
      const incoming = this.nextLayer;

      if (typeof outgoing.animate !== 'function') {
        this._settle(next);
        return;
      }

      const duration = Math.max(80, Number(options.duration) || DIAL_TRANSITION_MS);

      this.isTransitioning = true;
      this.targetDigit = next;
      this.pendingDigit = null;
      this.rapidSettled = false;

      // Underlying post-animation state. The WAAPI animations override it
      // while running, so cancelling never flashes the wrong glyph.
      this._setLayer(outgoing, this.currentDigit, 1, 1);
      this._setLayer(incoming, next, DIAL_IN_SCALE, 0);

      const outAnim = outgoing.animate(
        [
          { transform: 'scale(1)', opacity: 1 },
          { transform: `scale(${DIAL_OUT_SCALE})`, opacity: 0 }
        ],
        { duration, easing: DIAL_EASE, fill: 'both' }
      );
      const inAnim = incoming.animate(
        [
          { transform: `scale(${DIAL_IN_SCALE})`, opacity: 0 },
          { transform: 'scale(1)', opacity: 1 }
        ],
        { duration, easing: DIAL_EASE, fill: 'both' }
      );

      this.animations = [outAnim, inAnim];

      const token = ++this.transitionToken;
      const finish = () => {
        if (token !== this.transitionToken || !this.isTransitioning) return;
        this._finishTransition(token);
      };

      outAnim.addEventListener('finish', finish);
      inAnim.addEventListener('finish', finish);

      // Safety net for background tabs where finish delivery can lag.
      this.finishTimer = setTimeout(finish, duration + 80);
    }

    _finishTransition(token) {
      if (token !== this.transitionToken || !this.isTransitioning) return;

      const settled = this.targetDigit;
      if (settled == null) {
        this.isTransitioning = false;
        return;
      }
      const queued = this.pendingDigit;

      this._cancelAnimations();
      this.currentDigit = settled;
      this.targetDigit = null;
      this.pendingDigit = null;
      this.isTransitioning = false;

      this._setLayer(this.activeLayer, settled, 1, 1);
      this._setLayer(this.nextLayer, '', DIAL_IN_SCALE, 0);
      this.layoutHolder.textContent = settled;
      this.rapidSettled = true;

      if (queued !== null && queued !== settled) {
        this._startTransition(queued);
      }
    }

    destroy() {
      this._cancelAnimations();
      this.col.remove();
    }
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
        const display = i < hideCount ? 'none' : 'inline-flex';
        if (col.col.style.display !== display) {
          col.col.style.display = display;
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
    if (
      hoursDial && hoursDial.container.isConnected &&
      minsDial && minsDial.container.isConnected &&
      secsDial && secsDial.container.isConnected
    ) {
      return;
    }

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

    const timeDelta = lastDigitalSecs === -1 ? 0 : (safeSecs - lastDigitalSecs);

    // The running timer calls this at 4Hz, so most calls land on the same
    // displayed second. Bail out before touching the dials: re-setting a
    // digit here used to cancel its transition mid-flight (the main source
    // of choppy digit changes).
    if (lastDigitalSecs !== -1 && timeDelta === 0 && !forceNoAnim) {
      return;
    }

    // Toggle sub-hour class for seamless animated collapse and scale
    if (digitsEl.classList.contains('has-hours') !== hasHours) {
      digitsEl.classList.toggle('has-hours', hasHours);
      digitsEl.classList.toggle('is-sub-hour', !hasHours);
    }

    ensureDialControllers();

    // Determine direction and whether to animate:
    // When time decreases (countdown, hold-drain, scrubbing down): dir = -1
    // When time increases (preset, reset, scrubbing up): dir = 1
    const dir = timeDelta >= 0 ? 1 : -1;
    const shouldAnimate = !forceNoAnim && !options.rapid && lastDigitalSecs !== -1 && timeDelta !== 0;
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

  // Frame-locked hold countdown. Large durations are swept through with an
  // ease-out curve, then the last 30 seconds tick down one integer at a time
  // at a 60 Hz cadence. Nothing is throttled to 30 Hz and no frame repeats the
  // previous glyph, so the counter tracks the ring instead of stuttering.
  function getHoldVisualSeconds(totalSeconds, elapsedMs) {
    const total = Math.max(0, Math.floor(totalSeconds));
    if (total <= 0) return 0;

    const elapsed = Math.max(0, Number(elapsedMs) || 0);
    if (elapsed >= HOLD_DRAIN_MS) return 0;

    if (total <= RESET_TAIL_SECONDS) {
      const stepMs = HOLD_DRAIN_MS / total;
      return Math.max(0, total - Math.floor(elapsed / stepMs));
    }

    const tailMs = RESET_TAIL_SECONDS * RESET_TAIL_STEP_MS;
    const tailStart = Math.max(0, HOLD_DRAIN_MS - tailMs);

    if (elapsed >= tailStart) {
      const steps = Math.floor((elapsed - tailStart) / RESET_TAIL_STEP_MS);
      return Math.max(0, RESET_TAIL_SECONDS - steps);
    }

    const progress = tailStart > 0 ? Math.min(1, elapsed / tailStart) : 1;
    const eased = 1 - Math.pow(1 - progress, 2.6);
    return Math.max(RESET_TAIL_SECONDS, Math.round(total - (total - RESET_TAIL_SECONDS) * eased));
  }

  function beginTimerResetReturn(targetSeconds, options = {}) {
    const target = Math.max(0, Math.min(MAX_TIMER_SECONDS, Math.round(Number(targetSeconds) || 0)));
    const zeroHoldMs = Math.max(0, Number(options.zeroHoldMs) || 0);
    const returnMs = Math.max(90, Number(options.returnMs) || RESET_RETURN_MS);
    const token = ++resetReturnToken;

    resetVisualActive = true;
    document.body.classList.add('is-reset-returning');

    clearTimeout(resetZeroTimer);
    clearTimeout(resetFinishTimer);
    if (resetReturnRaf !== null) {
      cancelAnimationFrame(resetReturnRaf);
      resetReturnRaf = null;
    }

    // Paint 0:00 immediately. The browser commits this frame before the
    // zero-hold pauses, so the user actually sees zero this time.
    updateTimerRing(0);
    updateDigitalDisplay(0, true);

    const finish = () => {
      if (token !== resetReturnToken) return;

      clearTimeout(resetFinishTimer);
      clearTimeout(resetZeroTimer);
      resetFinishTimer = null;
      resetZeroTimer = null;

      if (resetReturnRaf !== null) {
        cancelAnimationFrame(resetReturnRaf);
        resetReturnRaf = null;
      }

      resetVisualActive = false;
      document.body.classList.remove('is-reset-returning');

      renderTimerDisplay(target);
      renderTimer();
      try {
        if (typeof options.onComplete === 'function') options.onComplete();
      } catch (e) {
        console.warn('StudyArk: Timer reset completion error:', e);
      }
      scheduleStatePersistence(90);
    };

    // Safety net for background tabs (rAF can be fully paused there).
    resetFinishTimer = setTimeout(finish, zeroHoldMs + returnMs + 320);

    resetZeroTimer = setTimeout(() => {
      if (token !== resetReturnToken) return;
      resetZeroTimer = null;

      try {
        if (typeof options.onCommit === 'function') options.onCommit();
      } catch (e) {
        console.warn('StudyArk: Timer reset commit error:', e);
      }
      if (token !== resetReturnToken) return;

      // Digits crossfade directly to the new target while the rim refills.
      updateDigitalDisplay(target, false, { duration: 340 });

      const startedAt = performance.now();
      const step = (now) => {
        if (token !== resetReturnToken) return;
        const progress = Math.min(1, (now - startedAt) / returnMs);
        const eased = 1 - Math.pow(1 - progress, 3);
        updateTimerRing(target * eased);

        if (progress >= 1) {
          finish();
          return;
        }
        resetReturnRaf = requestAnimationFrame(step);
      };
      resetReturnRaf = requestAnimationFrame(step);
    }, zeroHoldMs);
  }

  /* ==========================================================================
     AMBIENT FLOATING HEATMAP STREAM ENGINE (COMPOSITOR-DRIVEN)
     - Builds two static tile layers once; the browser animates them forever
       with GPU transforms (no canvas, no RAF loop, no per-frame allocations).
     - Hold-to-reset only changes animation playbackRate + a CSS class, so the
       speed rush costs effectively nothing on the main thread.
     - Paused/off = animations paused, so the compositor goes fully idle.
     ========================================================================== */
  class MatrixStreamEngine {
    constructor(streamId) {
      this.stream = document.getElementById(streamId);
      this.container = document.getElementById('ambient-aura-container');
      if (!this.stream) return;

      this.isRunning = false;
      this.isHolding = false;
      this.baseRate = 0.5;
      this.currentRate = 0.5;
      this.targetRate = 0.5;
      this.rampRaf = null;
      this.rampLastTime = 0;
      this.animations = [];

      this.build();
      this.start();

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this.stop();
        } else if (typeof state === 'undefined' || state.auraEnabled !== false) {
          if (!document.documentElement.classList.contains('aura-disabled')) {
            this.start();
          }
        }
      });

      // Accessibility / battery saver: respect system prefers-reduced-motion
      try {
        const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        motionQuery.addEventListener('change', () => {
          if (motionQuery.matches) this.stop();
          else if (typeof state === 'undefined' || state.auraEnabled !== false) {
            if (!document.documentElement.classList.contains('aura-disabled')) this.start();
          }
        });
      } catch (e) {}
    }

    build() {
      this.stream.textContent = '';
      this.animations = [];

      const isMobile = window.innerWidth < 680;
      const green = ['#0D2E18', '#134F2A', '#1F9851', '#10E068'];
      const amber = ['#2E1F09', '#4D330D', '#8C5C15', '#E5A958'];

      // Two depths give parallax without multiplying composited layers.
      // More tiles per viewport = a denser stream at the same GPU layer cost.
      const layers = [
        { duration: 20, count: isMobile ? 14 : 18, minW: 5, maxW: 8, opacity: 0.55 },
        { duration: 12, count: isMobile ? 20 : 26, minW: 7.5, maxW: 12, opacity: 0.85 }
      ];

      layers.forEach((spec) => {
        const layer = document.createElement('div');
        layer.className = 'bg-matrix-layer';

        const frag = document.createDocumentFragment();
        for (let i = 0; i < spec.count; i++) {
          const levelRoll = Math.random();
          const level = levelRoll < 0.18 ? 0 : levelRoll < 0.5 ? 1 : levelRoll < 0.85 ? 2 : 3;
          const width = spec.minW + Math.random() * (spec.maxW - spec.minW);
          const height = width * 1.4;
          const isLeft = Math.random() < 0.5;
          const xMin = isLeft ? 2.5 : 73.5;
          const xMax = isLeft ? 26.5 : 97.5;
          const left = xMin + Math.random() * (xMax - xMin);
          const top = Math.random() * 50;
          const opacity = spec.opacity * (0.7 + Math.random() * 0.3);

          // Each tile is painted twice, exactly one viewport apart. When the
          // layer scrolls -50% (one viewport) the next copy is pixel-identical,
          // so the infinite loop is seamless.
          for (let copy = 0; copy < 2; copy++) {
            const tile = document.createElement('span');
            tile.className = 'bg-matrix-tile';
            tile.style.cssText =
              `--tile-green:${green[level]};--tile-amber:${amber[level]};` +
              `left:${left.toFixed(2)}%;top:${(top + copy * 50).toFixed(2)}%;` +
              `width:${width.toFixed(2)}px;height:${height.toFixed(2)}px;opacity:${opacity.toFixed(2)};`;
            frag.appendChild(tile);
          }
        }

        layer.appendChild(frag);
        this.stream.appendChild(layer);

        const anim = layer.animate(
          [
            { transform: 'translate3d(0, 0, 0)' },
            { transform: 'translate3d(0, -50%, 0)' }
          ],
          {
            duration: spec.duration * 1000,
            iterations: Infinity,
            easing: 'linear'
          }
        );
        anim.playbackRate = this.baseRate;
        anim.currentTime = Math.random() * spec.duration * 1000;
        anim.pause();
        this.animations.push(anim);
      });
    }

    applyRate(rate) {
      this.currentRate = rate;
      for (let i = 0; i < this.animations.length; i++) {
        this.animations[i].playbackRate = rate;
      }
    }

    // Smoothly ease the actual playback speed toward its target. Runs only
    // while the speed is changing (hold + a short coast-down after release),
    // then stops completely.
    startRamp() {
      if (!this.isRunning || this.rampRaf !== null) return;
      this.rampLastTime = performance.now();

      const step = (now) => {
        this.rampRaf = null;
        if (!this.isRunning) return;

        const dt = Math.min(0.05, Math.max(0.001, (now - this.rampLastTime) / 1000));
        this.rampLastTime = now;

        const diff = this.targetRate - this.currentRate;
        if (Math.abs(diff) < 0.02) {
          if (this.currentRate !== this.targetRate) this.applyRate(this.targetRate);
          return;
        }

        // Accelerate eagerly, then coast down gently on release.
        const responsiveness = diff > 0 ? 9 : 3.2;
        const factor = 1 - Math.exp(-responsiveness * dt);
        this.applyRate(this.currentRate + diff * factor);
        this.rampRaf = requestAnimationFrame(step);
      };

      this.rampRaf = requestAnimationFrame(step);
    }

    setTimerStatus(status) {
      this.baseRate = status === 'running' ? 1.1 : 0.5;
      this.container?.classList.toggle('is-amber', status !== 'running');

      if (this.isHolding) return;

      this.targetRate = this.baseRate;
      if (this.isRunning && Math.abs(this.currentRate - this.targetRate) > 0.02) {
        this.startRamp();
      } else if (!this.isRunning) {
        this.applyRate(this.baseRate);
      }
    }

    setHolding(isHolding, progress = 0) {
      if (isHolding) {
        if (!this.isHolding) {
          this.isHolding = true;
          this.container?.classList.add('is-boosting');
        }
        const p = Math.min(1, Math.max(0, progress));
        // Starts with a real, visible boost and climbs quickly to ~16x.
        this.targetRate = 2.8 + Math.pow(p, 0.68) * 13.2;
        this.startRamp();
      } else if (this.isHolding) {
        this.isHolding = false;
        this.container?.classList.remove('is-boosting');
        this.targetRate = this.baseRate;
        this.startRamp();
      }
    }

    start() {
      if (this.isRunning) return;
      try {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      } catch (e) {}
      if (typeof state !== 'undefined' && state.auraEnabled === false) return;
      if (document.documentElement.classList.contains('aura-disabled')) return;
      // The aura is deliberately dark during the boot loader and entrance
      // sequence. It is released by the final intro step.
      if (document.documentElement.classList.contains('intro-aura-hidden')) return;
      this.isRunning = true;
      for (let i = 0; i < this.animations.length; i++) {
        this.animations[i].play();
      }
      if (this.isHolding) {
        this.applyRate(this.currentRate);
      } else {
        this.targetRate = this.baseRate;
        this.applyRate(this.baseRate);
      }
    }

    stop() {
      this.isRunning = false;
      if (this.rampRaf !== null) {
        cancelAnimationFrame(this.rampRaf);
        this.rampRaf = null;
      }
      if (this.isHolding) {
        this.isHolding = false;
        this.container?.classList.remove('is-boosting');
      }
      this.targetRate = this.baseRate;
      this.applyRate(this.baseRate);
      for (let i = 0; i < this.animations.length; i++) {
        this.animations[i].pause();
      }
    }
  }

  let matrixStreamEngine = null;

  function initMatrixStream() {
    if (!matrixStreamEngine) {
      matrixStreamEngine = new MatrixStreamEngine('bg-matrix-stream');
    }
    matrixStreamEngine.setTimerStatus(state.timer.status || 'idle');
  }

  function renderTimer() {
    // While a preset glide, hold drain, or zero-hold reset is playing, other
    // render paths must not snap the display before the animation finishes.
    if (presetAnimationRaf === null && !resetVisualActive && !isCenterPadHolding) {
      renderTimerDisplay(state.timer.remainingSeconds);
    }

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

      // Synchronize floating matrix stream and body with timer running/amber state
      const isRunning = state.timer.status === 'running';
      document.body.classList.toggle('is-timer-amber', !isRunning);
      document.body.classList.toggle('timer-running', isRunning);
      document.body.classList.toggle('is-timer-paused', state.timer.status === 'paused');
      matrixStreamEngine?.setTimerStatus(state.timer.status);

      if (isRunning) {
        timerSection?.classList.add('is-running');
        timerSection?.classList.remove('is-paused');
        centerPad?.setAttribute('aria-label', `Focusing on ${state.activeTaskName}. Tap to pause, hold 1.2s to save.`);
        document.title = `(${formatDigitalTime(state.timer.remainingSeconds)}) ${state.activeTaskName} • StudyArk`;
      } else if (state.timer.status === 'paused') {
        timerSection?.classList.remove('is-running');
        timerSection?.classList.add('is-paused');
        centerPad?.setAttribute('aria-label', `Paused on ${state.activeTaskName}. Tap to resume, hold 1.2s to save.`);
        document.title = `Paused (${formatDigitalTime(state.timer.remainingSeconds)}) • StudyArk`;
      } else {
        timerSection?.classList.remove('is-running', 'is-paused');
        centerPad?.setAttribute('aria-label', `Ready to focus on ${state.activeTaskName}. Tap to start.`);
        document.title = `StudyArk — Minimal Focus & Habit Tracker`;
      }
    } else {
      document.body.classList.add('is-timer-amber');
      document.body.classList.remove('timer-running');
      document.body.classList.remove('is-timer-paused');
      matrixStreamEngine?.setTimerStatus('idle');
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
      document.title = `StudyArk — Minimal Focus & Habit Tracker`;
    }

    updateTodayLiveStat();
    updateLiveXpStat();
    updateTimerPresetUI();
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

    const nextText = hrs > 0
      ? `${hrs}h ${String(mins).padStart(2, '0')}m ${secStr}`
      : `${mins}m ${secStr}`;

    if (todayStatEl.textContent !== nextText) {
      todayStatEl.textContent = nextText;
      adjustStatFontFit();
    }

    if (statItemToday) {
      const nextTitle = `Today's Focus: ${nextText} • Click to view Day Record`;
      if (statItemToday.title !== nextTitle) statItemToday.title = nextTitle;
      statItemToday.classList.toggle('is-running', state.timer.status === 'running');
      statItemToday.classList.toggle('is-paused', state.timer.status === 'paused');
    }
  }

  function renderTimerTick() {
    if (presetAnimationRaf === null && !resetVisualActive && !isCenterPadHolding) {
      renderTimerDisplay(state.timer.remainingSeconds);
    }
    updateTodayLiveStat();
    updateLiveXpStat();

    if (state.activeTaskName) {
      const nextTitle = `(${formatDigitalTime(state.timer.remainingSeconds)}) ${state.activeTaskName} • StudyArk`;
      if (document.title !== nextTitle) document.title = nextTitle;
    }
  }

  let activeSessionHasBeenPaused = false;

  function getLiveElapsedSeconds() {
    if (state.timer.status === 'running' || state.timer.status === 'paused') {
      return Math.max(0, state.timer.targetSeconds - state.timer.remainingSeconds);
    }
    return 0;
  }

  // Sessions shorter than one minute are discarded on reset (same strict rule
  // used by the Today's Focus pill and logSession()). Never show live XP for a
  // session that cannot be persisted yet: it would jump back to the saved value
  // the moment the discarded session is cleared.
  const LIVE_XP_MIN_SESSION_SECONDS = 60;

  function getLiveSessionXp() {
    const elapsedSecs = getLiveElapsedSeconds();
    if (elapsedSecs < LIVE_XP_MIN_SESSION_SECONDS) return 0;

    let flowMult = 1.00;
    if (elapsedSecs >= 90 * 60) flowMult = 1.35;
    else if (elapsedSecs >= 60 * 60) flowMult = 1.25;
    else if (elapsedSecs >= 30 * 60) flowMult = 1.15;

    const pristineMult = !activeSessionHasBeenPaused ? 1.10 : 1.00;

    const streak = state.streak || 0;
    let streakMult = 1.00;
    if (streak >= 31) streakMult = 1.20;
    else if (streak >= 15) streakMult = 1.15;
    else if (streak >= 8) streakMult = 1.10;
    else if (streak >= 4) streakMult = 1.05;

    // Real-time continuous accumulation: 10 base XP per 60 seconds (scaled by flow, pristine, and streak)
    const scaledRate = (10 * flowMult * pristineMult * streakMult) / 60.0;
    let liveXp = Math.floor(elapsedSecs * scaledRate);

    // Ignition (+100 XP) and milestone sparks kick in at the one-minute mark
    const todayStr = getLocalDateString();
    const todayMins = state.dayActivity[todayStr] || 0;
    if (todayMins === 0) {
      liveXp += 100;
    }
    const newTotalMins = todayMins + Math.floor(elapsedSecs / 60);
    if (todayMins < 60 && newTotalMins >= 60) liveXp += 150;
    if (todayMins < 120 && newTotalMins >= 120) liveXp += 300;
    if (todayMins < 240 && newTotalMins >= 240) liveXp += 600;

    return liveXp;
  }

  function getEffectiveTotalXp() {
    return Math.max(0, (state.xp || 0) + getLiveSessionXp());
  }

  function updateLiveXpStat() {
    const xpEl = document.getElementById('stat-xp');
    const levelNumEl = document.getElementById('stat-level-num');
    const levelNameEl = document.getElementById('stat-level-name');
    const xpFractionEl = document.getElementById('stat-xp-fraction');
    const xpBarFillEl = document.getElementById('stat-xp-bar-fill');
    const xpItemEl = document.getElementById('stat-item-xp');
    if (!xpEl && !levelNumEl && !xpItemEl) return;

    const effectiveXp = getEffectiveTotalXp();
    const lvlInfo = getLevelInfo(effectiveXp);

    if (xpEl) {
      const xpText = formatCompactNumber(effectiveXp);
      if (xpEl.textContent !== xpText) {
        xpEl.textContent = xpText;
        xpEl.title = `${Number(effectiveXp).toLocaleString()} XP`;
      }
    }
    if (levelNumEl) {
      const lvlText = `Lv. ${lvlInfo.level}`;
      if (levelNumEl.textContent !== lvlText) {
        levelNumEl.textContent = lvlText;
      }
    }
    if (levelNameEl) {
      if (levelNameEl.textContent !== lvlInfo.title) {
        levelNameEl.textContent = lvlInfo.title;
      }
    }
    if (xpFractionEl) {
      const fractionText = `${formatCompactNumber(lvlInfo.currentLevelXp)} / ${formatCompactNumber(lvlInfo.xpRequired)} XP (${lvlInfo.progressPercent.toFixed(1)}%)`;
      if (xpFractionEl.textContent !== fractionText) {
        xpFractionEl.textContent = fractionText;
      }
    }
    if (xpBarFillEl) {
      const widthText = `${lvlInfo.progressPercent.toFixed(1)}%`;
      if (xpBarFillEl.style.width !== widthText) {
        xpBarFillEl.style.width = widthText;
      }
    }
    if (xpItemEl) {
      const titleText = `Level ${lvlInfo.level}: ${lvlInfo.title} (${lvlInfo.tier})\nCollected: ${lvlInfo.currentLevelXp.toLocaleString()} / ${lvlInfo.xpRequired.toLocaleString()} XP (${lvlInfo.progressPercent.toFixed(1)}%)\nTotal Studied: ${Number(effectiveXp).toLocaleString()} XP`;
      if (xpItemEl.title !== titleText) {
        xpItemEl.title = titleText;
      }
      xpItemEl.classList.toggle('is-running', state.timer.status === 'running');
      xpItemEl.classList.toggle('is-paused', state.timer.status === 'paused');
    }

    const levelsDlg = document.getElementById('levels-dialog');
    if (levelsDlg && levelsDlg.open) {
      updateLevelsDialogLiveMetrics();
    }
  }

  function startTimer() {
    lastRenderedSeconds = null;
    initAudio();
    playChime('start');
    activeSessionHasBeenPaused = false;

    const now = Date.now();
    if (!state.activeTaskStartTime) {
      state.activeTaskStartTime = now;
    }
    if (!state.activeSessionIntervals || state.activeSessionIntervals.length === 0) {
      state.activeSessionIntervals = [{ type: 'focus', start: now, end: null }];
    }

    state.timer.status = 'running';
    state.timer.anchorRemainingSeconds = state.timer.remainingSeconds;
    state.timer.anchorServerTime = now + serverClockOffset;
    state.timer.lastTickTime = now;
    saveState();

    if (!timerInterval) {
      timerInterval = setInterval(handleTimerTick, 250);
    }
    renderTimer();
    syncTimerAction('start', {
      target_seconds: state.timer.targetSeconds,
      remaining_seconds: Math.round(state.timer.remainingSeconds),
      active_task_name: state.activeTaskName,
      session_started_at: state.activeTaskStartTime,
      intervals: state.activeSessionIntervals
    });
  }

  function resumeTimer() {
    lastRenderedSeconds = null;
    initAudio();
    playChime('start');

    const now = Date.now();
    if (!state.activeTaskStartTime) {
      state.activeTaskStartTime = now;
    }
    if (!state.activeSessionIntervals) {
      state.activeSessionIntervals = [];
    }
    if (state.activeSessionIntervals.length > 0) {
      const last = state.activeSessionIntervals[state.activeSessionIntervals.length - 1];
      if (last.end === null) {
        last.end = now;
      }
    }
    state.activeSessionIntervals.push({ type: 'focus', start: now, end: null });

    state.timer.status = 'running';
    state.timer.anchorRemainingSeconds = state.timer.remainingSeconds;
    state.timer.anchorServerTime = now + serverClockOffset;
    state.timer.lastTickTime = now;
    saveState();

    if (!timerInterval) {
      timerInterval = setInterval(handleTimerTick, 250);
    }
    renderTimer();
    syncTimerAction('resume', {
      target_seconds: state.timer.targetSeconds,
      remaining_seconds: Math.round(state.timer.remainingSeconds),
      active_task_name: state.activeTaskName,
      session_started_at: state.activeTaskStartTime,
      intervals: state.activeSessionIntervals
    });
  }

  function pauseTimer() {
    lastRenderedSeconds = null;
    activeSessionHasBeenPaused = true;

    const now = Date.now();
    if (!state.activeSessionIntervals) {
      state.activeSessionIntervals = [];
    }
    if (state.activeSessionIntervals.length > 0) {
      const last = state.activeSessionIntervals[state.activeSessionIntervals.length - 1];
      if (last.end === null) {
        last.end = now;
      }
    } else {
      state.activeSessionIntervals.push({
        type: 'focus',
        start: state.activeTaskStartTime || now,
        end: now
      });
    }
    state.activeSessionIntervals.push({ type: 'break', start: now, end: null });

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
      remaining_seconds: Math.round(state.timer.remainingSeconds),
      session_started_at: state.activeTaskStartTime,
      intervals: state.activeSessionIntervals
    });
  }

  function estimateSessionXp(minutes, unpaused = true) {
    const base = Math.max(1, minutes) * 10;
    let flowMult = 1.0;
    if (minutes >= 90) flowMult = 1.35;
    else if (minutes >= 60) flowMult = 1.25;
    else if (minutes >= 30) flowMult = 1.15;

    const pristineMult = unpaused ? 1.10 : 1.0;

    const streak = state.streak || 0;
    let streakMult = 1.0;
    if (streak >= 31) streakMult = 1.20;
    else if (streak >= 15) streakMult = 1.15;
    else if (streak >= 8) streakMult = 1.10;
    else if (streak >= 4) streakMult = 1.05;

    let scaled = Math.round(base * flowMult * pristineMult * streakMult);

    const todayStr = getLocalDateString();
    const todayMins = state.dayActivity[todayStr] || 0;
    if (todayMins === 0) {
      scaled += 100;
    }
    const newTotal = todayMins + minutes;
    if (todayMins < 60 && newTotal >= 60) scaled += 150;
    if (todayMins < 120 && newTotal >= 120) scaled += 300;
    if (todayMins < 240 && newTotal >= 240) scaled += 600;

    return scaled;
  }

  function handleTimerTick() {
    if (state.timer.status !== 'running') return;
    if (isCenterPadHolding || resetVisualActive) return;

    const remaining = recalculateRemainingSeconds();

    if (remaining <= 0) {
      completeSession();
    } else if (!document.hidden) {
      renderTimerTick();
    }

    // The persisted timer is intentionally stored as idle, so the old
    // 5-second full-state localStorage rewrite saved identical data while the
    // timer ran. Every real state change already calls saveState().
  }

  let deferredSessionUiTimer = null;

  // Stats + heatmap are surprisingly expensive (hundreds of cells). During a
  // reset they must never run in the same frame as the timer repaint, so the
  // non-timer UI settles a moment later while the digit transition plays.
  function scheduleSessionUIUpdate(delay = 120) {
    if (deferredSessionUiTimer !== null) {
      clearTimeout(deferredSessionUiTimer);
    }
    deferredSessionUiTimer = setTimeout(() => {
      deferredSessionUiTimer = null;
      renderStats();
      renderHeatmap();
      refreshOpenHistoryDialog();
    }, Math.max(0, delay));
  }

  async function logSession(minutesCompleted, subjectName = null, options = {}) {
    if (minutesCompleted < 1) return;
    const renderNow = options.render !== false;
    const persistNow = options.persist !== false;
    const todayStr = getLocalDateString();
    const subj = subjectName || state.activeTaskName || (state.subjects && state.subjects.length > 0 ? state.subjects[0].name : 'Focus Session');
    const now = Date.now();
    const sessionStartMs = Number(options.sessionStartMs || options.startTime || state.activeTaskStartTime) || (now - minutesCompleted * 60000);
    const sessionEndMs = Number(options.sessionEndMs || options.endTime || now);
    const breakMinutes = Number(options.breakMinutes || 0);
    const timeline = options.timeline || [{
      type: 'focus',
      start: sessionStartMs,
      end: sessionEndMs,
      duration: minutesCompleted * 60
    }];

    const startD = new Date(sessionStartMs);
    const endD = new Date(sessionEndMs);
    const startDateStr = getLocalDateString(startD);
    const endDateStr = getLocalDateString(endD);
    const isOvernight = (startDateStr !== endDateStr);

    const startStr = formatTime(startD);
    let endStr = formatTime(endD);
    if (isOvernight) {
      endStr += ' (+1d)';
    }
    const timeRangeStr = `${startStr} – ${endStr}`;
    const unpaused = options.unpaused !== false;
    const earnedXp = estimateSessionXp(minutesCompleted, unpaused);

    // Optimistic local update with midnight split
    state.xp += earnedXp;
    state.totalFocusSeconds += minutesCompleted * 60;

    let day1Mins = minutesCompleted;
    let day2Mins = 0;

    if (isOvernight) {
      const midnightD = new Date(startD);
      midnightD.setHours(24, 0, 0, 0);
      const midnightMs = midnightD.getTime();
      const totalSpan = Math.max(1, sessionEndMs - sessionStartMs);
      const spanDay1 = Math.max(0, midnightMs - sessionStartMs);
      if (totalSpan > 0) {
        day1Mins = Math.max(1, Math.round(minutesCompleted * (spanDay1 / totalSpan)));
        day2Mins = Math.max(1, minutesCompleted - day1Mins);
      } else {
        day1Mins = Math.max(1, Math.floor(minutesCompleted / 2));
        day2Mins = Math.max(1, minutesCompleted - day1Mins);
      }
      state.dayActivity[startDateStr] = (state.dayActivity[startDateStr] || 0) + day1Mins;
      state.dayActivity[endDateStr] = (state.dayActivity[endDateStr] || 0) + day2Mins;
      dayDetailsCache.delete(startDateStr);
      dayDetailsCache.delete(endDateStr);
    } else {
      state.dayActivity[startDateStr] = (state.dayActivity[startDateStr] || 0) + minutesCompleted;
      dayDetailsCache.delete(startDateStr);
    }

    const sessionObj = {
      id: 'sess_' + now,
      date: startDateStr,
      durationMinutes: minutesCompleted,
      subject: subj,
      timestamp: sessionEndMs,
      startTime: startStr,
      endTime: endStr,
      timeRange: timeRangeStr,
      xp: earnedXp,
      sessionStartMs: sessionStartMs,
      sessionEndMs: sessionEndMs,
      breakMinutes: breakMinutes,
      timeline: timeline
    };
    state.sessions.unshift(sessionObj);
    invalidateSessionIndex();

    updateStreak();
    if (persistNow) saveState();
    if (renderNow) {
      renderAll();
      refreshOpenHistoryDialog();
    }

    // Persist session to backend
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject_name: subj,
          duration_minutes: minutesCompleted,
          date: startDateStr,
          timestamp: sessionEndMs,
          start_time: startStr,
          end_time: endStr,
          unpaused: unpaused,
          session_start_ms: sessionStartMs,
          session_end_ms: sessionEndMs,
          break_minutes: breakMinutes,
          timeline: timeline
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          if (data.session && data.session.id) {
            const opt = state.sessions.find(s => s.id === ('sess_' + now));
            if (opt) {
              opt.id = data.session.id;
              if (data.session.xp != null) {
                opt.xp = data.session.xp;
              }
              if (data.session.sessionStartMs != null) {
                opt.sessionStartMs = data.session.sessionStartMs;
              }
              if (data.session.sessionEndMs != null) {
                opt.sessionEndMs = data.session.sessionEndMs;
              }
              if (data.session.breakMinutes != null) {
                opt.breakMinutes = data.session.breakMinutes;
              }
              if (data.session.timeline != null) {
                opt.timeline = data.session.timeline;
              }
              invalidateSessionIndex();
            }
          }
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
          if (options.persist !== false) {
            if (resetVisualActive) scheduleStatePersistence(120);
            else saveState();
          }
          if (options.deferUIDelay !== false) {
            scheduleSessionUIUpdate(options.deferUIDelay ?? 120);
          }
        }
      }
    } catch (err) {
      console.warn('StudyArk: SQLite sync error:', err);
    }
  }

  function completeSession() {
    if (resetVisualActive) return;

    const targetDuration = Math.max(
      60,
      Number(state.activeTaskTargetSeconds || state.timer.targetSeconds) || DEFAULT_TIMER_SECONDS
    );
    const remainingBefore = Math.max(0, Number(state.timer.remainingSeconds) || 0);
    // The target can be adjusted mid-session, so count when the timer actually
    // reached zero instead of assuming the original presentation duration.
    const elapsedSeconds = Math.max(0, targetDuration - remainingBefore);

    // Strict 1-minute rule: a completed session logs actual studied time, and
    // anything under 60 seconds is discarded instead of being rounded up.
    const minutesCompleted = elapsedSeconds >= 60
      ? Math.max(1, Math.round(elapsedSeconds / 60))
      : 0;

    // Natural completion keeps the finished duration as the next idle target.
    const resetDuration = Math.max(
      60,
      Math.min(MAX_TIMER_SECONDS, Math.round(targetDuration))
    );

    state.timer.remainingSeconds = 0;
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    playChime('complete');

    const prevLevel = getLevelInfo(state.xp).level;
    const taskName = state.activeTaskName || 'Focus Session';
    const now = Date.now();
    const sessionStartTime = state.activeTaskStartTime || (state.activeSessionIntervals && state.activeSessionIntervals[0]?.start) || (now - minutesCompleted * 60000);
    const sessionEndTime = now;

    const finalizedIntervals = (state.activeSessionIntervals || []).slice();
    if (finalizedIntervals.length > 0) {
      const last = finalizedIntervals[finalizedIntervals.length - 1];
      if (last.end === null) {
        last.end = sessionEndTime;
      }
    } else if (minutesCompleted > 0) {
      finalizedIntervals.push({
        type: 'focus',
        start: sessionStartTime,
        end: sessionEndTime,
        duration: minutesCompleted * 60
      });
    }

    let totalBreakSecs = 0;
    finalizedIntervals.forEach(int => {
      if (int.start && int.end) {
        int.duration = Math.max(0, Math.round((int.end - int.start) / 1000));
        if (int.type === 'break') {
          totalBreakSecs += int.duration;
        }
      }
    });
    const breakMinutes = Math.round(totalBreakSecs / 60);

    // Send the session to the server immediately, but keep all heavy local
    // persistence for after the zero-hold + refill animation.
    if (minutesCompleted > 0) {
      logSession(minutesCompleted, taskName, {
        render: false,
        persist: false,
        startTime: sessionStartTime,
        endTime: sessionEndTime,
        sessionStartMs: sessionStartTime,
        sessionEndMs: sessionEndTime,
        breakMinutes: breakMinutes,
        timeline: finalizedIntervals,
        deferUIDelay: false,
        unpaused: !activeSessionHasBeenPaused
      });
    }

    beginTimerResetReturn(resetDuration, {
      zeroHoldMs: 460,
      returnMs: 520,
      onCommit: () => {
        const newLevelInfo = getLevelInfo(state.xp);

        if (minutesCompleted > 0 && newLevelInfo.level > prevLevel) {
          setTimeout(() => {
            spawnFlyingPill(`🎉 Lv. ${newLevelInfo.level}!`, { extraClass: 'pill-xp', lane: 'center' });
            showToast(`Level Up! Reached Level ${newLevelInfo.level}: ${newLevelInfo.title}! ✨`);
          }, 550);
        }

        state.activeTaskName = null;
        state.activeTaskStartTime = null;
        state.activeTaskTargetSeconds = null;
        state.activeSessionIntervals = [];

        state.timer.targetSeconds = resetDuration;
        state.timer.remainingSeconds = resetDuration;
        state.timer.anchorRemainingSeconds = resetDuration;
        state.timer.anchorServerTime = null;
        state.timer.lastTickTime = null;
        state.timer.status = 'idle';

        // Timer UI classes/title refresh now; the rim/digits are owned by the
        // reset refill animation until it completes.
        renderTimer();
        syncTimerAction('complete', { target_seconds: resetDuration });
      },
      onComplete: () => {
        if (minutesCompleted > 0) {
          const streakBonus = Math.max(0, state.streak || 0);
          spawnRewardPills(minutesCompleted, minutesCompleted, streakBonus);
          scheduleSessionUIUpdate(140);
        }
      }
    });
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
          updateDigitalDisplay(state.timer.remainingSeconds, false, { rapid: true });
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
      if (resetVisualActive) return;
      e.preventDefault();
      e.stopPropagation();

      // If in an active task session, dragging bead or rim is locked!
      if (state.activeTaskName || state.timer.status !== 'idle') {
        return;
      }

      // A preset glide must yield cleanly to manual bead adjustments
      cancelTimerPresetAnimation();
      if (homeIntroDialActive) finishHomeIntroDial();

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
      if (resetVisualActive) return;
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
  // CENTER TIMER PAD: TAP TO START/PAUSE, 1.2-SECOND HOLD TO RESET
  // =========================================================================
  function initCenterPadInteraction() {
    const pad = document.getElementById('timer-center-pad');
    if (!pad) return;

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

      // Natural completion can start the reset while the pad is still held.
      // Abandon the manual drain so the session cannot be logged twice.
      if (resetVisualActive) {
        isDraining = false;
        isCenterPadHolding = false;
        holdCompleted = true;
        document.body.classList.remove('is-holding');
        pad.classList.remove('holding');
        matrixStreamEngine?.setHolding(false);
        return;
      }

      const elapsed = now - drainStartTime;
      const progress = Math.min(1, elapsed / HOLD_DRAIN_MS);

      // Accelerate background matrix stream and elongate boxes as hold progresses!
      matrixStreamEngine?.setHolding(true, progress);

      // Ring and digits share one frame-locked visual value. The value sweeps
      // quickly through large durations, then decelerates into a one-by-one
      // 30 -> 0 countdown so the display never looks like it is skipping.
      const visualSeconds = getHoldVisualSeconds(holdStartRemaining, elapsed);
      updateTimerRing(visualSeconds);
      updateDigitalDisplay(visualSeconds, false, { rapid: true });

      if (elapsed >= HOLD_DRAIN_MS) {
        // Complete 1.2-second hold: freeze on a real 0:00 frame first, then
        // commit/persist after the zero-hold instead of blocking that frame.
        holdCompleted = true;
        isDraining = false;
        isCenterPadHolding = false;
        document.body.classList.remove('is-holding');
        pad.classList.remove('holding');
        matrixStreamEngine?.setHolding(false);
        matrixStreamEngine?.setTimerStatus('idle');

        updateTimerRing(0);
        updateDigitalDisplay(0, true);

        if (navigator.vibrate) navigator.vibrate([40, 50, 40]);

        const now = Date.now();
        const taskName = state.activeTaskName || 'Focus Session';
        const targetSecs = state.activeTaskTargetSeconds || state.timer.targetSeconds || DEFAULT_TIMER_SECONDS;
        const elapsedStudy = Math.max(0, targetSecs - holdStartRemaining);
        const minutesLogged = elapsedStudy >= 60 ? Math.round(elapsedStudy / 60) : 0;
        const sessionStartTime = state.activeTaskStartTime || (state.activeSessionIntervals && state.activeSessionIntervals[0]?.start) || (now - minutesLogged * 60000);
        const sessionEndTime = now;
        const hadActiveTask = Boolean(state.activeTaskName);

        const finalizedIntervals = (state.activeSessionIntervals || []).slice();
        if (finalizedIntervals.length > 0) {
          const last = finalizedIntervals[finalizedIntervals.length - 1];
          if (last.end === null) {
            last.end = sessionEndTime;
          }
        } else if (minutesLogged > 0) {
          finalizedIntervals.push({
            type: 'focus',
            start: sessionStartTime,
            end: sessionEndTime,
            duration: minutesLogged * 60
          });
        }

        let totalBreakSecs = 0;
        finalizedIntervals.forEach(int => {
          if (int.start && int.end) {
            int.duration = Math.max(0, Math.round((int.end - int.start) / 1000));
            if (int.type === 'break') {
              totalBreakSecs += int.duration;
            }
          }
        });
        const breakMinutes = Math.round(totalBreakSecs / 60);

        beginTimerResetReturn(DEFAULT_TIMER_SECONDS, {
          zeroHoldMs: RESET_ZERO_HOLD_MS,
          returnMs: RESET_RETURN_MS,
          onCommit: () => {
            // Strict 1-minute rule: discard session if < 60s, save if >= 60s.
            if (minutesLogged > 0) {
              logSession(minutesLogged, taskName, {
                render: false,
                persist: false,
                startTime: sessionStartTime,
                endTime: sessionEndTime,
                sessionStartMs: sessionStartTime,
                sessionEndMs: sessionEndTime,
                breakMinutes: breakMinutes,
                timeline: finalizedIntervals,
                deferUIDelay: false,
                unpaused: !activeSessionHasBeenPaused
              });
            }

            if (timerInterval) {
              clearInterval(timerInterval);
              timerInterval = null;
            }
            state.activeTaskName = null;
            state.activeTaskStartTime = null;
            state.activeTaskTargetSeconds = null;
            state.activeSessionIntervals = [];

            // Reset timer back to fixed 1:30:00 default in stopped/paused state
            state.timer.targetSeconds = DEFAULT_TIMER_SECONDS;
            state.timer.remainingSeconds = DEFAULT_TIMER_SECONDS;
            state.timer.anchorRemainingSeconds = DEFAULT_TIMER_SECONDS;
            state.timer.anchorServerTime = null;
            state.timer.lastTickTime = null;
            state.timer.status = 'idle';

            // UI classes/theme refresh now; the rim/digits are owned by the
            // reset refill animation until it finishes.
            renderTimer();
            syncTimerAction('reset', { target_seconds: DEFAULT_TIMER_SECONDS });
            playChime('reset');
          },
          onComplete: () => {
            if (minutesLogged > 0) {
              const streakBonus = Math.max(0, state.streak || 0);
              spawnRewardPills(minutesLogged, minutesLogged, streakBonus);
              scheduleSessionUIUpdate(140);
            } else if (hadActiveTask) {
              spawnFlyingPill('Session Ended');
            } else {
              spawnFlyingPill('Timer Reset');
            }
          }
        });
        return;
      }

      holdRaf = requestAnimationFrame(stepHold);
    }

    function startHoldDrain() {
      if (!isPointerDown || resetVisualActive) return;
      isDraining = true;
      drainStartTime = performance.now();
      document.body.classList.add('is-holding');
      pad.classList.add('holding');
      matrixStreamEngine?.setHolding(true, 0.08);

      cancelAnimationFrame(holdRaf);
      holdRaf = requestAnimationFrame(stepHold);
    }

    pad.addEventListener('pointerdown', (e) => {
      if (e.button && e.button !== 0) return; // Only primary mouse button or touch
      if (resetVisualActive) return;
      cancelTimerPresetAnimation();
      if (homeIntroDialActive) finishHomeIntroDial();
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
      matrixStreamEngine?.setHolding(false);

      if (holdCompleted) {
        return;
      }

      const pressDuration = performance.now() - pointerDownTime;
      if (!wasDraining && pressDuration < 450) {
        // Clean quick click/tap: toggle Play / Pause / New Task!
        handlePlayPauseAction();
      } else if (wasDraining) {
        // Held partially (>220ms) but released before 1.2s: restore display cleanly
        if (state.timer.status === 'running') {
          state.timer.remainingSeconds = recalculateRemainingSeconds();
          state.timer.lastTickTime = Date.now();
        }
        renderTimerDisplay(state.timer.remainingSeconds, { duration: 340 });
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
    if (resetVisualActive) return;
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

  // iOS keeps fixed elements anchored to the layout viewport even while the
  // keyboard shrinks the visual viewport. Track the visible viewport so the
  // prompt stays centered in the space above the keyboard at all times.
  let taskPromptViewportRaf = null;

  function syncTaskPromptViewport() {
    const modal = document.getElementById('task-prompt-modal');
    if (!modal || modal.classList.contains('hidden')) return;

    const vv = window.visualViewport;
    if (!vv) {
      modal.style.removeProperty('--task-prompt-vv-top');
      modal.style.removeProperty('--task-prompt-vv-height');
      return;
    }

    modal.style.setProperty('--task-prompt-vv-top', `${Math.max(0, Math.round(vv.offsetTop))}px`);
    modal.style.setProperty('--task-prompt-vv-height', `${Math.max(1, Math.round(vv.height))}px`);
  }

  function scheduleTaskPromptViewportSync() {
    if (taskPromptViewportRaf !== null) return;
    taskPromptViewportRaf = requestAnimationFrame(() => {
      taskPromptViewportRaf = null;
      syncTaskPromptViewport();
    });
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
    syncTaskPromptViewport();

    // Automatically trigger on-screen mobile keyboard by focusing synchronously within user gesture
    if (input) {
      input.focus();
      try {
        const len = input.value.length;
        input.setSelectionRange(len, len);
      } catch (_) {}
      requestAnimationFrame(() => {
        input.focus();
        syncTaskPromptViewport();
      });
      // The real input now owns focus; let the iOS keyboard primer go.
      dismissPendingPromptKeyboard(false);
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
    state.activeSessionIntervals = [{ type: 'focus', start: state.activeTaskStartTime, end: null }];
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

  // Color results are immutable and reused across ring-buffer repaints.
  const HEATMAP_COLOR_CACHE_LIMIT = 2048;
  const heatmapColorCache = new Map();

  // Mathematical smooth-step interpolation yielding a distinct, flexible shade per minute
  function getHeatmapCellColor(minutes, customPeak = 240) {
    const peakMins = Math.max(60, customPeak || DEFAULT_PEAK_MINUTES);
    const safeMinutes = Math.max(0, Math.floor(Number(minutes) || 0));
    const cacheKey = `${peakMins}:${safeMinutes}`;
    const cached = heatmapColorCache.get(cacheKey);
    if (cached) return cached;

    if (safeMinutes <= 0) {
      const empty = { color: 'rgb(18, 24, 21)', level: 0, isPeak: false };
      heatmapColorCache.set(cacheKey, empty);
      return empty;
    }

    // Scale minutes proportionally to the 240-minute reference stops
    const scaledMins = Math.min(240, (safeMinutes / peakMins) * 240);

    if (scaledMins >= 240 || safeMinutes >= peakMins) {
      const peak = HEATMAP_COLOR_STOPS[HEATMAP_COLOR_STOPS.length - 1];
      const result = {
        color: `rgb(${peak.r}, ${peak.g}, ${peak.b})`,
        level: 9,
        isPeak: true
      };
      if (heatmapColorCache.size >= HEATMAP_COLOR_CACHE_LIMIT) heatmapColorCache.clear();
      heatmapColorCache.set(cacheKey, result);
      return result;
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
        const result = {
          color: `rgb(${r}, ${g}, ${b})`,
          level: level,
          isPeak: scaledMins >= 225
        };
        if (heatmapColorCache.size >= HEATMAP_COLOR_CACHE_LIMIT) heatmapColorCache.clear();
        heatmapColorCache.set(cacheKey, result);
        return result;
      }
    }

    const fallback = { color: 'rgb(18, 24, 21)', level: 0, isPeak: false };
    heatmapColorCache.set(cacheKey, fallback);
    return fallback;
  }

  // =========================================================================
  // HEATMAP VIRTUALIZER — O(VIEWPORT) DOM, O(1) WITH HISTORY LENGTH
  // One fixed ring of month blocks is positioned by a prefix-sum month index.
  // Months unroll their cells with the original CSS cascade as they enter the
  // viewport, while the DOM stays bounded to the ring.
  // =========================================================================
  const HEATMAP_RING_SIZE = 18;
  const HEATMAP_REVEAL_MARGIN = 30;

  const heatmapState = {
    months: [],
    contentWidth: 0,
    rangeKey: '',
    metricsKey: '',
    blockPool: [],
    activeBlocks: new Map(),
    firstVisible: 0,
    start: -1,
    padLeft: 48,
    scrollRaf: 0
  };

  function getHeatmapMetrics() {
    const styles = getComputedStyle(document.documentElement);
    const cellSize = parseFloat(styles.getPropertyValue('--hm-cell-size')) || 13.5;
    const colGap = parseFloat(styles.getPropertyValue('--hm-col-gap')) || 3.5;
    const monthGap = parseFloat(styles.getPropertyValue('--hm-month-gap')) || 12;
    const yearGap = parseFloat(styles.getPropertyValue('--hm-year-gap')) || 32;
    return {
      cellSize,
      colGap,
      monthGap,
      yearGap,
      step: cellSize + colGap
    };
  }

  function computeHeatmapRange() {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();

    // Earliest year defaults to current year
    let earliestYear = currentYear;

    // 1. Anchor to user's registration/opening year so their timeline is preserved even with 0 study sessions
    if (state.userCreatedAt) {
      const createdYear = parseInt(String(state.userCreatedAt).slice(0, 4), 10);
      if (!isNaN(createdYear) && createdYear < earliestYear) {
        earliestYear = createdYear;
      }
    }

    // 2. Expand backwards to any older study sessions (supports infinite years of studying)
    const activity = state.dayActivity;
    if (activity) {
      const keys = Object.keys(activity);
      for (let i = 0; i < keys.length; i++) {
        const y = parseInt(keys[i].slice(0, 4), 10);
        if (!isNaN(y) && y < earliestYear) earliestYear = y;
      }
    }

    return { currentYear, currentMonth, earliestYear };
  }

  function buildHeatmapMonths(metrics, range) {
    const months = [];
    let x = 0;
    let previousYear = null;

    for (let year = range.earliestYear; year <= range.currentYear; year++) {
      const endMonth = (year === range.currentYear) ? range.currentMonth : 11;
      for (let month = 0; month <= endMonth; month++) {
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const firstDay = (new Date(year, month, 1).getDay() + 6) % 7;
        const cols = Math.ceil((firstDay + daysInMonth) / 7);
        const width = cols * metrics.step - metrics.colGap;

        if (months.length > 0) {
          x += (year !== previousYear) ? metrics.yearGap : metrics.monthGap;
          // The first month of each year is never interlocked. Later months
          // tuck their leading empty week into the previous month, exactly
          // like the original flex layout did with a negative margin.
          if (month !== 0 && firstDay > 0) x -= metrics.step;
        }

        months.push({ year, month, firstDay, daysInMonth, cols, width, x });
        x += width;
        previousYear = year;
      }
    }

    const last = months[months.length - 1];
    return {
      months,
      contentWidth: last ? last.x + last.width : 0
    };
  }

  function updateHeatmapYearLabel(year) {
    const badge = document.getElementById('heatmap-year-badge');
    if (badge && badge.textContent !== String(year)) {
      badge.textContent = String(year);
    }
    if (state.viewedYear !== year) state.viewedYear = year;
  }

  function resetHeatmapCell(cell) {
    if (cell.dataset.date) cell.removeAttribute('data-date');
    if (cell.dataset.minutes) cell.removeAttribute('data-minutes');
    if (cell.className !== 'cell cell-spacer') cell.className = 'cell cell-spacer';
    if (cell.style.backgroundColor) cell.style.backgroundColor = '';
    cell._heatColor = '';
  }

  function paintHeatmapCell(cell, dateStr, minutes, peakMins, todayStr) {
    const colorInfo = getHeatmapCellColor(minutes, peakMins);
    let cls = `cell cell-lvl-${colorInfo.level}`;
    if (colorInfo.isPeak) cls += ' cell-peak';
    if (dateStr === todayStr) cls += ' is-today';

    if (cell.className !== cls) cell.className = cls;
    if (cell._heatColor !== colorInfo.color) {
      cell.style.backgroundColor = colorInfo.color;
      cell._heatColor = colorInfo.color;
    }
    if (cell.dataset.date !== dateStr) cell.dataset.date = dateStr;
    const minutesStr = String(minutes);
    if (cell.dataset.minutes !== minutesStr) cell.dataset.minutes = minutesStr;
  }

  function createHeatmapBlock() {
    const el = document.createElement('div');
    el.className = 'month-block';
    el.style.display = 'none';

    const label = document.createElement('div');
    label.className = 'month-label';
    el.appendChild(label);

    const weeks = document.createElement('div');
    weeks.className = 'month-weeks';
    const cells = [];

    for (let c = 0; c < 6; c++) {
      const col = document.createElement('div');
      col.className = 'week-col';
      col.dataset.col = String(c);
      for (let r = 0; r < 7; r++) {
        const cell = document.createElement('div');
        cell.className = 'cell cell-spacer';
        cell.dataset.hmRow = String(r);
        col.appendChild(cell);
        cells.push(cell);
      }
      weeks.appendChild(col);
    }

    el.appendChild(weeks);
    return { el, label, weeks, cells, index: -1, revealed: false };
  }

  function setHeatmapBlockRevealed(block, revealed) {
    if (!block || block.revealed === revealed) return;
    block.revealed = revealed;
    const cols = block.weeks.children;
    for (let i = 0; i < cols.length; i++) {
      cols[i].classList.toggle('is-revealed', revealed);
    }
  }

  function populateHeatmapBlock(block, index) {
    const descriptor = heatmapState.months[index];
    if (!descriptor) return;

    // Reused blocks go back to their pre-reveal state before new cells are
    // painted, so the CSS cascade replays as the month enters the viewport.
    setHeatmapBlockRevealed(block, false);

    const peakMins = state.heatmapPeakMinutes || DEFAULT_PEAK_MINUTES;
    const todayStr = getLocalDateString();

    block.index = index;
    block.el.dataset.index = String(index);
    block.el.dataset.year = String(descriptor.year);
    block.el.dataset.month = String(descriptor.month);
    block.el.dataset.cols = String(descriptor.cols);
    block.el.style.left = `${descriptor.x}px`;
    block.el.style.setProperty('--month-cols', String(descriptor.cols));
    block.el.style.display = '';
    block.label.textContent = SHORT_MONTHS[descriptor.month];

    const cols = block.weeks.children;
    for (let c = 0; c < 6; c++) {
      const col = cols[c];
      const isVisible = c < descriptor.cols;
      col.classList.toggle('is-hidden', !isVisible);

      for (let r = 0; r < 7; r++) {
        const cell = block.cells[c * 7 + r];
        if (!isVisible) {
          resetHeatmapCell(cell);
          continue;
        }

        const slot = c * 7 + r;
        const dayNum = slot - descriptor.firstDay + 1;
        if (slot < descriptor.firstDay || dayNum > descriptor.daysInMonth) {
          resetHeatmapCell(cell);
          continue;
        }

        const monthStr = String(descriptor.month + 1).padStart(2, '0');
        const dateStr = `${descriptor.year}-${monthStr}-${String(dayNum).padStart(2, '0')}`;
        const minutes = (state.dayActivity && state.dayActivity[dateStr]) || 0;
        paintHeatmapCell(cell, dateStr, minutes, peakMins, todayStr);
      }
    }
  }

  function updateHeatmapWindow(force = false) {
    const scrollArea = document.getElementById('heatmap-scroll-area');
    if (!scrollArea || heatmapState.months.length === 0) return;

    const months = heatmapState.months;
    const relativeScroll = Math.max(0, scrollArea.scrollLeft - heatmapState.padLeft);

    // Binary search: last month whose x starts at or before the viewport.
    let lo = 0;
    let hi = months.length - 1;
    let firstVisible = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (months[mid].x <= relativeScroll) {
        firstVisible = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    heatmapState.firstVisible = firstVisible;
    updateHeatmapYearLabel(months[firstVisible].year);

    const monthCount = months.length;
    const ringSize = Math.min(HEATMAP_RING_SIZE, monthCount);
    const start = Math.max(0, Math.min(monthCount - ringSize, firstVisible - 4));

    if (!force && start === heatmapState.start) return;

    heatmapState.start = start;
    const end = start + ringSize;
    const required = new Set();
    for (let i = start; i < end; i++) required.add(i);

    const reusable = new Map();
    heatmapState.activeBlocks.forEach((block, index) => reusable.set(index, block));

    const free = [];
    for (let i = 0; i < heatmapState.blockPool.length; i++) {
      const block = heatmapState.blockPool[i];
      if (!required.has(block.index)) free.push(block);
    }

    const nextActive = new Map();
    for (let i = start; i < end; i++) {
      let block = reusable.get(i);
      if (!block) {
        block = free.pop();
        if (!block) break;
        populateHeatmapBlock(block, i);
      }
      nextActive.set(i, block);
    }

    const visibleBlocks = new Set(nextActive.values());
    for (let i = 0; i < heatmapState.blockPool.length; i++) {
      const block = heatmapState.blockPool[i];
      if (!visibleBlocks.has(block)) {
        block.index = -1;
        block.el.dataset.index = '-1';
        if (block.el.style.display !== 'none') block.el.style.display = 'none';
      }
    }

    heatmapState.activeBlocks = nextActive;
    updateHeatmapRevealState();
  }

  function updateHeatmapCells(targetDate = null) {
    const trackEl = document.getElementById('heatmap-track');
    if (!trackEl) return;

    const peakMins = state.heatmapPeakMinutes || DEFAULT_PEAK_MINUTES;
    const todayStr = getLocalDateString();

    if (typeof targetDate === 'string' && targetDate) {
      const cell = trackEl.querySelector(`.cell[data-date="${targetDate}"]`);
      if (cell) {
        const minutes = (state.dayActivity && state.dayActivity[targetDate]) || 0;
        paintHeatmapCell(cell, targetDate, minutes, peakMins, todayStr);
      }
      return;
    }

    // Only the fixed ring is touched. This is O(viewport), never O(history).
    heatmapState.activeBlocks.forEach((block) => {
      for (let i = 0; i < block.cells.length; i++) {
        const cell = block.cells[i];
        const dateStr = cell.dataset.date;
        if (!dateStr) continue;
        const minutes = (state.dayActivity && state.dayActivity[dateStr]) || 0;
        paintHeatmapCell(cell, dateStr, minutes, peakMins, todayStr);
      }
    });
  }

  function updateHeatmapRevealState() {
    const scrollArea = document.getElementById('heatmap-scroll-area');
    if (!scrollArea || heatmapState.months.length === 0) return;

    const relativeScroll = Math.max(0, scrollArea.scrollLeft - heatmapState.padLeft);
    const viewStart = relativeScroll - HEATMAP_REVEAL_MARGIN;
    const viewEnd = relativeScroll + scrollArea.clientWidth + HEATMAP_REVEAL_MARGIN;

    heatmapState.activeBlocks.forEach((block, index) => {
      const descriptor = heatmapState.months[index];
      if (!descriptor) return;
      const isVisible = descriptor.x + descriptor.width > viewStart && descriptor.x < viewEnd;
      setHeatmapBlockRevealed(block, isVisible);
    });
  }

  function handleHeatmapScroll() {
    if (!heatmapState.scrollRaf) {
      heatmapState.scrollRaf = requestAnimationFrame(() => {
        heatmapState.scrollRaf = 0;
        updateHeatmapWindow();
        updateHeatmapRevealState();
      });
    }
  }

  function renderHeatmap(forceRebuild = false) {
    const trackEl = document.getElementById('heatmap-track');
    const scrollArea = document.getElementById('heatmap-scroll-area');
    if (!trackEl || !scrollArea) return;

    const range = computeHeatmapRange();
    const metrics = getHeatmapMetrics();
    const rangeKey = `${range.earliestYear}:${range.currentYear}:${range.currentMonth}`;
    const metricsKey = `${metrics.cellSize}:${metrics.colGap}:${metrics.monthGap}:${metrics.yearGap}`;

    if (!forceRebuild &&
        trackEl.querySelector('.heatmap-virtual-content') &&
        rangeKey === heatmapState.rangeKey &&
        metricsKey === heatmapState.metricsKey) {
      // Data changed but the calendar range did not: repaint only the visible ring.
      updateHeatmapCells();
      updateHeatmapWindow();
      updateHeatmapRevealState();
      return;
    }

    if (heatmapState.scrollRaf) {
      cancelAnimationFrame(heatmapState.scrollRaf);
      heatmapState.scrollRaf = 0;
    }
    heatmapState.rangeKey = rangeKey;
    heatmapState.metricsKey = metricsKey;

    const built = buildHeatmapMonths(metrics, range);
    heatmapState.months = built.months;
    heatmapState.contentWidth = built.contentWidth;
    heatmapState.activeBlocks.clear();
    heatmapState.start = -1;

    trackEl.innerHTML = '';
    trackEl.style.width = `${heatmapState.contentWidth}px`;

    const contentEl = document.createElement('div');
    contentEl.className = 'heatmap-virtual-content';
    trackEl.appendChild(contentEl);

    // Static snap anchors for every month. They remain at fixed calendar
    // positions while the render ring recycles, keeping mandatory snap stable.
    const snapFragment = document.createDocumentFragment();
    for (let i = 0; i < built.months.length; i++) {
      const descriptor = built.months[i];
      const snapPoint = document.createElement('div');
      snapPoint.className = 'heatmap-snap-point';
      snapPoint.style.left = `${descriptor.x}px`;
      snapPoint.style.width = `${descriptor.width}px`;
      snapFragment.appendChild(snapPoint);
    }
    contentEl.appendChild(snapFragment);

    // A fixed ring: 18 months is roughly twice the visible width. The pool
    // never grows with history, and cells are reused in place.
    heatmapState.blockPool = [];
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < HEATMAP_RING_SIZE; i++) {
      const block = createHeatmapBlock();
      heatmapState.blockPool.push(block);
      fragment.appendChild(block.el);
    }
    contentEl.appendChild(fragment);

    heatmapState.padLeft = parseFloat(getComputedStyle(trackEl).paddingLeft) || 48;

    // Place the window at the newest month immediately; no async observer wait.
    scrollHeatmapToEnd(false);
    updateHeatmapWindow(true);
    updateHeatmapRevealState();
    setupHeatmapInteraction();
  }

  function scrollHeatmapToEnd(smooth = false) {
    const scrollArea = document.getElementById('heatmap-scroll-area');
    if (!scrollArea) return;

    // Re-read the resolved safe-area padding after viewport/orientation changes.
    const trackEl = document.getElementById('heatmap-track');
    if (trackEl) {
      const resolvedPadLeft = parseFloat(getComputedStyle(trackEl).paddingLeft);
      if (!isNaN(resolvedPadLeft)) heatmapState.padLeft = resolvedPadLeft;
    }

    const maxScroll = Math.max(0, scrollArea.scrollWidth - scrollArea.clientWidth);

    if (smooth) {
      scrollArea.scrollTo({ left: maxScroll, behavior: 'smooth' });
      return;
    }

    scrollArea.scrollLeft = maxScroll;
    updateHeatmapWindow();
    // If scrollLeft was already at the end, no scroll event is dispatched.
    updateHeatmapRevealState();
  }

  let heatmapInteractionInitialized = false;
  function setupHeatmapInteraction() {
    if (heatmapInteractionInitialized) return;
    heatmapInteractionInitialized = true;

    const scrollArea = document.getElementById('heatmap-scroll-area');
    if (!scrollArea) return;

    const trackEl = document.getElementById('heatmap-track');
    if (trackEl) {
      trackEl.addEventListener('click', (e) => {
        const cell = e.target.closest('.cell[data-date]');
        if (cell && cell.dataset.date) {
          handleCellLeave();
          openDayDialog(cell.dataset.date);
        }
      });
      trackEl.addEventListener('mouseover', (e) => {
        const cell = e.target.closest('.cell[data-date]');
        if (cell && cell.dataset.date) {
          handleCellHover({ currentTarget: cell });
        }
      });
      trackEl.addEventListener('mouseout', (e) => {
        const cell = e.target.closest('.cell[data-date]');
        if (cell) {
          handleCellLeave();
        }
      });
    }

    scrollArea.addEventListener('scroll', handleHeatmapScroll, { passive: true });

    // Coalesce wheel input into one scroll write per frame. A wheel event can
    // fire much faster than the display refresh rate; calling scrollBy() for
    // each one forces unnecessary style/scroll work.
    let wheelDelta = 0;
    let wheelRaf = 0;
    scrollArea.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? scrollArea.clientHeight : 1);
      wheelDelta += e.deltaY * unit * 1.5;
      if (!wheelRaf) {
        wheelRaf = requestAnimationFrame(() => {
          wheelRaf = 0;
          if (!wheelDelta) return;
          scrollArea.scrollLeft += wheelDelta;
          wheelDelta = 0;
        });
      }
    }, { passive: false });

    // Drag-to-scroll, also limited to one write per frame.
    let isDragging = false;
    let startX = 0;
    let startScroll = 0;
    let dragTarget = 0;
    let dragRaf = 0;

    scrollArea.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      startX = e.pageX;
      startScroll = scrollArea.scrollLeft;
      dragTarget = startScroll;
      // Free the drag from mandatory snapping; it snaps on release.
      scrollArea.style.scrollSnapType = 'none';
      scrollArea.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      e.preventDefault();
      dragTarget = startScroll - (e.pageX - startX) * 1.2;
      if (!dragRaf) {
        dragRaf = requestAnimationFrame(() => {
          dragRaf = 0;
          scrollArea.scrollLeft = dragTarget;
        });
      }
    });

    window.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      if (dragRaf) {
        cancelAnimationFrame(dragRaf);
        dragRaf = 0;
        scrollArea.scrollLeft = dragTarget;
      }
      scrollArea.style.scrollSnapType = 'x mandatory';
      scrollArea.style.cursor = '';
      document.body.style.userSelect = '';
    });
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
      requestAnimationFrame(() => {
        scrollHeatmapToEnd(false);
      });
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
      const xpReq = Math.max(300, Math.round((300 + 10 * (lvl - 1) + 0.045 * Math.pow(lvl, 2) + 0.00003 * Math.pow(lvl, 3)) / 5) * 5);
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

    updateLiveXpStat();

    if (settingTotalFocusEl) {
      settingTotalFocusEl.textContent = formatHoursMinutes(state.totalFocusSeconds);
    }

    const totalFocusStatEl = document.getElementById('stat-total-focus');
    if (totalFocusStatEl) {
      totalFocusStatEl.textContent = formatHoursMinutes(state.totalFocusSeconds);
    }

    updateTodayLiveStat();
    adjustStatFontFit();

    const levelsDlg = document.getElementById('levels-dialog');
    if (levelsDlg && levelsDlg.open) {
      updateLevelsDialogLiveMetrics();
    }

    const historyDlg = document.getElementById('sessions-history-dialog');
    if (historyDlg && historyDlg.open) {
      // Only refresh the lightweight summary pills here. Rebuilding the whole
      // virtualized feed on every stats render used to replay every card's
      // entrance animation (delete flows trigger renderStats multiple times).
      updateHistoryDialogSummary();
    }
  }

  // =========================================================================
  // DAY DETAIL MODAL DIALOG (TODAY & PAST CELL CHRONICLE)
  // =========================================================================
  let currentDialogDate = null;

  function ensureSessionIndex() {
    if (!sessionDataIndex.dirty) return;

    const sessions = state.sessions || [];
    const byDate = sessionDataIndex.byDate;
    byDate.clear();

    const todayStr = getLocalDateString();
    const len = sessions.length;

    for (let i = 0; i < len; i++) {
      const s = sessions[i];
      let ts = s.timestamp ? Number(s.timestamp) : 0;
      let d = s.date;

      if (!d || d === 'Unknown') {
        if (ts > 0) {
          const dt = new Date(ts);
          if (!isNaN(dt.getTime())) {
            d = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
          }
        }
      }
      if (!d) d = todayStr;
      s.date = d;
      if (!s._ts) {
        s._ts = ts > 0 ? ts : (s.date ? new Date(s.date).getTime() : 0);
      }

      let list = byDate.get(d);
      if (!list) {
        list = [];
        byDate.set(d, list);
      }
      list.push(s);
    }

    sessionDataIndex.dirty = false;
  }

  function formatDayDateHeader(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return 'Unknown Date';
    if (sessionDataIndex.dateHeaderCache.has(dateStr)) {
      return sessionDataIndex.dateHeaderCache.get(dateStr);
    }
    try {
      const parts = dateStr.split('-');
      if (parts.length < 3) return dateStr;
      const y = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10) - 1;
      const d = parseInt(parts[2], 10);
      if (isNaN(y) || isNaN(m) || isNaN(d)) return dateStr;
      const dateObj = new Date(y, m, d);
      if (isNaN(dateObj.getTime())) return dateStr;
      const formatted = dateObj.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      sessionDataIndex.dateHeaderCache.set(dateStr, formatted);
      return formatted;
    } catch (_) {
      return dateStr;
    }
  }

  function getDayDataFromClient(dateStr) {
    // 1. Check in-memory cache first
    if (dayDetailsCache.has(dateStr)) {
      return dayDetailsCache.get(dateStr);
    }

    ensureSessionIndex();

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

    // 3. Fast O(1) indexed lookup from pre-built byDate Map
    const matching = sessionDataIndex.byDate.get(dateStr) || [];
    let matchingMins = 0;
    for (let i = 0; i < matching.length; i++) {
      matchingMins += (matching[i].durationMinutes || matching[i].duration_minutes || 0);
    }

    // If the sum of durations in state.sessions matches known dayActivity minutes, we have all records!
    if (matchingMins >= activityMins && matching.length > 0) {
      const totalSess = matching.length;
      const avgMins = Math.round(matchingMins / totalSess);
      const hrs = Math.floor(matchingMins / 60);
      const mins = matchingMins % 60;
      const formattedTotal = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

      const sortedMatching = matching.slice().sort((a, b) => (b._ts || b.timestamp || 0) - (a._ts || a.timestamp || 0));

      const fullData = {
        date: dateStr,
        formattedDate,
        isToday,
        totalMinutes: matchingMins,
        totalTimeFormatted: formattedTotal,
        totalSessions: totalSess,
        avgFocusMinutes: avgMins,
        totalXp: sortedMatching.reduce((acc, s) => acc + (s.xp != null ? s.xp : ((s.durationMinutes || s.duration_minutes || 0) * 10)), 0),
        sessions: sortedMatching.map(s => {
          const duration = s.durationMinutes || s.duration_minutes || 0;
          const sessXp = s.xp != null ? s.xp : (duration * 10);
          const ts = s._ts || s.timestamp || Date.now();
          const endD = new Date(ts);
          const startD = new Date(ts - duration * 60000);
          const timeRange = s.timeRange || `${formatTime(startD)} – ${formatTime(endD)}`;
          let parsedTimeline = s.timeline;
          if (typeof parsedTimeline === 'string') {
            try { parsedTimeline = JSON.parse(parsedTimeline); } catch (_) { parsedTimeline = null; }
          } else if (!parsedTimeline && s.timeline_json) {
            try { parsedTimeline = typeof s.timeline_json === 'string' ? JSON.parse(s.timeline_json) : s.timeline_json; } catch (_) { parsedTimeline = null; }
          }
          return {
            id: s.id,
            subject: s.subject || s.subject_name || 'Focus Session',
            color: s.color || '#10E068',
            durationMinutes: duration,
            duration_minutes: duration,
            dayMinutes: s.dayMinutes != null ? s.dayMinutes : (s.day_minutes != null ? s.day_minutes : duration),
            day_minutes: s.dayMinutes != null ? s.dayMinutes : (s.day_minutes != null ? s.day_minutes : duration),
            timeRange: timeRange,
            timestamp: ts,
            xp: sessXp,
            taskName: s.taskName || s.task_name || '',
            sessionStartMs: s.sessionStartMs || s.session_start_ms || startD.getTime(),
            sessionEndMs: s.sessionEndMs || s.session_end_ms || ts,
            breakMinutes: Number(s.breakMinutes != null ? s.breakMinutes : (s.break_minutes || 0)),
            break_minutes: Number(s.breakMinutes != null ? s.breakMinutes : (s.break_minutes || 0)),
            timeline: parsedTimeline
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
      // Defensive newest-first ordering: older cached/API payloads may arrive
      // in chronological order even though the modal should lead with the
      // most recent session card.
      const orderedSessions = Array.isArray(dayData.sessions)
        ? dayData.sessions.slice().sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
        : [];

      if (orderedSessions.length === 0) {
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
        orderedSessions.forEach(s => {
          if (s && s.id) sessionLookupCache.set(String(s.id), s);
        });
        listEl.innerHTML = orderedSessions.map(s => {
          const taskName = s.taskName || s.task_name || '';
          const taskNote = taskName ? `<span class="day-session-task">"${escapeHtml(taskName)}"</span>` : '';
          const timeRangeStr = s.timeRange ? `<span class="day-session-timerange">${escapeHtml(s.timeRange)}</span>` : '';
          const sep = (taskNote && timeRangeStr) ? '<span class="stat-xp-sep" aria-hidden="true">•</span>' : '';

          return `
          <div class="day-session-card" data-session-id="${escapeHtml(s.id)}" data-date="${escapeHtml(dayData.date)}" data-duration="${s.durationMinutes}" data-xp="${s.xp != null ? s.xp : (s.durationMinutes * 10)}" data-session-start-ms="${s.sessionStartMs || s.session_start_ms || ''}" data-session-end-ms="${s.sessionEndMs || s.session_end_ms || ''}">
            <div class="day-session-left">
              <div class="day-session-timeline">
                <span class="day-session-track-line"></span>
                <span class="day-session-track-node"></span>
              </div>
              <div class="day-session-orb-wrapper">
                <span class="day-session-orb" style="background-color: ${s.color || '#10E068'}; color: ${s.color || '#10E068'};"></span>
              </div>
              <div class="day-session-info">
                <span class="day-session-subject">${escapeHtml(s.subject || 'Focus Session')}</span>
                <div class="day-session-sub-row">
                  ${taskNote}
                  ${sep}
                  ${timeRangeStr}
                </div>
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
              <span class="day-session-xp">+${formatCompactNumber(s.xp != null ? s.xp : (s.durationMinutes * 10))} XP</span>
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
          `;
        }).join('');
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
    if (xpEl) xpEl.textContent = activityMins > 0 ? `+${formatCompactNumber(activityMins * 10)} XP` : '...';
    if (countEl) countEl.textContent = 'Loading...';
    if (listEl) {
      listEl.innerHTML = `
        <div class="day-session-skeleton"></div>
        <div class="day-session-skeleton" style="opacity: 0.6;"></div>
      `;
    }
  }

  function openSessionDetailDialog(sessionId, fallbackSession = null) {
    const dialog = document.getElementById('session-detail-dialog');
    if (!dialog) return;

    // 1. Locate session
    let s = sessionLookupCache.get(String(sessionId));
    if (!s) {
      s = (state.sessions || []).find(item => String(item.id) === String(sessionId));
    }
    if (!s && fallbackSession) {
      s = fallbackSession;
    }
    if (!s) {
      // Check dayDetailsCache
      for (const day of dayDetailsCache.values()) {
        if (day && Array.isArray(day.sessions)) {
          const match = day.sessions.find(item => String(item.id) === String(sessionId));
          if (match) {
            s = match;
            break;
          }
        }
      }
    }
    if (fallbackSession && fallbackSession.timeline && (!s || !s.timeline)) {
      s = Object.assign({}, s || {}, fallbackSession);
    }
    if (s && (!s.timeline || s.timeline.length === 0)) {
      const matchInState = (state.sessions || []).find(item => String(item.id) === String(sessionId));
      if (matchInState && matchInState.timeline && matchInState.timeline.length > 0) {
        s = Object.assign({}, s, {
          timeline: matchInState.timeline,
          breakMinutes: matchInState.breakMinutes != null ? matchInState.breakMinutes : s.breakMinutes
        });
      }
    }
    if (!s) {
      console.warn('StudyArk: Session detail not found for id:', sessionId);
      return;
    }
    sessionLookupCache.set(String(sessionId), s);

    const dur = Number(s.durationMinutes || s.duration_minutes || 0);
    const breakMins = Number(s.breakMinutes != null ? s.breakMinutes : (s.break_minutes || 0));
    const xp = s.xp != null ? s.xp : (dur * 10);
    const subjName = s.subject || s.subject_name || 'Focus Session';
    const subjColor = s.color || '#10E068';
    const dateStr = s.date || getLocalDateString();
    const timeRangeStr = s.timeRange || (s.startTime && s.endTime ? `${s.startTime} – ${s.endTime}` : '');

    const startMs = Number(s.sessionStartMs || s.session_start_ms || (s.timestamp ? (s.timestamp - dur * 60000) : Date.now()));
    const endMs = Number(s.sessionEndMs || s.session_end_ms || (s.timestamp || Date.now()));

    // Elements
    const badgeEl = document.getElementById('session-detail-badge');
    const dateChipEl = document.getElementById('session-detail-date-chip');
    const focusPillEl = document.getElementById('session-pill-focus');
    const breakPillEl = document.getElementById('session-pill-break');
    const pausesPillEl = document.getElementById('session-pill-pauses');
    const xpPillEl = document.getElementById('session-pill-xp');

    const ratioMetaEl = document.getElementById('session-ratio-meta');
    const ratioFocusBarEl = document.getElementById('session-ratio-focus-bar');
    const ratioBreakBarEl = document.getElementById('session-ratio-break-bar');

    const wallSpanEl = document.getElementById('session-graph-wall-span');
    const graphTrackEl = document.getElementById('session-graph-track');
    const graphTooltipEl = document.getElementById('session-graph-tooltip');
    const axisStartEl = document.getElementById('session-axis-start');
    const axisEndEl = document.getElementById('session-axis-end');

    const intervalsCountEl = document.getElementById('session-intervals-count');
    const intervalsListEl = document.getElementById('session-intervals-list');
    const deleteBtn = document.getElementById('btn-delete-session-from-detail');
    const doneBtn = document.getElementById('btn-done-session-detail');
    const closeBtn = document.getElementById('btn-close-session-detail');

    // Header info
    const startD = new Date(startMs);
    const endD = new Date(endMs);
    const startDayStr = getLocalDateString(startD);
    const endDayStr = getLocalDateString(endD);
    const isOvernight = (startDayStr !== endDayStr);

    if (badgeEl) {
      const taskName = s.taskName || s.task_name || '';
      let badgeText = subjName;
      if (taskName && taskName !== subjName && subjName !== 'Focus Session') {
        badgeText = `${subjName} • "${taskName}"`;
      } else if (taskName && subjName === 'Focus Session') {
        badgeText = `"${taskName}"`;
      }
      badgeEl.textContent = badgeText;
      badgeEl.style.color = subjColor;
      badgeEl.style.borderColor = `${subjColor}40`;
      badgeEl.style.backgroundColor = `${subjColor}15`;
    }
    if (dateChipEl) {
      const isToday = (startDayStr === getLocalDateString());
      if (isOvernight) {
        dateChipEl.textContent = `${formatShortDate(startD)} → ${formatShortDate(endD)} (+1d)`;
      } else {
        dateChipEl.textContent = isToday ? 'Today' : startDayStr;
      }
    }

    // Parse timeline
    let timeline = [];
    if (Array.isArray(s.timeline)) {
      timeline = s.timeline;
    } else if (typeof s.timeline === 'string') {
      try { timeline = JSON.parse(s.timeline); } catch (_) { timeline = []; }
    } else if (s.timeline_json) {
      try { timeline = JSON.parse(s.timeline_json); } catch (_) { timeline = []; }
    }

    // Fallback: If no timeline array, synthesize single continuous block
    if (!timeline || timeline.length === 0) {
      timeline = [{
        type: 'focus',
        start: startMs,
        end: endMs,
        duration: dur * 60
      }];
    }

    // Calculate break count and segment durations in exact seconds
    let breaksCount = 0;
    let computedBreakSeconds = 0;
    let computedFocusSeconds = 0;

    timeline.forEach(item => {
      const itemType = item.type || item.state || 'focus';
      item.type = itemType;
      const segStart = Number(item.start || item.start_ms || startMs);
      const segEnd = Number(item.end || item.end_ms || endMs);
      const segDur = Math.max(0, Math.round((segEnd - segStart) / 1000));
      item._calcDuration = (item.duration != null && item.duration > 0) ? item.duration : segDur;
      if (itemType === 'break') {
        breaksCount++;
        computedBreakSeconds += item._calcDuration;
      } else {
        computedFocusSeconds += item._calcDuration;
      }
    });

    if (computedBreakSeconds === 0 && (s.breakMinutes > 0 || s.break_minutes > 0)) {
      computedBreakSeconds = Math.round((s.breakMinutes || s.break_minutes) * 60);
      breaksCount = Math.max(1, breaksCount);
    }

    const activeFocusSec = computedFocusSeconds > 0 ? computedFocusSeconds : (dur * 60);
    const totalActiveSpanSec = activeFocusSec + computedBreakSeconds;
    const wallSpanSec = Math.max(totalActiveSpanSec, Math.round((endMs - startMs) / 1000));

    // Summary pills with precise seconds formatting
    if (focusPillEl) {
      focusPillEl.textContent = formatDetailedDuration(activeFocusSec);
      if (focusPillEl.parentElement) focusPillEl.parentElement.title = `Focus: ${formatDetailedDuration(activeFocusSec)}`;
    }
    if (breakPillEl) {
      breakPillEl.textContent = computedBreakSeconds > 0 ? formatDetailedDuration(computedBreakSeconds) : '0m';
      if (breakPillEl.parentElement) breakPillEl.parentElement.title = `Break: ${computedBreakSeconds > 0 ? formatDetailedDuration(computedBreakSeconds) : '0m'}`;
    }
    if (pausesPillEl) {
      pausesPillEl.textContent = breaksCount;
      if (pausesPillEl.parentElement) pausesPillEl.parentElement.title = `${breaksCount} ${breaksCount === 1 ? 'pause' : 'pauses'} taken`;
    }
    if (xpPillEl) {
      xpPillEl.textContent = `+${formatCompactNumber(xp)} XP`;
      if (xpPillEl.parentElement) xpPillEl.parentElement.title = `XP Earned: +${formatCompactNumber(xp)} XP`;
    }

    // Ratio Bar
    const focusPct = totalActiveSpanSec > 0 ? Math.round((activeFocusSec / totalActiveSpanSec) * 100) : 100;
    const breakPct = 100 - focusPct;
    if (ratioMetaEl) {
      ratioMetaEl.textContent = computedBreakSeconds > 0 ? `${focusPct}% Focus • ${breakPct}% Break` : '100% Unbroken Focus';
    }
    if (ratioFocusBarEl) ratioFocusBarEl.style.width = `${focusPct}%`;
    if (ratioBreakBarEl) ratioBreakBarEl.style.width = `${breakPct}%`;

    // Timeline Graph
    if (wallSpanEl) wallSpanEl.textContent = `Total: ${formatDetailedDuration(wallSpanSec)}`;
    if (axisStartEl) axisStartEl.textContent = formatTime(startD);
    if (axisEndEl) axisEndEl.textContent = isOvernight ? `${formatTime(endD)} (+1d)` : formatTime(endD);

    if (graphTrackEl) {
      graphTrackEl.innerHTML = '';
      const totalSpanMs = Math.max(1, endMs - startMs);

      timeline.forEach((seg, idx) => {
        const segType = seg.type || seg.state || 'focus';
        const segStart = Number(seg.start || seg.start_ms || startMs);
        const segEnd = Number(seg.end || seg.end_ms || endMs);
        const segDurationSec = seg._calcDuration || Math.max(0, Math.round((segEnd - segStart) / 1000));
        const segPct = Math.max(1.5, ((segEnd - segStart) / totalSpanMs) * 100);

        const segEl = document.createElement('div');
        segEl.className = `graph-segment graph-segment-${segType === 'break' ? 'break' : 'focus'}`;
        segEl.style.width = `${segPct}%`;

        const typeLabel = segType === 'break' ? 'Break' : 'Focus';
        const startStr = formatTime(new Date(segStart));
        const endStr = formatTime(new Date(segEnd));
        const durStr = formatDetailedDuration(segDurationSec);

        segEl.setAttribute('data-tooltip', `${typeLabel}: ${startStr} – ${endStr} (${durStr})`);

        const updateTooltipPosition = (clientX) => {
          if (!graphTooltipEl) return;
          graphTooltipEl.textContent = segEl.getAttribute('data-tooltip');
          graphTooltipEl.classList.remove('hidden');

          const container = graphTrackEl.parentElement || graphTrackEl;
          const containerRect = container.getBoundingClientRect();
          const segRect = segEl.getBoundingClientRect();

          const targetX = clientX != null
            ? Math.max(segRect.left + 2, Math.min(segRect.right - 2, clientX)) - containerRect.left
            : (segRect.left + segRect.width / 2) - containerRect.left;

          const tooltipWidth = graphTooltipEl.offsetWidth || 150;
          const halfWidth = tooltipWidth / 2;
          const minLeft = halfWidth + 8;
          const maxLeft = Math.max(minLeft, containerRect.width - halfWidth - 8);
          const clampedLeft = Math.max(minLeft, Math.min(maxLeft, targetX));

          graphTooltipEl.style.left = `${clampedLeft}px`;

          const pointerOffset = targetX - clampedLeft;
          const pointerX = Math.max(12, Math.min(tooltipWidth - 12, halfWidth + pointerOffset));
          graphTooltipEl.style.setProperty('--tooltip-pointer-x', `${pointerX}px`);
        };

        segEl.addEventListener('mouseenter', (e) => updateTooltipPosition(e.clientX));
        segEl.addEventListener('mousemove', (e) => updateTooltipPosition(e.clientX));

        segEl.addEventListener('mouseleave', () => {
          graphTooltipEl?.classList.add('hidden');
        });

        graphTrackEl.appendChild(segEl);
      });

      graphTrackEl.addEventListener('mouseleave', () => {
        graphTooltipEl?.classList.add('hidden');
      });

      // Overnight midnight marker
      if (isOvernight) {
        const midnightD = new Date(startD);
        midnightD.setHours(24, 0, 0, 0);
        const midnightMs = midnightD.getTime();
        if (midnightMs > startMs && midnightMs < endMs) {
          const midnightPct = Math.max(0, Math.min(100, ((midnightMs - startMs) / totalSpanMs) * 100));
          const lineEl = document.createElement('div');
          lineEl.className = 'session-graph-midnight-line';
          lineEl.style.left = `${midnightPct}%`;
          lineEl.setAttribute('title', 'Midnight Day Boundary (12:00 AM)');
          graphTrackEl.appendChild(lineEl);

          const mBadgeEl = document.createElement('div');
          mBadgeEl.className = 'session-graph-midnight-badge';
          mBadgeEl.style.left = `${midnightPct}%`;
          mBadgeEl.textContent = '12:00 AM';
          graphTrackEl.appendChild(mBadgeEl);
        }
      }
    }

    // Intervals & Breaks List
    if (intervalsCountEl) {
      intervalsCountEl.textContent = `${timeline.length} ${timeline.length === 1 ? 'interval' : 'intervals'}`;
    }
    if (intervalsListEl) {
      if (breaksCount === 0) {
        intervalsListEl.innerHTML = `
          <div class="interval-pristine-banner">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
            </svg>
            <div>
              <strong>Pristine Flow Session</strong>
              <div style="font-size: 0.72rem; opacity: 0.8; margin-top: 2px;">Continuous study without any pauses or breaks (+10% Pristine Flow XP earned).</div>
            </div>
          </div>
        `;
      } else {
        let breakIdx = 1;
        intervalsListEl.innerHTML = timeline.map(item => {
          const itemType = item.type || item.state || 'focus';
          const isBreak = itemType === 'break';
          const segStart = Number(item.start || item.start_ms || startMs);
          const segEnd = Number(item.end || item.end_ms || endMs);
          const segStartD = new Date(segStart);
          const segEndD = new Date(segEnd);
          const segStartStr = formatTime(segStartD);
          let segEndStr = formatTime(segEndD);
          if (isOvernight && getLocalDateString(segEndD) !== startDayStr) {
            segEndStr += ' (+1d)';
          }
          const durSec = item._calcDuration || Math.max(0, Math.round((segEnd - segStart) / 1000));
          const durStr = formatDetailedDuration(durSec);
          const titleLabel = isBreak ? `Break #${breakIdx++} (Paused)` : 'Focus Period';

          return `
            <div class="interval-row interval-row-${isBreak ? 'break' : 'focus'}">
              <div class="interval-left">
                <span class="interval-badge-pill interval-badge-${isBreak ? 'break' : 'focus'}">${isBreak ? 'PAUSE' : 'FOCUS'}</span>
                <div>
                  <div style="font-weight: 500;">${titleLabel}</div>
                  <div class="interval-times">${segStartStr} – ${segEndStr}</div>
                </div>
              </div>
              <div class="interval-right">
                <span class="interval-duration">${durStr}</span>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    // Actions
    if (deleteBtn) {
      deleteBtn.disabled = false;
      const targetSessionId = String(s.id || sessionId);
      deleteBtn.setAttribute('data-session-id', targetSessionId);
      deleteBtn.setAttribute('data-date', dateStr);
      deleteBtn.setAttribute('data-duration', String(dur));
      deleteBtn.setAttribute('data-xp', String(xp));
      deleteBtn.setAttribute('data-subject', subjName);
      deleteBtn.setAttribute('data-timerange', timeRangeStr);

      deleteBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (deleteBtn.disabled) return;

        const confirmOptions = getSessionDeleteConfirmOptions(s, dateStr);
        const confirmed = await confirmAction(confirmOptions);
        if (!confirmed) return;

        deleteBtn.disabled = true;
        dialog.close();
        try {
          await deleteSession(targetSessionId, dateStr);
        } catch (err) {
          console.error('StudyArk: Failed to delete session from details dialog:', err);
        }
      };
    }

    const closeHandler = () => {
      dialog.close();
      const dayDlg = document.getElementById('day-detail-dialog');
      const histDlg = document.getElementById('sessions-history-dialog');
      if ((!dayDlg || !dayDlg.open) && (!histDlg || !histDlg.open)) {
        resumeAmbientCanvas();
      }
    };
    if (doneBtn) doneBtn.onclick = closeHandler;
    if (closeBtn) closeBtn.onclick = closeHandler;
    dialog.oncancel = (e) => {
      e.preventDefault();
      closeHandler();
    };
    dialog.onclick = (e) => {
      if (e.target === dialog) {
        closeHandler();
      }
    };

    pauseAmbientCanvas();
    if (typeof dialog.showModal === 'function' && !dialog.open) {
      dialog.showModal();
    }
  }
  window.openSessionDetailDialog = openSessionDetailDialog;

  async function openDayDialog(dateStr) {
    const dialog = document.getElementById('day-detail-dialog');
    if (!dialog) return;

    pauseAmbientCanvas();
    currentDialogDate = dateStr;

    // 1. Open modal immediately on frame 0 to kick off compositor pop-in animation
    if (typeof dialog.showModal === 'function' && !dialog.open) {
      dialog.showModal();
    }
    globalLenis?.stop();

    // 2. Instant Synchronous Resolution: Cache, Zero-Minute Rest Day, or Already in state.sessions
    let dayData = getDayDataFromClient(dateStr);
    if (dayData) {
      renderDayDialogDOM(dayData);
      initShellLenis();
      setTimeout(() => { dayLenis?.resize(); }, 40);
      return;
    }

    // 3. Fallback for older dates outside recent memory:
    // Pre-populate with known activity stats & skeleton feed immediately so NO PREVIOUS DAY DATA IS EVER SHOWN
    renderDayDialogSkeleton(dateStr);
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
      console.warn('StudyArk: Error fetching day data from backend:', e);
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
  window.openDayDialog = openDayDialog;

  function closeDayDialog() {
    currentDialogDate = null;
    const dialog = document.getElementById('day-detail-dialog');
    if (dialog && dialog.open) {
      dialog.close();
    }
    globalLenis?.start();
    resumeAmbientCanvas();
  }

  // =========================================================================
  // RPG LEVEL & MASTERY MODAL DIALOG
  // =========================================================================
  let showAllLevelsView = false;

  function calculateLevelClearDates() {
    ensureSessionIndex();
    if (sessionDataIndex.levelClearDates) {
      return sessionDataIndex.levelClearDates;
    }

    // Cleared dates are derived data: replay the sessions that still exist in
    // chronological order and record the day each XP threshold was crossed.
    // Deleting old sessions therefore recalculates the timeline consistently
    // on every device, with no stale local-only level-up ledger.
    const dates = {};

    if (!sessionDataIndex.sortedAsc) {
      const sessions = (state.sessions || []).slice();
      sessions.sort((a, b) => (a._ts || 0) - (b._ts || 0));
      sessionDataIndex.sortedAsc = sessions;
    }
    const sessions = sessionDataIndex.sortedAsc;

    let cum = 0;
    let nextLvlIdx = 0;
    const totalLevels = RPG_LEVELS.length;

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      cum += Number(s.xp != null ? s.xp : ((s.durationMinutes || s.duration_minutes || 0) * 10));
      while (nextLvlIdx < totalLevels && cum >= RPG_LEVELS[nextLvlIdx].maxXp) {
        const l = RPG_LEVELS[nextLvlIdx];
        if (!dates[l.level]) {
          dates[l.level] = {
            date: s.date,
            timestamp: s._ts || s.timestamp,
            formatted: s.date ? formatDayDateHeader(s.date) : 'Cleared'
          };
        }
        nextLvlIdx++;
      }
      if (nextLvlIdx >= totalLevels) break;
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

    sessionDataIndex.levelClearDates = dates;
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
    lastRenderedLevelInDialog = null;

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

    pauseAmbientCanvas();

    // Clear any text selection that may have occurred
    if (window.getSelection) {
      window.getSelection().removeAllRanges();
    }

    // 1. Open modal first so container has active layout in the render tree
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

    // 2. Reset container and render fresh while dialog is open and visible.
    // Both render paths sync Lenis dimensions and start at the top, so the
    // open path does not need a second resize/scroll pass.
    resetLevelsContainer(true);
    showAllLevelsView = false;
    renderLevelsDialogDOM();
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
    resumeAmbientCanvas();
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
      this.lastScrollTop = 0;
      this.scrollDirection = 'down';
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

      // Track scroll direction so re-entering items swoop in from the side they
      // came from (Journey's bidirectional re-appearing animation)
      if (scrollTop > this.lastScrollTop + 1) {
        this.scrollDirection = 'down';
      } else if (scrollTop < this.lastScrollTop - 1) {
        this.scrollDirection = 'up';
      }
      this.lastScrollTop = scrollTop;

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

      // 4. Trigger entrance animations
      // Both views use the exact same view-boundary trigger, so cards & tier
      // headers animate right as they cross into the visible area — never
      // pre-triggered off-screen where nobody can see them.
      // A forced reflow commits the pre-reveal state before the "visible"
      // class is added, so the transition always plays, even on fast flings
      // (without it, cards mounted & revealed in the same frame snap in).
      // My Journey additionally swoops in from the direction of travel:
      // from the top when scrolling up, from the bottom when scrolling down.
      const viewTop = scrollTop;
      const viewBottom = scrollTop + viewportHeight;
      const toAnimate = [];

      for (const [idx, el] of this.mountedElements.entries()) {
        if (el.classList.contains('visible')) continue;

        const itemTop = this.itemOffsets[idx];
        const itemBottom = itemTop + this.virtualItems[idx].height;

        const isEnteringView = (idx === pinHeaderIdx) || (
          itemBottom >= viewTop - 10 && itemTop <= viewBottom + 25
        );

        if (isEnteringView) {
          toAnimate.push(el);
        }
      }

      if (toAnimate.length > 0) {
        const fromTop = !this.isCatalogMode && this.scrollDirection === 'up';

        requestAnimationFrame(() => {
          toAnimate.forEach((el, i) => {
            if (el.classList.contains('visible')) return;

            if (!this.isCatalogMode) {
              el.classList.toggle('enter-top', fromTop);
              el.classList.toggle('enter-bottom', !fromTop);
            }

            void el.offsetWidth; // Force reflow for the signature delayed multi-effect transition
            const delay = Math.min((i % 5) * 35, 140);
            el.style.transitionDelay = `${delay}ms`;
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

  let lastRenderedLevelInDialog = null;

  function updateLevelsDialogLiveMetrics() {
    const dialog = document.getElementById('levels-dialog');
    if (!dialog || !dialog.open) return;

    const effectiveXp = getEffectiveTotalXp();
    const lvlInfo = getLevelInfo(effectiveXp);

    // If level actually changed while the modal was open (real level-up or reset), rebuild list
    if (lastRenderedLevelInDialog !== null && lastRenderedLevelInDialog !== lvlInfo.level) {
      lastRenderedLevelInDialog = lvlInfo.level;
      renderLevelsDialogDOM();
      return;
    }
    lastRenderedLevelInDialog = lvlInfo.level;

    // Fast, flicker-free DOM update of metric pills and progress bar (0 animation resets!)
    const titleEl = document.getElementById('levels-dialog-title');
    const badgeEl = document.getElementById('levels-dialog-badge');
    if (titleEl && !showAllLevelsView) {
      const titleText = `Level ${lvlInfo.level} — ${lvlInfo.title}`;
      if (titleEl.textContent !== titleText) titleEl.textContent = titleText;
    }
    if (badgeEl && !showAllLevelsView) {
      const badgeText = `Tier ${lvlInfo.tierIndex}: ${lvlInfo.tier}`;
      if (badgeEl.textContent !== badgeText) badgeEl.textContent = badgeText;
    }

    const pillLevel = document.getElementById('levels-pill-level');
    const pillTier = document.getElementById('levels-pill-tier');
    const pillNext = document.getElementById('levels-pill-next');

    if (pillLevel) {
      const lvlText = `Lv. ${lvlInfo.level}`;
      if (pillLevel.textContent !== lvlText) pillLevel.textContent = lvlText;
    }
    if (pillTier) {
      if (pillTier.textContent !== lvlInfo.tier) pillTier.textContent = lvlInfo.tier;
    }
    if (pillNext) {
      const nextText = lvlInfo.isMax ? 'Max Rank' : `${formatCompactNumber(Math.max(0, lvlInfo.xpRequired - lvlInfo.currentLevelXp))} XP`;
      if (pillNext.textContent !== nextText) pillNext.textContent = nextText;
    }

    const progressFractionEl = document.getElementById('levels-progress-fraction');
    const progressPercentEl = document.getElementById('levels-progress-percent');
    const barFillEl = document.getElementById('levels-bar-fill');
    const totalXpEl = document.getElementById('levels-total-xp');

    if (progressFractionEl) {
      const fracText = `${formatCompactNumber(lvlInfo.currentLevelXp)} / ${formatCompactNumber(lvlInfo.xpRequired)} XP (${lvlInfo.progressPercent.toFixed(1)}%)`;
      if (progressFractionEl.textContent !== fracText) progressFractionEl.textContent = fracText;
    }
    if (progressPercentEl) {
      const pctText = lvlInfo.isMax ? 'MAX' : `${lvlInfo.progressPercent.toFixed(0)}%`;
      if (progressPercentEl.textContent !== pctText) progressPercentEl.textContent = pctText;
    }
    if (barFillEl) {
      const wText = `${lvlInfo.progressPercent.toFixed(1)}%`;
      if (barFillEl.style.width !== wText) barFillEl.style.width = wText;
    }
    if (totalXpEl) {
      const xpText = `${Number(effectiveXp || 0).toLocaleString()} XP`;
      if (totalXpEl.textContent !== xpText) totalXpEl.textContent = xpText;
    }

    // Also update the current level card in the virtual scroller if currently mounted
    const currentCard = document.querySelector('.level-card[data-current-level="true"], .level-card.is-current');
    if (currentCard) {
      const remaining = Math.max(0, lvlInfo.xpRequired - lvlInfo.currentLevelXp);
      const subEl = currentCard.querySelector('.level-item-subtitle, .level-subtitle');
      if (subEl) {
        const currentSub = showAllLevelsView
          ? `Requires +${formatCompactNumber(lvlInfo.xpRequired)} XP • Total: ${formatCompactNumber(lvlInfo.maxXp)} XP`
          : `Current Level • ${formatCompactNumber(lvlInfo.currentLevelXp)} / ${formatCompactNumber(lvlInfo.xpRequired)} XP (${remaining} XP to next)`;
        if (subEl.textContent !== currentSub) subEl.textContent = currentSub;
      }
      const badgeStatusEl = currentCard.querySelector('.level-badge-status');
      if (badgeStatusEl && !showAllLevelsView) {
        const currentBadge = `${lvlInfo.progressPercent.toFixed(0)}%`;
        if (badgeStatusEl.textContent !== currentBadge) badgeStatusEl.textContent = currentBadge;
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

    const effectiveXp = getEffectiveTotalXp();
    const lvlInfo = getLevelInfo(effectiveXp);
    lastRenderedLevelInDialog = lvlInfo.level;
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
      totalXpEl.textContent = `${Number(effectiveXp || 0).toLocaleString()} XP`;
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
          const diff = Math.max(0, l.minXp - effectiveXp);
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
      setTimeout(() => {
        levelsLenis?.resize();
        activeLevelsScroller?.scrollToLevel(lvlInfo.level, false);
      }, 50);
    } else {
      // My Journey: virtualized feed. Only the visible level cards exist in
      // the DOM, so opening the dialog no longer parses/lays out 100+ cards.
      // The same VirtualLevelsScroller powers the catalog view above.
      activeLevelsScroller = new VirtualLevelsScroller({
        container: feedList,
        virtualItems,
        tierHeaderIndices,
        renderCard,
        renderTierHeader,
        headingEl,
        isCatalogMode: false,
        currentLevel: lvlInfo.level
      });

      initShellLenis();
      if (typeof levelsLenis !== 'undefined' && levelsLenis) {
        levelsLenis.scrollTo(0, { immediate: true, force: true });
        levelsLenis.resize();
        levelsLenis.start();
      }
    }
  }

  // =========================================================================
  // SESSIONS HISTORY & ARCHIVE CHRONICLE MODAL DIALOG
  // =========================================================================
  let activeHistoryCleanup = null;
  let activeHistoryScroller = null;

  function resetHistoryContainer(cleanDOM = false) {
    const feedList = document.getElementById('history-feed-list');

    // 1. Destroy active virtual scroller, RAF loops, and scroll listeners
    if (activeHistoryScroller) {
      try { activeHistoryScroller.destroy(); } catch (e) {}
      activeHistoryScroller = null;
    }
    if (activeHistoryCleanup) {
      try { activeHistoryCleanup(); } catch (e) {}
      activeHistoryCleanup = null;
    }

    // 2. Reset DOM container scroll positions
    if (feedList) {
      feedList.scrollTop = 0;
      feedList.scrollLeft = 0;
      if (cleanDOM) {
        feedList.innerHTML = '';
      }
    }
  }

  function getShortDateBadge(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return 'DATE';
    const todayStr = getLocalDateString();
    if (dateStr === todayStr) return 'TODAY';

    const cacheKey = `${todayStr}_${dateStr}`;
    if (sessionDataIndex.shortBadgeCache.has(cacheKey)) {
      return sessionDataIndex.shortBadgeCache.get(cacheKey);
    }

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    if (dateStr === yStr) {
      sessionDataIndex.shortBadgeCache.set(cacheKey, 'YESTERDAY');
      return 'YESTERDAY';
    }

    try {
      const parts = dateStr.split('-');
      if (parts.length < 3) return dateStr.toUpperCase();
      const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      if (isNaN(d.getTime())) return dateStr.toUpperCase();
      const formatted = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
      sessionDataIndex.shortBadgeCache.set(cacheKey, formatted);
      return formatted;
    } catch (_) {
      return dateStr;
    }
  }

  function createHistoryDateHeader(item) {
    const dateHdr = document.createElement('div');
    dateHdr.className = 'history-date-sticky-header';
    dateHdr.setAttribute('data-date', item.date);
    dateHdr.setAttribute('data-full-date', item.fullDate);
    dateHdr.setAttribute('role', 'button');
    dateHdr.setAttribute('tabindex', '0');
    dateHdr.setAttribute('title', 'Click to jump to date via calendar');
    dateHdr.innerHTML = `
      <div class="history-date-sticky-left">
        <span class="history-date-badge">${escapeHtml(item.badge)}</span>
        <span class="history-date-title">${escapeHtml(item.fullDate)}</span>
      </div>
      <span class="history-date-meta">${item.sessionsCount} ${item.sessionsCount === 1 ? 'session' : 'sessions'} • ${formatHoursMinutes(item.totalMins * 60)}</span>
    `;
    dateHdr.addEventListener('click', () => {
      openHistoryCalendarModal(item.date);
    });
    return dateHdr;
  }

  function createHistorySessionCard(s) {
    const dur = s.durationMinutes || s.duration_minutes || 0;
    const xp = s.xp != null ? s.xp : (dur * 10);
    const taskName = s.taskName || s.task_name || '';
    const taskNote = taskName ? `<span class="history-session-task">"${escapeHtml(taskName)}"</span>` : '';
    const timeRangeStr = s.timeRange ? `<span class="history-session-timerange">${escapeHtml(s.timeRange)}</span>` : '';
    const sep = (taskNote && timeRangeStr) ? '<span class="stat-xp-sep" aria-hidden="true">•</span>' : '';

    const card = document.createElement('div');
    card.className = 'history-session-card';
    card.setAttribute('data-session-id', s.id);
    card.setAttribute('data-date', s.date || '');
    card.setAttribute('data-duration', dur);
    card.setAttribute('data-xp', xp);
    if (s.sessionStartMs || s.session_start_ms) card.setAttribute('data-session-start-ms', s.sessionStartMs || s.session_start_ms);
    if (s.sessionEndMs || s.session_end_ms) card.setAttribute('data-session-end-ms', s.sessionEndMs || s.session_end_ms);

    card.innerHTML = `
      <div class="history-session-left">
        <div class="history-session-timeline">
          <span class="history-session-track-line"></span>
          <span class="history-session-track-node"></span>
        </div>
        <div class="history-session-orb-wrapper">
          <span class="history-session-orb" style="background-color: ${s.color || '#10E068'}; color: ${s.color || '#10E068'};"></span>
        </div>
        <div class="history-session-info">
          <span class="history-session-subject">${escapeHtml(s.subject || 'Focus Session')}</span>
          <div class="history-session-sub-row">
            ${taskNote}
            ${sep}
            ${timeRangeStr}
          </div>
        </div>
      </div>
      <div class="history-session-right">
        <div class="history-session-duration">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
          <span>${dur} mins</span>
        </div>
        <span class="history-session-xp">+${formatCompactNumber(xp)} XP</span>
        <button class="history-session-delete-btn" data-session-id="${escapeHtml(s.id)}" data-date="${escapeHtml(s.date || '')}" title="Delete session" aria-label="Delete session">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            <line x1="10" y1="11" x2="10" y2="17"></line>
            <line x1="14" y1="11" x2="14" y2="17"></line>
          </svg>
        </button>
      </div>
    `;
    if (s && s.id) {
      sessionLookupCache.set(String(s.id), s);
    }
    card.addEventListener('click', (e) => {
      if (e.target.closest('.history-session-delete-btn')) return;
      openSessionDetailDialog(s.id, s);
    });
    return card;
  }

  class VirtualHistoryScroller {
    constructor({
      container,
      virtualItems,
      dateHeaderIndices,
      renderSessionCard,
      renderDateHeader,
      animateInitial = true,
      initialScrollTop = 0
    }) {
      this.container = container;
      this.virtualItems = virtualItems;
      this.dateHeaderIndices = dateHeaderIndices;
      this.renderSessionCard = renderSessionCard;
      this.renderDateHeader = renderDateHeader;
      this.animateInitial = animateInitial;

      this.mountedElements = new Map();
      this.totalHeight = 0;
      this.itemOffsets = new Float64Array(virtualItems.length);
      for (let i = 0; i < virtualItems.length; i++) {
        this.itemOffsets[i] = this.totalHeight;
        this.totalHeight += virtualItems[i].height;
      }

      this.container.innerHTML = '';

      this.topSpacer = document.createElement('div');
      this.topSpacer.className = 'history-spacer-top';
      this.topSpacer.style.height = '0px';
      this.topSpacer.style.display = 'none';

      this.bottomSpacer = document.createElement('div');
      this.bottomSpacer.className = 'history-spacer-bottom';
      this.bottomSpacer.style.height = `${this.totalHeight}px`;

      this.container.appendChild(this.topSpacer);
      this.container.appendChild(this.bottomSpacer);

      // Restore the previous scroll position before the first window is
      // calculated. Data refreshes (delete, archive sync) must never yank the
      // user back to the top of the feed.
      if (initialScrollTop > 0) {
        this.container.scrollTop = initialScrollTop;
      }

      this.pinnedHeader = document.getElementById('history-pinned-date-header');
      this.currentPinnedDate = null;
      if (this.pinnedHeader) {
        this.pinnedHeaderClickHandler = () => {
          openHistoryCalendarModal(this.currentPinnedDate);
        };
        this.pinnedHeader.addEventListener('click', this.pinnedHeaderClickHandler);
      }

      this.rafId = null;
      this.onScroll = this.onScroll.bind(this);
      // Native scrolling only: the feed is a standard overflow container, so
      // wheel/touch input is never intercepted by (or dependent on) Lenis.
      this.container.addEventListener('scroll', this.onScroll, { passive: true });

      this.updateWindow(true);
    }

    destroy() {
      this.container.removeEventListener('scroll', this.onScroll);
      if (this.pinnedHeader && this.pinnedHeaderClickHandler) {
        this.pinnedHeader.removeEventListener('click', this.pinnedHeaderClickHandler);
      }
      if (this.pinnedHeader) {
        this.pinnedHeader.style.display = 'none';
      }
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
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
      // 140px focused buffer matching All Levels tab so items animate right as they enter view area
      const buffer = 140;
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
      const viewportHeight = this.container.clientHeight || 520;
      const { startIndex, endIndex } = this.getVisibleRange(scrollTop, viewportHeight);

      const neededIndices = new Set();
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
      for (let idx = startIndex; idx <= endIndex; idx++) {
        if (this.mountedElements.has(idx)) continue;

        const item = this.virtualItems[idx];
        let el;
        if (item.type === 'header') {
          el = this.renderDateHeader(item);
        } else {
          el = this.renderSessionCard(item.session);
        }

        // Find correct anchor in DOM
        let anchor = this.bottomSpacer;
        for (let j = idx + 1; j <= endIndex; j++) {
          if (this.mountedElements.has(j)) {
            anchor = this.mountedElements.get(j);
            break;
          }
        }

        this.container.insertBefore(el, anchor);
        this.mountedElements.set(idx, el);
      }

      // 3. Update top and bottom spacers to maintain exact scroll height
      const topSpacerHeight = this.itemOffsets[startIndex];
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
      // View-boundary entrance trigger (exact match with All Levels tab):
      // Swoops in smoothly as cards reach the viewport boundary (+45px lookahead)
      // so cards are visibly animating even when scrolling slowly!
      // A rebuild caused by a data update must not replay the entrance
      // animation for cards that are already on screen, otherwise deleting one
      // session makes the whole feed animate several times in a row.
      const viewTop = scrollTop;
      const viewBottom = scrollTop + viewportHeight;
      const toAnimate = [];
      const shouldAnimateInitial = !isInitial || this.animateInitial;

      for (const [idx, el] of this.mountedElements.entries()) {
        if (el.classList.contains('visible')) continue;

        const itemTop = this.itemOffsets[idx];
        const itemBottom = itemTop + this.virtualItems[idx].height;

        const isEnteringView = (
          itemBottom >= viewTop - 10 && itemTop <= viewBottom + 45
        );

        if (isEnteringView) {
          toAnimate.push(el);
        }
      }

      if (toAnimate.length > 0) {
        if (!shouldAnimateInitial) {
          toAnimate.forEach((el) => {
            el.style.transitionDelay = '0ms';
            el.classList.add('visible');
          });
        } else {
          requestAnimationFrame(() => {
            toAnimate.forEach((el, i) => {
              void el.offsetWidth; // Force reflow for the signature delayed multi-effect transition
              const delay = isInitial ? Math.min((i % 5) * 35, 140) : 0;
              el.style.transitionDelay = `${delay}ms`;
              el.classList.add('visible');
            });
          });
        }
      }

      // 5. Update Persistent Pinned Date Header Overlay:
      // Detects which date header is currently active at top of viewport
      if (this.pinnedHeader && this.virtualItems.length > 0) {
        let activeHeaderItem = null;
        for (let i = 0; i < this.virtualItems.length; i++) {
          const it = this.virtualItems[i];
          if (it.type === 'header') {
            if (this.itemOffsets[i] <= scrollTop + 5) {
              activeHeaderItem = it;
            } else {
              break;
            }
          }
        }
        if (!activeHeaderItem) {
          for (let i = 0; i < this.virtualItems.length; i++) {
            if (this.virtualItems[i].type === 'header') {
              activeHeaderItem = this.virtualItems[i];
              break;
            }
          }
        }

        if (activeHeaderItem) {
          this.pinnedHeader.style.display = 'flex';
          if (this.currentPinnedDate !== activeHeaderItem.date) {
            this.currentPinnedDate = activeHeaderItem.date;
            const badgeEl = document.getElementById('history-pinned-badge');
            const titleEl = document.getElementById('history-pinned-title');
            const metaEl = document.getElementById('history-pinned-meta');

            if (badgeEl) badgeEl.textContent = activeHeaderItem.badge;
            if (titleEl) titleEl.textContent = activeHeaderItem.fullDate;
            if (metaEl) {
              const sCount = activeHeaderItem.sessionsCount;
              metaEl.textContent = `${sCount} ${sCount === 1 ? 'session' : 'sessions'} • ${formatHoursMinutes(activeHeaderItem.totalMins * 60)}`;
            }
          }
        }
      }
    }
  }

  // =========================================================================
  // SESSIONS HISTORY CALENDAR JUMP MODAL CONTROLLER
  // =========================================================================
  const CAL_MONTH_NAMES_SHORT = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];
  let currentCalYear = new Date().getFullYear();
  let currentCalMonth = new Date().getMonth(); // 0-indexed
  let activeSelectedDate = '';

  function isCalendarAtMaxMonth(year = currentCalYear, month = currentCalMonth) {
    const now = new Date();
    const liveYear = now.getFullYear();
    const liveMonth = now.getMonth();
    if (year > liveYear) return true;
    if (year === liveYear && month >= liveMonth) return true;
    return false;
  }

  // Dial picker state
  const DIAL_ITEM_HEIGHT = 40;
  let dialYearsList = [];
  let pendingDialMonth = new Date().getMonth();
  let pendingDialYear = new Date().getFullYear();
  let isDialViewOpen = false;
  let isMonthTransitioning = false;
  let isMonthDragging = false;
  let wasDraggingMonth = false;

  function renderMonthDaysInto(year, month, containerEl, isCurrent) {
    if (!containerEl) return { totalMins: 0, sessionCount: 0 };
    containerEl.innerHTML = '';

    ensureSessionIndex();

    const firstDayIndex = new Date(year, month, 1).getDay(); // 0 = Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayStr = getLocalDateString();

    let monthTotalMins = 0;
    let monthSessionCount = 0;

    // 1. Leading spacer empty days
    for (let i = 0; i < firstDayIndex; i++) {
      const emptyCell = document.createElement('div');
      emptyCell.className = 'history-cal-day empty';
      emptyCell.setAttribute('aria-hidden', 'true');
      containerEl.appendChild(emptyCell);
    }

    // 2. Actual active day cells
    for (let day = 1; day <= daysInMonth; day++) {
      const cellDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isFuture = cellDateStr > todayStr;
      const daySessions = !isFuture ? (sessionDataIndex.byDate.get(cellDateStr) || []) : [];
      const hasSessions = !isFuture && daySessions.length > 0;
      const isToday = cellDateStr === todayStr;
      const isActive = isCurrent && !isFuture && (cellDateStr === activeSelectedDate);

      let dayMins = 0;
      for (let j = 0; j < daySessions.length; j++) {
        dayMins += (daySessions[j].durationMinutes || daySessions[j].duration_minutes || 0);
      }
      monthTotalMins += dayMins;
      monthSessionCount += daySessions.length;

      const cell = document.createElement('div');
      cell.className = `history-cal-day ${hasSessions ? 'has-sessions' : ''} ${isToday ? 'is-today' : ''} ${isActive ? 'is-active-day' : ''} ${isFuture ? 'is-future' : ''}`;
      cell.setAttribute('data-date', cellDateStr);

      let inner = `<span>${day}</span>`;
      if (hasSessions) {
        inner += `<span class="history-cal-day-dot" aria-hidden="true"></span>`;
        cell.title = `${daySessions.length} ${daySessions.length === 1 ? 'session' : 'sessions'} • ${dayMins} mins focus (Click to jump)`;
      } else if (isFuture) {
        cell.title = `Future date`;
        cell.setAttribute('aria-disabled', 'true');
      } else {
        cell.title = `No sessions recorded`;
      }
      cell.innerHTML = inner;

      if (isCurrent && !isFuture) {
        cell.addEventListener('click', (e) => {
          if (wasDraggingMonth) {
            e.stopPropagation();
            return;
          }
          handleCalendarDateSelect(cellDateStr, hasSessions);
        });
      }

      containerEl.appendChild(cell);
    }

    // 3. Trailing spacer empty days to strictly lock to 42 cells (6 rows x 7 cols)
    const totalRendered = firstDayIndex + daysInMonth;
    const remainingSpacers = Math.max(0, 42 - totalRendered);
    for (let i = 0; i < remainingSpacers; i++) {
      const emptyCell = document.createElement('div');
      emptyCell.className = 'history-cal-day empty';
      emptyCell.setAttribute('aria-hidden', 'true');
      containerEl.appendChild(emptyCell);
    }

    return { totalMins: monthTotalMins, sessionCount: monthSessionCount };
  }

  function updateCalendarHeaderAndStats(stats) {
    const titleEl = document.getElementById('history-calendar-title');
    const monthSessionsEl = document.getElementById('history-cal-month-sessions');
    const monthTimeEl = document.getElementById('history-cal-month-time');
    const nextBtn = document.getElementById('history-cal-next-month');

    if (titleEl) {
      titleEl.textContent = `${CAL_MONTH_NAMES_SHORT[currentCalMonth]} ${currentCalYear}`;
    }
    if (monthSessionsEl) {
      monthSessionsEl.textContent = `${stats.sessionCount} ${stats.sessionCount === 1 ? 'session' : 'sessions'}`;
    }
    if (monthTimeEl) {
      monthTimeEl.textContent = `${formatHoursMinutes(stats.totalMins * 60)} focus`;
    }

    if (nextBtn) {
      const atMax = isCalendarAtMaxMonth();
      nextBtn.disabled = atMax;
      if (atMax) {
        nextBtn.classList.add('is-disabled');
        nextBtn.setAttribute('aria-disabled', 'true');
      } else {
        nextBtn.classList.remove('is-disabled');
        nextBtn.removeAttribute('aria-disabled');
      }
    }
  }

  function renderHistoryCalendarGrid() {
    const gridCurr = document.getElementById('history-cal-grid');
    const gridPrev = document.getElementById('history-cal-grid-prev');
    const gridNext = document.getElementById('history-cal-grid-next');
    const track = document.getElementById('history-cal-track');

    if (track) {
      track.classList.remove('animating');
      track.style.transform = 'translate3d(-33.333333%, 0, 0)';
    }

    if (gridCurr) {
      const stats = renderMonthDaysInto(currentCalYear, currentCalMonth, gridCurr, true);
      updateCalendarHeaderAndStats(stats);
    }

    // Render adjacent months for real-time 1:1 finger swipe
    if (gridPrev) {
      let pMonth = currentCalMonth - 1;
      let pYear = currentCalYear;
      if (pMonth < 0) {
        pMonth = 11;
        pYear--;
      }
      renderMonthDaysInto(pYear, pMonth, gridPrev, false);
    }

    if (gridNext) {
      if (isCalendarAtMaxMonth()) {
        gridNext.innerHTML = '';
      } else {
        let nMonth = currentCalMonth + 1;
        let nYear = currentCalYear;
        if (nMonth > 11) {
          nMonth = 0;
          nYear++;
        }
        renderMonthDaysInto(nYear, nMonth, gridNext, false);
      }
    }
  }

  function finishCalendarMonthSwipe(direction) {
    const track = document.getElementById('history-cal-track');
    if (!track) return;

    if (direction === 1 && isCalendarAtMaxMonth()) {
      // Cannot swipe into future months: snap back cleanly to current month
      direction = 0;
    }

    isMonthTransitioning = true;
    track.classList.add('animating');

    if (direction === 1) {
      // Next Month: slide left to show the next month slide
      track.style.transform = 'translate3d(-66.666667%, 0, 0)';
    } else if (direction === -1) {
      // Prev Month: slide right to show the prev month slide
      track.style.transform = 'translate3d(0%, 0, 0)';
    } else {
      // Snap back to center current month
      track.style.transform = 'translate3d(-33.333333%, 0, 0)';
    }

    let hasHandledEnd = false;
    const onEnd = () => {
      if (hasHandledEnd) return;
      hasHandledEnd = true;
      track.removeEventListener('transitionend', onEnd);
      track.classList.remove('animating');

      if (direction === 1) {
        if (!isCalendarAtMaxMonth()) {
          currentCalMonth++;
          if (currentCalMonth > 11) {
            currentCalMonth = 0;
            currentCalYear++;
          }
        }
      } else if (direction === -1) {
        currentCalMonth--;
        if (currentCalMonth < 0) {
          currentCalMonth = 11;
          currentCalYear--;
        }
      }

      renderHistoryCalendarGrid();
      isMonthTransitioning = false;
    };

    track.addEventListener('transitionend', onEnd, { once: true });
    setTimeout(() => {
      if (isMonthTransitioning) onEnd();
    }, 280);
  }

  function navigateCalendarMonth(delta) {
    if (isMonthTransitioning || isMonthDragging) return;
    if (delta > 0 && isCalendarAtMaxMonth()) return;
    finishCalendarMonthSwipe(delta);
  }

  let monthDrumWheel = null;
  let yearDrumWheel = null;
  let dialDrumsInitialized = false;

  function createDialDrumWheel({ drumEl, wheelEl, count, onSelect }) {
    const ITEM_HEIGHT = 40;
    let wheelCount = count;
    let currentIndex = 0;
    let currentY = 0;
    let isDragging = false;
    let startY = 0;
    let startDragY = 0;
    let startTime = 0;
    let activePointerId = null;

    function updateVisuals(activeIdx) {
      const items = wheelEl.querySelectorAll('.history-cal-drum-item');
      items.forEach((it, idx) => {
        if (idx === activeIdx) {
          it.classList.add('is-selected');
        } else {
          it.classList.remove('is-selected');
        }
      });
    }

    function setIndex(index, animated = true) {
      const clamped = Math.max(0, Math.min(wheelCount - 1, index));
      currentIndex = clamped;
      currentY = -clamped * ITEM_HEIGHT;

      if (animated) {
        wheelEl.classList.add('animating');
      } else {
        wheelEl.classList.remove('animating');
      }

      wheelEl.style.transform = `translate3d(0, ${currentY}px, 0)`;
      updateVisuals(clamped);
      if (onSelect) onSelect(clamped);

      if (animated) {
        const handleEnd = () => {
          wheelEl.removeEventListener('transitionend', handleEnd);
          wheelEl.classList.remove('animating');
        };
        wheelEl.addEventListener('transitionend', handleEnd, { once: true });
      }
    }

    function updateCount(newCount) {
      wheelCount = Math.max(1, newCount);
      if (currentIndex >= wheelCount) {
        setIndex(wheelCount - 1, false);
      } else {
        updateVisuals(currentIndex);
      }
    }

    function onPointerDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      isDragging = true;
      wheelEl.classList.remove('animating');
      startY = e.clientY;
      startDragY = currentY;
      startTime = Date.now();
      activePointerId = e.pointerId;
      try { drumEl.setPointerCapture(e.pointerId); } catch (_) {}
    }

    function onPointerMove(e) {
      if (!isDragging || e.pointerId !== activePointerId) return;
      if (e.cancelable) e.preventDefault();

      const dy = e.clientY - startY;
      let targetY = startDragY + dy;

      // Soft rubber banding beyond edges
      const minY = -(wheelCount - 1) * ITEM_HEIGHT;
      const maxY = 0;
      if (targetY > maxY) {
        targetY = maxY + (targetY - maxY) * 0.3;
      } else if (targetY < minY) {
        targetY = minY + (targetY - minY) * 0.3;
      }

      currentY = targetY;
      wheelEl.style.transform = `translate3d(0, ${currentY}px, 0)`;

      const liveIdx = Math.max(0, Math.min(wheelCount - 1, Math.round(-currentY / ITEM_HEIGHT)));
      updateVisuals(liveIdx);
    }

    function onPointerUp(e) {
      if (!isDragging || e.pointerId !== activePointerId) return;
      isDragging = false;
      try { drumEl.releasePointerCapture(e.pointerId); } catch (_) {}

      const dy = e.clientY - startY;
      const elapsed = Math.max(1, Date.now() - startTime);
      const velocity = dy / elapsed; // px per ms

      // Flick momentum projection
      let projectedY = currentY + velocity * 130;
      let snapIndex = Math.round(-projectedY / ITEM_HEIGHT);
      snapIndex = Math.max(0, Math.min(wheelCount - 1, snapIndex));

      setIndex(snapIndex, true);
    }

    drumEl.addEventListener('pointerdown', onPointerDown);
    drumEl.addEventListener('pointermove', onPointerMove);
    drumEl.addEventListener('pointerup', onPointerUp);
    drumEl.addEventListener('pointercancel', onPointerUp);

    // Mouse wheel / trackpad scroll
    let wheelTimeout = null;
    drumEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      wheelEl.classList.remove('animating');

      const step = e.deltaY > 0 ? 1 : -1;
      clearTimeout(wheelTimeout);
      wheelTimeout = setTimeout(() => {
        setIndex(currentIndex + step, true);
      }, 35);
    }, { passive: false });

    // Tap/click on an item directly centers it
    wheelEl.addEventListener('click', (e) => {
      const item = e.target.closest('.history-cal-drum-item');
      if (!item) return;
      const idx = parseInt(item.getAttribute('data-idx'), 10);
      if (!isNaN(idx) && idx < wheelCount) {
        setIndex(idx, true);
      }
    });

    return {
      setIndex,
      updateCount,
      getIndex: () => currentIndex
    };
  }

  function syncDialMonthLimit() {
    const now = new Date();
    const liveYear = now.getFullYear();
    const liveMonth = now.getMonth();
    const monthWheel = document.getElementById('history-cal-drum-wheel-month');
    if (!monthWheel) return;

    const maxAllowedMonth = (pendingDialYear >= liveYear) ? liveMonth : 11;
    const items = monthWheel.querySelectorAll('.history-cal-drum-item');
    items.forEach((it) => {
      const idx = parseInt(it.getAttribute('data-idx'), 10);
      if (idx > maxAllowedMonth) {
        it.style.display = 'none';
        it.classList.remove('is-selected');
      } else {
        it.style.display = '';
      }
    });

    if (monthDrumWheel) {
      monthDrumWheel.updateCount(maxAllowedMonth + 1);
      if (pendingDialMonth > maxAllowedMonth) {
        pendingDialMonth = maxAllowedMonth;
        monthDrumWheel.setIndex(maxAllowedMonth, true);
      }
    }
  }

  function buildDialDrums() {
    const monthDrum = document.getElementById('history-cal-drum-month');
    const yearDrum = document.getElementById('history-cal-drum-year');
    const monthWheel = document.getElementById('history-cal-drum-wheel-month');
    const yearWheel = document.getElementById('history-cal-drum-wheel-year');
    if (!monthDrum || !yearDrum || !monthWheel || !yearWheel) return;

    const currentYearMax = new Date().getFullYear();
    dialYearsList = [];
    for (let y = 2000; y <= currentYearMax; y++) {
      dialYearsList.push(y);
    }

    if (!dialDrumsInitialized) {
      dialDrumsInitialized = true;

      // 1. Month drum items (Jan..Dec)
      let mHtml = '';
      CAL_MONTH_NAMES_SHORT.forEach((m, idx) => {
        mHtml += `<div class="history-cal-drum-item" data-idx="${idx}">${m}</div>`;
      });
      monthWheel.innerHTML = mHtml;

      // 2. Year drum items: from 2000 to currentYearMax
      let yHtml = '';
      dialYearsList.forEach((yr, idx) => {
        yHtml += `<div class="history-cal-drum-item" data-idx="${idx}">${yr}</div>`;
      });
      yearWheel.innerHTML = yHtml;

      // Attach transform-based controllers
      monthDrumWheel = createDialDrumWheel({
        drumEl: monthDrum,
        wheelEl: monthWheel,
        count: 12,
        onSelect: (idx) => {
          pendingDialMonth = idx;
        }
      });

      yearDrumWheel = createDialDrumWheel({
        drumEl: yearDrum,
        wheelEl: yearWheel,
        count: dialYearsList.length,
        onSelect: (idx) => {
          if (dialYearsList[idx] !== undefined) {
            pendingDialYear = dialYearsList[idx];
            syncDialMonthLimit();
          }
        }
      });
    } else {
      // If already initialized and year count changed
      if (dialYearsList.length !== yearWheel.children.length) {
        let yHtml = '';
        dialYearsList.forEach((yr, idx) => {
          yHtml += `<div class="history-cal-drum-item" data-idx="${idx}">${yr}</div>`;
        });
        yearWheel.innerHTML = yHtml;
        if (yearDrumWheel) {
          yearDrumWheel.updateCount(dialYearsList.length);
        }
      }
    }

    syncDialMonthLimit();
  }

  function openCalendarDialView() {
    const mainView = document.getElementById('history-cal-main-view');
    const dialView = document.getElementById('history-cal-dial-view');
    const shell = document.getElementById('history-calendar-shell');
    if (!dialView) return;

    isDialViewOpen = true;
    const now = new Date();
    const liveYear = now.getFullYear();
    const liveMonth = now.getMonth();

    if (currentCalYear > liveYear) {
      currentCalYear = liveYear;
      currentCalMonth = liveMonth;
    } else if (currentCalYear === liveYear && currentCalMonth > liveMonth) {
      currentCalMonth = liveMonth;
    }

    pendingDialMonth = currentCalMonth;
    pendingDialYear = currentCalYear;

    buildDialDrums();
    syncDialMonthLimit();

    if (mainView) mainView.style.display = 'none';
    dialView.style.display = 'flex';
    if (shell) shell.classList.add('is-dial-open');

    // Immediately set wheel positions to pendingDialYear and pendingDialMonth without delay
    if (yearDrumWheel) {
      const yIdx = dialYearsList.indexOf(pendingDialYear);
      const targetIdx = yIdx >= 0 ? yIdx : dialYearsList.length - 1;
      yearDrumWheel.setIndex(targetIdx, false);
    }
    if (monthDrumWheel) {
      monthDrumWheel.setIndex(pendingDialMonth, false);
    }
  }

  function closeCalendarDialView(applyChanges = true) {
    const mainView = document.getElementById('history-cal-main-view');
    const dialView = document.getElementById('history-cal-dial-view');
    const shell = document.getElementById('history-calendar-shell');
    if (!dialView) return;

    isDialViewOpen = false;

    if (applyChanges) {
      const now = new Date();
      const liveYear = now.getFullYear();
      const liveMonth = now.getMonth();

      if (yearDrumWheel && dialYearsList[yearDrumWheel.getIndex()] !== undefined) {
        pendingDialYear = Math.min(liveYear, dialYearsList[yearDrumWheel.getIndex()]);
      }
      if (monthDrumWheel) {
        const maxM = (pendingDialYear >= liveYear) ? liveMonth : 11;
        pendingDialMonth = Math.min(maxM, monthDrumWheel.getIndex());
      }
      currentCalMonth = pendingDialMonth;
      currentCalYear = pendingDialYear;
    }

    dialView.style.display = 'none';
    if (mainView) mainView.style.display = 'flex';
    if (shell) shell.classList.remove('is-dial-open');

    renderHistoryCalendarGrid();
  }

  function toggleCalendarDialView() {
    if (isDialViewOpen) {
      closeCalendarDialView(true);
    } else {
      openCalendarDialView();
    }
  }

  function openHistoryCalendarModal(initialDateStr) {
    const dialog = document.getElementById('history-calendar-dialog');
    if (!dialog) return;

    closeCalendarDialView(false);

    let targetDate = new Date();
    if (initialDateStr && typeof initialDateStr === 'string') {
      const parts = initialDateStr.split('-');
      if (parts.length === 3) {
        const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        if (!isNaN(d.getTime())) {
          targetDate = d;
        }
      }
    }

    const now = new Date();
    if (targetDate > now) {
      targetDate = now;
    }

    currentCalYear = targetDate.getFullYear();
    currentCalMonth = targetDate.getMonth();
    activeSelectedDate = (initialDateStr && initialDateStr <= getLocalDateString(now)) ? initialDateStr : getLocalDateString(targetDate);

    dialog.classList.remove('is-closing');
    if (typeof dialog.showModal === 'function' && !dialog.open) {
      dialog.showModal();
    }

    renderHistoryCalendarGrid();
  }

  function closeHistoryCalendarModal() {
    const dialog = document.getElementById('history-calendar-dialog');
    if (!dialog || !dialog.open) return;

    closeCalendarDialView(false);

    dialog.classList.add('is-closing');
    setTimeout(() => {
      dialog.close();
      dialog.classList.remove('is-closing');
    }, 200);
  }

  function handleCalendarDateSelect(dateStr, hasSessions) {
    if (wasDraggingMonth) return;
    closeHistoryCalendarModal();

    if (!activeHistoryScroller) return;

    let targetDate = dateStr;

    // If the selected date does not have recorded sessions, find the closest available date in history
    if (!hasSessions || activeHistoryScroller.dateHeaderIndices[targetDate] === undefined) {
      const availableDates = Object.keys(activeHistoryScroller.dateHeaderIndices).sort();
      if (availableDates.length === 0) return;

      const selectedTime = new Date(dateStr).getTime();
      let closestDate = availableDates[0];
      let minDiff = Infinity;

      for (let i = 0; i < availableDates.length; i++) {
        const d = availableDates[i];
        const diff = Math.abs(new Date(d).getTime() - selectedTime);
        if (diff < minDiff) {
          minDiff = diff;
          closestDate = d;
        }
      }
      targetDate = closestDate;
      showToast(`Jumped to nearest session date: ${formatDayDateHeader(targetDate)}`);
    }

    const targetIdx = activeHistoryScroller.dateHeaderIndices[targetDate];
    if (targetIdx !== undefined) {
      activeSelectedDate = targetDate;
      const targetOffset = activeHistoryScroller.itemOffsets[targetIdx];

      activeHistoryScroller.container.scrollTo({ top: targetOffset, behavior: 'smooth' });
      setTimeout(() => flashDateHeader(targetDate), 400);
    }
  }

  function flashDateHeader(dateStr) {
    if (!activeHistoryScroller) return;
    const idx = activeHistoryScroller.dateHeaderIndices[dateStr];
    if (idx === undefined) return;

    const el = activeHistoryScroller.mountedElements.get(idx);
    if (el) {
      el.classList.remove('pulse-highlight');
      void el.offsetWidth;
      el.classList.add('pulse-highlight');
    }
  }

  function handleCalendarShortcutJump(jumpType) {
    closeCalendarDialView(false);
    if (!activeHistoryScroller) return;
    const availableDates = Object.keys(activeHistoryScroller.dateHeaderIndices).sort();
    if (availableDates.length === 0) return;

    let targetDate = '';
    const todayStr = getLocalDateString();

    if (jumpType === 'today') {
      targetDate = todayStr;
    } else if (jumpType === 'yesterday') {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      targetDate = getLocalDateString(y);
    } else if (jumpType === 'latest') {
      // Last date in chronological order (or first in descending feed)
      targetDate = availableDates[availableDates.length - 1];
    } else if (jumpType === 'oldest') {
      targetDate = availableDates[0];
    }

    if (targetDate) {
      const parts = targetDate.split('-');
      if (parts.length === 3) {
        currentCalYear = parseInt(parts[0], 10);
        currentCalMonth = parseInt(parts[1], 10) - 1;
      }
      handleCalendarDateSelect(targetDate, activeHistoryScroller.dateHeaderIndices[targetDate] !== undefined);
    }
  }

  function setupCalendarViewportGestures() {
    const viewport = document.getElementById('history-cal-viewport');
    const track = document.getElementById('history-cal-track');
    if (!viewport || !track) return;

    let startX = 0;
    let startY = 0;
    let diffX = 0;
    let diffY = 0;
    let startTime = 0;
    let isLockedHorizontal = false;
    let viewportWidth = 0;
    let activePointerId = null;

    const onPointerDown = (e) => {
      if (isMonthTransitioning) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      isMonthDragging = true;
      wasDraggingMonth = false;
      isLockedHorizontal = false;
      startX = e.clientX;
      startY = e.clientY;
      diffX = 0;
      diffY = 0;
      startTime = Date.now();
      viewportWidth = viewport.clientWidth || 320;
      activePointerId = e.pointerId;

      track.classList.remove('animating');
    };

    const onPointerMove = (e) => {
      if (!isMonthDragging || e.pointerId !== activePointerId) return;

      diffX = e.clientX - startX;
      diffY = e.clientY - startY;

      if (!isLockedHorizontal) {
        if (Math.abs(diffY) > Math.abs(diffX) && Math.abs(diffY) > 8) {
          isMonthDragging = false;
          try { viewport.releasePointerCapture(e.pointerId); } catch (_) {}
          return;
        }
        if (Math.abs(diffX) > 6) {
          isLockedHorizontal = true;
          wasDraggingMonth = true;
          try { viewport.setPointerCapture(e.pointerId); } catch (_) {}
        }
      }

      if (isLockedHorizontal) {
        if (e.cancelable) e.preventDefault();

        // 1:1 real-time finger tracking with soft rubber-banding beyond 1 screen width
        let dampedDiffX = diffX;
        const atMax = isCalendarAtMaxMonth();
        if (atMax && diffX < 0) {
          dampedDiffX = diffX * 0.15; // Firm resistance when attempting to drag into future
        } else if (diffX > viewportWidth) {
          dampedDiffX = viewportWidth + (diffX - viewportWidth) * 0.35;
        } else if (diffX < -viewportWidth) {
          dampedDiffX = -viewportWidth + (diffX + viewportWidth) * 0.35;
        }

        const currentOffsetPx = -viewportWidth + dampedDiffX;
        track.style.transform = `translate3d(${currentOffsetPx}px, 0, 0)`;
      }
    };

    const onPointerUp = (e) => {
      if (!isMonthDragging || e.pointerId !== activePointerId) return;
      isMonthDragging = false;
      try { viewport.releasePointerCapture(e.pointerId); } catch (_) {}

      if (!isLockedHorizontal) {
        track.style.transform = 'translate3d(-33.333333%, 0, 0)';
        setTimeout(() => { wasDraggingMonth = false; }, 60);
        return;
      }

      const elapsed = Math.max(1, Date.now() - startTime);
      const velocity = diffX / elapsed; // px/ms
      const threshold = viewportWidth * 0.22;

      if (diffX < -threshold || velocity < -0.38) {
        // Swipe left -> Next Month (blocked if at max month)
        finishCalendarMonthSwipe(isCalendarAtMaxMonth() ? 0 : 1);
      } else if (diffX > threshold || velocity > 0.38) {
        // Swipe right -> Prev Month
        finishCalendarMonthSwipe(-1);
      } else {
        // Snap back to current month
        finishCalendarMonthSwipe(0);
      }

      setTimeout(() => {
        wasDraggingMonth = false;
      }, 80);
    };

    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', onPointerUp);
    viewport.addEventListener('pointercancel', onPointerUp);

    // Trackpad horizontal wheel support
    let wheelTimer = null;
    viewport.addEventListener('wheel', (e) => {
      if (isMonthTransitioning || isMonthDragging) return;
      if (Math.abs(e.deltaX) > 28 && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        if (e.deltaX > 0 && isCalendarAtMaxMonth()) return;
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => {
          navigateCalendarMonth(e.deltaX > 0 ? 1 : -1);
        }, 40);
      }
    }, { passive: false });
  }

  function initHistoryCalendarEvents() {
    const dialog = document.getElementById('history-calendar-dialog');
    const closeBtn = document.getElementById('btn-close-calendar-dialog');
    const prevBtn = document.getElementById('history-cal-prev-month');
    const nextBtn = document.getElementById('history-cal-next-month');
    const titleBtn = document.getElementById('history-calendar-title-btn');
    const dialDoneBtn = document.getElementById('history-cal-dial-done-btn');

    if (closeBtn) {
      closeBtn.addEventListener('click', closeHistoryCalendarModal);
    }

    if (titleBtn) {
      titleBtn.addEventListener('click', toggleCalendarDialView);
    }

    if (dialDoneBtn) {
      dialDoneBtn.addEventListener('click', () => closeCalendarDialView(true));
    }

    if (dialog) {
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) {
          closeHistoryCalendarModal();
        }
      });
      dialog.addEventListener('cancel', (e) => {
        e.preventDefault();
        closeHistoryCalendarModal();
      });
    }

    if (prevBtn) {
      prevBtn.addEventListener('click', () => navigateCalendarMonth(-1));
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => navigateCalendarMonth(1));
    }

    setupCalendarViewportGestures();

    // Shortcut pills: Today, Yesterday, Latest, Oldest
    const shortcuts = document.querySelectorAll('.history-cal-pill-btn');
    shortcuts.forEach((btn) => {
      btn.addEventListener('click', () => {
        const jumpType = btn.getAttribute('data-jump');
        handleCalendarShortcutJump(jumpType);
      });
    });
  }

  async function refreshHistoryArchive(force = false) {
    if (historyArchiveRefreshPending) return;
    if (!force && Date.now() - historyArchiveFetchedAt < HISTORY_ARCHIVE_TTL_MS) return;

    historyArchiveRefreshPending = true;
    try {
      const res = await fetch('/api/sessions');
      if (res.ok) {
        const data = await res.json();
        const incoming = Array.isArray(data) ? data : (data.sessions || []);
        const previous = state.sessions || [];
        let differs = incoming.length !== previous.length;
        if (!differs) {
          // Length alone misses replacements/deletes made on another device.
          for (let i = 0; i < incoming.length; i++) {
            if (String(incoming[i].id) !== String(previous[i].id)) {
              differs = true;
              break;
            }
          }
        }

        if (differs) {
          state.sessions = incoming;
          invalidateSessionIndex();
          saveState();
        }
        historyArchiveFetchedAt = Date.now();

        const dialog = document.getElementById('sessions-history-dialog');
        if (dialog && dialog.open && (differs || !activeHistoryScroller)) {
          renderHistoryDialogDOM();
        }
      }
    } catch (e) {
      console.warn('StudyArk: Could not refresh sessions archive:', e);
      const dialog = document.getElementById('sessions-history-dialog');
      if (dialog && dialog.open && !activeHistoryScroller) {
        renderHistoryDialogDOM();
      }
    } finally {
      historyArchiveRefreshPending = false;
    }
  }

  function scheduleHistoryArchiveRefresh() {
    if (historyArchiveRefreshPending) return;
    if (Date.now() - historyArchiveFetchedAt < HISTORY_ARCHIVE_TTL_MS) return;

    // Never make the modal wait on the network: refresh after the open frame
    // has been painted, or when the main thread is otherwise idle.
    if (window.requestIdleCallback) {
      window.requestIdleCallback(() => refreshHistoryArchive(), { timeout: 2000 });
    } else {
      setTimeout(() => refreshHistoryArchive(), 250);
    }
  }

  async function openHistoryDialog() {
    const dialog = document.getElementById('sessions-history-dialog');
    if (!dialog) return;

    pauseAmbientCanvas();

    // Clear any text selection that may have occurred
    if (window.getSelection) {
      window.getSelection().removeAllRanges();
    }

    // 1. Open modal first so container has active layout in the render tree
    if (typeof dialog.showModal === 'function' && !dialog.open) {
      dialog.showModal();
    }

    // Direct focus to the close button so browser never text-selects anything
    const closeBtn = document.getElementById('btn-close-history-dialog');
    if (closeBtn) {
      try { closeBtn.focus({ preventScroll: true }); } catch (e) {}
    } else if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }

    globalLenis?.stop();

    // 2. Reset container and render fresh while dialog is open and visible
    resetHistoryContainer(true);

    // If sessions are already in state, render immediately with zero delay
    if (state.sessions && state.sessions.length > 0) {
      renderHistoryDialogDOM({ animateEntrance: true });
    } else {
      // Show smooth emerald skeleton placeholder while fetching
      const feedList = document.getElementById('history-feed-list');
      if (feedList) {
        feedList.innerHTML = `
          <div class="day-session-skeleton" style="margin-bottom: 0.55rem;"></div>
          <div class="day-session-skeleton" style="margin-bottom: 0.55rem;"></div>
          <div class="day-session-skeleton" style="margin-bottom: 0.55rem;"></div>
          <div class="day-session-skeleton" style="margin-bottom: 0.55rem;"></div>
        `;
      }
    }

    // 3. The initial /api/state payload already contains the archive, so the
    // modal never waits on the network. Only refresh stale data in idle time.
    if (state.sessions && state.sessions.length > 0) {
      scheduleHistoryArchiveRefresh();
    } else {
      refreshHistoryArchive(true);
    }
  }

  function closeHistoryDialog() {
    closeHistoryCalendarModal();
    const dialog = document.getElementById('sessions-history-dialog');
    if (dialog && dialog.open) {
      dialog.close();
    }
    // Reset container as soon as we leave, as if starting from beginning
    resetHistoryContainer(true);
    globalLenis?.start();
    resumeAmbientCanvas();
  }

  function getHistoryScrollerData() {
    ensureSessionIndex();
    if (sessionDataIndex.historyScrollerData) {
      return sessionDataIndex.historyScrollerData;
    }

    if (!sessionDataIndex.sortedDesc) {
      const sessions = (state.sessions || []).slice();
      sessions.sort((a, b) => (b._ts || 0) - (a._ts || 0));
      sessionDataIndex.sortedDesc = sessions;
    }
    const allSessions = sessionDataIndex.sortedDesc;

    // Group sessions by date, then render dates newest-first.
    const dateMap = new Map();
    for (let i = 0; i < allSessions.length; i++) {
      const s = allSessions[i];
      const d = s.date;
      let list = dateMap.get(d);
      if (!list) {
        list = [];
        dateMap.set(d, list);
      }
      list.push(s);
    }

    const totalSessions = allSessions.length;
    let totalFocusSec = state.totalFocusSeconds || 0;
    if (!totalFocusSec) {
      for (let i = 0; i < allSessions.length; i++) {
        totalFocusSec += (allSessions[i].durationMinutes || allSessions[i].duration_minutes || 0) * 60;
      }
    }
    const activeDaysCount = dateMap.size;

    const virtualItems = [];
    const dateHeaderIndices = {};

    const orderedDateKeys = Array.from(dateMap.keys()).sort((a, b) => String(b).localeCompare(String(a)));
    for (const dateStr of orderedDateKeys) {
      const daySessions = (dateMap.get(dateStr) || [])
        .slice()
        .sort((a, b) => (b._ts || b.timestamp || 0) - (a._ts || a.timestamp || 0));
      const fullDateStr = formatDayDateHeader(dateStr);
      let dayTotalMins = 0;
      for (let j = 0; j < daySessions.length; j++) {
        dayTotalMins += (daySessions[j].durationMinutes || daySessions[j].duration_minutes || 0);
      }
      const badgeText = getShortDateBadge(dateStr);

      dateHeaderIndices[dateStr] = virtualItems.length;
      virtualItems.push({
        type: 'header',
        date: dateStr,
        fullDate: fullDateStr,
        badge: badgeText,
        sessionsCount: daySessions.length,
        totalMins: dayTotalMins,
        height: 52
      });

      for (let j = 0; j < daySessions.length; j++) {
        const s = daySessions[j];
        s.fullDate = fullDateStr;
        virtualItems.push({
          type: 'session',
          session: s,
          date: dateStr,
          height: 64
        });
      }
    }

    sessionDataIndex.historyScrollerData = {
      virtualItems,
      dateHeaderIndices,
      stats: {
        totalSessions,
        totalFocusSec,
        activeDaysCount
      }
    };
    return sessionDataIndex.historyScrollerData;
  }

  function applyHistorySummaryPills(stats) {
    const { totalSessions, totalFocusSec, activeDaysCount } = stats;

    const pillTotalTime = document.getElementById('history-pill-total-time');
    const pillSessions = document.getElementById('history-pill-sessions-count');
    const pillDays = document.getElementById('history-pill-days-count');

    if (pillTotalTime) pillTotalTime.textContent = formatHoursMinutes(totalFocusSec);
    if (pillSessions) pillSessions.textContent = totalSessions.toLocaleString();
    if (pillDays) pillDays.textContent = activeDaysCount.toLocaleString();
  }

  // Cheap summary-only refresh used by renderStats(). It must never rebuild the
  // virtualized feed, otherwise every stats update (including the synchronous
  // and asynchronous parts of a delete) replays all card entrance animations.
  function updateHistoryDialogSummary() {
    const dialog = document.getElementById('sessions-history-dialog');
    if (!dialog || !dialog.open) return;
    applyHistorySummaryPills(getHistoryScrollerData().stats);
  }

  function renderHistoryDialogDOM({ animateEntrance = false } = {}) {
    const dialog = document.getElementById('sessions-history-dialog');
    if (!dialog) return;

    const feedList = document.getElementById('history-feed-list');
    if (!feedList) return;

    // Capture the current scroll position before the feed is torn down so
    // in-place refreshes (delete, archive sync) never jump back to the top.
    const hadActiveScroller = !!activeHistoryScroller;
    const previousScrollTop = activeHistoryScroller
      ? activeHistoryScroller.container.scrollTop
      : (feedList.scrollTop || 0);

    if (activeHistoryScroller) {
      try { activeHistoryScroller.destroy(); } catch (e) {}
      activeHistoryScroller = null;
    }
    if (activeHistoryCleanup) {
      try { activeHistoryCleanup(); } catch (e) {}
      activeHistoryCleanup = null;
    }

    const data = getHistoryScrollerData();
    const { totalSessions } = data.stats;

    applyHistorySummaryPills(data.stats);

    // Handle Empty State
    if (totalSessions === 0) {
      feedList.scrollTop = 0;
      feedList.innerHTML = `
        <div class="history-empty-card">
          <div class="history-empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
          </div>
          <div class="history-empty-title">No sessions recorded yet</div>
          <div class="history-empty-sub">Start a focus timer on the homescreen to begin your chronicle.</div>
        </div>
      `;
      return;
    }

    // Instantiate VirtualHistoryScroller with precomputed virtual items.
    // Only an explicit dialog open animates the initial batch of cards; data
    // refreshes keep the feed visually stable.
    activeHistoryScroller = new VirtualHistoryScroller({
      container: feedList,
      virtualItems: data.virtualItems,
      dateHeaderIndices: data.dateHeaderIndices,
      renderSessionCard: createHistorySessionCard,
      renderDateHeader: createHistoryDateHeader,
      // A feed that was previously empty (skeleton/empty state) should still
      // get its first entrance animation; a rebuild over existing cards should not.
      animateInitial: animateEntrance || !hadActiveScroller,
      initialScrollTop: previousScrollTop
    });
  }

  function refreshOpenHistoryDialog(options = {}) {
    const dialog = document.getElementById('sessions-history-dialog');
    if (!dialog || !dialog.open) return false;
    renderHistoryDialogDOM(options);
    return true;
  }

  // =========================================================================
  // THEMED CONFIRMATION DIALOG (DESTRUCTIVE ACTIONS)
  // =========================================================================
  let confirmDialogResolve = null;

  function setConfirmPill(pillEl, value) {
    if (!pillEl) return false;
    const text = value ? String(value).trim() : '';
    pillEl.textContent = text;
    pillEl.classList.toggle('hidden', !text);
    return !!text;
  }

  function setConfirmPillRow(rowEl, visible) {
    if (rowEl) rowEl.classList.toggle('hidden', !visible);
  }

  function confirmAction({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', variant = 'delete', pills = null } = {}) {
    const dialog = document.getElementById('confirm-dialog');
    if (!dialog || typeof dialog.showModal !== 'function') {
      console.warn('StudyArk: Confirmation dialog is unavailable.');
      return Promise.resolve(false);
    }

    // A modal confirmation is already open (for example, a rapid double-click).
    if (confirmDialogResolve || dialog.open) {
      return Promise.resolve(false);
    }

    const titleEl = document.getElementById('confirm-dialog-title');
    const messageEl = document.getElementById('confirm-dialog-message');
    const confirmBtn = document.getElementById('confirm-dialog-confirm');
    const cancelBtn = document.getElementById('confirm-dialog-cancel');
    const trashIcon = document.getElementById('confirm-dialog-icon-trash');
    const warningIcon = document.getElementById('confirm-dialog-icon-warning');
    const pillsEl = document.getElementById('confirm-dialog-pills');
    const pillTask = document.getElementById('confirm-pill-task');
    const pillDate = document.getElementById('confirm-pill-date');
    const pillTime = document.getElementById('confirm-pill-time');
    const pillDuration = document.getElementById('confirm-pill-duration');
    const pillXp = document.getElementById('confirm-pill-xp');
    const pillRowTask = document.getElementById('confirm-pill-row-task');
    const pillRowDate = document.getElementById('confirm-pill-row-date');
    const pillRowStats = document.getElementById('confirm-pill-row-stats');

    const isReset = variant === 'reset';
    const hasPills = !!(pills && (pills.task || pills.date || pills.time || pills.duration || pills.xp));

    if (titleEl) titleEl.textContent = title;
    if (messageEl) {
      messageEl.textContent = message;
      messageEl.classList.toggle('hidden', hasPills);
    }
    if (pillsEl) pillsEl.classList.toggle('hidden', !hasPills);
    if (hasPills) {
      const hasTask = setConfirmPill(pillTask, pills.task);
      const hasDate = setConfirmPill(pillDate, pills.date);
      const hasTime = setConfirmPill(pillTime, pills.time);
      const hasDuration = setConfirmPill(pillDuration, pills.duration);
      const hasXp = setConfirmPill(pillXp, pills.xp);
      setConfirmPillRow(pillRowTask, hasTask);
      setConfirmPillRow(pillRowDate, hasDate || hasTime);
      setConfirmPillRow(pillRowStats, hasDuration || hasXp);
    }
    if (confirmBtn) confirmBtn.textContent = confirmLabel;
    if (trashIcon) trashIcon.classList.toggle('hidden', isReset);
    if (warningIcon) warningIcon.classList.toggle('hidden', !isReset);

    pauseAmbientCanvas();

    try {
      dialog.showModal();
    } catch (err) {
      console.warn('StudyArk: Could not open confirmation dialog:', err);
      resumeAmbientCanvas();
      return Promise.resolve(false);
    }

    // Safe default: focus stays on Cancel so Enter/Escape never destroys data.
    requestAnimationFrame(() => {
      try {
        cancelBtn?.focus({ preventScroll: true });
      } catch (_) {
        cancelBtn?.focus();
      }
    });

    return new Promise((resolve) => {
      confirmDialogResolve = resolve;
    });
  }

  function closeConfirmDialog(result) {
    const dialog = document.getElementById('confirm-dialog');
    const resolve = confirmDialogResolve;
    confirmDialogResolve = null;

    if (resolve) resolve(!!result);
    if (dialog && dialog.open) {
      dialog.close();
    }
    resumeAmbientCanvas();
  }

  function initConfirmDialog() {
    const dialog = document.getElementById('confirm-dialog');
    if (!dialog) return;

    const confirmBtn = document.getElementById('confirm-dialog-confirm');
    const cancelBtn = document.getElementById('confirm-dialog-cancel');

    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => closeConfirmDialog(true));
    }
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => closeConfirmDialog(false));
    }

    dialog.addEventListener('click', (e) => {
      if (e.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const isInDialog = (
        rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
        rect.left <= e.clientX && e.clientX <= rect.left + rect.width
      );
      if (!isInDialog) {
        closeConfirmDialog(false);
      }
    });

    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      closeConfirmDialog(false);
    });

    dialog.addEventListener('close', () => {
      // Ignore a stale close event if the dialog was reopened immediately.
      if (dialog.open) return;
      if (confirmDialogResolve) {
        const resolve = confirmDialogResolve;
        confirmDialogResolve = null;
        resolve(false);
      }
      resumeAmbientCanvas();
    });
  }

  function getSessionDeleteConfirmOptions(btnOrData, dateStr) {
    let duration = 0;
    let subject = '';
    let taskNote = '';
    let timeRange = '';
    let xpText = '';
    let xpVal = 0;

    if (btnOrData instanceof Element) {
      const card = btnOrData.closest('.day-session-card, .history-session-card');
      duration = parseInt(card?.getAttribute('data-duration') || btnOrData.getAttribute('data-duration') || '', 10) || 0;
      subject = card?.querySelector('.day-session-subject, .history-session-subject')?.textContent?.trim() || btnOrData.getAttribute('data-subject') || '';
      taskNote = card?.querySelector('.history-session-task, .day-session-task')?.textContent?.trim() || '';
      timeRange = card?.querySelector('.day-session-timerange, .history-session-timerange')?.textContent?.trim() || btnOrData.getAttribute('data-timerange') || '';
      xpText = card?.querySelector('.day-session-xp, .history-session-xp')?.textContent?.trim() || '';
      xpVal = parseInt(card?.getAttribute('data-xp') || btnOrData.getAttribute('data-xp') || '', 10) || (duration * 10);
    } else if (btnOrData && typeof btnOrData === 'object') {
      duration = Number(btnOrData.durationMinutes || btnOrData.duration_minutes || btnOrData.duration || 0);
      subject = btnOrData.subject || btnOrData.subject_name || '';
      taskNote = btnOrData.taskName || btnOrData.task_name || '';
      timeRange = btnOrData.timeRange || (btnOrData.startTime && btnOrData.endTime ? `${btnOrData.startTime} – ${btnOrData.endTime}` : '');
      xpVal = btnOrData.xp != null ? btnOrData.xp : (duration * 10);
      xpText = `+${formatCompactNumber(xpVal)} XP`;
    }

    const dateLabel = dateStr ? formatDayDateHeader(dateStr) : '';

    return {
      title: 'Delete Session Permanently?',
      confirmLabel: 'Delete',
      pills: {
        task: subject && subject !== 'Focus Session' ? subject : (taskNote || subject || 'Focus Session'),
        date: dateLabel,
        time: timeRange,
        duration: duration > 0 ? `${duration} min` : '',
        xp: xpText || (xpVal > 0 ? `+${formatCompactNumber(xpVal)} XP` : '')
      }
    };
  }

  function deleteSession(sessionId, dateStr) {
    if (!sessionId) return Promise.resolve();
    const rawId = String(sessionId).replace(/^sess_/, '');
    const cachedSession = sessionLookupCache.get(String(sessionId)) || sessionLookupCache.get(rawId) || null;
    sessionLookupCache.delete(String(sessionId));
    sessionLookupCache.delete(rawId);

    // The delete button also carries data-session-id, so scope the selector to
    // actual card elements. Matching the button as a second "card" used to run
    // the dismiss animation twice and rebuild the history feed twice.
    const targetCards = Array.from(document.querySelectorAll(
      '.day-session-card[data-session-id], .history-session-card[data-session-id]'
    )).filter(el => {
      const cardId = String(el.getAttribute('data-session-id') || '').replace(/^sess_/, '');
      return cardId === rawId || (cachedSession && cachedSession.timestamp && cardId === String(cachedSession.timestamp));
    });
    const cardEl = targetCards[0] || null;

    // 1. Identify session duration from client state, card dataset, or cachedSession
    const idx = (state.sessions || []).findIndex(s => {
      const sId = String(s.id || '').replace(/^sess_/, '');
      const sTs = s.timestamp ? String(s.timestamp) : '';
      return sId === rawId || sTs === rawId;
    });
    let duration = 0;
    let sessionXp = 0;
    let sessionStartMs = null;
    let sessionEndMs = null;
    let sessionDate = dateStr;

    if (idx !== -1) {
      const sess = state.sessions[idx];
      duration = sess.durationMinutes || sess.duration_minutes || 0;
      sessionXp = sess.xp != null ? sess.xp : (duration * 10);
      sessionStartMs = sess.sessionStartMs || sess.session_start_ms || null;
      sessionEndMs = sess.sessionEndMs || sess.session_end_ms || null;
      sessionDate = sess.date || dateStr;
      state.sessions.splice(idx, 1);
      invalidateSessionIndex();
    } else if (cardEl) {
      duration = parseInt(cardEl.dataset.duration || cardEl.querySelector('.day-session-duration')?.textContent || '0', 10) || 0;
      sessionXp = parseInt(cardEl.dataset.xp || '0', 10) || (duration * 10);
      sessionStartMs = cardEl.dataset.sessionStartMs ? parseInt(cardEl.dataset.sessionStartMs, 10) : null;
      sessionEndMs = cardEl.dataset.sessionEndMs ? parseInt(cardEl.dataset.sessionEndMs, 10) : null;
    } else if (cachedSession) {
      duration = Number(cachedSession.durationMinutes || cachedSession.duration_minutes || 0);
      sessionXp = cachedSession.xp != null ? cachedSession.xp : (duration * 10);
      sessionStartMs = cachedSession.sessionStartMs || cachedSession.session_start_ms || null;
      sessionEndMs = cachedSession.sessionEndMs || cachedSession.session_end_ms || null;
      sessionDate = cachedSession.date || dateStr;
    }

    // 2. Update day activity and gamification stats immediately
    let isOvernight = false;
    let sDate = sessionDate;
    let eDate = sessionDate;
    let day1Mins = duration;
    let day2Mins = 0;

    if (sessionStartMs && sessionEndMs) {
      sDate = getLocalDateString(new Date(sessionStartMs));
      eDate = getLocalDateString(new Date(sessionEndMs));
      if (sDate !== eDate) {
        isOvernight = true;
        const eD = new Date(sessionEndMs);
        const midnightMs = new Date(eD.getFullYear(), eD.getMonth(), eD.getDate(), 0, 0, 0, 0).getTime();
        const d1Wall = Math.max(0, (midnightMs - sessionStartMs) / 1000);
        const d2Wall = Math.max(0, (sessionEndMs - midnightMs) / 1000);
        const totalWall = d1Wall + d2Wall;
        if (totalWall > 0) {
          day1Mins = Math.round(duration * (d1Wall / totalWall));
          day2Mins = Math.max(0, duration - day1Mins);
        }
      }
    }
    if (!isOvernight) {
      const eStr = (cachedSession && cachedSession.endTime) || (idx !== -1 && state.sessions[idx] && state.sessions[idx].endTime) || '';
      if (eStr.includes('(+1d)')) {
        isOvernight = true;
        sDate = sessionDate;
        try {
          const dObj = new Date(sessionDate + 'T00:00:00');
          dObj.setDate(dObj.getDate() + 1);
          eDate = getLocalDateString(dObj);
        } catch (_) {
          eDate = sessionDate;
        }
        day1Mins = Math.max(1, Math.floor(duration / 2));
        day2Mins = Math.max(1, duration - day1Mins);
      }
    }

    if (state.dayActivity) {
      if (isOvernight) {
        if (sDate && state.dayActivity[sDate] !== undefined) {
          state.dayActivity[sDate] = Math.max(0, state.dayActivity[sDate] - day1Mins);
          if (state.dayActivity[sDate] === 0) delete state.dayActivity[sDate];
        }
        if (eDate && state.dayActivity[eDate] !== undefined) {
          state.dayActivity[eDate] = Math.max(0, state.dayActivity[eDate] - day2Mins);
          if (state.dayActivity[eDate] === 0) delete state.dayActivity[eDate];
        }
      } else if (dateStr && state.dayActivity[dateStr] !== undefined) {
        state.dayActivity[dateStr] = Math.max(0, state.dayActivity[dateStr] - duration);
        if (state.dayActivity[dateStr] === 0) {
          delete state.dayActivity[dateStr];
        }
      }
    }
    state.xp = Math.max(0, (state.xp || 0) - sessionXp);
    state.totalFocusSeconds = Math.max(0, (state.totalFocusSeconds || 0) - duration * 60);
    updateStreak();

    // 3. Update or invalidate dayDetailsCache
    const targetDates = isOvernight ? [sDate, eDate].filter(Boolean) : (dateStr ? [dateStr] : []);
    targetDates.forEach(dStr => {
      if (dayDetailsCache.has(dStr)) {
        const cached = dayDetailsCache.get(dStr);
        if (cached && Array.isArray(cached.sessions)) {
          const deductMins = (isOvernight && dStr === eDate) ? day2Mins : (isOvernight && dStr === sDate ? day1Mins : duration);
          cached.sessions = cached.sessions.filter(s => {
            const sId = String(s.id || '').replace(/^sess_/, '');
            const sTs = s.timestamp ? String(s.timestamp) : '';
            return sId !== rawId && sTs !== rawId;
          });
          cached.totalMinutes = Math.max(0, (cached.totalMinutes || 0) - deductMins);
          cached.totalSessions = cached.sessions.length;
          cached.avgFocusMinutes = cached.totalSessions > 0 ? Math.round(cached.totalMinutes / cached.totalSessions) : 0;
          const hrs = Math.floor(cached.totalMinutes / 60);
          const mins = cached.totalMinutes % 60;
          cached.totalTimeFormatted = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
          cached.totalXp = cached.sessions.reduce((acc, s) => acc + (s.xp != null ? s.xp : ((s.durationMinutes || 0) * 10)), 0);
          dayDetailsCache.set(dStr, cached);
        } else {
          dayDetailsCache.delete(dStr);
        }
      }
    });

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
    let dayTotalXp = 0;

    if (dateStr && dayDetailsCache.has(dateStr)) {
      const c = dayDetailsCache.get(dateStr);
      dayTotalMins = c.totalMinutes || 0;
      dayTotalSess = c.totalSessions || 0;
      dayAvgMins = c.avgFocusMinutes || 0;
      dayTotalXp = c.totalXp || (dayTotalMins * 10);
    } else {
      const matching = (state.sessions || []).filter(s => s.date === dateStr);
      matching.forEach(s => {
        const d = (s.durationMinutes || s.duration_minutes || 0);
        dayTotalMins += d;
        dayTotalXp += (s.xp || (d * 10));
      });
      dayTotalSess = matching.length;
      dayAvgMins = dayTotalSess > 0 ? Math.round(dayTotalMins / dayTotalSess) : 0;
    }

    const hrs = Math.floor(dayTotalMins / 60);
    const mins = dayTotalMins % 60;
    const formattedTotal = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

    if (timeEl) timeEl.textContent = formattedTotal;
    if (sessEl) sessEl.textContent = dayTotalSess;
    if (avgEl) avgEl.textContent = `${dayAvgMins}m`;
    if (xpEl) xpEl.textContent = `+${formatCompactNumber(dayTotalXp)} XP`;
    if (countEl) countEl.textContent = `${dayTotalSess} session${dayTotalSess === 1 ? '' : 's'}`;

    saveState();
    renderStats();
    renderHeatmap();
    updateTodayLiveStat();

    // 5. Exact dismiss animation from Taski:
    // Lock measured natural height, then double-rAF to transition height to 0, margin-bottom to -0.65rem,
    // transform translateX(-50%) scale(0.85), opacity to 0, and red tint
    if (targetCards.length > 0) {
      targetCards.forEach((cEl) => {
        cEl.style.pointerEvents = 'none';
        cEl.style.overflow = 'hidden';

        const h = cEl.offsetHeight;
        cEl.style.height = h + 'px';

        const dot = cEl.querySelector('.day-session-orb') || cEl.querySelector('.history-session-orb') || cEl.querySelector('.day-session-dot');
        if (dot) {
          dot.style.transition = 'background-color 0.2s, box-shadow 0.2s';
          dot.style.backgroundColor = '#ef4444';
          dot.style.boxShadow = '0 0 8px #ef4444';
        }
        const trackNode = cEl.querySelector('.day-session-track-node') || cEl.querySelector('.history-session-track-node');
        if (trackNode) {
          trackNode.style.transition = 'background-color 0.2s, box-shadow 0.2s';
          trackNode.style.backgroundColor = '#ef4444';
          trackNode.style.boxShadow = '0 0 8px #ef4444';
        }
        const subj = cEl.querySelector('.day-session-subject') || cEl.querySelector('.history-session-subject');
        if (subj) {
          subj.style.transition = 'color 0.2s';
          subj.style.color = '#fca5a5';
        }

        // Double-rAF batching: set transition in frame 1, animate in frame 2
        requestAnimationFrame(() => {
          cEl.style.transition = 'transform 0.28s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease-out, height 0.28s cubic-bezier(0.22, 1, 0.36, 1), margin-bottom 0.28s cubic-bezier(0.22, 1, 0.36, 1), padding 0.28s cubic-bezier(0.22, 1, 0.36, 1), border-width 0.22s ease-out, background 0.2s, border-color 0.2s';

          requestAnimationFrame(() => {
            cEl.style.transform = 'translateX(-50%) scale(0.85)';
            cEl.style.opacity = '0';
            cEl.style.height = '0px';
            cEl.style.marginBottom = '-0.55rem';
            cEl.style.paddingTop = '0px';
            cEl.style.paddingBottom = '0px';
            cEl.style.borderTopWidth = '0px';
            cEl.style.borderBottomWidth = '0px';
            cEl.style.background = 'rgba(239, 68, 68, 0.18)';
            cEl.style.borderColor = 'rgba(239, 68, 68, 0.45)';
          });
        });

        let cleanedUp = false;
        const finishDismiss = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          if (cEl && cEl.parentNode) {
            cEl.remove();
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
          const histDlg = document.getElementById('sessions-history-dialog');
          if (histDlg && histDlg.open) {
            renderHistoryDialogDOM();
          }
        };

        cEl.addEventListener('transitionend', function handler(e) {
          if (e.propertyName !== 'height') return;
          cEl.removeEventListener('transitionend', handler);
          finishDismiss();
        });
        setTimeout(finishDismiss, 350);
      });
    } else {
      const dayDlg = document.getElementById('day-detail-dialog');
      if (dayDlg && dayDlg.open && currentDialogDate) {
        const updatedDay = getDayDataFromClient(currentDialogDate);
        if (updatedDay) {
          renderDayDialogDOM(updatedDay);
        } else {
          openDayDialog(currentDialogDate);
        }
      }
      const histDlg = document.getElementById('sessions-history-dialog');
      if (histDlg && histDlg.open) {
        renderHistoryDialogDOM();
      }
    }

    // 6. Fire backend deletion in the background
    const clientDate = getLocalDateString();
    return fetch(`/api/sessions/${encodeURIComponent(sessionId)}?date=${encodeURIComponent(clientDate)}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Date': clientDate
      }
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
            invalidateSessionIndex();
          }
          if (backendPayload.dayDetails && backendPayload.dayDetails.date) {
            dayDetailsCache.set(backendPayload.dayDetails.date, backendPayload.dayDetails);
          }
          saveState();
          renderStats();
          renderHeatmap();
          updateTodayLiveStat();
        }
      } else {
        // Fallback POST /api/sessions/<sessionId>/delete in case DELETE method was restricted
        console.warn(`StudyArk: DELETE /api/sessions returned ${res.status}. Attempting fallback POST deletion...`);
        const fallbackRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/delete?date=${encodeURIComponent(clientDate)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Client-Date': clientDate
          }
        });
        if (fallbackRes.ok) {
          const backendPayload = await fallbackRes.json();
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
              invalidateSessionIndex();
            }
            if (backendPayload.dayDetails && backendPayload.dayDetails.date) {
              dayDetailsCache.set(backendPayload.dayDetails.date, backendPayload.dayDetails);
            }
            saveState();
            renderStats();
            renderHeatmap();
            updateTodayLiveStat();
          }
        } else {
          console.error(`StudyArk: Fallback deletion also failed (${fallbackRes.status})`);
        }
      }
    }).catch((err) => {
      console.warn('StudyArk: Background session deletion notice:', err);
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
  // LIVE TEMPORAL DRIFT & CALENDAR/HEATMAP ROLLOVER MONITOR
  // Detects midnight (day rollover) and new month arrivals in real-time,
  // automatically regenerating the heatmap for new months, moving today's
  // highlight, updating stats, and unlocking live calendar bounds.
  // =========================================================================
  let liveMonitorDateStr = getLocalDateString();
  let liveMonitorMonth = new Date().getMonth();
  let liveMonitorYear = new Date().getFullYear();
  let liveMonitorInterval = null;

  function checkLiveTimeRollover() {
    const now = new Date();
    const currentDateStr = getLocalDateString(now);
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const monthChanged = (currentMonth !== liveMonitorMonth || currentYear !== liveMonitorYear);
    const dayChanged = (currentDateStr !== liveMonitorDateStr);

    if (!monthChanged && !dayChanged) return;

    liveMonitorDateStr = currentDateStr;
    liveMonitorMonth = currentMonth;
    liveMonitorYear = currentYear;

    // 1. Heatmap live update:
    // If month changed, new month arrived -> rebuild heatmap so the new month block is generated!
    // If only day changed, update today's highlighted cell in the heatmap ring.
    if (monthChanged) {
      renderHeatmap(true);
    } else {
      updateHeatmapCells();
    }

    // 2. Stats & streak live update for today
    renderStats();
    updateTodayLiveStat();

    // 3. Calendar live update:
    // Update live calendar bounds (unlocking newly arrived month/day)
    const calDialog = document.getElementById('history-calendar-dialog');
    if (calDialog && calDialog.open) {
      if (isDialViewOpen) {
        buildDialDrums();
        syncDialMonthLimit();
      } else {
        renderHistoryCalendarGrid();
      }
    }
  }

  function initLiveTimeTicker() {
    if (liveMonitorInterval) return;
    liveMonitorDateStr = getLocalDateString();
    liveMonitorMonth = new Date().getMonth();
    liveMonitorYear = new Date().getFullYear();

    // Check every 5 seconds for smooth, reliable midnight and month roll
    liveMonitorInterval = setInterval(checkLiveTimeRollover, 5000);

    // Immediate check whenever user returns to the tab (e.g. computer woke up from sleep next day/month)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        checkLiveTimeRollover();
      }
    });

    window.addEventListener('focus', checkLiveTimeRollover);
  }

  // =========================================================================
  // EVENT LISTENERS & SETUP
  // =========================================================================
  function initEvents() {
    initConfirmDialog();
    initLiveTimeTicker();

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

    // 4. Prevent vertical document scroll, bounce, and rubberbanding on mobile.
    // Any open dialog exposes native touch scrolling for its inner feeds
    // (session history, day detail, levels, calendar) instead of blocking it.
    document.addEventListener('touchmove', (e) => {
      if (e.target && e.target.closest && e.target.closest('dialog[open], #view-settings, .panel-inner, .heatmap-scroll-area')) {
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

    // Header quick-duration preset pills (25m / 1h / 2h / 3h)
    initHeaderPresets();

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

    // Day Sessions List: Delete session action and card inspection via event delegation
    const daySessionsList = document.getElementById('day-sessions-list');
    if (daySessionsList) {
      daySessionsList.addEventListener('click', async (e) => {
        const btn = e.target.closest('.day-session-delete-btn');
        if (btn) {
          if (btn.disabled) return;
          e.preventDefault();
          e.stopPropagation();

          const sessionId = btn.getAttribute('data-session-id');
          const dateStr = btn.getAttribute('data-date');
          if (!sessionId) return;

          const confirmed = await confirmAction(getSessionDeleteConfirmOptions(btn, dateStr));
          if (!confirmed) return;

          btn.disabled = true;
          if (typeof btn.blur === 'function') {
            btn.blur();
          }
          await deleteSession(sessionId, dateStr);
          return;
        }

        const card = e.target.closest('.day-session-card');
        if (card) {
          const sessId = card.getAttribute('data-session-id');
          if (sessId) {
            let sessObj = sessionLookupCache.get(String(sessId));
            if (!sessObj && currentDialogDate && dayDetailsCache.has(currentDialogDate)) {
              const d = dayDetailsCache.get(currentDialogDate);
              sessObj = (d.sessions || []).find(x => String(x.id) === String(sessId));
            }
            openSessionDetailDialog(sessId, sessObj);
          }
        }
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
        // Clicks on dialog content are never backdrop clicks. Re-checking
        // coordinates after a content re-layout could otherwise dismiss it.
        if (e.target.closest('.day-dialog-shell')) return;
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
        // Switching to the catalog re-layouts the dialog. Without this guard
        // the coordinate check below can treat that click as a backdrop hit
        // and close the dialog immediately.
        if (e.target.closest('.day-dialog-shell')) return;
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

    // Sessions History Dialog: Open via clicking or Enter on Total Focus pill
    const statItemTotal = document.getElementById('stat-item-total');
    if (statItemTotal) {
      statItemTotal.addEventListener('click', (e) => {
        e.stopPropagation();
        openHistoryDialog();
      });
      statItemTotal.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openHistoryDialog();
        }
      });
    }

    // Sessions History Dialog: Close button
    const btnCloseHistory = document.getElementById('btn-close-history-dialog');
    if (btnCloseHistory) {
      btnCloseHistory.addEventListener('click', closeHistoryDialog);
    }
    initHistoryCalendarEvents();

    // Sessions History Feed: Delete session action and card inspection via event delegation
    const historyFeedList = document.getElementById('history-feed-list');
    if (historyFeedList) {
      historyFeedList.addEventListener('click', async (e) => {
        const btn = e.target.closest('.history-session-delete-btn');
        if (btn) {
          if (btn.disabled) return;
          e.preventDefault();
          e.stopPropagation();

          const sessionId = btn.getAttribute('data-session-id');
          const dateStr = btn.getAttribute('data-date');
          if (!sessionId) return;

          const confirmed = await confirmAction(getSessionDeleteConfirmOptions(btn, dateStr));
          if (!confirmed) return;

          btn.disabled = true;
          if (typeof btn.blur === 'function') {
            btn.blur();
          }
          await deleteSession(sessionId, dateStr);
          return;
        }

        const card = e.target.closest('.history-session-card');
        if (card) {
          const sessId = card.getAttribute('data-session-id');
          if (sessId) {
            openSessionDetailDialog(sessId);
          }
        }
      });
    }

    // Sessions History Dialog: backdrop click & native cancel/close light-dismiss fallback
    const historyDialog = document.getElementById('sessions-history-dialog');
    if (historyDialog) {
      historyDialog.addEventListener('click', (e) => {
        if (e.target.closest('.day-dialog-shell')) return;
        const rect = historyDialog.getBoundingClientRect();
        const isInDialog = (
          rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
          rect.left <= e.clientX && e.clientX <= rect.left + rect.width
        );
        if (!isInDialog) {
          closeHistoryDialog();
        }
      });
      historyDialog.addEventListener('cancel', () => {
        closeHistoryDialog();
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

    const auraToggle = document.getElementById('setting-aura-enabled');
    if (auraToggle) {
      let auraSettingsRequestId = 0;
      auraToggle.checked = state.auraEnabled !== false;
      auraToggle.addEventListener('change', async () => {
        const nextValue = auraToggle.checked;
        const previousValue = state.auraEnabled !== false;
        const requestId = ++auraSettingsRequestId;

        // Optimistic apply so the change is instant on this device.
        state.auraEnabled = nextValue;
        saveState();
        applyAuraPreference();

        try {
          const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ auraEnabled: nextValue })
          });
          if (!res.ok) throw new Error(`Settings update failed (${res.status})`);
          const data = await res.json();
          if (requestId !== auraSettingsRequestId) return;
          if (data && typeof data.auraEnabled !== 'undefined') {
            state.auraEnabled = !!data.auraEnabled;
          } else if (data && data.preferences && typeof data.preferences.auraEnabled !== 'undefined') {
            state.auraEnabled = !!data.preferences.auraEnabled;
          }
          auraToggle.checked = state.auraEnabled !== false;
          saveState();
          applyAuraPreference();
        } catch (err) {
          if (requestId !== auraSettingsRequestId) return;
          console.warn('StudyArk: Could not sync aura preference:', err);
          state.auraEnabled = previousValue;
          auraToggle.checked = previousValue;
          saveState();
          applyAuraPreference();
          showToast('Could not save preference. Please try again.');
        }
      });
    }

    const btnWipeData = document.getElementById('btn-wipe-data');
    if (btnWipeData) {
      btnWipeData.addEventListener('click', async () => {
        const confirmed = await confirmAction({
          title: 'Reset all progress?',
          message: 'This permanently deletes every session log, streak, and XP point from the database. This cannot be undone.',
          confirmLabel: 'Reset everything',
          variant: 'reset'
        });
        if (!confirmed) return;

        try {
          const res = await fetch('/api/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reseed: false })
          });
          if (!res.ok) throw new Error(`Reset failed (${res.status})`);

          state.xp = 0;
          state.streak = 0;
          state.totalFocusSeconds = 0;
          state.dayActivity = {};
          state.sessions = [];
          state.subjects = [];
          dayDetailsCache.clear();
          invalidateSessionIndex();
          state.timer.targetSeconds = 60 * 60;
          state.timer.remainingSeconds = 60 * 60;
          state.timer.status = 'idle';
          saveState();
          renderAll();
          switchView('focus');
          showToast('All progress has been reset.');
        } catch (e) {
          console.error('Failed to wipe data:', e);
          showToast('Could not reset progress. Please try again.');
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

    // Keep the task prompt centered in the visible area while the iOS
    // keyboard opens, closes, or the page pans.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', scheduleTaskPromptViewportSync, { passive: true });
      window.visualViewport.addEventListener('scroll', scheduleTaskPromptViewportSync, { passive: true });
    }
    window.addEventListener('resize', scheduleTaskPromptViewportSync, { passive: true });
    window.addEventListener('orientationchange', scheduleTaskPromptViewportSync, { passive: true });

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
        resumeAmbientCanvas();
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

  // Dialog Lenis instances share a single RAF driver that only runs while a
  // dialog is actually open. Previously each of the instances kept its own
  // autoRaf loop alive forever, even with every dialog closed.
  let dialogLenisRafId = null;

  function startDialogLenisLoop() {
    if (dialogLenisRafId !== null) return;
    [levelsLenis, dayLenis]
      .forEach((lenis) => { if (lenis) lenis.time = 0; });

    const tick = (timestamp) => {
      if (!document.querySelector('dialog[open]')) {
        dialogLenisRafId = null;
        return;
      }
      if (levelsLenis) levelsLenis.raf(timestamp);
      if (dayLenis) dayLenis.raf(timestamp);
      dialogLenisRafId = requestAnimationFrame(tick);
    };
    dialogLenisRafId = requestAnimationFrame(tick);
  }

  function stopDialogLenisLoop() {
    if (dialogLenisRafId !== null) {
      cancelAnimationFrame(dialogLenisRafId);
      dialogLenisRafId = null;
    }
  }

  // The ambient background is paused when modal is open to ensure maximum performance
  function pauseAmbientCanvas() {
    document.documentElement.classList.add('modal-open');
    startDialogLenisLoop();
    matrixStreamEngine?.stop();
  }

  function resumeAmbientCanvas() {
    if (document.querySelector('dialog[open]')) return;
    document.documentElement.classList.remove('modal-open');
    stopDialogLenisLoop();
    if (document.documentElement.classList.contains('intro-aura-hidden') ||
        document.documentElement.classList.contains('unauthenticated-gate') ||
        !state.authenticated || !state.user) {
      matrixStreamEngine?.stop();
      return;
    }
    if (state.auraEnabled !== false) {
      matrixStreamEngine?.start();
    }
  }

  function applyAuraPreference() {
    const enabled = state.auraEnabled !== false;
    document.documentElement.classList.toggle('aura-disabled', !enabled);
    const auraToggle = document.getElementById('setting-aura-enabled');
    if (auraToggle) auraToggle.checked = enabled;
    if (!enabled ||
        document.documentElement.classList.contains('intro-aura-hidden') ||
        document.documentElement.classList.contains('unauthenticated-gate') ||
        !state.authenticated || !state.user) {
      matrixStreamEngine?.stop();
    } else {
      matrixStreamEngine?.start();
    }
  }

  function initLenis() {
    // The main app layout is an overflow: hidden fixed-height viewport with
    // touchmove preventDefault, so a global window Lenis RAF loop is unnecessary
    // and continuously burns CPU/battery. We delegate smooth scrolling
    // exclusively to dialog feeds via initShellLenis().
    globalLenis = null;
    window.lenis = null;
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
          autoRaf: false,
          autoResize: false,
          smoothWheel: true,
          duration: 0.85,
          easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        });
        window.levelsLenis = levelsLenis;
      } catch (e) {
        console.warn('StudyArk: Error initializing levelsLenis:', e);
      }
    }

    const dayFeed = document.getElementById('day-sessions-list');
    if (dayFeed && !dayLenis) {
      try {
        dayLenis = new Lenis({
          wrapper: dayFeed,
          content: dayFeed,
          eventsTarget: dayFeed,
          autoRaf: false,
          autoResize: false,
          smoothWheel: true,
          duration: 0.85,
          easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        });
        window.dayLenis = dayLenis;
      } catch (e) {
        console.warn('StudyArk: Error initializing dayLenis:', e);
      }
    }

    // The sessions-history feed intentionally has no Lenis instance. It is a
    // native overflow container driven by wheel/touch, which keeps scrolling
    // reliable even when the shared dialog RAF loop is stopped.
  }

  // =========================================================================
  // BOOT LOADER & ONE-SHOT HOME ENTRANCE
  // =========================================================================
  function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  function clearLoaderFailsafe() {
    if (window.__studyArkLoaderFailsafe) {
      clearTimeout(window.__studyArkLoaderFailsafe);
      window.__studyArkLoaderFailsafe = null;
    }
    if (window.__studyArcLoaderFailsafe) {
      clearTimeout(window.__studyArcLoaderFailsafe);
      window.__studyArcLoaderFailsafe = null;
    }
  }

  function setAppLoaderStatus(message) {
    const statusEl = document.getElementById('app-loader-status');
    if (statusEl && message) statusEl.textContent = message;
  }

  function showAppLoader(message, options = {}) {
    const loader = document.getElementById('app-loader');
    appLoaderShownAt = performance.now();
    if (message) setAppLoaderStatus(message);
    document.documentElement.classList.add('app-booting');
    document.body.setAttribute('aria-busy', 'true');
    if (!loader) return;
    loader.setAttribute('aria-hidden', 'false');
    loader.removeAttribute('style');
    if (options && options.immediate) {
      loader.style.transition = 'none';
      loader.classList.remove('is-hidden');
      void loader.offsetWidth;
      loader.style.transition = '';
    } else {
      loader.classList.remove('is-hidden');
      void loader.offsetWidth;
    }
  }

  function prepareAppLoaderForIntro(message, options = {}) {
    document.documentElement.classList.add('intro-aura-hidden');
    matrixStreamEngine?.stop();
    showAppLoader(message, options);
  }

  function hideAppLoader(options = {}) {
    document.documentElement.classList.remove('app-booting');
    document.body.removeAttribute('aria-busy');
    const loader = document.getElementById('app-loader');
    clearLoaderFailsafe();
    if (!loader) return Promise.resolve();

    loader.removeAttribute('style');
    if (options && options.immediate) {
      loader.style.transition = 'none';
      loader.classList.add('is-hidden');
      loader.setAttribute('aria-hidden', 'true');
      void loader.offsetWidth;
      loader.style.transition = '';
      return Promise.resolve();
    }

    loader.classList.add('is-hidden');
    loader.setAttribute('aria-hidden', 'true');
    return waitMs(APP_LOADER_FADE_MS);
  }

  async function waitForLoaderMinimum() {
    const elapsed = performance.now() - appLoaderShownAt;
    const remaining = APP_LOADER_MIN_VISIBLE_MS - elapsed;
    if (remaining > 0) await waitMs(remaining);
  }

  async function waitForFonts(maxWait = 700) {
    try {
      if (document.fonts && document.fonts.ready) {
        await Promise.race([document.fonts.ready, waitMs(maxWait)]);
      }
    } catch (e) {}
  }



  function clearHomeIntroTimers() {
    homeIntroTimers.forEach((timer) => clearTimeout(timer));
    homeIntroTimers.clear();
  }

  function scheduleHomeIntroStep(fn, delay) {
    const timer = setTimeout(() => {
      homeIntroTimers.delete(timer);
      fn();
    }, Math.max(0, delay));
    homeIntroTimers.add(timer);
    return timer;
  }

  function finishHomeIntroDial() {
    if (homeIntroDialRaf !== null) {
      cancelAnimationFrame(homeIntroDialRaf);
      homeIntroDialRaf = null;
    }
    homeIntroDialActive = false;
    document.body.classList.remove('is-intro-dial');
    updateTimerRing(state.timer.remainingSeconds);
  }

  function startHomeIntroDial(generation) {
    if (generation !== homeIntroGeneration || !homeIntroRunning) return;

    const targetSeconds = Math.max(0, Number(state.timer.remainingSeconds) || 0);
    const duration = 1100;
    const startedAt = performance.now();

    // Back ease-out curve: overshoots the target duration slightly (~4.5%)
    // before settling smoothly onto the exact mark.
    const s = 1.18;

    const step = (now) => {
      if (generation !== homeIntroGeneration) return;
      const progress = Math.min(1, (now - startedAt) / duration);
      const p = progress - 1;
      const eased = Math.max(0, p * p * ((s + 1) * p + s) + 1);
      updateTimerRing(targetSeconds * eased, { intro: true });

      if (progress < 1) {
        homeIntroDialRaf = requestAnimationFrame(step);
      } else {
        homeIntroDialRaf = null;
        finishHomeIntroDial();
      }
    };

    homeIntroDialRaf = requestAnimationFrame(step);
  }

  function resetHeatmapIntroReveal() {
    if (!heatmapState.activeBlocks.size) return;
    heatmapState.activeBlocks.forEach((block) => setHeatmapBlockRevealed(block, false));
    const trackEl = document.getElementById('heatmap-track');
    if (trackEl) void trackEl.offsetWidth;
  }

  function replayHeatmapIntroReveal() {
    if (!heatmapState.activeBlocks.size) return;
    const trackEl = document.getElementById('heatmap-track');
    if (trackEl) void trackEl.offsetWidth;
    updateHeatmapRevealState();
  }

  function cancelHomeIntro() {
    homeIntroGeneration += 1;
    clearHomeIntroTimers();

    if (homeIntroDialRaf !== null) {
      cancelAnimationFrame(homeIntroDialRaf);
      homeIntroDialRaf = null;
    }

    homeIntroDialActive = false;
    document.body.classList.remove('is-intro-dial', 'is-home-intro');
    homeIntroRunning = false;
    document.documentElement.classList.remove('intro-aura-hidden');

    updateTimerRing(state.timer.remainingSeconds);
    updateHeatmapRevealState();

    if (state.authenticated && state.auraEnabled !== false) {
      matrixStreamEngine?.start();
    }
  }

  async function loadAppDataForReveal() {
    document.body.setAttribute('aria-busy', 'true');

    // `/api/state` carries the full dashboard payload. The live timer fetch is
    // kicked off alongside it so the dial lands on the current server value.
    const loadTask = Promise.allSettled([
      checkAuthAndSync({ suppressAuthDialog: true }),
      fetchLatestServerTimer()
    ]);

    // A stalled backend must never trap the app behind the loader forever.
    await Promise.race([loadTask, waitMs(10000)]);
    await waitForLoaderMinimum();
    await waitForFonts(700);

    // One final coherent paint using whatever state actually arrived.
    renderAll();
    updateAuthUI();
  }

  async function finishLoaderForAuthGate() {
    document.documentElement.classList.add('unauthenticated-gate', 'intro-aura-hidden');
    document.documentElement.classList.remove('app-booting');
    matrixStreamEngine?.stop();
    if (!state.authenticated || !state.user) openAuthDialog('login');
    await hideAppLoader({ immediate: true });
  }

  async function revealAfterSignIn() {
    try {
      await loadAppDataForReveal();
      if (state.authenticated && state.user) {
        updateAuthUI();
        playHomeIntro();
      } else {
        await finishLoaderForAuthGate();
      }
    } catch (err) {
      console.warn('StudyArk: Sign-in reveal failed, showing available data:', err);
      cancelHomeIntro();
      await finishLoaderForAuthGate();
    }
  }

  function playHomeIntro() {
    if (!state.authenticated || !state.user) return;
    if (homeIntroRunning || homeIntroPlayed) {
      hideAppLoader();
      return;
    }

    const reducedMotion = (() => {
      try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (e) {
        return false;
      }
    })();

    homeIntroRunning = true;
    homeIntroPlayed = true;
    const generation = ++homeIntroGeneration;

    try {
      if (reducedMotion) {
        document.documentElement.classList.remove('intro-aura-hidden');
        if (state.auraEnabled !== false) matrixStreamEngine?.start();
        hideAppLoader();
        homeIntroRunning = false;
        return;
      }

      // Arm the initial dial ring at 0 so it animates when its step fires.
      // Adding `is-home-intro` immediately kicks off the pure CSS compositor
      // animations with their staggered group delays.
      resetHeatmapIntroReveal();
      homeIntroDialActive = true;
      document.body.classList.add('is-intro-dial', 'is-home-intro');
      updateTimerRing(0, { intro: true });

      // Staggered Group Orchestration:
      // Group 1: Dial Pop Scale In with Overshoot & Fade (CSS: 180ms - 740ms)
      // Group 2: Dial Digits Smooth Slide Up (CSS: 680ms - 1160ms)
      // Group 3: Dial Ring Fill with Overshoot (JS: starts at 1050ms)
      scheduleHomeIntroStep(() => startHomeIntroDial(generation), 1050);

      // Group 4: Header Items Drop Down (CSS: starts at 1120ms)
      // Group 5: Stats Pills Pop Overshoot (CSS: starts at 1240ms)
      // Group 6: Heatmap Card Slide (CSS: starts at 1380ms)
      // Heatmap cascading cells wave reveal (triggers right with heatmap card)
      scheduleHomeIntroStep(() => replayHeatmapIntroReveal(), 1450);

      // Group 7: Ambient Fluid Aura Soft Fade-in (as all groups land)
      scheduleHomeIntroStep(() => {
        if (generation !== homeIntroGeneration) return;
        document.documentElement.classList.remove('intro-aura-hidden');
        if (state.auraEnabled !== false) matrixStreamEngine?.start();
      }, 2100);

      // Cleanup: remove intro class once pure CSS animations complete
      scheduleHomeIntroStep(() => {
        if (generation === homeIntroGeneration) {
          document.body.classList.remove('is-home-intro');
          homeIntroRunning = false;
        }
      }, 2900);
    } catch (err) {
      console.warn('StudyArk: Home intro could not complete, revealing final state:', err);
      cancelHomeIntro();
    } finally {
      // The loader must always disappear, even if an unexpected exception occurs.
      hideAppLoader();
    }
  }

  // =========================================================================
  // BOOTSTRAP (Safe for both pre-parsed and async/cached script execution)
  // =========================================================================
  let appBootstrapped = false;
  async function bootstrapApp() {
    if (appBootstrapped) return;
    appBootstrapped = true;

    try {
      initLenis();
      initEvents();
      initMatrixStream();
      applyAuraPreference();
      matrixStreamEngine?.stop();

      // FAST-PATH: If unauthenticated in cached state, load sign-in modal instantly
      // without loading background homescreen elements, tiles, dial, or aura.
      if (!state.authenticated || !state.user) {
        document.documentElement.classList.add('unauthenticated-gate', 'intro-aura-hidden');
        document.documentElement.classList.remove('app-booting');
        clearLoaderFailsafe();
        hideAppLoader({ immediate: true });
        openAuthDialog('login');

        // Silently verify if a valid session cookie exists on server
        checkAuthAndSync({ suppressAuthDialog: true }).then((res) => {
          if (res && res.authenticated && !res.stale) {
            prepareAppLoaderForIntro('Syncing your progress', { immediate: true });
            document.documentElement.classList.remove('unauthenticated-gate');
            closeAuthDialog(true);
            updateAuthUI();
            revealAfterSignIn();
          }
        }).catch(() => {});
        return;
      }

      document.documentElement.classList.add('app-booting', 'intro-aura-hidden');
      document.body.setAttribute('aria-busy', 'true');
      renderAll();

      await loadAppDataForReveal();

      if (state.authenticated && state.user) {
        updateAuthUI();
        closeAuthDialog(true);
        playHomeIntro();
      } else {
        await finishLoaderForAuthGate();
      }
    } catch (err) {
      console.warn('StudyArk: Boot sequence failed, revealing cached app:', err);
      cancelHomeIntro();
      await finishLoaderForAuthGate();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapApp);
  } else {
    bootstrapApp();
  }

})();
