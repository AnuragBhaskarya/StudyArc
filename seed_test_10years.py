#!/usr/bin/env python3
"""
Seed 10 Years of Realistic, Valid Study Session Data for user 'test'.
Using credentials in .env (Supabase PostgreSQL pooler).
Covers 2016-10-25 to 2026-10-24 (today).
"""

import os
import random
from datetime import datetime, timedelta, date, time
import database

def generate_10years_test_data():
    user = database.get_user_by_username('test')
    if not user:
        print("Error: User 'test' not found!")
        return

    user_id = user['id']
    print(f"============================================================")
    print(f"Seeding 10 Years of Realistic Study Data for User '{user['username']}' (ID: {user_id})")
    print(f"============================================================")

    # 1. Clean subject roster (real, high-value engineering & academic disciplines)
    subjects_spec = [
        ('Deep Work & Research', '#EC4899'),
        ('Machine Learning & Neural Nets', '#10E068'),
        ('System Architecture & Distributed Systems', '#38BDF8'),
        ('Database Internals & Optimization', '#A855F7'),
        ('Algorithms & Problem Solving', '#F59E0B'),
        ('Mathematics & Statistics', '#3B82F6'),
        ('Computer Science Fundamentals', '#14B8A6'),
        ('Literature & Philosophy', '#F97316')
    ]

    with database.get_connection() as ctx:
        # Delete any informal/stray subjects
        ctx.execute("DELETE FROM subjects WHERE user_id = ? AND name IN ('Okay', 'Hm', 'Focus Session', 'wefg', 'Jdkd', 'wef')", (user_id,))

        for name, color in subjects_spec:
            cur = ctx.execute("SELECT id FROM subjects WHERE user_id = ? AND LOWER(name) = LOWER(?)", (user_id, name))
            row = cur.fetchone()
            if row:
                ctx.execute("UPDATE subjects SET color = ? WHERE id = ?", (color, database.fetch_scalar(row)))
            else:
                ctx.execute("INSERT INTO subjects (user_id, name, color) VALUES (?, ?, ?)", (user_id, name, color))

        cur = ctx.execute("SELECT id, name, color FROM subjects WHERE user_id = ? ORDER BY id", (user_id,))
        subjects_by_name = {r['name']: dict(r) for r in cur.fetchall()}
        print(f"Subjects configured: {list(subjects_by_name.keys())}")

        # Wipe existing sessions for user 'test' to avoid duplicates or date inconsistencies
        ctx.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        print("Cleaned existing sessions for user 'test'.")

        # 2. Date Range: Exactly 10 years ending on 2026-10-24 (today)
        end_date = date(2026, 10, 24)
        start_date = date(2016, 10, 25)
        total_days = (end_date - start_date).days + 1
        print(f"Generating realistic study timeline: {start_date} -> {end_date} ({total_days} total days, 10 full years)...")

        # Unbroken active streak for the last 35 days (leading right up to today 2026-10-24)
        streak_start_date = end_date - timedelta(days=35)

        sessions_to_insert = []
        current_date = start_date
        active_days_count = 0
        total_minutes = 0

        # Reproducible but rich random sequence
        random.seed(42)

        while current_date <= end_date:
            year = current_date.year
            month = current_date.month
            is_weekend = (current_date.weekday() >= 5) # 5 = Sat, 6 = Sun
            is_streak_period = (current_date >= streak_start_date)

            # Realistic rest day probability:
            # - Streaks: 0% rest
            # - Holidays (late Dec / early Jan / mid Aug): ~28% rest
            # - Normal weekdays: ~12% rest
            # - Normal weekends: ~28% rest
            is_holiday_season = (month == 12 and current_date.day >= 24) or (month == 1 and current_date.day <= 3) or (month == 8 and 10 <= current_date.day <= 18)
            
            if is_streak_period:
                is_rest = False
            elif is_holiday_season:
                is_rest = (random.random() < 0.28)
            elif is_weekend:
                is_rest = (random.random() < 0.25)
            else:
                is_rest = (random.random() < 0.11)

            if is_rest:
                current_date += timedelta(days=1)
                continue

            active_days_count += 1
            date_str = current_date.strftime('%Y-%m-%d')

            # Session count distribution
            # Exam/project seasons (May, Nov, Dec): higher density
            is_exam_season = (month in (5, 11, 12)) and not is_holiday_season
            if is_streak_period:
                num_sessions = random.choices([1, 2, 3, 4], weights=[0.20, 0.45, 0.25, 0.10])[0]
            elif is_exam_season:
                num_sessions = random.choices([2, 3, 4], weights=[0.40, 0.45, 0.15])[0]
            elif is_weekend:
                num_sessions = random.choices([1, 2, 3], weights=[0.55, 0.35, 0.10])[0]
            else:
                num_sessions = random.choices([1, 2, 3, 4], weights=[0.25, 0.50, 0.20, 0.05])[0]

            # Lifecyle subject weight shift over 10 years:
            if year <= 2018:
                # Undergrad / Foundation years
                weights_dict = {
                    'Mathematics & Statistics': 0.30,
                    'Computer Science Fundamentals': 0.28,
                    'Algorithms & Problem Solving': 0.22,
                    'Literature & Philosophy': 0.10,
                    'Deep Work & Research': 0.05,
                    'System Architecture & Distributed Systems': 0.03,
                    'Database Internals & Optimization': 0.01,
                    'Machine Learning & Neural Nets': 0.01
                }
            elif year <= 2022:
                # Systems Engineering & Transition years
                weights_dict = {
                    'System Architecture & Distributed Systems': 0.26,
                    'Database Internals & Optimization': 0.24,
                    'Algorithms & Problem Solving': 0.18,
                    'Machine Learning & Neural Nets': 0.14,
                    'Computer Science Fundamentals': 0.08,
                    'Deep Work & Research': 0.05,
                    'Mathematics & Statistics': 0.03,
                    'Literature & Philosophy': 0.02
                }
            else:
                # 2023 - 2026: Senior Mastery, Research & AI
                weights_dict = {
                    'Deep Work & Research': 0.28,
                    'Machine Learning & Neural Nets': 0.25,
                    'System Architecture & Distributed Systems': 0.20,
                    'Database Internals & Optimization': 0.12,
                    'Algorithms & Problem Solving': 0.07,
                    'Mathematics & Statistics': 0.04,
                    'Literature & Philosophy': 0.02,
                    'Computer Science Fundamentals': 0.02
                }

            subj_list = [subjects_by_name[s] for s in weights_dict.keys() if s in subjects_by_name]
            subj_weights = [weights_dict[s['name']] for s in subj_list]

            # Realistic daily time slots
            time_slots = [
                # Morning Block
                (random.randint(8, 10), random.choice([0, 15, 30, 45])),
                # Midday Block
                (random.randint(11, 13), random.choice([0, 15, 30])),
                # Afternoon Block
                (random.randint(14, 16), random.choice([0, 15, 30, 45])),
                # Evening Block
                (random.randint(18, 20), random.choice([0, 15, 30])),
                # Late Evening Block
                (random.randint(21, 22), random.choice([0, 15, 30]))
            ]
            # Pick distinct time slots in ascending order
            chosen_slots = sorted(random.sample(time_slots, num_sessions), key=lambda x: (x[0], x[1]))

            for slot_h, slot_m in chosen_slots:
                chosen_subj = random.choices(subj_list, weights=subj_weights)[0]
                # Standard realistic focus session durations
                duration = random.choices(
                    [25, 30, 45, 50, 60, 75, 90, 120],
                    weights=[0.12, 0.12, 0.22, 0.18, 0.18, 0.08, 0.07, 0.03]
                )[0]
                total_minutes += duration

                end_dt = datetime.combine(current_date, time(slot_h, slot_m))
                start_dt = end_dt - timedelta(minutes=duration)

                start_time_str = start_dt.strftime('%I:%M %p').lstrip('0')
                end_time_str = end_dt.strftime('%I:%M %p').lstrip('0')
                timestamp_ms = int(end_dt.timestamp() * 1000)

                sessions_to_insert.append((
                    user_id,
                    chosen_subj['id'],
                    chosen_subj['name'],
                    duration,
                    date_str,
                    timestamp_ms,
                    start_time_str,
                    end_time_str,
                    duration * 10
                ))

            current_date += timedelta(days=1)

        print(f"Generated {len(sessions_to_insert)} sessions across {active_days_count}/{total_days} active days ({total_minutes} total focus minutes / {round(total_minutes/60, 1)} hours).")

        # 3. Fast bulk insertion
        if ctx.is_pg:
            from psycopg2.extras import execute_values
            sql = """
                INSERT INTO sessions (user_id, subject_id, subject_name, duration_minutes, date, timestamp, start_time, end_time, xp)
                VALUES %s
            """
            cur = ctx.cursor()
            execute_values(cur, sql, sessions_to_insert, page_size=2000)
        else:
            ctx.conn.executemany("""
                INSERT INTO sessions (user_id, subject_id, subject_name, duration_minutes, date, timestamp, start_time, end_time, xp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, sessions_to_insert)

        ctx.commit()
        print("Successfully committed 10 years of study sessions into the database!")

        # 4. Update timer state updated_at
        now_ms = int(datetime.now().timestamp() * 1000)
        ctx.execute("UPDATE user_timer_state SET updated_at = ? WHERE user_id = ?", (now_ms, user_id))
        ctx.commit()

        # 5. Verify statistics & activity
        stats = database.get_stats(user_id)
        subjects_summary = database.get_subjects(user_id)
        activity = database.get_daily_activity(user_id)

        print("\n============================================================")
        print("SEEDING VERIFICATION REPORT FOR 'test'")
        print("============================================================")
        print(f"User ID:                 {user_id}")
        print(f"Username:                test")
        print(f"Date Span:               {start_date} to {end_date} (10 Full Years)")
        print(f"Total Sessions Inserted: {len(sessions_to_insert)}")
        print(f"Total Active Days:       {len(activity)} / {total_days} ({round(len(activity)/total_days*100, 1)}% consistency)")
        print(f"Current Streak:          {stats['streak']} days (Active up to today {end_date})")
        print(f"Today Focus:             {stats['todayFocusMinutes']} mins ({stats['todayFocusSeconds']}s)")
        print(f"Total XP:                {stats['xp']} XP ({round(stats['xp']/60, 1)} focus hours)")
        print("\nSubject Breakdown:")
        for s in subjects_summary:
            print(f"  • {s['name']:42} | {s['hours']:6.1f} hrs ({s['session_count']} sessions)")
        print("============================================================\n")

if __name__ == '__main__':
    generate_10years_test_data()
