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
            if conn.closed:
                try:
                    pg_pool.putconn(conn, close=True)
                except Exception:
                    pass
                conn = pg_pool.getconn()
            conn.autocommit = True
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
                if exc_type is not None and not getattr(self.conn, 'autocommit', False):
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
        if not getattr(self.conn, 'autocommit', False):
            self.conn.commit()

    def execute(self, sql, params=()):
        if self.is_pg:
            sql_pg = sql.replace('?', '%s')
            try:
                cur = self.conn.cursor()
                cur.execute(sql_pg, params)
                return cur
            except (psycopg2.OperationalError, psycopg2.InterfaceError):
                try:
                    get_pg_pool().putconn(self.conn, close=True)
                except Exception:
                    pass
                self.conn = get_pg_pool().getconn()
                self.conn.autocommit = True
                cur = self.conn.cursor()
                cur.execute(sql_pg, params)
                return cur
        else:
            cur = self.conn.cursor()
            cur.execute(sql, params)
            return cur

    def execute_insert(self, sql, params=()):
        """
        Executes an INSERT query and returns the newly generated integer primary key.
        """
        if self.is_pg:
            sql_pg = sql.replace('?', '%s') + " RETURNING id"
            try:
                cur = self.conn.cursor()
                cur.execute(sql_pg, params)
                res = cur.fetchone()
                val = fetch_scalar(res)
                return int(val) if val is not None else None
            except (psycopg2.OperationalError, psycopg2.InterfaceError):
                try:
                    get_pg_pool().putconn(self.conn, close=True)
                except Exception:
                    pass
                self.conn = get_pg_pool().getconn()
                self.conn.autocommit = True
                cur = self.conn.cursor()
                cur.execute(sql_pg, params)
                res = cur.fetchone()
                val = fetch_scalar(res)
                return int(val) if val is not None else None
        else:
            cur = self.conn.cursor()
            cur.execute(sql, params)
            return cur.lastrowid
def get_connection():
    """Factory creating the unified DBContext manager."""
    return DBContext()

DEFAULT_STARTER_SUBJECTS = [
    ('Deep Work', '#10E068'),
    ('Reading', '#34E87C'),
    ('Problem Solving', '#05DF63'),
    ('Learning', '#4EFA8F')
]

SUBJECT_PALETTE = [
    '#10E068', '#4EFA8F', '#22C55E', '#16A34A', '#05DF63',
    '#34E87C', '#6EFF9F', '#00C853', '#10B981', '#00E676'
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
                    target_seconds INTEGER NOT NULL DEFAULT 5400,
                    remaining_seconds INTEGER NOT NULL DEFAULT 5400,
                    active_task_name VARCHAR(255),
                    started_at BIGINT,
                    updated_at BIGINT NOT NULL,
                    sequence BIGINT NOT NULL DEFAULT 1
                )
            """)
            ctx.execute("ALTER TABLE user_timer_state ADD COLUMN IF NOT EXISTS sequence BIGINT NOT NULL DEFAULT 1")

            # 3. Subjects Table
            ctx.execute("""
                CREATE TABLE IF NOT EXISTS subjects (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    name VARCHAR(255) NOT NULL,
                    color VARCHAR(32) NOT NULL DEFAULT '#10E068',
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
                    target_seconds INTEGER NOT NULL DEFAULT 5400,
                    remaining_seconds INTEGER NOT NULL DEFAULT 5400,
                    active_task_name TEXT,
                    started_at INTEGER,
                    updated_at INTEGER NOT NULL,
                    sequence INTEGER NOT NULL DEFAULT 1
                )
            """)

            cur = ctx.execute("PRAGMA table_info(user_timer_state)")
            cols = [r['name'] for r in cur.fetchall()]
            if 'sequence' not in cols:
                ctx.execute("ALTER TABLE user_timer_state ADD COLUMN sequence INTEGER NOT NULL DEFAULT 1")

            ctx.execute("""
                CREATE TABLE IF NOT EXISTS subjects (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    color TEXT NOT NULL DEFAULT '#10E068',
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
            VALUES (?, 'idle', 5400, 5400, ?)
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
            SELECT status, target_seconds, remaining_seconds, active_task_name, started_at, updated_at, sequence
            FROM user_timer_state
            WHERE user_id = ?
        """, (user_id,))
        row = cur.fetchone()

        if not row:
            ctx.execute("""
                INSERT INTO user_timer_state (user_id, status, target_seconds, remaining_seconds, updated_at, sequence)
                VALUES (?, 'idle', 5400, 5400, ?, 1)
            """, (user_id, now_ms))
            return {
                'status': 'idle',
                'targetSeconds': 5400,
                'remainingSeconds': 5400,
                'activeTaskName': None,
                'startedAt': None,
                'hasCompleted': False,
                'sequence': 1,
                'version': 1
            }

        state = dict(row)
        status = state['status']
        target_secs = int(state['target_seconds'])
        remaining_secs = int(state['remaining_seconds'])
        started_at = state.get('started_at')
        active_task = state.get('active_task_name')
        sequence = int(state.get('sequence') or 1)
        has_completed = False

        current_rem = remaining_secs
        if status == 'running' and started_at:
            elapsed_seconds = (now_ms - int(started_at)) / 1000.0
            calc_remaining = remaining_secs - elapsed_seconds
            if calc_remaining <= 0:
                calc_remaining = 0
                has_completed = True
                status = 'idle'
                remaining_secs = target_secs
                started_at = None
                try:
                    ctx.execute("""
                        UPDATE user_timer_state
                        SET status = 'idle', remaining_seconds = target_seconds, started_at = NULL, sequence = sequence + 1
                        WHERE user_id = ?
                    """, (user_id,))
                except Exception as e:
                    print(f"[Timer] DB auto-idle update warning: {e}")
            current_rem = max(0, int(calc_remaining))

        return {
            'status': status,
            'targetSeconds': target_secs,
            'remainingSeconds': remaining_secs,
            'currentRemaining': current_rem,
            'activeTaskName': active_task,
            'startedAt': started_at,
            'hasCompleted': has_completed,
            'sequence': sequence,
            'version': sequence
        }

def update_timer_state(user_id, action, target_seconds=None, active_task_name=None, remaining_seconds=None, status=None, started_at=None, sequence=None):
    now_ms = int(datetime.now().timestamp() * 1000)

    # Optimization: if caller already computed state in RAM (e.g. server.py hot cache),
    # bypass redundant SELECT query over the network and directly persist UPSERT!
    if status is not None and sequence is not None:
        new_status = status
        new_target = int(target_seconds) if target_seconds is not None else 5400
        new_remaining = int(remaining_seconds) if remaining_seconds is not None else new_target
        new_task = active_task_name
        new_started_at = started_at
        new_sequence = int(sequence)
    else:
        current = get_timer_state(user_id)
        new_status = current['status']
        new_target = target_seconds if target_seconds is not None else current['targetSeconds']
        new_remaining = current['remainingSeconds']
        new_task = active_task_name if active_task_name is not None else current['activeTaskName']
        new_started_at = current.get('startedAt')
        new_sequence = int(current.get('sequence') or 1) + 1

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
            if current['status'] in ('idle', 'paused'):
                new_remaining = new_target
                new_started_at = None

        elif action == 'complete':
            new_status = 'idle'
            new_target = int(target_seconds) if target_seconds else 5400
            new_remaining = new_target
            new_started_at = None
            new_task = None

    with get_connection() as ctx:
        ctx.execute("""
            INSERT INTO user_timer_state (user_id, status, target_seconds, remaining_seconds, active_task_name, started_at, updated_at, sequence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (user_id) DO UPDATE SET
                status = EXCLUDED.status,
                target_seconds = EXCLUDED.target_seconds,
                remaining_seconds = EXCLUDED.remaining_seconds,
                active_task_name = EXCLUDED.active_task_name,
                started_at = EXCLUDED.started_at,
                updated_at = EXCLUDED.updated_at,
                sequence = EXCLUDED.sequence
        """ if ctx.is_pg else """
            INSERT INTO user_timer_state (user_id, status, target_seconds, remaining_seconds, active_task_name, started_at, updated_at, sequence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                status = excluded.status,
                target_seconds = excluded.target_seconds,
                remaining_seconds = excluded.remaining_seconds,
                active_task_name = excluded.active_task_name,
                started_at = excluded.started_at,
                updated_at = excluded.updated_at,
                sequence = excluded.sequence
        """, (user_id, new_status, new_target, new_remaining, new_task, new_started_at, now_ms, new_sequence))

    return {
        'status': new_status,
        'targetSeconds': new_target,
        'remainingSeconds': new_remaining,
        'currentRemaining': new_remaining,
        'activeTaskName': new_task,
        'startedAt': new_started_at,
        'hasCompleted': False,
        'sequence': new_sequence,
        'version': new_sequence
    }

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

        if not color or color == '#10E068':
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
                'color': r['color'] or '#10E068',
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
            'color': r['color'] or '#10E068',
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

def get_full_state(user_id):
    """
    High-performance state aggregation. Loads timer, subjects, sessions,
    and daily activity in a SINGLE database round trip, computing gamification
    metrics in-memory for instant page loading.
    """
    now_ms = int(datetime.now().timestamp() * 1000)
    today_str = datetime.now().strftime('%Y-%m-%d')

    with get_connection() as ctx:
        if ctx.is_pg:
            cur = ctx.execute("""
                SELECT json_build_object(
                    'timer', (
                        SELECT row_to_json(t) FROM (
                            SELECT status, target_seconds, remaining_seconds, active_task_name, started_at, updated_at 
                            FROM user_timer_state WHERE user_id = %s
                        ) t
                    ),
                    'subjects', (
                        SELECT COALESCE(json_agg(sub), '[]'::json) FROM (
                            SELECT s.id, s.name, s.color, COALESCE(SUM(sess.duration_minutes), 0)::int AS total_minutes, COUNT(sess.id)::int AS session_count
                            FROM subjects s
                            LEFT JOIN sessions sess ON s.id = sess.subject_id AND sess.user_id = %s
                            WHERE s.user_id = %s
                            GROUP BY s.id, s.name, s.color
                            ORDER BY total_minutes DESC, s.name ASC
                        ) sub
                    ),
                    'sessions', (
                        SELECT COALESCE(json_agg(sess_row), '[]'::json) FROM (
                            SELECT sess.id, sess.subject_id, sess.subject_name, s.color, sess.duration_minutes, sess.date, sess.timestamp, sess.start_time, sess.end_time
                            FROM sessions sess
                            LEFT JOIN subjects s ON sess.subject_id = s.id
                            WHERE sess.user_id = %s
                            ORDER BY sess.timestamp DESC
                            LIMIT 100
                        ) sess_row
                    ),
                    'activity', (
                        SELECT COALESCE(json_object_agg(a.date, a.total_minutes), '{}'::json) FROM (
                            SELECT date, SUM(duration_minutes)::int as total_minutes
                            FROM sessions WHERE user_id = %s
                            GROUP BY date ORDER BY date ASC
                        ) a
                    )
                ) AS full_state
            """, (user_id, user_id, user_id, user_id, user_id))
            data = cur.fetchone()['full_state']
        else:
            # SQLite fallback: fetch with single connection
            cur_t = ctx.execute("SELECT * FROM user_timer_state WHERE user_id = ?", (user_id,))
            t_row = cur_t.fetchone()
            cur_s = ctx.execute("""
                SELECT s.id, s.name, s.color, COALESCE(SUM(sess.duration_minutes), 0) AS total_minutes, COUNT(sess.id) AS session_count
                FROM subjects s LEFT JOIN sessions sess ON s.id = sess.subject_id AND sess.user_id = ?
                WHERE s.user_id = ? GROUP BY s.id, s.name, s.color ORDER BY total_minutes DESC, s.name ASC
            """, (user_id, user_id))
            sub_rows = [dict(r) for r in cur_s.fetchall()]
            cur_sess = ctx.execute("""
                SELECT sess.id, sess.subject_id, sess.subject_name, s.color, sess.duration_minutes, sess.date, sess.timestamp, sess.start_time, sess.end_time
                FROM sessions sess LEFT JOIN subjects s ON sess.subject_id = s.id
                WHERE sess.user_id = ? ORDER BY sess.timestamp DESC LIMIT 100
            """, (user_id,))
            sess_rows = [dict(r) for r in cur_sess.fetchall()]
            cur_act = ctx.execute("SELECT date, SUM(duration_minutes) as total_minutes FROM sessions WHERE user_id = ? GROUP BY date ORDER BY date ASC", (user_id,))
            act_dict = {r['date']: int(r['total_minutes']) for r in cur_act.fetchall()}
            data = {
                'timer': dict(t_row) if t_row else None,
                'subjects': sub_rows,
                'sessions': sess_rows,
                'activity': act_dict
            }

    # 1. Process Timer State
    timer_raw = data.get('timer') or {'status': 'idle', 'target_seconds': 5400, 'remaining_seconds': 5400}
    status = timer_raw.get('status', 'idle')
    target_secs = int(timer_raw.get('target_seconds', 5400))
    remaining_secs = int(timer_raw.get('remaining_seconds', 5400))
    started_at = timer_raw.get('started_at')
    has_completed = False

    if status == 'running' and started_at:
        elapsed = (now_ms - int(started_at)) / 1000.0
        calc_rem = remaining_secs - elapsed
        if calc_rem <= 0:
            calc_rem = 0
            has_completed = True
            status = 'idle'
            remaining_secs = target_secs
            started_at = None
            try:
                with get_connection() as c2:
                    c2.execute("""
                        UPDATE user_timer_state
                        SET status = 'idle', remaining_seconds = target_seconds, started_at = NULL, sequence = sequence + 1
                        WHERE user_id = ?
                    """, (user_id,))
            except Exception as e:
                print(f"[Timer] DB full_state auto-idle warning: {e}")
        else:
            remaining_secs = max(0, int(calc_rem))

    timer_res = {
        'status': status,
        'targetSeconds': target_secs,
        'remainingSeconds': remaining_secs,
        'activeTaskName': timer_raw.get('active_task_name'),
        'startedAt': started_at,
        'hasCompleted': has_completed
    }

    # 2. Process Subjects
    subjects_res = []
    for s in (data.get('subjects') or []):
        tot = int(s.get('total_minutes') or 0)
        subjects_res.append({
            'id': s['id'],
            'name': s['name'],
            'color': s.get('color', '#10E068'),
            'total_minutes': tot,
            'hours': round(tot / 60.0, 1),
            'session_count': int(s.get('session_count') or 0)
        })

    # 3. Process Sessions
    sessions_res = []
    for r in (data.get('sessions') or []):
        duration = int(r['duration_minutes'])
        ts = int(r['timestamp'])
        end_dt = datetime.fromtimestamp(ts / 1000)
        start_dt = end_dt - timedelta(minutes=duration)
        start_str = r.get('start_time') or start_dt.strftime('%I:%M %p').lstrip('0')
        end_str = r.get('end_time') or end_dt.strftime('%I:%M %p').lstrip('0')
        sessions_res.append({
            'id': f"sess_{r['id']}",
            'subject_id': r['subject_id'],
            'subject': r['subject_name'],
            'color': r.get('color') or '#10E068',
            'durationMinutes': duration,
            'date': r['date'],
            'timestamp': ts,
            'startTime': start_str,
            'endTime': end_str,
            'timeRange': f"{start_str} – {end_str}",
            'xp': duration
        })

    # 4. Process Activity & Compute Stats in Python (0 extra DB queries!)
    day_act = {k: int(v) for k, v in (data.get('activity') or {}).items()}
    tot_focus_mins = sum(day_act.values())
    today_focus_mins = day_act.get(today_str, 0)

    active_dates = {d for d, mins in day_act.items() if mins > 0}
    current_check = datetime.now().date()
    if today_str not in active_dates:
        current_check -= timedelta(days=1)
    streak = 0
    while current_check.strftime('%Y-%m-%d') in active_dates:
        streak += 1
        current_check -= timedelta(days=1)

    stats_res = {
        'streak': streak,
        'xp': tot_focus_mins,
        'totalFocusSeconds': tot_focus_mins * 60,
        'todayFocusSeconds': today_focus_mins * 60,
        'todayFocusMinutes': today_focus_mins
    }

    return {
        'subjects': subjects_res,
        'sessions': sessions_res,
        'dayActivity': day_act,
        'stats': stats_res,
        'timer': timer_res
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
        update_timer_state(user_id, 'reset', target_seconds=5400)
