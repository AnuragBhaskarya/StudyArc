import os
import mimetypes
from flask import Flask, jsonify, request, send_from_directory
import database

app = Flask(__name__, static_folder='.', static_url_path='')

# Ensure correct MIME types
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('text/css', '.css')

# Initialize SQLite database with authentic starter data
database.init_db(seed_real_data=True)

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:filename>')
def static_files(filename):
    return send_from_directory('.', filename)

@app.route('/api/state', methods=['GET'])
def get_state():
    """
    Returns full application state aggregated directly from SQLite.
    """
    try:
        subjects = database.get_subjects()
        sessions = database.get_sessions()
        day_activity = database.get_daily_activity()
        stats = database.get_stats()
        
        return jsonify({
            'success': True,
            'subjects': subjects,
            'sessions': sessions,
            'dayActivity': day_activity,
            'stats': stats
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/subjects', methods=['GET', 'POST'])
def handle_subjects():
    if request.method == 'GET':
        return jsonify(database.get_subjects())
    
    data = request.get_json(force=True, silent=True) or {}
    name = data.get('name', '').strip()
    color = data.get('color', '#79D99B')
    if not name:
        return jsonify({'error': 'Subject name is required'}), 400
        
    subj = database.add_or_get_subject(name, color)
    return jsonify({'success': True, 'subject': subj, 'subjects': database.get_subjects()})

@app.route('/api/sessions', methods=['GET', 'POST', 'DELETE'])
def handle_sessions():
    if request.method == 'GET':
        return jsonify(database.get_sessions())
        
    if request.method == 'DELETE':
        data = request.get_json(force=True, silent=True) or {}
        session_id = data.get('id') or data.get('session_id') or request.args.get('id')
        if not session_id:
            return jsonify({'success': False, 'error': 'Session ID is required'}), 400
        return delete_session_endpoint(session_id)
        
    data = request.get_json(force=True, silent=True) or {}
    subject_name = data.get('subject_name') or data.get('subject') or 'Focus Session'
    duration_minutes = int(data.get('duration_minutes') or data.get('durationMinutes') or 25)
    date_str = data.get('date')
    timestamp_ms = data.get('timestamp')
    start_time = data.get('start_time') or data.get('startTime')
    end_time = data.get('end_time') or data.get('endTime')
    
    new_session = database.add_session(
        subject_name, duration_minutes, date_str, timestamp_ms, start_time, end_time
    )
    
    # Return updated session and newly recalculated metrics from SQL
    return jsonify({
        'success': True,
        'session': new_session,
        'stats': database.get_stats(),
        'dayActivity': database.get_daily_activity(),
        'subjects': database.get_subjects()
    })

@app.route('/api/sessions/<session_id>', methods=['DELETE', 'POST'])
@app.route('/api/sessions/<session_id>/delete', methods=['POST'])
def delete_session_endpoint(session_id):
    deleted = database.delete_session(session_id)
    if not deleted:
        return jsonify({'success': False, 'error': 'Session not found'}), 404
        
    date_str = deleted.get('date')
    day_details = database.get_day_details(date_str) if date_str else None
    
    return jsonify({
        'success': True,
        'deletedSession': deleted,
        'dayDetails': day_details,
        'stats': database.get_stats(),
        'dayActivity': database.get_daily_activity(),
        'subjects': database.get_subjects(),
        'sessions': database.get_sessions()
    })

@app.route('/api/day/<date_str>', methods=['GET'])
def get_day(date_str):
    try:
        details = database.get_day_details(date_str)
        return jsonify({'success': True, 'data': details})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/activity', methods=['GET'])
def get_activity():
    return jsonify(database.get_daily_activity())

@app.route('/api/stats', methods=['GET'])
def get_stats():
    return jsonify(database.get_stats())

@app.route('/api/reset', methods=['POST'])
def reset_data():
    data = request.get_json(force=True, silent=True) or {}
    reseed = data.get('reseed', True)
    database.reset_database(reseed=reseed)
    return jsonify({
        'success': True,
        'stats': database.get_stats(),
        'dayActivity': database.get_daily_activity(),
        'subjects': database.get_subjects(),
        'sessions': database.get_sessions()
    })

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    print(f"StudyArc SQLite server running at http://0.0.0.0:{port}")
    app.run(host='0.0.0.0', port=port, debug=False)
