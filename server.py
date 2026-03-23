"""
Simple HTTP server for the Alicia Model Viewer.
Run from the soa-modelviwer directory:

    python server.py

Then open: http://localhost:8080/viewer/
"""

import http.server
import socketserver
import os
import sys

PORT = 8081

class CORSHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def log_message(self, fmt, *args):
        # Suppress per-request noise; show only errors
        if int(args[1]) >= 400:
            super().log_message(fmt, *args)

if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with socketserver.TCPServer(('', PORT), CORSHandler) as httpd:
        print(f'Alicia Viewer — http://localhost:{PORT}/viewer/')
        print('Press Ctrl+C to stop.\n')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nServer stopped.')
