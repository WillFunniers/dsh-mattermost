#!/usr/bin/env python3
"""Tiny Mattermost mock used by deploy/tests. Read-only behaviour only."""
import json
import os
import re
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODE = os.environ.get('MOCK_MODE', 'normal')
TOTALS = {'chanA': 179, 'chanB': 135}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == '/api/v4/users/me':
            if MODE == 'identity_mismatch':
                return self._json({'id': 'abcd00000000000000000000', 'username': 'other', 'is_bot': True})
            return self._json({'id': 'jock00000000000000000000', 'username': 'dsh', 'is_bot': True})
        m = re.match(r'^/api/v4/channels/([^/]+)/posts$', u.path)
        if not m:
            return self._json({'error': 'not found'}, 404)
        ch = m.group(1)
        q = urllib.parse.parse_qs(u.query)
        page = int(q.get('page', ['0'])[0])
        per_page = int(q.get('per_page', ['60'])[0])
        total = TOTALS.get(ch, 0)
        if MODE == 'anomaly' and page == 0 and per_page == 200:
            return self._json(self._payload(ch, 201, page, pending=False))
        start = page * per_page
        n = 0 if start >= total else min(per_page, total - start)
        return self._json(self._payload(ch, n, page, pending=(MODE == 'pending')))

    def _payload(self, ch, n, page, pending):
        posts, order = {}, []
        for i in range(n):
            pid = f'{ch}p{page:03d}{i:04d}'
            order.append(pid)
            props = {}
            if page == 0 and i == 0:
                props = {'attachments': [{
                    'title': '审批请求 `abc12345` · read',
                    'fields': [{'title': '状态', 'value': '待决定' if pending else '已批准（仅本次）'}],
                }]}
            posts[pid] = {'id': pid, 'channel_id': ch, 'message': 'hello', 'create_at': i, 'props': props}
        return {'order': order, 'posts': posts, 'next_post_id': '', 'prev_post_id': ''}


if __name__ == '__main__':
    srv = ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('MOCK_PORT', '0'))), H)
    print(srv.server_address[1], flush=True)
    srv.serve_forever()
