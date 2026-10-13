import sqlite3
import os
import random
from datetime import datetime, timedelta, date, time

# Automatically load .env if present (git-ignored, keeping secrets safe)
env_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
if os.path.exists(env_file):
    try:
        with open(env_file, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    k, v = k.strip(), v.strip().strip('"').strip("'")
                    if k not in os.environ:
                        os.environ[k] = v
    except Exception:
        pass

# Cloud PostgreSQL (Supabase / Neon / Render Postgres) support
DATABASE_URL = os.environ.get('DATABASE_URL')
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'study_tracker.db')

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ImportError:
    psycopg2 = None
    RealDictCursor = None

def is_postgres():
    """Returns True if a PostgreSQL connection URL is configured in the environment."""
    url = (os.environ.get('DATABASE_URL') or '').strip()
    return (
        url.startswith(('postgres://', 'postgresql://'))
        and '[YOUR-PASSWORD]' not in url
        and 'your-project-ref' not in url
    )

def get_clean_database_url():
    url = (os.environ.get('DATABASE_URL') or '').strip()
    if url.startswith('postgres://'):
        url = 'postgresql://' + url[len('postgres://'):]
    if 'sslmode' not in url and 'localhost' not in url and '127.0.0.1' not in url:
        sep = '&' if '?' in url else '?'
        url = f"{url}{sep}sslmode=require"
    return url

def fetch_scalar(row):
    """Safely extracts a single scalar value from a DB row (dict, tuple, or sqlite3.Row)."""
    if row is None:
        return None
    if isinstance(row, dict) or hasattr(row, 'values'):
        return next(iter(row.values()))
    return row[0]

_pg_pool = None

def get_pg_pool():
    global _pg_pool
    if _pg_pool is None:
        if psycopg2 is None:
            raise RuntimeError(
                "psycopg2 is not installed. Please run 'pip install psycopg2-binary' "
                "to use PostgreSQL with DATABASE_URL."
            )
        from psycopg2 import pool
        _pg_pool = pool.ThreadedConnectionPool(
            minconn=1,
            maxconn=10,
            dsn=get_clean_database_url(),
            cursor_factory=RealDictCursor
        )
    return _pg_pool

class DBContext:
    """
    Unified database context manager supporting both local SQLite
    and production cloud PostgreSQL (Supabase / Neon) with thread-safe pooling.
    """
    def __init__(self):
        self.is_pg = is_postgres()
        if self.is_pg:
            pg_pool = get_pg_pool()
            conn = pg_pool.getconn()
            try:
                # Liveness check on pooled connection
                if conn.closed:
                    pg_pool.putconn(conn, close=True)
                    conn = pg_pool.getconn()
                else:
                    cur = conn.cursor()
                    cur.execute("SELECT 1")
            except Exception:
                try:
                    pg_pool.putconn(conn, close=True)
                except Exception:
                    pass
                conn = pg_pool.getconn()
            self.conn = conn
        else:
            self.conn = sqlite3.connect(DB_PATH)
            self.conn.row_factory = sqlite3.Row
            self.conn.execute("PRAGMA foreign_keys = ON")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.is_pg:
            try:
                if exc_type is None:
                    self.conn.commit()
                else:
                    self.conn.rollback()
            finally:
                get_pg_pool().putconn(self.conn)
        else:
            if exc_type is None:
                self.conn.commit()
            else:
                self.conn.rollback()
            self.conn.close()

    def cursor(self):
        return self.conn.cursor()

    def commit(self):
        self.conn.commit()

    def execute(self, sql, params=()):
        cur = self.conn.cursor()
        if self.is_pg:
            sql_pg = sql.replace('?', '%s')
            cur.execute(sql_pg, params)
        else:
            cur.execute(sql, params)
        return cur

    def execute_insert(self, sql, params=()):
        """
        Executes an INSERT query and returns the newly generated integer primary key.
        """
        cur = self.conn.cursor()
        if self.is_pg:
            sql_pg = sql.replace('?', '%s') + " RETURNING id"
            cur.execute(sql_pg, params)
            res = cur.fetchone()
            val = fetch_scalar(res)
            return int(val) if val is not None else None
        else:
            cur.execute(sql, params)
            return cur.lastrowid

def get_connection():
    """Factory creating the unified DBContext manager."""
    return DBContext()

DEFAULT_STARTER_SUBJECTS = [
    ('Deep Work', '#79D99B'),
    ('Reading', '#34D399'),
    ('Problem Solving', '#2DD4BF'),
    ('Learning', '#52C480')
]

SUBJECT_PALETTE = [
    '#79D99B', '#A3F0BA', '#52C480', '#3A965A', '#4ECCA3',
    '#6EE7B7', '#86EFAC', '#34D399', '#2DD4BF', '#5EEAD4'
]

def init_db():
    with get_connection() as ctx:
        if ctx.is_pg:
            # 1. Users Table
            ctx.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    username VARCHAR(64) UNIQUE NOT NULL,
                    password_hash VARCHAR(255) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_login_at TIMESTAMP
                )
            """)

            # 2. Per-User Persistent Timer State Table
            ctx.execute("""
                CREATE TABLE IF NOT EXISTS user_timer_state (
                    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    status VARCHAR(32) NOT NULL DEFAULT 'idle',
                    target_seconds INTEGER NOT NULL DEFAULT 3600,
                    remaining_seconds INTEGER NOT NULL DEFAULT 3600,
                    active_task_name VARCHAR(255),
                    started_at BIGINT,
                    updated_at BIGINT NOT NULL
                )
            """)

            # 3. Subjects Table
            ctx.execute("""
                CREATE TABLE IF NOT EXISTS subjects (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    name VARCHAR(255) NOT NULL,
                    color VARCHAR(32) NOT NULL DEFAULT '#79D99B',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # 4. Sessions Table
            ctx.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
                    subject_name VARCHAR(255) NOT NULL,
                    duration_minutes INTEGER NOT NULL,
                    date VARCHAR(32) NOT NULL,
                    timestamp BIGINT NOT NULL,
                    start_time VARCHAR(32),
                    end_time VARCHAR(32),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Idempotent Column Additions & Constraint Updates
            cur = ctx.execute("""
                SELECT column_name FROM information_schema.columns 
                WHERE table_schema = 'public' AND table_name = 'subjects' AND column_name = 'user_id'
            """)
            if not cur.fetchone():
                ctx.execute("ALTER TABLE subjects ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE")

            cur = ctx.execute("""
                SELECT column_name FROM information_schema.columns 
                WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'user_id'
            """)
            if not cur.fetchone():
                ctx.execute("ALTER TABLE sessions ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE")

            ctx.execute("ALTER TABLE subjects DROP CONSTRAINT IF EXISTS subjects_name_key")
            ctx.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_user_name ON subjects (user_id, LOWER(name))")
            ctx.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_date ON sessions (user_id, date)")
            ctx.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_ts ON sessions (user_id, timestamp DESC)")
            ctx.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_subject ON sessions (user_id, subject_id)")

        else:
            # SQLite Schema
            ctx.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_login_at TIMESTAMP
                )
            """)

            ctx.execute("""
                CREATE TABLE IF NOT EXISTS user_timer_state (
                    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    status TEXT NOT NULL DEFAULT 'idle',
                    target_seconds INTEGER NOT NULL DEFAULT 3600,
                    remaining_seconds INTEGER NOT NULL DEFAULT 3600,
                    active_task_name TEXT,
                    started_at INTEGER,
                    updated_at INTEGER NOT NULL
                )
            """)

            ctx.execute("""
                CREATE TABLE IF NOT EXISTS subjects (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    color TEXT NOT NULL DEFAULT '#79D99B',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            ctx.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
                    subject_name TEXT NOT NULL,
                    duration_minutes INTEGER NOT NULL,
                    date TEXT NOT NULL,
                    timestamp BIGINT NOT NULL,
                    start_time TEXT,
                    end_time TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # SQLite migration check
            cur = ctx.execute("PRAGMA table_info(subjects)")
            cols = [r['name'] for r in cur.fetchall()]
            if 'user_id' not in cols:
                ctx.execute("ALTER TABLE subjects ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE")

            cur = ctx.execute("PRAGMA table_info(sessions)")
            cols = [r['name'] for r in cur.fetchall()]
            if 'user_id' not in cols:
                ctx.execute("ALTER TABLE sessions ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE")

            ctx.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_user_name ON subjects (user_id, LOWER(name))")
            ctx.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_date ON sessions (user_id, date)")
            ctx.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_ts ON sessions (user_id, timestamp DESC)")
            ctx.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_subject ON sessions (user_id, subject_id)")

# =========================================================================
# USER AUTHENTICATION & MANAGEMENT
# =========================================================================

def create_user(username, password_hash):
    clean_user = username.strip()
    with get_connection() as ctx:
        cur = ctx.execute("SELECT id FROM users WHERE LOWER(username) = LOWER(?)", (clean_user,))
        if cur.fetchone():
            raise ValueError("Username is already taken")

        user_id = ctx.execute_insert(
            "INSERT INTO users (username, password_hash, last_login_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
            (clean_user, password_hash)
        )

        now_ms = int(datetime.now().timestamp() * 1000)
        # Initialize user timer state
        ctx.execute("""
            INSERT INTO user_timer_state (user_id, status, target_seconds, remaining_seconds, updated_at)
            VALUES (?, 'idle', 3600, 3600, ?)
        """, (user_id, now_ms))

        # Seed starter focus subjects for the user
        for s_name, s_color in DEFAULT_STARTER_SUBJECTS:
            ctx.execute(
                "INSERT INTO subjects (user_id, name, color) VALUES (?, ?, ?)",
                (user_id, s_name, s_color)
            )

        return {'id': user_id, 'username': clean_user}

def get_user_by_username(username):
    clean_user = username.strip()
    with get_connection() as ctx:
        cur = ctx.execute(
            "SELECT id, username, password_hash, created_at, last_login_at FROM users WHERE LOWER(username) = LOWER(?)",
            (clean_user,)
        )
        row = cur.fetchone()
        return dict(row) if row else None

def get_user_by_id(user_id):
    with get_connection() as ctx:
        cur = ctx.execute(
            "SELECT id, username, created_at, last_login_at FROM users WHERE id = ?",
            (user_id,)
        )
        row = cur.fetchone()
        return dict(row) if row else None

def update_user_last_login(user_id):
    with get_connection() as ctx:
        ctx.execute("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?", (user_id,))

# =========================================================================
# PERSISTENT REAL-TIME TIMER STATE (ZERO SERVER LOAD MATHEMATICAL DELTA)
# =========================================================================

def get_timer_state(user_id):
    now_ms = int(datetime.now().timestamp() * 1000)
    with get_connection() as ctx:
        cur = ctx.execute("""
            SELECT status, target_seconds, remaining_seconds, active_task_name, started_at, updated_at
            FROM user_timer_state
            WHERE user_id = ?
        """, (user_id,))
        row = cur.fetchone()

        if not row:
            ctx.execute("""
                INSERT INTO user_timer_state (user_id, status, target_seconds, remaining_seconds, updated_at)
                VALUES (?, 'idle', 3600, 3600, ?)
            """, (user_id, now_ms))
            return {
                'status': 'idle',
                'targetSeconds': 3600,
                'remainingSeconds': 3600,
                'activeTaskName': None,
                'startedAt': None,
                'hasCompleted': False
            }

        state = dict(row)
        status = state['status']
        target_secs = int(state['target_seconds'])
        remaining_secs = int(state['remaining_seconds'])
        started_at = state.get('started_at')
        active_task = state.get('active_task_name')
        has_completed = False

        if status == 'running' and started_at:
            elapsed_seconds = (now_ms - int(started_at)) / 1000.0
            calc_remaining = remaining_secs - elapsed_seconds
            if calc_remaining <= 0:
                calc_remaining = 0
                has_completed = True
            remaining_secs = max(0, int(calc_remaining))

        return {
            'status': status,
            'targetSeconds': target_secs,
            'remainingSeconds': remaining_secs,
            'activeTaskName': active_task,
            'startedAt': started_at,
            'hasCompleted': has_completed
        }

def update_timer_state(user_id, action, target_seconds=None, active_task_name=None, remaining_seconds=None):
    now_ms = int(datetime.now().timestamp() * 1000)
    current = get_timer_state(user_id)
    new_status = current['status']
    new_target = target_seconds if target_seconds is not None else current['targetSeconds']
    new_remaining = current['remainingSeconds']
    new_task = active_task_name if active_task_name is not None else current['activeTaskName']
    new_started_at = current.get('startedAt')

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
        if current['status'] == 'running' and current.get('startedAt'):
            elapsed = (now_ms - int(current['startedAt'])) / 1000.0
            new_remaining = max(0, int(current['remainingSeconds'] - elapsed))
        new_status = 'paused'
        new_started_at = None

    elif action == 'resume':
        new_status = 'running'
        new_started_at = now_ms

    elif action == 'reset':
        new_status = 'idle'
        if target_seconds:
            new_target = int(target_seconds)
        new_remaining = new_target
        new_started_at = None
        new_task = None

    elif action == 'adjust':
        if target_seconds:
            new_target = int(target_seconds)
        if current['status'] in ('idle', 'paused'):
            new_remaining = new_target
            new_started_at = None

    elif action == 'complete':
        new_status = 'idle'
        new_remaining = new_target
        new_started_at = None
        new_task = None

    with get_connection() as ctx:
        ctx.execute("""
            INSERT INTO user_timer_state (user_id, status, target_seconds, remaining_seconds, active_task_name, started_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (user_id) DO UPDATE SET
                status = EXCLUDED.status,
                target_seconds = EXCLUDED.target_seconds,
                remaining_seconds = EXCLUDED.remaining_seconds,
                active_task_name = EXCLUDED.active_task_name,
                started_at = EXCLUDED.started_at,
                updated_at = EXCLUDED.updated_at
        """ if ctx.is_pg else """
            INSERT INTO user_timer_state (user_id, status, target_seconds, remaining_seconds, active_task_name, started_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                status = excluded.status,
                target_seconds = excluded.target_seconds,
                remaining_seconds = excluded.remaining_seconds,
                active_task_name = excluded.active_task_name,
                started_at = excluded.started_at,
                updated_at = excluded.updated_at
        """, (user_id, new_status, new_target, new_remaining, new_task, new_started_at, now_ms))

    return get_timer_state(user_id)

# =========================================================================
# PER-USER SUBJECTS & SESSIONS
# =========================================================================

def get_subjects(user_id):
    with get_connection() as ctx:
        cur = ctx.execute("""
            SELECT 
                s.id, 
                s.name, 
                s.color, 
                COALESCE(SUM(sess.duration_minutes), 0) AS total_minutes,
                COUNT(sess.id) AS session_count
            FROM subjects s
            LEFT JOIN sessions sess ON s.id = sess.subject_id AND sess.user_id = ?
            WHERE s.user_id = ?
            GROUP BY s.id, s.name, s.color
            ORDER BY total_minutes DESC, s.name ASC
        """, (user_id, user_id))
        rows = [dict(r) for r in cur.fetchall()]
        for r in rows:
            tot = int(r.get('total_minutes') or 0)
            r['total_minutes'] = tot
            r['hours'] = round(tot / 60.0, 1)
        return rows

def add_or_get_subject(user_id, name, color=None):
    clean_name = name.strip()
    if not clean_name:
        clean_name = 'Focus Session'

    with get_connection() as ctx:
        cur = ctx.execute(
            "SELECT id, name, color FROM subjects WHERE user_id = ? AND LOWER(name) = LOWER(?)",
            (user_id, clean_name)
        )
        row = cur.fetchone()
        if row:
            return dict(row)

        if not color or color == '#79D99B':
            idx = abs(hash(clean_name)) % len(SUBJECT_PALETTE)
            color = SUBJECT_PALETTE[idx]

        new_id = ctx.execute_insert(
            "INSERT INTO subjects (user_id, name, color) VALUES (?, ?, ?)",
            (user_id, clean_name, color)
        )
        return {'id': new_id, 'name': clean_name, 'color': color}

def add_session(user_id, subject_name, duration_minutes, date_str=None, timestamp_ms=None, start_time=None, end_time=None):
    if duration_minutes < 1:
        duration_minutes = 1

    now = datetime.now()
    if not date_str:
        date_str = now.strftime('%Y-%m-%d')
    if not timestamp_ms:
        timestamp_ms = int(now.timestamp() * 1000)

    end_dt = datetime.fromtimestamp(timestamp_ms / 1000)
    start_dt = end_dt - timedelta(minutes=duration_minutes)

    if not start_time:
        start_time = start_dt.strftime('%I:%M %p').lstrip('0')
    if not end_time:
        end_time = end_dt.strftime('%I:%M %p').lstrip('0')

    subj = add_or_get_subject(user_id, subject_name)

    with get_connection() as ctx:
        session_id = ctx.execute_insert("""
            INSERT INTO sessions (user_id, subject_id, subject_name, duration_minutes, date, timestamp, start_time, end_time)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (user_id, subj['id'], subj['name'], duration_minutes, date_str, timestamp_ms, start_time, end_time))

    return {
        'id': f"sess_{session_id}",
        'subject_id': subj['id'],
        'subject': subj['name'],
        'color': subj['color'],
        'durationMinutes': duration_minutes,
        'date': date_str,
        'timestamp': timestamp_ms,
        'startTime': start_time,
        'endTime': end_time,
        'timeRange': f"{start_time} – {end_time}"
    }

def delete_session(user_id, session_id):
    if isinstance(session_id, str) and session_id.startswith('sess_'):
        session_id = session_id[5:]
    try:
        session_id = int(session_id)
    except (ValueError, TypeError):
        return None

    with get_connection() as ctx:
        cur = ctx.execute("""
            SELECT id, subject_id, subject_name, duration_minutes, date, timestamp
            FROM sessions
            WHERE id = ? AND user_id = ?
        """, (session_id, user_id))
        row = cur.fetchone()
        if not row:
            return None

        deleted = {
            'id': f"sess_{row['id']}",
            'numeric_id': row['id'],
            'subject_id': row['subject_id'],
            'subject_name': row['subject_name'],
            'duration_minutes': int(row['duration_minutes']),
            'date': row['date'],
            'timestamp': int(row['timestamp'])
        }

        ctx.execute("DELETE FROM sessions WHERE id = ? AND user_id = ?", (session_id, user_id))
        return deleted

def get_sessions(user_id, limit=100):
    with get_connection() as ctx:
        cur = ctx.execute("""
            SELECT sess.id, sess.subject_id, sess.subject_name, s.color, 
                   sess.duration_minutes, sess.date, sess.timestamp,
                   sess.start_time, sess.end_time
            FROM sessions sess
            LEFT JOIN subjects s ON sess.subject_id = s.id
            WHERE sess.user_id = ?
            ORDER BY sess.timestamp DESC
            LIMIT ?
        """, (user_id, limit))

        rows = [dict(r) for r in cur.fetchall()]
        result = []
        for r in rows:
            duration = int(r['duration_minutes'])
            ts = int(r['timestamp'])
            end_dt = datetime.fromtimestamp(ts / 1000)
            start_dt = end_dt - timedelta(minutes=duration)
            start_str = r['start_time'] or start_dt.strftime('%I:%M %p').lstrip('0')
            end_str = r['end_time'] or end_dt.strftime('%I:%M %p').lstrip('0')

            result.append({
                'id': f"sess_{r['id']}",
                'subject_id': r['subject_id'],
                'subject': r['subject_name'],
                'color': r['color'] or '#79D99B',
                'durationMinutes': duration,
                'date': r['date'],
                'timestamp': ts,
                'startTime': start_str,
                'endTime': end_str,
                'timeRange': f"{start_str} – {end_str}",
                'xp': duration
            })
        return result

def get_day_details(user_id, date_str):
    with get_connection() as ctx:
        cur = ctx.execute("""
            SELECT sess.id, sess.subject_id, sess.subject_name, s.color,
                   sess.duration_minutes, sess.date, sess.timestamp,
                   sess.start_time, sess.end_time
            FROM sessions sess
            LEFT JOIN subjects s ON sess.subject_id = s.id
            WHERE sess.user_id = ? AND sess.date = ?
            ORDER BY sess.timestamp ASC
        """, (user_id, date_str))
        rows = [dict(r) for r in cur.fetchall()]

    sessions = []
    total_minutes = 0
    for r in rows:
        duration = int(r['duration_minutes'])
        total_minutes += duration
        ts = int(r['timestamp'])
        end_dt = datetime.fromtimestamp(ts / 1000)
        start_dt = end_dt - timedelta(minutes=duration)
        start_str = r['start_time'] or start_dt.strftime('%I:%M %p').lstrip('0')
        end_str = r['end_time'] or end_dt.strftime('%I:%M %p').lstrip('0')

        sessions.append({
            'id': f"sess_{r['id']}",
            'subject_id': r['subject_id'],
            'subject': r['subject_name'],
            'color': r['color'] or '#79D99B',
            'durationMinutes': duration,
            'date': r['date'],
            'timestamp': ts,
            'startTime': start_str,
            'endTime': end_str,
            'timeRange': f"{start_str} – {end_str}",
            'xp': duration
        })

    total_sessions = len(sessions)
    avg_minutes = round(total_minutes / total_sessions, 1) if total_sessions > 0 else 0

    try:
        dt = datetime.strptime(date_str, '%Y-%m-%d')
        formatted_date = dt.strftime('%A, %B %d, %Y')
    except Exception:
        formatted_date = date_str

    today_str = datetime.now().strftime('%Y-%m-%d')
    is_today = (date_str == today_str)

    hrs = total_minutes // 60
    mins = total_minutes % 60
    total_formatted = f"{hrs}h {mins}m" if hrs > 0 else f"{mins}m"

    return {
        'date': date_str,
        'formattedDate': formatted_date,
        'isToday': is_today,
        'totalMinutes': total_minutes,
        'totalTimeFormatted': total_formatted,
        'totalSessions': total_sessions,
        'avgFocusMinutes': avg_minutes,
        'totalXp': total_minutes,
        'sessions': sessions
    }

def get_daily_activity(user_id):
    with get_connection() as ctx:
        cur = ctx.execute("""
            SELECT date, SUM(duration_minutes) as total_minutes
            FROM sessions
            WHERE user_id = ?
            GROUP BY date
            ORDER BY date ASC
        """, (user_id,))
        rows = [dict(r) for r in cur.fetchall()]
        return {r['date']: int(r['total_minutes']) for r in rows}

def get_stats(user_id):
    today_str = datetime.now().strftime('%Y-%m-%d')
    with get_connection() as ctx:
        cur = ctx.execute("SELECT COALESCE(SUM(duration_minutes), 0) FROM sessions WHERE user_id = ?", (user_id,))
        total_focus_minutes = int(fetch_scalar(cur.fetchone()) or 0)

        cur = ctx.execute(
            "SELECT COALESCE(SUM(duration_minutes), 0) FROM sessions WHERE user_id = ? AND date = ?",
            (user_id, today_str)
        )
        today_focus_minutes = int(fetch_scalar(cur.fetchone()) or 0)

        cur = ctx.execute("""
            SELECT date, SUM(duration_minutes) as mins
            FROM sessions
            WHERE user_id = ?
            GROUP BY date
            HAVING SUM(duration_minutes) > 0
            ORDER BY date DESC
        """, (user_id,))
        active_dates = {dict(row)['date'] for row in cur.fetchall()}

    current_check = datetime.now().date()
    if today_str not in active_dates:
        current_check -= timedelta(days=1)

    streak = 0
    while current_check.strftime('%Y-%m-%d') in active_dates:
        streak += 1
        current_check -= timedelta(days=1)

    return {
        'streak': streak,
        'xp': total_focus_minutes,
        'totalFocusSeconds': total_focus_minutes * 60,
        'todayFocusSeconds': today_focus_minutes * 60,
        'todayFocusMinutes': today_focus_minutes
    }

def reset_database(user_id):
    with get_connection() as ctx:
        ctx.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        ctx.execute("DELETE FROM subjects WHERE user_id = ?", (user_id,))
        # Re-seed default subjects
        for s_name, s_color in DEFAULT_STARTER_SUBJECTS:
            ctx.execute(
                "INSERT INTO subjects (user_id, name, color) VALUES (?, ?, ?)",
                (user_id, s_name, s_color)
            )
        # Reset timer
        update_timer_state(user_id, 'reset', target_seconds=3600)
