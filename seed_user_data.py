import os
import random
from datetime import datetime, timedelta, time
import database

def seed_anurag_data():
    user = database.get_user_by_username('anurag')
    if not user:
        print("User 'anurag' not found!")
        return

    user_id = user['id']
    print(f"Seeding year of study data for user '{user['username']}' (ID: {user_id})...")

    # 1. Setup clean subject roster
    subjects_spec = [
        ('Deep Work', '#10E068'),
        ('Problem Solving', '#05DF63'),
        ('Machine Learning', '#4EFA8F'),
        ('System Architecture', '#22C55E'),
        ('Mathematics', '#34E87C'),
        ('Reading', '#10B981')
    ]

    with database.get_connection() as ctx:
        # Clean up any test subjects (5: wefg, 6: Jdkd)
        ctx.execute("DELETE FROM subjects WHERE user_id = ? AND name IN ('wefg', 'Jdkd', 'wef')", (user_id,))
        for name, color in subjects_spec:
            cur = ctx.execute("SELECT id FROM subjects WHERE user_id = ? AND LOWER(name) = LOWER(?)", (user_id, name))
            row = cur.fetchone()
            if row:
                ctx.execute("UPDATE subjects SET color = ? WHERE id = ?", (color, database.fetch_scalar(row)))
            else:
                ctx.execute("INSERT INTO subjects (user_id, name, color) VALUES (?, ?, ?)", (user_id, name, color))

        # Fetch current subject mapping
        cur = ctx.execute("SELECT id, name, color FROM subjects WHERE user_id = ? ORDER BY id", (user_id,))
        all_subjects = [dict(r) for r in cur.fetchall()]
        print(f"Subjects ready: {[s['name'] for s in all_subjects]}")

        # Clean existing sessions for anurag (if any)
        ctx.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))

        # 2. Generate dates from 2025-01-01 through 2026-10-17 (today)
        end_date = datetime(2026, 10, 17).date()
        start_date = datetime(2025, 1, 1).date()

        current_date = start_date
        sessions_to_insert = []
        streak_start_date = end_date - timedelta(days=22) # Ensure unbroken streak for last 22 days

        # Generate weights matching number of subjects
        base_weights = [0.30, 0.20, 0.16, 0.14, 0.10, 0.06, 0.04]
        subject_weights = base_weights[:len(all_subjects)]
        if len(subject_weights) < len(all_subjects):
            subject_weights += [0.05] * (len(all_subjects) - len(subject_weights))

        total_days = (end_date - start_date).days + 1
        active_days_count = 0
        total_minutes = 0

        while current_date <= end_date:
            date_str = current_date.strftime('%Y-%m-%d')
            is_streak_period = (current_date >= streak_start_date)

            # Decide if this day has study activity
            # Rest day chance ~14% unless in the streak period
            if not is_streak_period and random.random() < 0.14:
                current_date += timedelta(days=1)
                continue

            active_days_count += 1

            # Determine number of sessions today
            rand_val = random.random()
            if is_streak_period:
                num_sessions = random.choices([1, 2, 3, 4], weights=[0.2, 0.45, 0.25, 0.1])[0]
            elif rand_val < 0.40:
                num_sessions = 1
            elif rand_val < 0.75:
                num_sessions = 2
            elif rand_val < 0.92:
                num_sessions = 3
            else:
                num_sessions = 4 # Heavy flow state day

            # Possible time slots (hour, minute range)
            time_slots = [
                (random.randint(9, 11), random.choice([0, 15, 30, 45])),
                (random.randint(14, 16), random.choice([0, 15, 30, 45])),
                (random.randint(17, 18), random.choice([0, 15, 30, 45])),
                (random.randint(19, 21), random.choice([0, 15, 30, 45]))
            ]
            random.shuffle(time_slots)

            for s_idx in range(num_sessions):
                chosen_subj = random.choices(all_subjects, weights=subject_weights[:len(all_subjects)])[0]
                duration = random.choice([25, 30, 45, 50, 60, 75, 90])
                total_minutes += duration

                slot_h, slot_m = time_slots[s_idx % len(time_slots)]
                # Session end time
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
                    end_time_str
                ))

            current_date += timedelta(days=1)

        print(f"Generated {len(sessions_to_insert)} sessions across {active_days_count}/{total_days} days ({total_minutes} total focus mins).")

        # 3. Batch insert into database
        if ctx.is_pg:
            from psycopg2.extras import execute_values
            sql = """
                INSERT INTO sessions (user_id, subject_id, subject_name, duration_minutes, date, timestamp, start_time, end_time)
                VALUES %s
            """
            cur = ctx.cursor()
            execute_values(cur, sql, sessions_to_insert)
        else:
            ctx.conn.executemany("""
                INSERT INTO sessions (user_id, subject_id, subject_name, duration_minutes, date, timestamp, start_time, end_time)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, sessions_to_insert)

        ctx.commit()
        print("Database commit successful!")

        # 4. Verify stats
        stats = database.get_stats(user_id)
        subjects_summary = database.get_subjects(user_id)
        activity = database.get_daily_activity(user_id)

        print("\n--- SEEDING VERIFICATION ---")
        print(f"User: Anurag")
        print(f"Current Streak: {stats['streak']} days")
        print(f"Total XP / Focus Mins: {stats['xp']} ({round(stats['xp']/60, 1)} hours)")
        print(f"Today Focus Mins: {stats['todayFocusMinutes']} mins")
        print(f"Total Days with Activity: {len(activity)}")
        print("Top Subjects:")
        for s in subjects_summary[:4]:
            print(f" - {s['name']}: {s['hours']} hrs ({s['session_count']} sessions)")

if __name__ == '__main__':
    seed_anurag_data()
