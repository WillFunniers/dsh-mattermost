#!/usr/bin/env python3
"""Read-only checks shared by deploy/preflight.sh and deploy/verify.sh.

Prints one line per check:  PASS|FAIL|UNKNOWN <detail>
Never prints tokens, user ids, channel ids or card ids.
"""
import json
import os
import re
import sys
import urllib.request

import yaml


class Loader(yaml.SafeLoader):
    pass


Loader.add_constructor('tag:yaml.org,2002:js', lambda l, n: '<js>')


def paths():
    cfg = os.environ.get('AB_CFG') or os.path.expanduser('~/.dsh/profiles/web/cordis.patch.yml')
    cred = os.environ.get('AB_CRED') or os.path.expanduser('~/.dsh/.credentials.yaml')
    log = os.environ.get('AB_LOG') or os.path.expanduser('~/.dsh/mattermost/plugin.log')
    return cfg, cred, log


def load_row():
    cfg, _, _ = paths()
    data = yaml.load(open(cfg), Loader=Loader)
    rows = [r for r in data if isinstance(r, dict) and r.get('id') == 'mattermost']
    if not rows:
        raise RuntimeError('no mattermost row')
    return rows[0]['config']


def token():
    _, cred, _ = paths()
    row = load_row()
    ref = str(row.get('tokenRef') or 'MATTERMOST_TOKEN')
    refs = (yaml.load(open(cred), Loader=Loader).get('refs') or {})
    value = refs.get(ref)
    if not value:
        raise RuntimeError('credential ref missing')
    return str(value)


def emit(status, detail=''):
    print(f'{status} {detail}'.rstrip())
    return 0 if status == 'PASS' else (1 if status == 'FAIL' else 2)


def config():
    try:
        row = load_row()
        chans = [str(c) for c in (row.get('channels') or [])]
        if not chans:
            return emit('FAIL', 'no channels configured')
        return emit('PASS', f"channels={len(chans)} webApproval={'present' if 'webApproval' in row else 'absent'}")
    except Exception:
        return emit('UNKNOWN', 'config unreadable')


def credential():
    try:
        token()
        return emit('PASS', 'credential ref present')
    except Exception:
        return emit('UNKNOWN', 'credential source unavailable')


def _me():
    row = load_row()
    base = str(row['baseUrl']).rstrip('/')
    req = urllib.request.Request(base + '/api/v4/users/me',
                                 headers={'Authorization': 'Bearer ' + token()})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def identity():
    try:
        me = _me()
    except Exception:
        return emit('UNKNOWN', 'auth request failed')
    _, _, log = paths()
    try:
        text = open(log, errors='ignore').read()
    except Exception:
        return emit('UNKNOWN', 'identity log unreadable')
    names = re.findall(r'bot identity: (\S+) \(([a-z0-9]{4})', text)
    if not names:
        return emit('UNKNOWN', 'identity evidence missing')
    name, prefix = names[-1]
    if me.get('username') != name or not str(me.get('id', '')).startswith(prefix):
        return emit('UNKNOWN', 'identity mismatch')
    return emit('PASS', 'identity matched')


def _fetch(base, tok, path):
    req = urllib.request.Request(base + path, headers={'Authorization': 'Bearer ' + tok})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def pending():
    try:
        row = load_row()
        base = str(row['baseUrl']).rstrip('/')
        chans = [str(c) for c in (row.get('channels') or [])]
        tok = token()
    except Exception:
        return emit('UNKNOWN', 'config or credential unavailable')

    per_page = 200
    max_pages = int(os.environ.get('AB_MAX_PAGES') or 500)
    pages = total = cards = 0
    pending_count = 0

    def fetch(ch, page, size):
        d = _fetch(base, tok, f'/api/v4/channels/{ch}/posts?page={page}&per_page={size}')
        if not isinstance(d, dict) or 'posts' not in d or 'order' not in d:
            raise RuntimeError('response structure')
        return d

    def count(d):
        return len(d.get('posts') or {})

    try:
        for ch in chans:
            n1 = count(fetch(ch, 0, 1))
            n100 = count(fetch(ch, 0, 100))
            n200 = count(fetch(ch, 0, per_page))
            n1000 = count(fetch(ch, 0, 1000))
            if n200 > per_page or n1000 > per_page:
                return emit('UNKNOWN', 'per_page cap exceeded')
            if n200 > 0:
                if n1 != 1:
                    return emit('UNKNOWN', 'per_page=1 not honored')
                if n100 != min(100, n200):
                    return emit('UNKNOWN', 'per_page scaling inconsistent')
            elif n1 != 0 or n100 != 0:
                return emit('UNKNOWN', 'per_page contradiction')
    except Exception:
        return emit('UNKNOWN', 'pagination probe failed')

    try:
        for ch in chans:
            page = 0
            short = False
            while True:
                d = fetch(ch, page, per_page)
                n = count(d)
                pages += 1
                total += n
                if n > per_page:
                    return emit('UNKNOWN', 'page larger than per_page')
                if n == 0:
                    break
                if short:
                    return emit('UNKNOWN', 'short page but more history')
                if n < per_page:
                    short = True
                for post in (d.get('posts') or {}).values():
                    for att in ((post.get('props') or {}).get('attachments') or []):
                        if not str(att.get('title', '')).startswith('审批请求'):
                            continue
                        cards += 1
                        status = None
                        for field in (att.get('fields') or []):
                            if str(field.get('title')) == '状态':
                                status = str(field.get('value'))
                        if status is None:
                            return emit('UNKNOWN', 'card structure mismatch')
                        if status.startswith('待决定'):
                            pending_count += 1
                page += 1
                if page > max_pages:
                    return emit('UNKNOWN', 'page cap reached')
    except Exception:
        return emit('UNKNOWN', 'pagination failed')

    if cards == 0:
        return emit('UNKNOWN', 'no card to validate parser')
    if total == 0:
        return emit('UNKNOWN', 'no history to prove pagination')
    if pending_count:
        return emit('FAIL', f'pending={pending_count} pages={pages} cards={cards}')
    return emit('PASS', f'pending=0 pages={pages} cards={cards} posts={total}')


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    fn = {'config': config, 'credential': credential, 'identity': identity, 'pending': pending}.get(cmd)
    if not fn:
        print('UNKNOWN unknown subcommand')
        sys.exit(2)
    sys.exit(fn())
