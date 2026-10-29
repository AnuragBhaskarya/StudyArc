import sqlite3
import os
import random
import json
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
MAX_TIMER_SECONDS = 3 * 3600  # Hard ceiling for a focus session (3 hours)
MIN_ACTIVE_TIMER_SECONDS = 30 * 60  # Live sessions never drop below 30 minutes

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
    def __init__(self, autocommit=False):
        self.is_pg = is_postgres()
        self.autocommit = autocommit
        if self.is_pg:
            pg_pool = get_pg_pool()
            conn = pg_pool.getconn()
            if conn.closed:
                try:
                    pg_pool.putconn(conn, close=True)
                except Exception:
                    pass
                conn = pg_pool.getconn()
            conn.autocommit = self.autocommit
            self.conn = conn
        else:
            self.conn = sqlite3.connect(DB_PATH, timeout=10.0)
            self.conn.row_factory = sqlite3.Row
            self.conn.execute("PRAGMA foreign_keys = ON")
            self.conn.execute("PRAGMA busy_timeout = 10000")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.is_pg:
            try:
                if exc_type is not None:
                    if not getattr(self.conn, 'autocommit', False):
                        self.conn.rollback()
                else:
                    if not getattr(self.conn, 'autocommit', False):
                        self.conn.commit()
            except Exception:
                try:
                    self.conn.rollback()
                except Exception:
                    pass
            finally:
                try:
                    if getattr(self.conn, 'closed', 0) != 0:
                        get_pg_pool().putconn(self.conn, close=True)
                    else:
                        get_pg_pool().putconn(self.conn)
                except Exception:
                    pass
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
                self.conn.autocommit = self.autocommit
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
                self.conn.autocommit = self.autocommit
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
                    last_login_at TIMESTAMP,
                    aura_enabled BOOLEAN NOT NULL DEFAULT TRUE
                )
            """)
            ctx.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS aura_enabled BOOLEAN NOT NULL DEFAULT TRUE")

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
                    sequence BIGINT NOT NULL DEFAULT 1,
                    session_started_at BIGINT,
                    intervals_json TEXT
                )
            """)
            ctx.execute("ALTER TABLE user_timer_state ADD COLUMN IF NOT EXISTS sequence BIGINT NOT NULL DEFAULT 1")
            ctx.execute("ALTER TABLE user_timer_state ADD COLUMN IF NOT EXISTS session_started_at BIGINT")
            ctx.execute("ALTER TABLE user_timer_state ADD COLUMN IF NOT EXISTS intervals_json TEXT")

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
                    subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
                    subject_name VARCHAR(255) NOT NULL,
                    duration_minutes INTEGER NOT NULL,
                    date VARCHAR(32) NOT NULL,
                    timestamp BIGINT NOT NULL,
                    start_time VARCHAR(32),
                    end_time VARCHAR(32),
                    xp INTEGER NOT NULL DEFAULT 0,
                    session_start_ms BIGINT,
                    session_end_ms BIGINT,
                    break_minutes INTEGER NOT NULL DEFAULT 0,
                    timeline_json TEXT,
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

            cur = ctx.execute("""
                SELECT column_name FROM information_schema.columns 
                WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'xp'
            """)
            if not cur.fetchone():
                ctx.execute("ALTER TABLE sessions ADD COLUMN xp INTEGER NOT NULL DEFAULT 0")
            ctx.execute("UPDATE sessions SET xp = duration_minutes * 10 WHERE xp IS NULL OR xp = 0")

            ctx.execute("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_start_ms BIGINT")
            ctx.execute("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_end_ms BIGINT")
            ctx.execute("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS break_minutes INTEGER NOT NULL DEFAULT 0")
            ctx.execute("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS timeline_json TEXT")

            try:
                ctx.execute("ALTER TABLE sessions ALTER COLUMN subject_id DROP NOT NULL")
                ctx.execute("ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_subject_id_fkey")
                ctx.execute("ALTER TABLE sessions ADD CONSTRAINT sessions_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL")
            except Exception:
                pass

            ctx.execute("ALTER TABLE subjects DROP CONSTRAINT IF EXISTS subjects_name_key")
            ctx.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_lower_username ON users (LOWER(username))")
            ctx.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_user_name ON subjects (user_id, LOWER(name))")
            ctx.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_date ON sessions (user_id, date)")
            ctx.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_ts ON sessions (user_id, timestamp DESC)")
            ctx.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_subject ON sessions (user_id, subject_id)")

        else:
            # SQLite Schema
            try:
                ctx.conn.execute("PRAGMA journal_mode = WAL")
                ctx.conn.execute("PRAGMA synchronous = NORMAL")
            except Exception:
                pass
            ctx.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_login_at TIMESTAMP,
                    aura_enabled INTEGER NOT NULL DEFAULT 1
                )
            """)

            cur = ctx.execute("PRAGMA table_info(users)")
            user_cols = [r['name'] for r in cur.fetchall()]
            if 'aura_enabled' not in user_cols:
                ctx.execute("ALTER TABLE users ADD COLUMN aura_enabled INTEGER NOT NULL DEFAULT 1")

            ctx.execute("""
                CREATE TABLE IF NOT EXISTS user_timer_state (
                    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    status TEXT NOT NULL DEFAULT 'idle',
                    target_seconds INTEGER NOT NULL DEFAULT 5400,
                    remaining_seconds INTEGER NOT NULL DEFAULT 5400,
                    active_task_name TEXT,
                    started_at INTEGER,
                    updated_at INTEGER NOT NULL,
                    sequence INTEGER NOT NULL DEFAULT 1,
                    session_started_at INTEGER,
                    intervals_json TEXT
                )
            """)

            cur = ctx.execute("PRAGMA table_info(user_timer_state)")
            cols = [r['name'] for r in cur.fetchall()]
            if 'sequence' not in cols:
                ctx.execute("ALTER TABLE user_timer_state ADD COLUMN sequence INTEGER NOT NULL DEFAULT 1")
            if 'session_started_at' not in cols:
                ctx.execute("ALTER TABLE user_timer_state ADD COLUMN session_started_at INTEGER")
            if 'intervals_json' not in cols:
                ctx.execute("ALTER TABLE user_timer_state ADD COLUMN intervals_json TEXT")

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
                    subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
                    subject_name TEXT NOT NULL,
                    duration_minutes INTEGER NOT NULL,
                    date TEXT NOT NULL,
                    timestamp BIGINT NOT NULL,
                    start_time TEXT,
                    end_time TEXT,
                    xp INTEGER NOT NULL DEFAULT 0,
                    session_start_ms INTEGER,
                    session_end_ms INTEGER,
                    break_minutes INTEGER NOT NULL DEFAULT 0,
                    timeline_json TEXT,
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
            if 'xp' not in cols:
                ctx.execute("ALTER TABLE sessions ADD COLUMN xp INTEGER NOT NULL DEFAULT 0")
            if 'session_start_ms' not in cols:
                ctx.execute("ALTER TABLE sessions ADD COLUMN session_start_ms INTEGER")
            if 'session_end_ms' not in cols:
                ctx.execute("ALTER TABLE sessions ADD COLUMN session_end_ms INTEGER")
            if 'break_minutes' not in cols:
                ctx.execute("ALTER TABLE sessions ADD COLUMN break_minutes INTEGER NOT NULL DEFAULT 0")
            if 'timeline_json' not in cols:
                ctx.execute("ALTER TABLE sessions ADD COLUMN timeline_json TEXT")
            ctx.execute("UPDATE sessions SET xp = duration_minutes * 10 WHERE xp IS NULL OR xp = 0")

            # SQLite automatic migration: decouple sessions from subject ON DELETE CASCADE
            try:
                cur = ctx.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'")
                row = cur.fetchone()
                if row and 'ON DELETE CASCADE' in row['sql'] and 'subject_id' in row['sql']:
                    ctx.execute("PRAGMA foreign_keys = OFF")
                    ctx.execute("""
                        CREATE TABLE sessions_v2 (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                            subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
                            subject_name TEXT NOT NULL,
                            duration_minutes INTEGER NOT NULL,
                            date TEXT NOT NULL,
                            timestamp BIGINT NOT NULL,
                            start_time TEXT,
                            end_time TEXT,
                            xp INTEGER NOT NULL DEFAULT 0,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        )
                    """)
                    ctx.execute("INSERT INTO sessions_v2 (id, user_id, subject_id, subject_name, duration_minutes, date, timestamp, start_time, end_time, xp, created_at) SELECT id, user_id, subject_id, subject_name, duration_minutes, date, timestamp, start_time, end_time, COALESCE(NULLIF(xp, 0), duration_minutes * 10), created_at FROM sessions")
                    ctx.execute("DROP TABLE sessions")
                    ctx.execute("ALTER TABLE sessions_v2 RENAME TO sessions")
                    ctx.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_date ON sessions (user_id, date)")
                    ctx.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_ts ON sessions (user_id, timestamp DESC)")
                    ctx.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_subject ON sessions (user_id, subject_id)")
                    ctx.execute("PRAGMA foreign_keys = ON")
            except Exception as e:
                print(f"[DB SQLite Migration] sessions constraint notice: {e}")

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
            "SELECT id, username, password_hash, created_at, last_login_at, aura_enabled FROM users WHERE LOWER(username) = LOWER(?)",
            (clean_user,)
        )
        row = cur.fetchone()
        return dict(row) if row else None

def get_user_by_id(user_id):
    with get_connection() as ctx:
        cur = ctx.execute(
            "SELECT id, username, created_at, last_login_at, aura_enabled FROM users WHERE id = ?",
            (user_id,)
        )
        row = cur.fetchone()
        return dict(row) if row else None

def get_user_preferences(user_id):
    with get_connection() as ctx:
        cur = ctx.execute("SELECT aura_enabled FROM users WHERE id = ?", (user_id,))
        row = cur.fetchone()
    if not row:
        return {'auraEnabled': True}
    value = row['aura_enabled']
    return {'auraEnabled': bool(value) if value is not None else True}

def set_user_aura_enabled(user_id, enabled):
    with get_connection() as ctx:
        ctx.execute(
            "UPDATE users SET aura_enabled = ? WHERE id = ?",
            (bool(enabled), user_id)
        )
    return {'auraEnabled': bool(enabled)}

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
            SELECT status, target_seconds, remaining_seconds, active_task_name, started_at, updated_at, sequence, session_started_at, intervals_json
            FROM user_timer_state
            WHERE user_id = ?
        """, (user_id,))
        row = cur.fetchone()

        if not row:
            ctx.execute("""
                INSERT INTO user_timer_state (user_id, status, target_seconds, remaining_seconds, updated_at, sequence, session_started_at, intervals_json)
                VALUES (?, 'idle', 5400, 5400, ?, 1, NULL, '[]')
            """, (user_id, now_ms))
            return {
                'status': 'idle',
                'targetSeconds': 5400,
                'remainingSeconds': 5400,
                'activeTaskName': None,
                'startedAt': None,
                'sessionStartedAt': None,
                'intervals': [],
                'hasCompleted': False,
                'sequence': 1,
                'version': 1
            }

        state = dict(row)
        status = state['status']
        target_secs = int(state['target_seconds'])
        remaining_secs = int(state['remaining_seconds'])
        started_at = state.get('started_at')
        session_started_at = state.get('session_started_at')
        active_task = state.get('active_task_name')
        sequence = int(state.get('sequence') or 1)
        intervals_raw = state.get('intervals_json')
        intervals = []
        if intervals_raw:
            try:
                intervals = json.loads(intervals_raw)
            except Exception:
                intervals = []
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
                session_started_at = None
                intervals = []
                try:
                    ctx.execute("""
                        UPDATE user_timer_state
                        SET status = 'idle', remaining_seconds = target_seconds, started_at = NULL, session_started_at = NULL, intervals_json = '[]', sequence = sequence + 1
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
            'sessionStartedAt': session_started_at,
            'intervals': intervals,
            'hasCompleted': has_completed,
            'sequence': sequence,
            'version': sequence
        }

def update_timer_state(user_id, action, target_seconds=None, active_task_name=None, remaining_seconds=None, status=None, started_at=None, sequence=None, session_started_at=None, intervals_json=None):
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
        new_session_started_at = session_started_at
        if isinstance(intervals_json, (list, dict)):
            new_intervals_json = json.dumps(intervals_json)
        else:
            new_intervals_json = intervals_json if intervals_json is not None else '[]'
    else:
        current = get_timer_state(user_id)
        new_status = current['status']
        new_target = target_seconds if target_seconds is not None else current['targetSeconds']
        new_remaining = current['remainingSeconds']
        new_task = active_task_name if active_task_name is not None else current['activeTaskName']
        new_started_at = current.get('startedAt')
        new_session_started_at = current.get('sessionStartedAt')
        current_intervals = current.get('intervals') or []
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
            new_session_started_at = now_ms
            current_intervals = [{'type': 'focus', 'start': now_ms, 'end': None}]
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
            if current_intervals and current_intervals[-1].get('end') is None:
                current_intervals[-1]['end'] = now_ms
            current_intervals.append({'type': 'break', 'start': now_ms, 'end': None})

        elif action == 'resume':
            new_status = 'running'
            if remaining_seconds is not None:
                new_remaining = int(remaining_seconds)
            else:
                new_remaining = current.get('remainingSeconds', 5400)
            new_started_at = now_ms
            if not new_session_started_at:
                new_session_started_at = now_ms
            if current_intervals and current_intervals[-1].get('end') is None:
                current_intervals[-1]['end'] = now_ms
            current_intervals.append({'type': 'focus', 'start': now_ms, 'end': None})

        elif action == 'reset':
            new_status = 'idle'
            new_target = int(target_seconds) if target_seconds else 5400
            new_remaining = new_target
            new_started_at = None
            new_session_started_at = None
            current_intervals = []
            new_task = None

        elif action == 'adjust':
            new_target = max(0, min(MAX_TIMER_SECONDS, int(new_target)))
            client_rem = int(remaining_seconds) if remaining_seconds is not None else None

            if current['status'] in ('running', 'paused'):
                new_target = max(MIN_ACTIVE_TIMER_SECONDS, min(MAX_TIMER_SECONDS, int(new_target)))

            if current['status'] == 'running':
                if client_rem is None:
                    client_rem = max(0, int(current.get('remainingSeconds', new_target)))
                new_remaining = max(0, min(new_target, MAX_TIMER_SECONDS, client_rem))
                new_started_at = now_ms
            elif current['status'] == 'paused':
                if client_rem is None:
                    client_rem = max(0, int(current.get('remainingSeconds', new_target)))
                new_remaining = max(0, min(new_target, MAX_TIMER_SECONDS, client_rem))
                new_started_at = None
            else:
                new_status = 'idle'
                new_remaining = new_target
                new_started_at = None
                new_session_started_at = None
                current_intervals = []

        elif action == 'complete':
            new_status = 'idle'
            new_target = int(target_seconds) if target_seconds else current.get('targetSeconds', 5400)
            new_remaining = new_target
            new_started_at = None
            new_session_started_at = None
            current_intervals = []
            new_task = None

        new_intervals_json = json.dumps(current_intervals)

    with get_connection() as ctx:
        ctx.execute("""
            INSERT INTO user_timer_state (user_id, status, target_seconds, remaining_seconds, active_task_name, started_at, updated_at, sequence, session_started_at, intervals_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (user_id) DO UPDATE SET
                status = EXCLUDED.status,
                target_seconds = EXCLUDED.target_seconds,
                remaining_seconds = EXCLUDED.remaining_seconds,
                active_task_name = EXCLUDED.active_task_name,
                started_at = EXCLUDED.started_at,
                updated_at = EXCLUDED.updated_at,
                sequence = EXCLUDED.sequence,
                session_started_at = EXCLUDED.session_started_at,
                intervals_json = EXCLUDED.intervals_json
            WHERE EXCLUDED.sequence >= user_timer_state.sequence
        """ if ctx.is_pg else """
            INSERT INTO user_timer_state (user_id, status, target_seconds, remaining_seconds, active_task_name, started_at, updated_at, sequence, session_started_at, intervals_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                status = excluded.status,
                target_seconds = excluded.target_seconds,
                remaining_seconds = excluded.remaining_seconds,
                active_task_name = excluded.active_task_name,
                started_at = excluded.started_at,
                updated_at = excluded.updated_at,
                sequence = excluded.sequence,
                session_started_at = excluded.session_started_at,
                intervals_json = excluded.intervals_json
            WHERE excluded.sequence >= user_timer_state.sequence
        """, (user_id, new_status, new_target, new_remaining, new_task, new_started_at, now_ms, new_sequence, new_session_started_at, new_intervals_json))

    try:
        parsed_intervals = json.loads(new_intervals_json) if new_intervals_json else []
    except Exception:
        parsed_intervals = []

    return {
        'status': new_status,
        'targetSeconds': new_target,
        'remainingSeconds': new_remaining,
        'currentRemaining': new_remaining,
        'activeTaskName': new_task,
        'startedAt': new_started_at,
        'sessionStartedAt': new_session_started_at,
        'intervals': parsed_intervals,
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

def calculate_session_xp(user_id, duration_minutes, date_str=None, unpaused=True):
    """
    Computes dynamic XP for a study session based on:
    - Base XP: duration_minutes * 10
    - Flow Multiplier: 1.0x (<30m), 1.15x (30-59m), 1.25x (60-89m), 1.35x (90-180m)
    - Pristine Focus: +10% (1.10x) if unpaused
    - Streak Multiplier: 1.0x (1-3d), 1.05x (4-7d), 1.10x (8-14d), 1.15x (15-30d), 1.20x (31+d)
    - Daily First Session Ignition: +100 XP
    - Daily Volume Milestones: +150 XP (crossed 60m), +300 XP (crossed 120m), +600 XP (crossed 240m)
    """
    if not date_str:
        date_str = datetime.now().strftime('%Y-%m-%d')
    try:
        duration_minutes = int(duration_minutes)
    except (ValueError, TypeError):
        duration_minutes = 25
    duration_minutes = max(1, min(duration_minutes, 1440))

    base_xp = duration_minutes * 10

    # Flow Multiplier
    if duration_minutes >= 90:
        flow_mult = 1.35
    elif duration_minutes >= 60:
        flow_mult = 1.25
    elif duration_minutes >= 30:
        flow_mult = 1.15
    else:
        flow_mult = 1.00

    # Pristine Focus
    pristine_mult = 1.10 if unpaused else 1.00

    # Current Streak
    stats = get_stats(user_id, client_date=date_str)
    streak = stats.get('streak', 0)
    if streak >= 31:
        streak_mult = 1.20
    elif streak >= 15:
        streak_mult = 1.15
    elif streak >= 8:
        streak_mult = 1.10
    elif streak >= 4:
        streak_mult = 1.05
    else:
        streak_mult = 1.00

    scaled_xp = round(base_xp * flow_mult * pristine_mult * streak_mult)

    # First session of the day & Milestone bonuses
    bonus_first = 0
    bonus_milestone = 0
    with get_connection() as ctx:
        cur = ctx.execute(
            "SELECT COALESCE(SUM(duration_minutes), 0) as today_mins, COUNT(id) as today_count FROM sessions WHERE user_id = ? AND date = ?",
            (user_id, date_str)
        )
        row = cur.fetchone()
        today_mins = 0
        today_count = 0
        if row:
            if isinstance(row, dict) or hasattr(row, 'keys'):
                today_mins = int(row['today_mins'] or 0)
                today_count = int(row['today_count'] or 0)
            else:
                today_mins = int(row[0] or 0)
                today_count = int(row[1] or 0)

        if today_count == 0:
            bonus_first = 100

        new_total_mins = today_mins + duration_minutes
        if today_mins < 60 and new_total_mins >= 60:
            bonus_milestone += 150
        if today_mins < 120 and new_total_mins >= 120:
            bonus_milestone += 300
        if today_mins < 240 and new_total_mins >= 240:
            bonus_milestone += 600

    total_xp = scaled_xp + bonus_first + bonus_milestone
    return {
        'total_xp': total_xp,
        'base_xp': base_xp,
        'flow_mult': flow_mult,
        'pristine_mult': pristine_mult,
        'streak_mult': streak_mult,
        'bonus_first': bonus_first,
        'bonus_milestone': bonus_milestone
    }

def add_session(user_id, subject_name, duration_minutes, date_str=None, timestamp_ms=None, start_time=None, end_time=None, unpaused=True, xp=None, session_start_ms=None, session_end_ms=None, break_minutes=0, timeline_json=None):
    try:
        duration_minutes = int(duration_minutes)
    except (ValueError, TypeError):
        duration_minutes = 25
    duration_minutes = max(1, min(duration_minutes, 1440))

    clean_subj_name = str(subject_name or '').strip()[:200]
    if not clean_subj_name:
        clean_subj_name = 'Focus Session'

    now = datetime.now()
    now_ms = int(now.timestamp() * 1000)

    try:
        session_end_ms = int(session_end_ms) if session_end_ms is not None else (int(timestamp_ms) if timestamp_ms is not None else now_ms)
    except (ValueError, TypeError):
        session_end_ms = now_ms

    timestamp_ms = session_end_ms

    try:
        session_start_ms = int(session_start_ms) if session_start_ms is not None else (session_end_ms - duration_minutes * 60000)
    except (ValueError, TypeError):
        session_start_ms = session_end_ms - duration_minutes * 60000

    try:
        break_minutes = max(0, int(break_minutes or 0))
    except (ValueError, TypeError):
        break_minutes = 0

    end_dt = datetime.fromtimestamp(session_end_ms / 1000)
    start_dt = datetime.fromtimestamp(session_start_ms / 1000)

    start_date_str = start_dt.strftime('%Y-%m-%d')
    end_date_str = end_dt.strftime('%Y-%m-%d')
    is_overnight = (start_date_str != end_date_str)

    if not date_str:
        date_str = start_date_str

    if not start_time:
        start_time = start_dt.strftime('%I:%M %p').lstrip('0')
    if not end_time:
        base_end = end_dt.strftime('%I:%M %p').lstrip('0')
        end_time = f"{base_end} (+1d)" if is_overnight else base_end
    elif is_overnight and '(+' not in end_time and '(-' not in end_time:
        end_time = f"{end_time} (+1d)"

    # Normalize timeline
    if isinstance(timeline_json, (list, dict)):
        timeline_serialized = json.dumps(timeline_json)
        timeline_parsed = timeline_json if isinstance(timeline_json, list) else [timeline_json]
    elif isinstance(timeline_json, str) and timeline_json.strip():
        try:
            timeline_parsed = json.loads(timeline_json)
            timeline_serialized = timeline_json.strip()
        except Exception:
            timeline_parsed = [{
                'type': 'focus',
                'start': session_start_ms,
                'end': session_end_ms,
                'duration': duration_minutes * 60
            }]
            timeline_serialized = json.dumps(timeline_parsed)
    else:
        timeline_parsed = [{
            'type': 'focus',
            'start': session_start_ms,
            'end': session_end_ms,
            'duration': duration_minutes * 60
        }]
        timeline_serialized = json.dumps(timeline_parsed)

    subj = add_or_get_subject(user_id, clean_subj_name)

    session_xp = None
    if xp is not None:
        try:
            session_xp = int(xp)
        except (ValueError, TypeError):
            session_xp = None

    if session_xp is None:
        xp_calc = calculate_session_xp(user_id, duration_minutes, date_str, unpaused=unpaused)
        session_xp = xp_calc['total_xp']

    with get_connection() as ctx:
        session_id = ctx.execute_insert("""
            INSERT INTO sessions (user_id, subject_id, subject_name, duration_minutes, date, timestamp, start_time, end_time, xp, session_start_ms, session_end_ms, break_minutes, timeline_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (user_id, subj['id'], subj['name'], duration_minutes, date_str, timestamp_ms, start_time, end_time, session_xp, session_start_ms, session_end_ms, break_minutes, timeline_serialized))

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
        'timeRange': f"{start_time} – {end_time}",
        'xp': session_xp,
        'sessionStartMs': session_start_ms,
        'sessionEndMs': session_end_ms,
        'breakMinutes': break_minutes,
        'timeline': timeline_parsed
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
            SELECT id, subject_id, subject_name, duration_minutes, date, timestamp,
                   COALESCE(NULLIF(xp, 0), duration_minutes * 10) as xp
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
            'timestamp': int(row['timestamp']),
            'xp': int(row['xp'])
        }

        ctx.execute("DELETE FROM sessions WHERE id = ? AND user_id = ?", (session_id, user_id))
        return deleted

def get_sessions(user_id, limit=None):
    with get_connection() as ctx:
        if limit is not None:
            cur = ctx.execute("""
                SELECT sess.id, sess.subject_id, sess.subject_name, s.color, 
                       sess.duration_minutes, sess.date, sess.timestamp,
                       sess.start_time, sess.end_time,
                       COALESCE(NULLIF(sess.xp, 0), sess.duration_minutes * 10) as xp,
                       sess.session_start_ms, sess.session_end_ms, sess.break_minutes, sess.timeline_json
                FROM sessions sess
                LEFT JOIN subjects s ON sess.subject_id = s.id
                WHERE sess.user_id = ?
                ORDER BY sess.timestamp DESC
                LIMIT ?
            """, (user_id, limit))
        else:
            cur = ctx.execute("""
                SELECT sess.id, sess.subject_id, sess.subject_name, s.color, 
                       sess.duration_minutes, sess.date, sess.timestamp,
                       sess.start_time, sess.end_time,
                       COALESCE(NULLIF(sess.xp, 0), sess.duration_minutes * 10) as xp,
                       sess.session_start_ms, sess.session_end_ms, sess.break_minutes, sess.timeline_json
                FROM sessions sess
                LEFT JOIN subjects s ON sess.subject_id = s.id
                WHERE sess.user_id = ?
                ORDER BY sess.timestamp DESC
            """, (user_id,))

        rows = [dict(r) for r in cur.fetchall()]
        result = []
        for r in rows:
            duration = int(r['duration_minutes'])
            sess_xp = int(r.get('xp') or (duration * 10))
            ts = int(r['timestamp'])
            end_ms = r.get('session_end_ms') or ts
            start_ms = r.get('session_start_ms')
            if not start_ms:
                start_ms = end_ms - (duration * 60000)

            end_dt = datetime.fromtimestamp(end_ms / 1000)
            start_dt = datetime.fromtimestamp(start_ms / 1000)
            start_str = r.get('start_time') or start_dt.strftime('%I:%M %p').lstrip('0')
            end_str = r.get('end_time') or end_dt.strftime('%I:%M %p').lstrip('0')

            timeline_parsed = []
            if r.get('timeline_json'):
                try:
                    timeline_parsed = json.loads(r['timeline_json'])
                except Exception:
                    timeline_parsed = []
            if not timeline_parsed:
                timeline_parsed = [{
                    'type': 'focus',
                    'start': start_ms,
                    'end': end_ms,
                    'duration': duration * 60
                }]

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
                'xp': sess_xp,
                'sessionStartMs': start_ms,
                'sessionEndMs': end_ms,
                'breakMinutes': int(r.get('break_minutes') or 0),
                'timeline': timeline_parsed
            })
        return result

def get_day_details(user_id, date_str):
    try:
        dt = datetime.strptime(date_str, '%Y-%m-%d')
        day_start_ms = int(datetime(dt.year, dt.month, dt.day, 0, 0, 0).timestamp() * 1000)
        day_end_ms = int(datetime(dt.year, dt.month, dt.day, 23, 59, 59, 999).timestamp() * 1000)
        formatted_date = dt.strftime('%A, %B %d, %Y')
    except Exception:
        dt = datetime.now()
        day_start_ms = 0
        day_end_ms = int(dt.timestamp() * 1000) + 86400000
        formatted_date = date_str

    with get_connection() as ctx:
        cur = ctx.execute("""
            SELECT sess.id, sess.subject_id, sess.subject_name, s.color,
                   sess.duration_minutes, sess.date, sess.timestamp,
                   sess.start_time, sess.end_time,
                   COALESCE(NULLIF(sess.xp, 0), sess.duration_minutes * 10) as xp,
                   sess.session_start_ms, sess.session_end_ms, sess.break_minutes, sess.timeline_json
            FROM sessions sess
            LEFT JOIN subjects s ON sess.subject_id = s.id
            WHERE sess.user_id = ? AND (
                sess.date = ?
                OR (sess.session_start_ms IS NOT NULL AND sess.session_end_ms IS NOT NULL AND (
                    sess.session_start_ms <= ? AND sess.session_end_ms >= ?
                ))
            )
            ORDER BY sess.timestamp DESC
        """, (user_id, date_str, day_end_ms, day_start_ms))
        rows = [dict(r) for r in cur.fetchall()]

    sessions = []
    total_minutes = 0
    total_xp = 0
    for r in rows:
        duration = int(r['duration_minutes'])
        sess_xp = int(r.get('xp') or (duration * 10))
        ts = int(r['timestamp'])
        end_ms = r.get('session_end_ms') or ts
        start_ms = r.get('session_start_ms')
        if not start_ms:
            start_ms = end_ms - (duration * 60000)

        start_dt = datetime.fromtimestamp(start_ms / 1000)
        end_dt = datetime.fromtimestamp(end_ms / 1000)
        start_date_str = start_dt.strftime('%Y-%m-%d')
        end_date_str = end_dt.strftime('%Y-%m-%d')
        recorded_date = r.get('date') or start_date_str
        is_overnight = (start_date_str != end_date_str)

        day_minutes = duration
        if is_overnight:
            midnight_dt = datetime(end_dt.year, end_dt.month, end_dt.day, 0, 0, 0)
            midnight_ms = int(midnight_dt.timestamp() * 1000)
            total_span = max(1, end_ms - start_ms)
            span_day1 = max(0, midnight_ms - start_ms)
            if total_span > 0:
                day1_mins = max(1, round(duration * (span_day1 / total_span)))
                day2_mins = max(1, duration - day1_mins)
            else:
                day1_mins = max(1, duration // 2)
                day2_mins = max(1, duration - day1_mins)

            if date_str == start_date_str:
                day_minutes = day1_mins
            elif date_str == end_date_str:
                day_minutes = day2_mins

        total_minutes += day_minutes
        total_xp += sess_xp

        clean_start = (r.get('start_time') or start_dt.strftime('%I:%M %p').lstrip('0')).replace(' (-1d)', '').replace(' (+1d)', '').strip()
        clean_end = (r.get('end_time') or end_dt.strftime('%I:%M %p').lstrip('0')).replace(' (+1d)', '').replace(' (-1d)', '').strip()

        if is_overnight:
            if date_str == start_date_str:
                time_range_display = f"{clean_start} – {clean_end} (+1d)"
                start_str = clean_start
                end_str = f"{clean_end} (+1d)"
            elif date_str == end_date_str:
                time_range_display = f"{clean_start} (-1d) – {clean_end}"
                start_str = f"{clean_start} (-1d)"
                end_str = clean_end
            else:
                time_range_display = f"{clean_start} – {clean_end}"
                start_str = clean_start
                end_str = clean_end
        else:
            time_range_display = f"{clean_start} – {clean_end}"
            start_str = clean_start
            end_str = clean_end

        timeline_parsed = []
        if r.get('timeline_json'):
            try:
                timeline_parsed = json.loads(r['timeline_json'])
            except Exception:
                timeline_parsed = []
        if not timeline_parsed:
            timeline_parsed = [{
                'type': 'focus',
                'start': start_ms,
                'end': end_ms,
                'duration': duration * 60
            }]

        sessions.append({
            'id': f"sess_{r['id']}",
            'subject_id': r['subject_id'],
            'subject': r['subject_name'] or 'Focus Session',
            'color': r['color'] or '#10E068',
            'durationMinutes': duration,
            'duration_minutes': duration,
            'dayMinutes': day_minutes,
            'day_minutes': day_minutes,
            'date': recorded_date,
            'timestamp': ts,
            'startTime': start_str,
            'endTime': end_str,
            'timeRange': time_range_display,
            'xp': sess_xp,
            'sessionStartMs': start_ms,
            'sessionEndMs': end_ms,
            'breakMinutes': int(r.get('break_minutes') or 0),
            'timeline': timeline_parsed
        })

    total_sessions = len(sessions)
    avg_minutes = round(total_minutes / total_sessions, 1) if total_sessions > 0 else 0

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
        'totalXp': total_xp,
        'sessions': sessions
    }

def get_daily_activity(user_id):
    with get_connection() as ctx:
        cur = ctx.execute("""
            SELECT id, date, duration_minutes, session_start_ms, session_end_ms
            FROM sessions
            WHERE user_id = ?
            ORDER BY timestamp ASC
        """, (user_id,))
        rows = [dict(r) for r in cur.fetchall()]

    activity = {}
    for r in rows:
        dur = int(r.get('duration_minutes') or 0)
        start_ms = r.get('session_start_ms')
        end_ms = r.get('session_end_ms')
        date_str = r.get('date')

        if start_ms and end_ms and end_ms > start_ms:
            start_dt = datetime.fromtimestamp(start_ms / 1000)
            end_dt = datetime.fromtimestamp(end_ms / 1000)
            s_date = start_dt.strftime('%Y-%m-%d')
            e_date = end_dt.strftime('%Y-%m-%d')

            if s_date != e_date:
                midnight_dt = datetime(end_dt.year, end_dt.month, end_dt.day, 0, 0, 0)
                midnight_ms = int(midnight_dt.timestamp() * 1000)

                total_span = end_ms - start_ms
                span_day1 = max(0, midnight_ms - start_ms)
                if total_span > 0:
                    day1_mins = max(1, round(dur * (span_day1 / total_span)))
                    day2_mins = max(1, dur - day1_mins)
                else:
                    day1_mins = max(1, dur // 2)
                    day2_mins = max(1, dur - day1_mins)

                activity[s_date] = activity.get(s_date, 0) + day1_mins
                activity[e_date] = activity.get(e_date, 0) + day2_mins
                continue

        if not date_str and start_ms:
            date_str = datetime.fromtimestamp(start_ms / 1000).strftime('%Y-%m-%d')
        if not date_str:
            date_str = datetime.now().strftime('%Y-%m-%d')
        activity[date_str] = activity.get(date_str, 0) + dur

    return activity

def get_stats(user_id, client_date=None):
    if client_date and isinstance(client_date, str) and len(client_date) == 10:
        try:
            current_date_obj = datetime.strptime(client_date, '%Y-%m-%d').date()
            today_str = client_date
        except Exception:
            current_date_obj = datetime.now().date()
            today_str = current_date_obj.strftime('%Y-%m-%d')
    else:
        current_date_obj = datetime.now().date()
        today_str = current_date_obj.strftime('%Y-%m-%d')

    with get_connection() as ctx:
        cur = ctx.execute("SELECT COALESCE(SUM(duration_minutes), 0) FROM sessions WHERE user_id = ?", (user_id,))
        total_focus_minutes = int(fetch_scalar(cur.fetchone()) or 0)

        cur = ctx.execute("SELECT COALESCE(SUM(COALESCE(NULLIF(xp, 0), duration_minutes * 10)), 0) FROM sessions WHERE user_id = ?", (user_id,))
        total_xp = int(fetch_scalar(cur.fetchone()) or 0)

    daily_act = get_daily_activity(user_id)
    today_focus_minutes = int(daily_act.get(today_str, 0))
    active_dates = {d for d, mins in daily_act.items() if mins > 0}

    current_check = current_date_obj
    if today_str not in active_dates:
        current_check -= timedelta(days=1)

    streak = 0
    while current_check.strftime('%Y-%m-%d') in active_dates:
        streak += 1
        current_check -= timedelta(days=1)

    return {
        'streak': streak,
        'xp': total_xp,
        'totalFocusSeconds': total_focus_minutes * 60,
        'todayFocusSeconds': today_focus_minutes * 60,
        'todayFocusMinutes': today_focus_minutes
    }

def get_full_state(user_id, client_date=None):
    """
    High-performance state aggregation. Loads timer, subjects, sessions,
    and daily activity in a SINGLE database round trip, computing gamification
    metrics in-memory for instant page loading.
    """
    now_ms = int(datetime.now().timestamp() * 1000)
    if client_date and isinstance(client_date, str) and len(client_date) == 10:
        try:
            current_date_obj = datetime.strptime(client_date, '%Y-%m-%d').date()
            today_str = client_date
        except Exception:
            current_date_obj = datetime.now().date()
            today_str = current_date_obj.strftime('%Y-%m-%d')
    else:
        current_date_obj = datetime.now().date()
        today_str = current_date_obj.strftime('%Y-%m-%d')

    with get_connection() as ctx:
        if ctx.is_pg:
            cur = ctx.execute("""
                SELECT json_build_object(
                    'timer', (
                        SELECT row_to_json(t) FROM (
                            SELECT status, target_seconds, remaining_seconds, active_task_name, started_at, updated_at, sequence, session_started_at, intervals_json 
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
                            SELECT sess.id, sess.subject_id, sess.subject_name, s.color, sess.duration_minutes, sess.date, sess.timestamp, sess.start_time, sess.end_time, COALESCE(NULLIF(sess.xp, 0), sess.duration_minutes * 10)::int as xp, sess.session_start_ms, sess.session_end_ms, sess.break_minutes, sess.timeline_json
                            FROM sessions sess
                            LEFT JOIN subjects s ON sess.subject_id = s.id
                            WHERE sess.user_id = %s
                            ORDER BY sess.timestamp DESC
                        ) sess_row
                    ),
                    'total_xp', (
                        SELECT COALESCE(SUM(COALESCE(NULLIF(xp, 0), duration_minutes * 10)), 0)::int
                        FROM sessions WHERE user_id = %s
                    ),
                    'activity', (
                        SELECT COALESCE(json_object_agg(a.date, a.total_minutes), '{}'::json) FROM (
                            SELECT date, SUM(duration_minutes)::int as total_minutes
                            FROM sessions WHERE user_id = %s
                            GROUP BY date ORDER BY date ASC
                        ) a
                    ),
                    'preferences', (
                        SELECT json_build_object('auraEnabled', COALESCE(aura_enabled, TRUE))
                        FROM users WHERE id = %s
                    ),
                    'user_created_at', (
                        SELECT to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS')
                        FROM users WHERE id = %s
                    )
                ) AS full_state
            """, (user_id, user_id, user_id, user_id, user_id, user_id, user_id, user_id))
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
                SELECT sess.id, sess.subject_id, sess.subject_name, s.color, sess.duration_minutes, sess.date, sess.timestamp, sess.start_time, sess.end_time, COALESCE(NULLIF(sess.xp, 0), sess.duration_minutes * 10) as xp, sess.session_start_ms, sess.session_end_ms, sess.break_minutes, sess.timeline_json
                FROM sessions sess LEFT JOIN subjects s ON sess.subject_id = s.id
                WHERE sess.user_id = ? ORDER BY sess.timestamp DESC
            """, (user_id,))
            sess_rows = [dict(r) for r in cur_sess.fetchall()]
            cur_xp = ctx.execute("SELECT COALESCE(SUM(COALESCE(NULLIF(xp, 0), duration_minutes * 10)), 0) FROM sessions WHERE user_id = ?", (user_id,))
            total_xp = int(fetch_scalar(cur_xp.fetchone()) or 0)
            cur_act = ctx.execute("SELECT date, SUM(duration_minutes) as total_minutes FROM sessions WHERE user_id = ? GROUP BY date ORDER BY date ASC", (user_id,))
            act_dict = {r['date']: int(r['total_minutes']) for r in cur_act.fetchall()}
            cur_pref = ctx.execute("SELECT aura_enabled, created_at FROM users WHERE id = ?", (user_id,))
            pref_row = cur_pref.fetchone()
            aura_enabled = True
            user_created_at = None
            if pref_row is not None:
                if pref_row['aura_enabled'] is not None:
                    aura_enabled = bool(pref_row['aura_enabled'])
                if pref_row['created_at'] is not None:
                    user_created_at = str(pref_row['created_at'])
            data = {
                'timer': dict(t_row) if t_row else None,
                'subjects': sub_rows,
                'sessions': sess_rows,
                'total_xp': total_xp,
                'activity': act_dict,
                'preferences': {'auraEnabled': aura_enabled},
                'user_created_at': user_created_at
            }

    # 1. Process Timer State
    timer_raw = data.get('timer') or {'status': 'idle', 'target_seconds': 5400, 'remaining_seconds': 5400}
    status = timer_raw.get('status', 'idle')
    target_secs = int(timer_raw.get('target_seconds', 5400))
    remaining_secs = int(timer_raw.get('remaining_seconds', 5400))
    started_at = timer_raw.get('started_at')
    session_started_at = timer_raw.get('session_started_at')
    intervals_raw = timer_raw.get('intervals_json')
    intervals = []
    if intervals_raw:
        try:
            intervals = json.loads(intervals_raw) if isinstance(intervals_raw, str) else intervals_raw
        except Exception:
            intervals = []
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
            session_started_at = None
            intervals = []
            try:
                with get_connection() as c2:
                    c2.execute("""
                        UPDATE user_timer_state
                        SET status = 'idle', remaining_seconds = target_seconds, started_at = NULL, session_started_at = NULL, intervals_json = '[]', sequence = sequence + 1
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
        'sessionStartedAt': session_started_at,
        'intervals': intervals,
        'hasCompleted': has_completed,
        'sequence': int(timer_raw.get('sequence') or 1),
        'version': int(timer_raw.get('sequence') or 1)
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
        end_ms = r.get('session_end_ms') or ts
        start_ms = r.get('session_start_ms')
        if not start_ms:
            start_ms = end_ms - (duration * 60000)

        end_dt = datetime.fromtimestamp(end_ms / 1000)
        start_dt = datetime.fromtimestamp(start_ms / 1000)
        start_str = r.get('start_time') or start_dt.strftime('%I:%M %p').lstrip('0')
        end_str = r.get('end_time') or end_dt.strftime('%I:%M %p').lstrip('0')

        timeline_parsed = []
        raw_tl = r.get('timeline_json')
        if raw_tl:
            try:
                timeline_parsed = json.loads(raw_tl) if isinstance(raw_tl, str) else raw_tl
            except Exception:
                timeline_parsed = []
        if not timeline_parsed:
            timeline_parsed = [{
                'type': 'focus',
                'start': start_ms,
                'end': end_ms,
                'duration': duration * 60
            }]

        start_dt = datetime.fromtimestamp(start_ms / 1000)
        end_dt = datetime.fromtimestamp(end_ms / 1000)
        start_date_str = start_dt.strftime('%Y-%m-%d')
        end_date_str = end_dt.strftime('%Y-%m-%d')
        is_overnight = (start_date_str != end_date_str)
        if is_overnight and '(+' not in end_str and '(-' not in end_str:
            time_range_str = f"{start_str} – {end_str} (+1d)"
        else:
            time_range_str = f"{start_str} – {end_str}"

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
            'timeRange': time_range_str,
            'xp': int(r.get('xp') or (duration * 10)),
            'sessionStartMs': start_ms,
            'sessionEndMs': end_ms,
            'breakMinutes': int(r.get('break_minutes') or 0),
            'timeline': timeline_parsed
        })

    # 4. Process Activity & Compute Stats in Python with Midnight-Crossing Split
    day_act = {}
    for r in (data.get('sessions') or []):
        dur = int(r.get('duration_minutes') or 0)
        start_ms = r.get('session_start_ms')
        end_ms = r.get('session_end_ms')
        rec_date = r.get('date')

        if start_ms and end_ms and end_ms > start_ms:
            start_dt = datetime.fromtimestamp(start_ms / 1000)
            end_dt = datetime.fromtimestamp(end_ms / 1000)
            s_date = start_dt.strftime('%Y-%m-%d')
            e_date = end_dt.strftime('%Y-%m-%d')

            if s_date != e_date:
                midnight_dt = datetime(end_dt.year, end_dt.month, end_dt.day, 0, 0, 0)
                midnight_ms = int(midnight_dt.timestamp() * 1000)
                total_span = end_ms - start_ms
                span_day1 = max(0, midnight_ms - start_ms)
                if total_span > 0:
                    day1_mins = max(1, round(dur * (span_day1 / total_span)))
                    day2_mins = max(1, dur - day1_mins)
                else:
                    day1_mins = max(1, dur // 2)
                    day2_mins = max(1, dur - day1_mins)

                day_act[s_date] = day_act.get(s_date, 0) + day1_mins
                day_act[e_date] = day_act.get(e_date, 0) + day2_mins
                continue

        if not rec_date and start_ms:
            rec_date = datetime.fromtimestamp(start_ms / 1000).strftime('%Y-%m-%d')
        if not rec_date:
            rec_date = datetime.now().strftime('%Y-%m-%d')
        day_act[rec_date] = day_act.get(rec_date, 0) + dur

    tot_focus_mins = sum(day_act.values())
    today_focus_mins = day_act.get(today_str, 0)
    total_xp = int(data['total_xp']) if data.get('total_xp') is not None else (tot_focus_mins * 10)

    active_dates = {d for d, mins in day_act.items() if mins > 0}
    current_check = current_date_obj
    if today_str not in active_dates:
        current_check -= timedelta(days=1)
    streak = 0
    while current_check.strftime('%Y-%m-%d') in active_dates:
        streak += 1
        current_check -= timedelta(days=1)

    stats_res = {
        'streak': streak,
        'xp': total_xp,
        'totalFocusSeconds': tot_focus_mins * 60,
        'todayFocusSeconds': today_focus_mins * 60,
        'todayFocusMinutes': today_focus_mins
    }

    return {
        'subjects': subjects_res,
        'sessions': sessions_res,
        'dayActivity': day_act,
        'stats': stats_res,
        'timer': timer_res,
        'preferences': data.get('preferences') or {'auraEnabled': True},
        'userCreatedAt': str(data.get('user_created_at')) if data.get('user_created_at') else None
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
    # Reset timer after transaction commits to prevent SQLite lock contention
    update_timer_state(user_id, 'reset', target_seconds=5400)
