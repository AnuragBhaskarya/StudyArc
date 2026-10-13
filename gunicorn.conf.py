# Gunicorn Configuration for StudyArc on Render / Production
# Automatically loaded by Gunicorn on startup, ensuring the correct WebSocket worker
# and single-worker concurrency even if the hosting platform overrides the CLI command.

import os

# Use gevent-websocket for real-time Socket.IO and WebSocket upgrades
worker_class = 'geventwebsocket.gunicorn.workers.GeventWebSocketWorker'

# Single worker is required for in-memory Socket.IO rooms and real-time state sync
workers = 1
threads = 1
worker_connections = 1000
timeout = 120
keepalive = 10

def on_starting(server):
    """Ensure exactly 1 worker even if CLI passed -w 2 or WEB_CONCURRENCY is set."""
    server.num_workers = 1
