from gevent import monkey
monkey.patch_all()

import os
import re
import json
import time
import threading
import mimetypes
from datetime import datetime, timedelta
from functools import wraps
from flask import Flask, jsonify, request, send_from_directory, session, Response, make_response
from flask_socketio import SocketIO, emit, join_room, disconnect
from werkzeug.security import generate_password_hash, check_password_hash
import database

app = Flask(__name__, static_folder='.', static_url_path='')
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='gevent', ping_timeout=30, ping_interval=10)

# Secret key configuration for cryptographic session signing
app.secret_key = os.environ.get('SECRET_KEY', 'studyarc-production-super-secret-key-change-me')
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_SECURE'] = bool(os.environ.get('RENDER') or os.environ.get('DYNO'))
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)

# Ensure correct MIME types
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('text/css', '.css')
mimetypes.add_type('application/manifest+json', '.webmanifest')
mimetypes.add_type('image/webp', '.webp')
mimetypes.add_type('image/x-icon', '.ico')

# Initialize database (PostgreSQL if DATABASE_URL is set, SQLite fallback)
database.init_db()

# =========================================================================
# AUTHENTICATION DECORATOR
# =========================================================================

def auth_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user_id = session.get('user_id')
        if not user_id:
            return jsonify({
                'success': False,
                'error': 'Authentication required. Please sign in.',
                'authenticated': False
            }), 401
        return f(user_id, *args, **kwargs)
    return decorated

# =========================================================================
# HEALTH / PING ENDPOINTS (Public Uptime Keep-Alive)
# =========================================================================

@app.route('/api/ping')
@app.route('/ping')
@app.route('/healthz')
@app.route('/api/health')
def ping_endpoint():
    """
    Lightweight ping & health check endpoint for Cloudflare Worker uptime monitor (pinger-js)
    and Render health checks. Returns 200 OK immediately to keep the server awake 24/7.
    """
    return jsonify({
        'status': 'pong',
        'app': 'StudyArc',
        'database': 'postgresql' if database.is_postgres() else 'sqlite',
        'timestamp': int(datetime.now().timestamp() * 1000)
    }), 200

# =========================================================================
# STATIC FILE SERVING
# =========================================================================

@app.route('/')
def index():
    resp = make_response(send_from_directory('.', 'index.html'))
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    return resp

@app.route('/sw.js')
def service_worker():
    resp = make_response(send_from_directory('.', 'sw.js'))
    resp.headers['Content-Type'] = 'application/javascript; charset=utf-8'
    resp.headers['Service-Worker-Allowed'] = '/'
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp

@app.route('/manifest.webmanifest')
@app.route('/manifest.json')
def web_manifest():
    resp = make_response(send_from_directory('.', 'manifest.webmanifest'))
    resp.headers['Content-Type'] = 'application/manifest+json; charset=utf-8'
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate, max-age=0'
    return resp

@app.route('/favicon.ico')
def favicon_root():
    return send_from_directory('assets', 'favicon.ico', mimetype='image/x-icon')

@app.route('/<path:filename>')
def static_files(filename):
    resp = make_response(send_from_directory('.', filename))
    if filename.endswith(('.js', '.html', '.css', '.webmanifest')):
        resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate, max-age=0'
        resp.headers['Pragma'] = 'no-cache'
    return resp

@app.route('/api/levels')
def api_levels():
    levels_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'levels.json')
    if os.path.exists(levels_path):
        with open(levels_path, 'r', encoding='utf-8') as f:
            return jsonify({'success': True, 'levels': json.load(f)})
    return jsonify({'success': False, 'error': 'Levels configuration not found'}), 404

# =========================================================================
# AUTHENTICATION REST API
# =========================================================================

@app.route('/api/auth/register', methods=['POST'])
def auth_register():
    data = request.get_json(force=True, silent=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''
    confirm_password = data.get('confirm_password') or data.get('confirmPassword') or ''

    if not username:
        return jsonify({'success': False, 'error': 'Username is required'}), 400

    if len(username) < 3 or len(username) > 30:
        return jsonify({'success': False, 'error': 'Username must be between 3 and 30 characters'}), 400

    if not re.match(r'^[a-zA-Z0-9_]+$', username):
        return jsonify({'success': False, 'error': 'Username can only contain letters, numbers, and underscores'}), 400

    if not password:
        return jsonify({'success': False, 'error': 'Password is required'}), 400

    if len(password) < 6:
        return jsonify({'success': False, 'error': 'Password must be at least 6 characters long'}), 400

    if password != confirm_password:
        return jsonify({'success': False, 'error': 'Passwords do not match'}), 400

    existing = database.get_user_by_username(username)
    if existing:
        return jsonify({'success': False, 'error': 'Username is already taken'}), 409

    password_hash = generate_password_hash(password, method='scrypt')
    try:
        user = database.create_user(username, password_hash)
        session.permanent = True
        session['user_id'] = user['id']
        session['username'] = user['username']

        # Pre-warm timer hot cache asynchronously so subsequent actions take <2ms
        threading.Thread(target=get_hot_timer_state, args=(user['id'],), daemon=True).start()

        return jsonify({
            'success': True,
            'user': {
                'id': user['id'],
                'username': user['username']
            }
        }), 201
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    data = request.get_json(force=True, silent=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''

    if not username or not password:
        return jsonify({'success': False, 'error': 'Username and password are required'}), 400

    user = database.get_user_by_username(username)
    if not user or not check_password_hash(user['password_hash'], password):
        return jsonify({'success': False, 'error': 'Invalid username or password'}), 401

    database.update_user_last_login(user['id'])
    session.permanent = True
    session['user_id'] = user['id']
    session['username'] = user['username']

    # Pre-warm timer hot cache asynchronously so subsequent actions take <2ms
    threading.Thread(target=get_hot_timer_state, args=(user['id'],), daemon=True).start()

    return jsonify({
        'success': True,
        'user': {
            'id': user['id'],
            'username': user['username']
        }
    })

@app.route('/api/auth/logout', methods=['POST'])
def auth_logout():
    session.clear()
    return jsonify({'success': True, 'message': 'Logged out successfully'})

@app.route('/api/auth/me', methods=['GET'])
def auth_me():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'authenticated': False, 'user': None})

    user = database.get_user_by_id(user_id)
    if not user:
        session.clear()
        return jsonify({'authenticated': False, 'user': None})

    return jsonify({
        'authenticated': True,
        'preferences': database.get_user_preferences(user['id']),
        'user': {
            'id': user['id'],
            'username': user['username'],
            'created_at': str(user.get('created_at', ''))
        }
    })

# =========================================================================
# ULTRA-LOW LATENCY REAL-TIME TIMER ENGINE (RAM HOT-CACHE, MONOTONIC SEQ, & WEBSOCKET BROADCASTER)
# =========================================================================

_timer_lock = threading.Lock()
_timer_condition = threading.Condition(_timer_lock)
USER_TIMER_HOT_CACHE = {}

def broadcast_timer_state(user_id, state):
    """
    Instantly pushes timer updates to all connected Socket.IO clients in user's room.
    Socket.IO handles dead connection cleanup automatically.
    """
    socketio.emit('timer_update', {
        'timer': state,
        'serverTime': int(time.time() * 1000)
    }, room=str(user_id))

def get_hot_timer_state(user_id):
    """
    Returns real-time timer state from RAM in 0.01ms.
    Loads from PostgreSQL/SQLite on cold cache miss.
    """
    now_ms = int(time.time() * 1000)
    with _timer_lock:
        cached = USER_TIMER_HOT_CACHE.get(user_id)
        if cached:
            state = dict(cached)
            if state.get('status') == 'running' and state.get('startedAt'):
                elapsed = (now_ms - int(state['startedAt'])) / 1000.0
                calc_rem = state['remainingSeconds'] - elapsed
                if calc_rem <= 0:
                    state['status'] = 'idle'
                    state['remainingSeconds'] = state['targetSeconds']
                    state['currentRemaining'] = state['targetSeconds']
                    state['hasCompleted'] = True
                    state['startedAt'] = None
                    # Hot cache in RAM transitions to idle with hasCompleted=False for subsequent requests
                    USER_TIMER_HOT_CACHE[user_id] = {**state, 'hasCompleted': False}
                    def persist_auto_complete():
                        try:
                            database.update_timer_state(
                                user_id, 'complete',
                                target_seconds=state['targetSeconds'],
                                remaining_seconds=state['targetSeconds'],
                                status='idle'
                            )
                        except Exception as ex:
                            print(f"[TimerSync] Auto-complete persist error: {ex}")
                    threading.Thread(target=persist_auto_complete, daemon=True).start()
                else:
                    state['currentRemaining'] = max(0.0, calc_rem)
                    state['hasCompleted'] = False
            else:
                state['currentRemaining'] = state.get('remainingSeconds', 3600)
            state['serverTime'] = now_ms
            return state

    # Cold cache miss: fetch from PostgreSQL/SQLite once and cache in RAM
    db_state = database.get_timer_state(user_id)
    with _timer_lock:
        now_ms = int(time.time() * 1000)
        seq = int(db_state.get('sequence') or 1)
        state = {
            'status': db_state['status'],
            'targetSeconds': db_state['targetSeconds'],
            'remainingSeconds': db_state['remainingSeconds'],
            'currentRemaining': db_state.get('currentRemaining', db_state['remainingSeconds']),
            'activeTaskName': db_state.get('activeTaskName'),
            'startedAt': db_state.get('startedAt'),
            'updatedAt': now_ms,
            'sequence': seq,
            'version': seq,
            'hasCompleted': db_state.get('hasCompleted', False),
            'serverTime': now_ms
        }
        USER_TIMER_HOT_CACHE[user_id] = state
        return dict(state)

def trigger_timer_update(user_id, action, target_seconds=None, active_task_name=None, remaining_seconds=None):
    """
    Unified routine for all timer modifications across the entire application:
    Updates RAM state in 0.01ms, increments monotonic sequence (1, 2, 3...),
    broadcasts instantly over WebSockets (<1ms), wakes any long-poll listeners,
    and persists to database asynchronously in a background thread.
    """
    now_ms = int(time.time() * 1000)
    current = get_hot_timer_state(user_id)

    new_status = current.get('status', 'idle')
    new_target = int(target_seconds) if target_seconds is not None else int(current.get('targetSeconds', 5400))
    new_remaining = int(current.get('remainingSeconds', 5400))
    new_task = active_task_name if active_task_name is not None else current.get('activeTaskName')
    new_started_at = current.get('startedAt')
    current_seq = int(current.get('sequence') or 0)
    new_seq = current_seq + 1

    if action == 'start':
        new_status = 'running'
        if target_seconds:
            new_target = int(target_seconds)
        if remaining_seconds is not None:
            new_remaining = int(remaining_seconds)
        else:
            new_remaining = new_target
        new_started_at = now_ms
        if active_task_name:
            new_task = active_task_name

    elif action == 'pause':
        if current.get('status') == 'running' and current.get('startedAt'):
            elapsed = (now_ms - int(current['startedAt'])) / 1000.0
            new_remaining = max(0, int(current.get('remainingSeconds', 5400) - elapsed))
        elif remaining_seconds is not None:
            new_remaining = int(remaining_seconds)
        else:
            new_remaining = int(current.get('remainingSeconds', 5400))
        new_status = 'paused'
        new_started_at = None

    elif action == 'resume':
        new_status = 'running'
        if remaining_seconds is not None:
            new_remaining = int(remaining_seconds)
        else:
            new_remaining = current.get('remainingSeconds', 5400)
        new_started_at = now_ms

    elif action == 'reset':
        new_status = 'idle'
        new_target = int(target_seconds) if target_seconds else 5400
        new_remaining = new_target
        new_started_at = None
        new_task = None

    elif action == 'adjust':
        if target_seconds:
            new_target = int(target_seconds)
        if current.get('status') in ('idle', 'paused'):
            new_remaining = new_target
            new_started_at = None

    elif action == 'complete':
        new_status = 'idle'
        new_target = int(target_seconds) if target_seconds else 5400
        new_remaining = new_target
        new_started_at = None
        new_task = None

    new_state = {
        'status': new_status,
        'targetSeconds': new_target,
        'remainingSeconds': new_remaining,
        'currentRemaining': new_remaining,
        'activeTaskName': new_task,
        'startedAt': new_started_at,
        'updatedAt': now_ms,
        'sequence': new_seq,
        'version': new_seq,
        'hasCompleted': False,
        'serverTime': now_ms
    }

    # 1. Update RAM state and wake condition listeners
    with _timer_condition:
        USER_TIMER_HOT_CACHE[user_id] = new_state
        _timer_condition.notify_all()

    # 2. Push real-time event directly over WebSockets in <1ms
    broadcast_timer_state(user_id, new_state)

    # 3. Persist to database asynchronously in a background greenlet/thread
    def persist_worker():
        try:
            database.update_timer_state(
                user_id,
                action,
                target_seconds=new_target,
                active_task_name=new_task,
                remaining_seconds=new_remaining,
                status=new_status,
                started_at=new_started_at,
                sequence=new_seq
            )
        except Exception as e:
            print(f"[TimerSync] DB persist warning: {e}")

    threading.Thread(target=persist_worker, daemon=True).start()

    return new_state

# =========================================================================
# SOCKET.IO EVENT HANDLERS — Industry-standard real-time engine
# Supports WebSocket + automatic HTTP long-polling fallback
# Works with gunicorn + eventlet on Render, Heroku, Railway, etc.
# =========================================================================

@socketio.on('connect')
def sio_connect():
    user_id = session.get('user_id')
    if not user_id:
        disconnect()
        return False
    # Join a room named after the user_id for targeted broadcasting
    join_room(str(user_id))
    # Send initial full state immediately upon connection
    initial_state = get_hot_timer_state(user_id)
    emit('timer_init', {
        'timer': initial_state,
        'serverTime': int(time.time() * 1000)
    })
    # Preferences are sent as a separate packet so the timer is never delayed
    # by the extra database lookup.
    emit('preferences_update', {
        'preferences': database.get_user_preferences(user_id)
    })

@socketio.on('ping_server')
def sio_ping(data):
    """Clock offset measurement for anchor time calculations."""
    emit('pong_server', {
        'clientTime': data.get('clientTime') if data else None,
        'serverTime': int(time.time() * 1000)
    })

@socketio.on('get_state')
def sio_get_state():
    user_id = session.get('user_id')
    if not user_id:
        return
    emit('timer_update', {
        'timer': get_hot_timer_state(user_id),
        'serverTime': int(time.time() * 1000)
    })
    emit('preferences_update', {
        'preferences': database.get_user_preferences(user_id)
    })

@socketio.on('timer_action')
def sio_timer_action(data):
    """Handles all timer actions: start, pause, resume, reset, adjust, complete."""
    user_id = session.get('user_id')
    if not user_id:
        return
    action = data.get('action') if data else None
    if not action:
        return
    trigger_timer_update(
        user_id,
        action,
        target_seconds=data.get('target_seconds') or data.get('targetSeconds'),
        active_task_name=data.get('active_task_name') or data.get('activeTaskName'),
        remaining_seconds=data.get('remaining_seconds') or data.get('remainingSeconds')
    )

@app.route('/api/timer/live', methods=['GET'])
@app.route('/api/timer/state', methods=['GET'])
@auth_required
def timer_live_route(user_id):
    """
    Fallback HTTP poll endpoint with monotonic sequence check.
    """
    since_version = request.args.get('since', type=int)

    current_state = get_hot_timer_state(user_id)
    current_ver = current_state.get('version', 0)

    if since_version is not None and since_version >= current_ver:
        with _timer_condition:
            def has_update():
                s = USER_TIMER_HOT_CACHE.get(user_id)
                return s is not None and s.get('version', 0) > since_version

            _timer_condition.wait_for(has_update, timeout=10.0)

        current_state = get_hot_timer_state(user_id)

    resp = jsonify({'success': True, 'timer': current_state})
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    resp.headers['X-Accel-Buffering'] = 'no'
    return resp

@app.route('/api/timer/action', methods=['POST'])
@auth_required
def timer_action_route(user_id):
    """
    HTTP POST action fallback: updates hot cache and broadcasts over WebSockets instantly.
    """
    data = request.get_json(force=True, silent=True) or {}
    action = data.get('action')
    if not action:
        return jsonify({'success': False, 'error': 'Action is required'}), 400

    target_seconds = data.get('target_seconds') or data.get('targetSeconds')
    remaining_seconds = data.get('remaining_seconds') or data.get('remainingSeconds')
    active_task_name = data.get('active_task_name') or data.get('activeTaskName')

    try:
        new_state = trigger_timer_update(
            user_id,
            action,
            target_seconds=target_seconds,
            active_task_name=active_task_name,
            remaining_seconds=remaining_seconds
        )
        resp = jsonify({'success': True, 'timer': new_state})
        resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate, max-age=0'
        resp.headers['Pragma'] = 'no-cache'
        resp.headers['Expires'] = '0'
        resp.headers['X-Accel-Buffering'] = 'no'
        return resp
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/timer/stream')
@auth_required
def timer_stream_legacy_route(user_id):
    timer_state = get_hot_timer_state(user_id)
    payload = json.dumps(timer_state)
    return Response(f"event: timer_state\ndata: {payload}\n\n", mimetype='text/event-stream')

# =========================================================================
# APPLICATION STATE & AGGREGATE METRICS
# =========================================================================

@app.route('/api/state', methods=['GET'])
@auth_required
def get_state(user_id):
    """
    Returns full application state aggregated for the authenticated user in a single optimized call.
    Uses hot in-memory timer state for sub-millisecond real-time accuracy.
    """
    try:
        data = database.get_full_state(user_id)
        hot_timer = get_hot_timer_state(user_id)
        if hot_timer:
            data['timer'] = hot_timer

        user_name = session.get('username')
        if not user_name:
            u_info = database.get_user_by_id(user_id)
            if u_info:
                user_name = u_info.get('username')
                session['username'] = user_name

        return jsonify({
            'success': True,
            'authenticated': True,
            'user': {
                'id': user_id,
                'username': user_name or 'User'
            },
            'preferences': data.get('preferences') or {'auraEnabled': True},
            'subjects': data['subjects'],
            'sessions': data['sessions'],
            'dayActivity': data['dayActivity'],
            'stats': data['stats'],
            'timer': data['timer']
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/settings', methods=['POST'])
@auth_required
def update_settings(user_id):
    """
    Persist account-scoped preferences so they follow the user across devices.
    """
    data = request.get_json(force=True, silent=True) or {}
    updated = False

    if 'auraEnabled' in data or 'aura_enabled' in data:
        raw_value = data.get('auraEnabled', data.get('aura_enabled'))
        if isinstance(raw_value, str):
            aura_enabled = raw_value.strip().lower() in ('1', 'true', 'yes', 'on')
        else:
            aura_enabled = bool(raw_value)
        preferences = database.set_user_aura_enabled(user_id, aura_enabled)
        updated = True
    else:
        preferences = database.get_user_preferences(user_id)

    if updated:
        socketio.emit('preferences_update', {
            'preferences': preferences
        }, room=str(user_id))

    return jsonify({
        'success': True,
        'preferences': preferences,
        'auraEnabled': preferences.get('auraEnabled', True)
    })

@app.route('/api/subjects', methods=['GET', 'POST'])
@auth_required
def handle_subjects(user_id):
    if request.method == 'GET':
        return jsonify(database.get_subjects(user_id))

    data = request.get_json(force=True, silent=True) or {}
    name = data.get('name', '').strip()
    color = data.get('color', '#10E068')
    if not name:
        return jsonify({'error': 'Subject name is required'}), 400

    subj = database.add_or_get_subject(user_id, name, color)
    return jsonify({'success': True, 'subject': subj, 'subjects': database.get_subjects(user_id)})

@app.route('/api/sessions', methods=['GET', 'POST', 'DELETE'])
@auth_required
def handle_sessions(user_id):
    if request.method == 'GET':
        limit = int(request.args.get('limit', 5000))
        return jsonify(database.get_sessions(user_id, limit=limit))

    if request.method == 'DELETE':
        data = request.get_json(force=True, silent=True) or {}
        session_id = data.get('id') or data.get('session_id') or request.args.get('id')
        if not session_id:
            return jsonify({'success': False, 'error': 'Session ID is required'}), 400
        return delete_session_endpoint(user_id, session_id)

    data = request.get_json(force=True, silent=True) or {}
    subject_name = data.get('subject_name') or data.get('subject') or 'Focus Session'
    duration_minutes = int(data.get('duration_minutes') or data.get('durationMinutes') or 25)
    date_str = data.get('date')
    timestamp_ms = data.get('timestamp')
    start_time = data.get('start_time') or data.get('startTime')
    end_time = data.get('end_time') or data.get('endTime')

    new_session = database.add_session(
        user_id, subject_name, duration_minutes, date_str, timestamp_ms, start_time, end_time
    )

    # Automatically update persistent timer state back to idle upon session save & broadcast to all WebSockets
    trigger_timer_update(user_id, 'complete')

    return jsonify({
        'success': True,
        'session': new_session,
        'stats': database.get_stats(user_id),
        'dayActivity': database.get_daily_activity(user_id),
        'subjects': database.get_subjects(user_id)
    })

@app.route('/api/sessions/<session_id>', methods=['DELETE', 'POST'])
@app.route('/api/sessions/<session_id>/delete', methods=['POST'])
@auth_required
def delete_session_endpoint(user_id, session_id):
    deleted = database.delete_session(user_id, session_id)
    if not deleted:
        return jsonify({'success': False, 'error': 'Session not found'}), 404

    date_str = deleted.get('date')
    day_details = database.get_day_details(user_id, date_str) if date_str else None

    return jsonify({
        'success': True,
        'deletedSession': deleted,
        'dayDetails': day_details,
        'stats': database.get_stats(user_id),
        'dayActivity': database.get_daily_activity(user_id),
        'subjects': database.get_subjects(user_id),
        'sessions': database.get_sessions(user_id)
    })

@app.route('/api/day/<date_str>', methods=['GET'])
@auth_required
def get_day(user_id, date_str):
    try:
        details = database.get_day_details(user_id, date_str)
        return jsonify({'success': True, 'data': details})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/activity', methods=['GET'])
@auth_required
def get_activity(user_id):
    return jsonify(database.get_daily_activity(user_id))

@app.route('/api/stats', methods=['GET'])
@auth_required
def get_stats(user_id):
    return jsonify(database.get_stats(user_id))

@app.route('/api/reset', methods=['POST'])
@auth_required
def reset_data(user_id):
    database.reset_database(user_id)
    timer_state = trigger_timer_update(user_id, 'reset', target_seconds=5400)
    return jsonify({
        'success': True,
        'stats': database.get_stats(user_id),
        'dayActivity': database.get_daily_activity(user_id),
        'subjects': database.get_subjects(user_id),
        'sessions': database.get_sessions(user_id),
        'timer': timer_state
    })

# Pre-warm database connection pool on startup
try:
    if database.is_postgres():
        pool = database.get_pg_pool()
        conn = pool.getconn()
        conn.autocommit = True
        pool.putconn(conn)
        print('✓ Database connection pool warmed up successfully.')
except Exception as e:
    print(f'Pool warmup notice: {e}')

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    engine = 'PostgreSQL' if database.is_postgres() else 'SQLite'
    print(f"StudyArc {engine} + Socket.IO server running at http://0.0.0.0:{port}")
    socketio.run(app, host='0.0.0.0', port=port, debug=False)
