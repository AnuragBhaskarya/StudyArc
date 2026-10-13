import os
import re
import mimetypes
from datetime import datetime, timedelta
from functools import wraps
from flask import Flask, jsonify, request, send_from_directory, session
from werkzeug.security import generate_password_hash, check_password_hash
import database

app = Flask(__name__, static_folder='.', static_url_path='')

# Secret key configuration for cryptographic session signing
app.secret_key = os.environ.get('SECRET_KEY', 'studyarc-production-super-secret-key-change-me')
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_SECURE'] = False
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)

# Ensure correct MIME types
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('text/css', '.css')

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
    return send_from_directory('.', 'index.html')

@app.route('/<path:filename>')
def static_files(filename):
    return send_from_directory('.', filename)

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
        'user': {
            'id': user['id'],
            'username': user['username'],
            'created_at': str(user.get('created_at', ''))
        }
    })

# =========================================================================
# PERSISTENT REAL-TIME TIMER STATE
# =========================================================================

@app.route('/api/timer/state', methods=['GET'])
@auth_required
def get_timer_state_route(user_id):
    try:
        timer_state = database.get_timer_state(user_id)
        return jsonify({'success': True, 'timer': timer_state})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/timer/action', methods=['POST'])
@auth_required
def timer_action_route(user_id):
    data = request.get_json(force=True, silent=True) or {}
    action = data.get('action')
    if not action:
        return jsonify({'success': False, 'error': 'Action is required'}), 400

    target_seconds = data.get('target_seconds') or data.get('targetSeconds')
    remaining_seconds = data.get('remaining_seconds') or data.get('remainingSeconds')
    active_task_name = data.get('active_task_name') or data.get('activeTaskName')

    try:
        new_state = database.update_timer_state(
            user_id,
            action,
            target_seconds=target_seconds,
            active_task_name=active_task_name,
            remaining_seconds=remaining_seconds
        )
        return jsonify({'success': True, 'timer': new_state})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# =========================================================================
# APPLICATION STATE & AGGREGATE METRICS
# =========================================================================

@app.route('/api/state', methods=['GET'])
@auth_required
def get_state(user_id):
    """
    Returns full application state aggregated for the authenticated user.
    """
    try:
        subjects = database.get_subjects(user_id)
        sessions = database.get_sessions(user_id)
        day_activity = database.get_daily_activity(user_id)
        stats = database.get_stats(user_id)
        timer_state = database.get_timer_state(user_id)

        return jsonify({
            'success': True,
            'authenticated': True,
            'user': {
                'id': user_id,
                'username': session.get('username')
            },
            'subjects': subjects,
            'sessions': sessions,
            'dayActivity': day_activity,
            'stats': stats,
            'timer': timer_state
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/subjects', methods=['GET', 'POST'])
@auth_required
def handle_subjects(user_id):
    if request.method == 'GET':
        return jsonify(database.get_subjects(user_id))

    data = request.get_json(force=True, silent=True) or {}
    name = data.get('name', '').strip()
    color = data.get('color', '#79D99B')
    if not name:
        return jsonify({'error': 'Subject name is required'}), 400

    subj = database.add_or_get_subject(user_id, name, color)
    return jsonify({'success': True, 'subject': subj, 'subjects': database.get_subjects(user_id)})

@app.route('/api/sessions', methods=['GET', 'POST', 'DELETE'])
@auth_required
def handle_sessions(user_id):
    if request.method == 'GET':
        return jsonify(database.get_sessions(user_id))

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

    # Automatically update persistent timer state back to idle upon session save
    database.update_timer_state(user_id, 'complete')

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
    return jsonify({
        'success': True,
        'stats': database.get_stats(user_id),
        'dayActivity': database.get_daily_activity(user_id),
        'subjects': database.get_subjects(user_id),
        'sessions': database.get_sessions(user_id),
        'timer': database.get_timer_state(user_id)
    })

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    engine = 'PostgreSQL' if database.is_postgres() else 'SQLite'
    print(f"StudyArc {engine} server running at http://0.0.0.0:{port}")
    app.run(host='0.0.0.0', port=port, debug=False)
