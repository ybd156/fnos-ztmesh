"""本地冒烟测试：用桩服务驱动真实二进制，覆盖后端接口契约。

    python tests/smoke.py            # Windows（先编译 tests/ztmesh-server.exe）
    python3 tests/smoke.py           # Linux / WSL（先编译 tests/ztmesh-server）

Windows 上子进程无法执行 bash 生命周期脚本，因此用 tests/stubcmd 这个 Go 桩程序；
Linux 上直接跑 tests 里生成的 bash 桩脚本，与真实环境一致。

覆盖：静态资源与路径穿越、/api 透传、子网路由（校验/开启/回滚/关闭）、令牌掩码、
网络选项回读、开机自启、ZeroTier 核心检查/升级/回滚、服务控制、流量统计。
"""
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RUN = os.path.join(HERE, 'run')
IS_WIN = os.name == 'nt'
EXE_NAME = 'ztmesh-server.exe' if IS_WIN else 'ztmesh-server'
STUB_NAME = 'stubcmd.exe' if IS_WIN else 'stubcmd'

APPNAME = 'ztmesh'
NWID = '8056c2e21c000001'
ZT_PORT = 19993
CENTRAL_PORT = 18080
CORE_PORT = 18081
WEB_PORT = 13443
CORE_NEW = '9.9.9'
CORE_OLD = '1.16.2'

failures = []


def check(cond, msg, extra=''):
    if cond:
        print('  OK   ' + msg)
    else:
        failures.append(msg)
        print('  FAIL ' + msg + (' :: ' + str(extra) if extra else ''))


# --------------------------------------------------------------------------
# 桩：本机 ZeroTier 服务 API
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

# 守护进程自报的版本；核心升级测试里会改它，模拟重启后换了个核心
ZT_STATE = {'version': CORE_OLD}


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
            return self._send(200, {'address': 'deadbeef99', 'online': True,
                                    'version': ZT_STATE['version']})
        if p == '/network':
            return self._send(200, [NET])
        if p == '/network/' + NWID:
            return self._send(200, NET)
        if p == '/peer':
            return self._send(200, [])
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
# 桩：ZeroTier Central（legacy v1 形状）
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


# --------------------------------------------------------------------------
# 桩：官方更新源（releases/latest + deb 下载）
# --------------------------------------------------------------------------
DEB_PATH = os.path.join(HERE, 'fixtures', 'zerotier-one_%s_amd64.deb' % CORE_NEW)


class CoreStub(BaseHTTPRequestHandler):
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
        p = self.path.split('?')[0]
        if p.endswith('/releases/latest'):
            return self._send(200, {'tag_name': 'v' + CORE_NEW, 'name': CORE_NEW})
        if p.endswith('.deb'):
            try:
                with open(DEB_PATH, 'rb') as fh:
                    data = fh.read()
            except OSError:
                return self._send(404, {'error': 'no fixture'})
            self.send_response(200)
            self.send_header('Content-Type', 'application/vnd.debian.binary-package')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return self._send(404, {'error': 'not found'})


def serve(handler, port):
    srv = ThreadingHTTPServer(('127.0.0.1', port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# --------------------------------------------------------------------------
# 造一个真实的 .deb（ar + data.tar.xz），内容取自仓库里的 x86 核心
# --------------------------------------------------------------------------
def ar_member(name, payload):
    hdr = name.ljust(16).encode()
    hdr += b'0'.ljust(12)
    hdr += b'0'.ljust(6)
    hdr += b'0'.ljust(6)
    hdr += b'100644'.ljust(8)
    hdr += str(len(payload)).ljust(10).encode()
    hdr += b'`\n'
    assert len(hdr) == 60, len(hdr)
    body = hdr + payload
    if len(payload) % 2:
        body += b'\n'
    return body


def build_deb_fixture():
    core = os.path.join(ROOT, 'fpk', 'app', 'zt', 'zerotier-one')
    if not os.path.exists(core):
        return False
    os.makedirs(os.path.dirname(DEB_PATH), exist_ok=True)
    with open(core, 'rb') as fh:
        payload = fh.read()
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:xz') as tf:
        info = tarfile.TarInfo('./usr/sbin/zerotier-one')
        info.size = len(payload)
        info.mode = 0o755
        tf.addfile(info, io.BytesIO(payload))
    deb = b'!<arch>\n'
    deb += ar_member('debian-binary', b'2.0\n')
    deb += ar_member('control.tar.xz', b'')
    deb += ar_member('data.tar.xz', buf.getvalue())
    with open(DEB_PATH, 'wb') as fh:
        fh.write(deb)
    return True


# --------------------------------------------------------------------------
# HTTP 助手
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
    if os.path.isdir(RUN):
        shutil.rmtree(RUN)
    appdest = os.path.join(RUN, 'target')
    pkgvar = os.path.join(RUN, 'var')
    pkgtmp = os.path.join(RUN, 'tmp')
    for d in (os.path.join(appdest, 'www', 'css'), os.path.join(pkgvar, 'zt'),
              os.path.join(appdest, 'zt'), os.path.join(appdest, 'bin'),
              pkgtmp, os.path.join(RUN, 'cmd')):
        os.makedirs(d, exist_ok=True)
    with open(os.path.join(appdest, 'www', 'index.html'), 'w', encoding='utf-8') as fh:
        fh.write('<!doctype html><title>smoke</title><h1>ztmesh smoke</h1>')
    with open(os.path.join(appdest, 'www', 'css', 'style.css'), 'w', encoding='utf-8') as fh:
        fh.write('body{color:#fff}')
    with open(os.path.join(pkgvar, 'zt', 'authtoken.secret'), 'w') as fh:
        fh.write('smoketoken\n')
    with open(os.path.join(pkgvar, 'zt', 'zerotier-one.port'), 'w') as fh:
        fh.write('%d\n' % ZT_PORT)

    # 包内核心（模拟 app/zt/zerotier-one）：首次界面升级时它就是回滚目标
    core_src = os.path.join(ROOT, 'fpk', 'app', 'zt', 'zerotier-one')
    if os.path.exists(core_src):
        dest = os.path.join(appdest, 'zt', 'zerotier-one')
        shutil.copy2(core_src, dest)
        os.chmod(dest, 0o755)

    state_path = os.path.join(HERE, 'stub-autostart.state').replace('\\', '/')
    script = '\n'.join([
        '#!/bin/bash',
        'STATE="' + state_path + '"',
        'case "$1" in',
        '  autostart-status)',
        '    if [ "$(cat "$STATE" 2>/dev/null)" = "0" ]; then',
        '      echo "enabled=0"; echo "mechanism=none"; echo "detail=stub disabled";',
        '    else',
        '      echo "enabled=1"; echo "mechanism=systemd"; echo "detail=stub unit";',
        '    fi;;',
        '  autostart-enable) echo 1 > "$STATE"; echo "enabled=1"; echo "mechanism=systemd"; echo "detail=stub enabled";;',
        '  autostart-disable) echo 0 > "$STATE"; echo "enabled=0"; echo "mechanism=none"; echo "detail=stub disabled";;',
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
    main_path = os.path.join(RUN, 'cmd', 'main')
    with open(main_path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(script)
    os.chmod(main_path, 0o755)
    return appdest, pkgvar, pkgtmp


def manifest_version():
    """从 fpk/manifest 读版本号，避免每次发版都改测试。"""
    path = os.path.join(ROOT, 'fpk', 'manifest')
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            if line.startswith('version='):
                return line.split('=', 1)[1].strip()
    return ''


def elf_machine(path):
    with open(path, 'rb') as fh:
        head = fh.read(20)
    if len(head) < 20 or head[:4] != b'\x7fELF':
        return None
    return int.from_bytes(head[18:20], 'little' if head[5] == 1 else 'big')


def main():
    zt_srv = serve(ZTStub, ZT_PORT)
    central_srv = serve(CentralStub, CENTRAL_PORT)
    core_srv = serve(CoreStub, CORE_PORT)
    appdest, pkgvar, pkgtmp = prepare_tree()
    have_core = build_deb_fixture()
    if not have_core:
        print('!! 没有 fpk/app/zt/zerotier-one，跳过核心升级测试')

    exe = os.path.join(HERE, EXE_NAME)
    if not os.path.exists(exe):
        print('缺少 %s，先编译：' % exe)
        print('  Windows: cd server && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o ../tests/ztmesh-server.exe .')
        print('  Linux:   cd server && GOOS=linux  GOARCH=amd64 CGO_ENABLED=0 go build -o ../tests/ztmesh-server .')
        return 2

    env = os.environ.copy()
    env.update({
        'TRIM_APPNAME': APPNAME,
        'TRIM_APPDEST': appdest,
        'TRIM_PKGVAR': pkgvar,
        'TRIM_PKGTMP': pkgtmp,
        'TRIM_PKGETC': os.path.join(RUN, 'etc'),
        'TRIM_SERVICE_PORT': str(WEB_PORT),
        'TRIM_PKGMETA': os.path.join(RUN, 'meta'),
        'ZT_CENTRAL_BASES': 'stub|http://127.0.0.1:%d/api/v1|token' % CENTRAL_PORT,
        'ZT_CORE_API': 'http://127.0.0.1:%d/releases/latest' % CORE_PORT,
        'ZT_CORE_DEB_BASE': 'http://127.0.0.1:%d/deb/zerotier-one_{v}_{arch}.deb' % CORE_PORT,
    })
    if IS_WIN:
        stub = os.path.join(HERE, STUB_NAME)
        if not os.path.exists(stub):
            print('缺少 %s，先编译： go build -o tests/stubcmd.exe tests/stubcmd/main.go' % stub)
            return 2
        env['ZT_MAIN_SHELL'] = stub

    # 每次从「装好即开自启」的初始状态开始
    state = os.path.join(HERE, 'stub-autostart.state')
    if os.path.exists(state):
        os.remove(state)

    log = open(os.path.join(RUN, 'server.log'), 'wb')
    proc = subprocess.Popen([exe], env=env, stdout=log, stderr=subprocess.STDOUT)
    try:
        for _ in range(60):
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
        check(body.get('version') == manifest_version(),
              '后端自报版本与 manifest 一致', (body.get('version'), manifest_version()))

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

        print('== ZeroTier 核心 ==')
        code, body = http('GET', '/api/core')
        check(code == 200 and body.get('ok') is True, 'GET /api/core', body)
        check(body.get('current') == CORE_OLD, '读到当前核心版本', body.get('current'))
        check(body.get('latest') == CORE_NEW, '读到官方最新版本', body.get('latest'))
        check(body.get('updateAvailable') is True, '判定有新版本', body)
        check(body.get('managed') is False, '初始使用包内核心', body.get('managed'))

        if have_core:
            ZT_STATE['version'] = CORE_NEW  # 模拟升级后守护进程重启、自报新版本
            code, body = http('POST', '/api/core/update', {}, timeout=180)
            check(code == 200 and body.get('ok') is True, 'POST /api/core/update 升级成功', body)
            check(body.get('after') == CORE_NEW, '升级后版本为新版本', body.get('after'))
            installed = os.path.join(pkgvar, 'zt-bin', 'zerotier-one')
            check(os.path.exists(installed), '核心写入 $TRIM_PKGVAR/zt-bin', installed)
            check(elf_machine(installed) == 62, '安装的核心架构正确（x86-64）', elf_machine(installed))
            check(os.path.exists(installed + '.prev'), '保留上一版本用于回滚', installed + '.prev')

            code, body = http('GET', '/api/core')
            check(body.get('managed') is True, '升级后使用界面安装的核心', body)
            check(body.get('rollbackReady') is True, '报告可回滚', body)
            check(body.get('updateAvailable') is False, '升级后不再提示有新版本', body)

            ZT_STATE['version'] = CORE_OLD
            code, body = http('POST', '/api/core/rollback', {}, timeout=180)
            check(code == 200 and body.get('ok') is True, 'POST /api/core/rollback 回滚成功', body)
            check(body.get('after') == CORE_OLD, '回滚后版本恢复', body.get('after'))
        else:
            print('  SKIP 核心升级/回滚（缺少包内核心二进制）')

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
        core_srv.shutdown()

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
