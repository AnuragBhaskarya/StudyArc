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
    # Normalize legacy postgres:// to postgresql:// (required by SQLAlchemy & some psycopg2 versions)
    if url.startswith('postgres://'):
        url = 'postgresql://' + url[len('postgres://'):]
    # Ensure sslmode=require for cloud-hosted DBs (Supabase, Neon) unless local
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

class DBContext:
    """
    Unified database context manager supporting both local SQLite
    and production cloud PostgreSQL (Supabase / Neon).
    """
    def __init__(self):
        self.is_pg = is_postgres()
        if self.is_pg:
            if psycopg2 is None:
                raise RuntimeError(
                    "psycopg2 is not installed. Please run 'pip install psycopg2-binary' "
                    "to use PostgreSQL with DATABASE_URL."
                )
            self.conn = psycopg2.connect(get_clean_database_url(), cursor_factory=RealDictCursor)
        else:
            self.conn = sqlite3.connect(DB_PATH)
            self.conn.row_factory = sqlite3.Row
            self.conn.execute("PRAGMA foreign_keys = ON")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
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

def init_db(seed_real_data=True):
    with get_connection() as ctx:
        if ctx.is_pg:
            # PostgreSQL Schema
            ctx.execute("""
                CREATE TABLE IF NOT EXISTS subjects (
                    id SERIAL PRIMARY KEY,
                    name VARCHAR(255) UNIQUE NOT NULL,
                    color VARCHAR(32) NOT NULL DEFAULT '#79D99B',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            ctx.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id SERIAL PRIMARY KEY,
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
        else:
            # SQLite Schema
            ctx.execute("""
                CREATE TABLE IF NOT EXISTS subjects (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT UNIQUE NOT NULL COLLATE NOCASE,
                    color TEXT NOT NULL DEFAULT '#79D99B',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            ctx.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
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

        ctx.execute("CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date)")
        ctx.execute("CREATE INDEX IF NOT EXISTS idx_sessions_subject ON sessions(subject_id)")
        ctx.execute("CREATE INDEX IF NOT EXISTS idx_sessions_ts ON sessions(timestamp DESC)")

        cur = ctx.execute("SELECT COUNT(*) FROM sessions")
        session_count = fetch_scalar(cur.fetchone()) or 0

        if session_count == 0 and seed_real_data:
            seed_initial_real_data(ctx)

def seed_initial_real_data(ctx):
    """
    Populate realistic, genuine session-based study history from 2025-01-01 through 2026-10-12.
    Includes diverse subjects, realistic time slots ('from when to when'), varying intensities,
    streaks, and rest days.
    """
    random.seed(1337)  # Deterministic seed for consistent, rich realistic history
    
    subjects_def = [
        ('Computer Science', '#79D99B'),
        ('Mathematics', '#A3F0BA'),
        ('System Architecture', '#52C480'),
        ('Cognitive Science', '#3A965A'),
        ('Algorithms & Data Structures', '#4ECCA3'),
        ('Machine Learning', '#6EE7B7'),
        ('Linear Algebra', '#86EFAC'),
        ('Deep Learning & AI', '#34D399'),
        ('Operating Systems', '#2DD4BF'),
        ('Physics & Quantum', '#5EEAD4'),
    ]
    
    subject_map = {}
    for name, color in subjects_def:
        if ctx.is_pg:
            ctx.execute("INSERT INTO subjects (name, color) VALUES (?, ?) ON CONFLICT (name) DO NOTHING", (name, color))
        else:
            ctx.execute("INSERT OR IGNORE INTO subjects (name, color) VALUES (?, ?)", (name, color))
        cur = ctx.execute("SELECT id FROM subjects WHERE name = ?", (name,))
        row = cur.fetchone()
        if row:
            subject_map[name] = fetch_scalar(row)

    start_date = date(2025, 1, 1)
    end_date = date(2026, 10, 12)
    
    time_windows = [
        [(8, 30), (9, 0), (9, 30), (10, 0)],    # Morning block
        [(13, 0), (13, 30), (14, 0), (14, 30)],  # Midday block
        [(16, 0), (16, 30), (17, 0)],           # Late afternoon block
        [(19, 0), (19, 30), (20, 0), (20, 30)]   # Evening block
    ]
    
    durations_pool = [30, 45, 50, 60, 75, 90]
    
    sessions_to_insert = []
    curr = start_date
    while curr <= end_date:
        d_str = curr.strftime('%Y-%m-%d')
        weekday = curr.weekday() # 0 = Mon, 6 = Sun
        
        # Last 17 days leading up to today (Oct 12) form an active streak
        is_recent_streak = (curr >= date(2026, 9, 26))
        
        if is_recent_streak:
            has_activity = True
        elif weekday in (5, 6): # Weekend
            has_activity = random.random() < 0.68
        else: # Weekday
            has_activity = random.random() < 0.85
            
        if not has_activity:
            curr += timedelta(days=1)
            continue
            
        if curr == date(2026, 10, 12):
            num_sessions = 3
        else:
            num_sessions = random.choices([1, 2, 3, 4], weights=[0.25, 0.45, 0.25, 0.05])[0]
            
        chosen_window_indices = sorted(random.sample(range(len(time_windows)), num_sessions))
        for w_idx in chosen_window_indices:
            start_opts = time_windows[w_idx]
            sh, sm = random.choice(start_opts)
            duration = random.choice(durations_pool)
            
            start_dt = datetime.combine(curr, time(sh, sm))
            end_dt = start_dt + timedelta(minutes=duration)
            
            start_str = start_dt.strftime('%I:%M %p').lstrip('0')
            end_str = end_dt.strftime('%I:%M %p').lstrip('0')
            ts_ms = int(end_dt.timestamp() * 1000)
            
            subj_name, _ = random.choice(subjects_def)
            subj_id = subject_map.get(subj_name, 1)
            
            sessions_to_insert.append((subj_id, subj_name, duration, d_str, ts_ms, start_str, end_str))
            
        curr += timedelta(days=1)

    if sessions_to_insert:
        if ctx.is_pg:
            from psycopg2.extras import execute_values
            cur = ctx.conn.cursor()
            execute_values(cur, """
                INSERT INTO sessions (subject_id, subject_name, duration_minutes, date, timestamp, start_time, end_time)
                VALUES %s
            """, sessions_to_insert)
        else:
            cur = ctx.conn.cursor()
            cur.executemany("""
                INSERT INTO sessions (subject_id, subject_name, duration_minutes, date, timestamp, start_time, end_time)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, sessions_to_insert)

def get_subjects():
    with get_connection() as ctx:
        cur = ctx.execute("""
            SELECT 
                s.id, 
                s.name, 
                s.color, 
                COALESCE(SUM(sess.duration_minutes), 0) AS total_minutes,
                COUNT(sess.id) AS session_count
            FROM subjects s
            LEFT JOIN sessions sess ON s.id = sess.subject_id
            GROUP BY s.id, s.name, s.color
            ORDER BY total_minutes DESC, s.name ASC
        """)
        rows = [dict(r) for r in cur.fetchall()]
        for r in rows:
            tot = int(r.get('total_minutes') or 0)
            r['total_minutes'] = tot
            r['hours'] = round(tot / 60.0, 1)
        return rows

SUBJECT_PALETTE = [
    '#79D99B', '#A3F0BA', '#52C480', '#3A965A', '#4ECCA3',
    '#6EE7B7', '#86EFAC', '#34D399', '#2DD4BF', '#5EEAD4'
]

def add_or_get_subject(name, color=None):
    clean_name = name.strip()
    if not clean_name:
        clean_name = 'Focus Session'
        
    with get_connection() as ctx:
        cur = ctx.execute("SELECT id, name, color FROM subjects WHERE LOWER(name) = LOWER(?)", (clean_name,))
        row = cur.fetchone()
        if row:
            return dict(row)
            
        if not color or color == '#79D99B':
            idx = abs(hash(clean_name)) % len(SUBJECT_PALETTE)
            color = SUBJECT_PALETTE[idx]
            
        new_id = ctx.execute_insert("INSERT INTO subjects (name, color) VALUES (?, ?)", (clean_name, color))
        return {'id': new_id, 'name': clean_name, 'color': color}

def add_session(subject_name, duration_minutes, date_str=None, timestamp_ms=None, start_time=None, end_time=None):
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
        
    subj = add_or_get_subject(subject_name)
    
    with get_connection() as ctx:
        session_id = ctx.execute_insert("""
            INSERT INTO sessions (subject_id, subject_name, duration_minutes, date, timestamp, start_time, end_time)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (subj['id'], subj['name'], duration_minutes, date_str, timestamp_ms, start_time, end_time))
        
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

def delete_session(session_id):
    """
    Deletes a session by ID (accepts integer or string like 'sess_123').
    Returns details of the deleted session if successful, or None if not found.
    """
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
            WHERE id = ?
        """, (session_id,))
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

        ctx.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        return deleted

def get_sessions(limit=100):
    with get_connection() as ctx:
        cur = ctx.execute("""
            SELECT sess.id, sess.subject_id, sess.subject_name, s.color, 
                   sess.duration_minutes, sess.date, sess.timestamp,
                   sess.start_time, sess.end_time
            FROM sessions sess
            LEFT JOIN subjects s ON sess.subject_id = s.id
            ORDER BY sess.timestamp DESC
            LIMIT ?
        """, (limit,))
        
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

def get_day_details(date_str):
    """
    Returns complete breakdown for a specific date:
    - total minutes, total sessions, avg focus time, total xp
    - detailed session timeline with 'from when to when'
    """
    with get_connection() as ctx:
        cur = ctx.execute("""
            SELECT sess.id, sess.subject_id, sess.subject_name, s.color,
                   sess.duration_minutes, sess.date, sess.timestamp,
                   sess.start_time, sess.end_time
            FROM sessions sess
            LEFT JOIN subjects s ON sess.subject_id = s.id
            WHERE sess.date = ?
            ORDER BY sess.timestamp ASC
        """, (date_str,))
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
    
    # Calculate formatted total hours
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

def get_daily_activity():
    with get_connection() as ctx:
        cur = ctx.execute("""
            SELECT date, SUM(duration_minutes) as total_minutes
            FROM sessions
            GROUP BY date
            ORDER BY date ASC
        """)
        rows = [dict(r) for r in cur.fetchall()]
        return {r['date']: int(r['total_minutes']) for r in rows}

def get_stats():
    today_str = datetime.now().strftime('%Y-%m-%d')
    with get_connection() as ctx:
        cur = ctx.execute("SELECT COALESCE(SUM(duration_minutes), 0) FROM sessions")
        total_focus_minutes = int(fetch_scalar(cur.fetchone()) or 0)
        
        cur = ctx.execute("SELECT COALESCE(SUM(duration_minutes), 0) FROM sessions WHERE date = ?", (today_str,))
        today_focus_minutes = int(fetch_scalar(cur.fetchone()) or 0)
        
        cur = ctx.execute("""
            SELECT date, SUM(duration_minutes) as mins
            FROM sessions
            GROUP BY date
            HAVING SUM(duration_minutes) > 0
            ORDER BY date DESC
        """)
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

def reset_database(reseed=True):
    with get_connection() as ctx:
        ctx.execute("DELETE FROM sessions")
        ctx.execute("DELETE FROM subjects")
    if reseed:
        with get_connection() as ctx:
            seed_initial_real_data(ctx)
