"""Local smoke test for the Go backend (runs on Windows, no NAS needed).

Starts two stubs -- the local ZeroTier service API and a ZeroTier Central
endpoint -- then drives the real binary over HTTP and asserts the contract the
web UI depends on. Run with the bundled Python:

    python tests/smoke.py
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
STUB_SRC = os.path.join(HERE, 'stubcmd')
SMOKE = os.path.join(HERE, 'run')
APPNAME = 'ztmesh'
NWID = '8056c2e21c000001'
ZT_PORT = 19993
CENTRAL_PORT = 18080
WEB_PORT = 13443

failures = []


def check(cond, msg, extra=''):
    if cond:
        print('  OK   ' + msg)
    else:
        failures.append(msg)
        print('  FAIL ' + msg + (' :: ' + str(extra) if extra else ''))


# --------------------------------------------------------------------------
# stub: local ZeroTier service API
# --------------------------------------------------------------------------
NET = {
    'nwid': NWID,
    'name': 'smoke-net',
    'status': 'OK',
    'type': 'PRIVATE',
    'mac': 'aa:bb:cc:dd:ee:ff',
    'portDeviceName': 'ztabc123',
    'assignedAddresses': ['fd00::1/64', '10.147.17.5/24'],
    'allowManaged': True,
    'allowGlobal': False,
    'allowDefault': False,
    'allowDNS': False,
}


class ZTStub(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self):
        return self.headers.get('X-ZT1-Auth') == 'smoketoken'

    def do_GET(self):
        if not self._auth_ok():
            return self._send(401, {'error': 'unauthorized'})
        p = self.path.split('?')[0]
        if p == '/status':
            return self._send(200, {'address': 'deadbeef99', 'online': True, 'version': '1.16.2'})
        if p == '/network':
            return self._send(200, [NET])
        if p == '/network/' + NWID:
            return self._send(200, NET)
        if p == '/peer':
            return self._send(200, [])
        if p.startswith('/controller/network/'):
            # not the controller for this network
            return self._send(404, {'error': 'not found'})
        return self._send(404, {'error': 'not found'})

    def do_POST(self):
        if not self._auth_ok():
            return self._send(401, {'error': 'unauthorized'})
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length)
        p = self.path.split('?')[0]
        if p == '/network/' + NWID:
            try:
                patch = json.loads(raw or b'{}')
            except ValueError:
                patch = {}
            NET.update(patch)
            return self._send(200, NET)
        return self._send(404, {'error': 'not found'})


# --------------------------------------------------------------------------
# stub: ZeroTier Central (legacy v1 shape)
# --------------------------------------------------------------------------
CENTRAL_ROUTES = []


class CentralStub(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.headers.get('Authorization') != 'token smoke-central-token':
            return self._send(401, {'error': 'unauthorized'})
        if self.path.endswith('/network/' + NWID):
            return self._send(200, {'id': NWID, 'config': {'routes': CENTRAL_ROUTES}})
        return self._send(404, {'error': 'not found'})

    def do_POST(self):
        global CENTRAL_ROUTES
        if self.headers.get('Authorization') != 'token smoke-central-token':
            return self._send(401, {'error': 'unauthorized'})
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw or b'{}')
        except ValueError:
            return self._send(400, {'error': 'bad json'})
        CENTRAL_ROUTES = (payload.get('config') or {}).get('routes', [])
        return self._send(200, {'id': NWID, 'config': {'routes': CENTRAL_ROUTES}})


def serve(handler, port):
    srv = ThreadingHTTPServer(('127.0.0.1', port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# --------------------------------------------------------------------------
# HTTP helpers
# --------------------------------------------------------------------------
def http(method, path, body=None, timeout=15):
    url = 'http://127.0.0.1:%d%s' % (WEB_PORT, path)
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            try:
                return resp.status, json.loads(raw)
            except ValueError:
                return resp.status, raw.decode('utf-8', 'replace')
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, raw.decode('utf-8', 'replace')


# --------------------------------------------------------------------------
# fixture
# --------------------------------------------------------------------------
def prepare_tree():
    if os.path.isdir(SMOKE):
        shutil.rmtree(SMOKE)
    appdest = os.path.join(SMOKE, 'target')
    pkgvar = os.path.join(SMOKE, 'var')
    pkgtmp = os.path.join(SMOKE, 'tmp')
    for d in (os.path.join(appdest, 'www', 'css'), os.path.join(pkgvar, 'zt'), pkgtmp,
              os.path.join(SMOKE, 'cmd')):
        os.makedirs(d, exist_ok=True)
    with open(os.path.join(appdest, 'www', 'index.html'), 'w', encoding='utf-8') as fh:
        fh.write('<!doctype html><title>smoke</title><h1>ztmesh smoke</h1>')
    with open(os.path.join(appdest, 'www', 'css', 'style.css'), 'w', encoding='utf-8') as fh:
        fh.write('body{color:#fff}')
    with open(os.path.join(pkgvar, 'zt', 'authtoken.secret'), 'w') as fh:
        fh.write('smoketoken\n')
    with open(os.path.join(pkgvar, 'zt', 'zerotier-one.port'), 'w') as fh:
        fh.write('%d\n' % ZT_PORT)
    script = '\n'.join([
        '#!/bin/bash',
        'case "$1" in',
        '  autostart-status) echo "enabled=1"; echo "mechanism=systemd"; echo "detail=stub unit";;',
        '  autostart-enable) echo "enabled=1"; echo "mechanism=systemd"; echo "detail=stub enabled";;',
        '  autostart-disable) echo "enabled=0"; echo "mechanism=none"; echo "detail=stub disabled";;',
        '  subnet-status) echo "ip_forward=1"; echo "phy=eth0 nat_rule=present forward_rules=present";',
        '                 echo "nat_rule=present"; echo "forward_rules=present";;',
        '  subnet-up) echo "ip_forward=1"; echo "phy=eth0 nat_rule=present forward_rules=present";',
        '             echo "nat_rule=present"; echo "forward_rules=present";;',
        '  subnet-down) echo "phy=eth0 rules=removed";;',
        '  zt-start) echo "started";;',
        '  zt-stop) echo "stopped";;',
        '  set-option) echo "set $2 $3=$4";;',
        '  *) echo "noop $1";;',
        'esac',
        'exit 0',
        '',
    ])
    with open(os.path.join(SMOKE, 'cmd', 'main'), 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(script)
    return appdest, pkgvar, pkgtmp


def main():
    zt_srv = serve(ZTStub, ZT_PORT)
    central_srv = serve(CentralStub, CENTRAL_PORT)
    appdest, pkgvar, pkgtmp = prepare_tree()

    exe = os.path.join(HERE, 'ztmesh-server.exe')
    stub = os.path.join(HERE, 'stubcmd.exe')
    if not os.path.exists(exe) or not os.path.exists(stub):
        print('缺少 %s / %s' % (exe, stub))
        print('先在仓库根目录构建：')
        print('  cd server && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o ../tests/ztmesh-server.exe .')
        print('  go build -o tests/stubcmd.exe tests/stubcmd/main.go')
        return 2

    env = os.environ.copy()
    env.update({
        # Windows cannot execute the bash lifecycle script from a child process
        # here; the stub binary answers the same way cmd/main does.
        'ZT_MAIN_SHELL': stub,
        'TRIM_APPNAME': APPNAME,
        'TRIM_APPDEST': appdest,
        'TRIM_PKGVAR': pkgvar,
        'TRIM_PKGTMP': pkgtmp,
        'TRIM_PKGETC': os.path.join(SMOKE, 'etc'),
        'TRIM_SERVICE_PORT': str(WEB_PORT),
        'TRIM_PKGMETA': os.path.join(SMOKE, 'meta'),
        'ZT_CENTRAL_BASES': 'stub|http://127.0.0.1:%d/api/v1|token' % CENTRAL_PORT,
    })
    # Fresh install state: the stub remembers autostart between runs, and the
    # assertions below start from "enabled by install_callback".
    state = os.path.join(HERE, 'stub-autostart.state')
    if os.path.exists(state):
        os.remove(state)

    log = open(os.path.join(SMOKE, 'server.log'), 'wb')
    proc = subprocess.Popen([exe], env=env, stdout=log, stderr=subprocess.STDOUT)
    try:
        for _ in range(50):
            try:
                code, _ = http('GET', '/api/ping', timeout=1)
                if code == 200:
                    break
            except Exception:
                pass
            time.sleep(0.2)

        print('== 基础 ==')
        code, body = http('GET', '/api/ping')
        check(code == 200 and body.get('ok'), 'GET /api/ping', body)

        code, body = http('GET', '/api/health')
        check(code == 200 and body['zt']['reachable'] is True, 'GET /api/health 能探测守护进程', body)

        code, body = http('GET', '/api/status')
        check(code == 200 and body.get('address') == 'deadbeef99', 'GET /api/status 走本地 API 代理', body)

        code, body = http('GET', '/api/network')
        check(code == 200 and isinstance(body, list) and body[0]['nwid'] == NWID, 'GET /api/network 透传', body)

        print('== 静态资源 ==')
        code, body = http('GET', '/')
        check(code == 200 and 'ztmesh smoke' in body, 'GET / 返回 index.html', code)
        code, body = http('GET', '/css/style.css')
        check(code == 200 and 'body' in body, 'GET /css/style.css', code)
        code, body = http('GET', '/%2e%2e/%2e%2e/etc/passwd')
        check(code in (400, 403, 404), '路径穿越被拒绝', code)

        print('== 子网路由 ==')
        code, body = http('GET', '/api/subnet/info')
        check(code == 200 and isinstance(body.get('interfaces'), list), 'GET /api/subnet/info', body)
        ifaces = [i for i in body['interfaces'] if ' ' not in i['name']]
        check(len(ifaces) >= 1, '能枚举到本机网卡', body.get('interfaces'))
        check(body['networks'][0]['ztAddress'] == '10.147.17.5', '双栈网络里挑出 IPv4 作为 via', body['networks'][0])

        code, body = http('POST', '/api/subnet/enable', {'nwid': 'bogus'})
        check(code == 400 and body.get('error') == 'invalid-network-id', '非法网络 ID 被拒绝', body)

        code, body = http('POST', '/api/subnet/enable', {'nwid': NWID})
        check(code == 400 and body.get('error') == 'invalid-interface', '未选网卡被拒绝', body)

        code, body = http('POST', '/api/subnet/enable', {'nwid': NWID, 'phyIfaces': ['definitely-not-here']})
        check(code == 400 and body.get('error') == 'unknown-interface', '不存在的网卡被拒绝', body)

        iface = ifaces[0]
        code, body = http('POST', '/api/subnet/enable', {
            'nwid': NWID, 'phyIfaces': [iface['name']], 'token': 'smoke-central-token',
        }, timeout=40)
        check(code == 200 and body.get('ok') is True, 'POST /api/subnet/enable 成功', body)
        check(bool(body.get('targets')), '返回广播网段', body)
        check(body.get('via') == '10.147.17.5', 'via 是 IPv4', body.get('via'))
        check(len(CENTRAL_ROUTES) >= 1, '托管路由写进了 Central', CENTRAL_ROUTES)

        code, body = http('GET', '/api/subnet/info')
        cfg = body.get('config') or {}
        check(code == 200 and cfg.get('nwid') == NWID, 'subnet.conf 被读回', body.get('config'))
        local = body.get('local') or {}
        check(bool(local.get('perIface')), 'subnet-status 解析出每网卡状态', local)

        code, body = http('GET', '/api/subnet/token')
        check(code == 200 and body.get('tokenSaved') is True, 'GET /api/subnet/token 报告已保存', body)
        check(body.get('token') == 'smoke-central-token', '回环请求可读完整令牌', body.get('token'))
        check(body.get('tokenPreview', '').startswith('smok'), '返回掩码预览', body.get('tokenPreview'))

        code, body = http('POST', '/api/subnet/disable', {})
        check(code == 200 and body.get('ok') is True, 'POST /api/subnet/disable 成功', body)
        check(CENTRAL_ROUTES == [], '托管路由已从 Central 撤掉', CENTRAL_ROUTES)

        print('== 网络选项 ==')
        code, body = http('POST', '/api/network-option',
                          {'nwid': NWID, 'option': 'allowDefault', 'value': True})
        check(code == 200 and body.get('ok') is True, 'POST /api/network-option 生效并回读确认', body)
        code, body = http('POST', '/api/network-option',
                          {'nwid': NWID, 'option': 'nope', 'value': True})
        check(code == 400, '非法选项被拒绝', body)

        print('== 自启动 ==')
        code, body = http('GET', '/api/autostart')
        check(code == 200 and body.get('enabled') is True and body.get('mechanism') == 'systemd',
              'GET /api/autostart', body)
        code, body = http('POST', '/api/autostart', {'enabled': False})
        check(code == 200 and body.get('enabled') is False, 'POST /api/autostart 关闭', body)
        code, body = http('POST', '/api/autostart', {'enabled': 'yes'})
        check(code == 400, '非布尔 enabled 被拒绝', body)

        print('== 服务控制 ==')
        code, body = http('POST', '/api/service/stop')
        check(code == 200 and body.get('action') == 'zt-stop', 'POST /api/service/stop 调用 cmd/main', body)

        print('== 流量统计 ==')
        code, body = http('GET', '/api/netstats')
        check(code == 200 and isinstance(body.get('ifaces'), list), 'GET /api/netstats', body)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        zt_srv.shutdown()
        central_srv.shutdown()

    print()
    if failures:
        print('%d 项失败：' % len(failures))
        for f in failures:
            print('  - ' + f)
        return 1
    print('全部通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
