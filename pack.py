#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 ./fpk 打包成 .fpk 安装包（纯 Python，不再依赖 fnpack.exe）。

为什么重写
----------
1. `fnpack.exe` 只能在 Windows 上跑，而且它写出来的 tar 成员权限全是 0666：
   `cmd/*` 不可执行、`app/zt/zerotier-one` 不可执行，装到 fnOS 上守护进程根本起不来。
   以前的做法是「先让 fnpack 打包，再把两层 tar 解包重写权限」，绕且脆。
   现在直接用 Python 标准库 `tarfile` 生成两级归档，权限一次写对。
2. 后端已经从 Node 换成一个 Go 静态二进制（源码在 `server/`，包内路径
   `app/bin/ztmesh-server`）。这里用 `go build` 交叉编译，产物写进临时目录，
   绝不在源码树里留下二进制。

产物结构（与 fnOS 约定一致）
---------------------------
外层：gzip'd tar，成员为 `manifest`、`app.tgz`、`cmd/*`、`config/*`、`wizard/*`、
      `ICON.PNG`、`ICON_256.PNG`。
内层 `app.tgz`：`app/` 目录树的 gzip'd tar（成员名相对 `app/`，即 `ui/config`、
      `www/index.html`、`zt/zerotier-one`、`bin/ztmesh-server`）。

权限：目录 0755；`cmd/*`、`app/bin/ztmesh-server`、`app/zt/zerotier-one` 0755；其余 0644；
      所有成员 uid/gid=0、属主 root。

用法
----
    python pack.py            # 等价于 x86_64
    python pack.py x86_64     # -> ztmesh-x86_64.fpk（GOOS=linux GOARCH=amd64）
    python pack.py arm        # -> ztmesh-arm.fpk   （GOOS=linux GOARCH=arm64）

找不到可用的 Go 工具链时，回退使用预置二进制
`dl/ztmesh-server-<arch>`（`x86_64`/`arm` 或 `amd64`/`arm64` 两种命名都认）；
两者都没有则中文报错并以退出码 2 结束。
"""
import gzip
import hashlib
import io
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

#: 中文进度输出：强制 UTF-8，避免 Windows 控制台按 cp936 解码成乱码
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:  # pragma: no cover - 老版本 Python 没有 reconfigure
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'fpk')
APPSRC = os.path.join(SRC, 'app')
SERVER_SRC = os.path.join(HERE, 'server')
DL = os.path.join(HERE, 'dl')
MANIFEST = os.path.join(SRC, 'manifest')

#: 内置 ZeroTier 守护进程（源码树里恒为 x86-64 版本，arm 构建时临时替换）
ZT_BIN = os.path.join(APPSRC, 'zt', 'zerotier-one')
ARM_ZT_BIN = os.path.join(DL, 'zerotier-one.arm64')

#: 包内 Go 二进制路径（相对 app/）
SERVER_REL = 'bin/ztmesh-server'

DIR_MODE = 0o755
FILE_MODE = 0o644
EXEC_MODE = 0o755

#: 源码树里永远不打包的东西
SKIP_DIRS = {'__pycache__', '.git', '.idea', '.vscode'}
SKIP_FILES = {'.DS_Store', 'Thumbs.db'}

#: 平台 -> (GOARCH, manifest platform, ELF e_machine)
TARGETS = {
    'x86_64': ('amd64', 'x86', 62),
    'arm': ('arm64', 'arm', 183),
}

#: fnOS 外层归档里必须存在的骨架目录/文件
OUTER_DIRS = ('cmd', 'config', 'wizard')
OUTER_FILES = ('ICON.PNG', 'ICON_256.PNG')

#: cmd/ 下必须存在的生命周期脚本
REQUIRED_CMD = (
    'main',
    'install_init', 'install_callback',
    'upgrade_init', 'upgrade_callback',
    'uninstall_init', 'uninstall_callback',
    'config_init', 'config_callback',
)

PLATFORM = (sys.argv[1] if len(sys.argv) > 1 else 'x86_64').strip()
if PLATFORM not in TARGETS:
    sys.stderr.write('用法: python pack.py [x86_64|arm]\n')
    sys.exit(2)

GOARCH, MANIFEST_PLATFORM, ELF_MACHINE = TARGETS[PLATFORM]
FPK = os.path.join(HERE, 'ztmesh-%s.fpk' % PLATFORM)


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

def say(msg):
    print(msg, flush=True)


def fail(msg, code=1):
    sys.stderr.write('错误: %s\n' % msg)
    sys.exit(code)


def build_timestamp():
    """归档时间戳：可用 SOURCE_DATE_EPOCH 固定，便于复现构建。"""
    raw = os.environ.get('SOURCE_DATE_EPOCH')
    if raw:
        try:
            return max(0, int(raw))
        except ValueError:
            pass
    return int(time.time())


def elf_machine(payload):
    """返回 ELF 的 e_machine；不是 ELF 或读不出来时返回 None。"""
    if len(payload) < 20 or payload[:4] != b'\x7fELF':
        return None
    order = 'little' if payload[5] == 1 else 'big'
    return int.from_bytes(payload[18:20], order)


def md5_hex(payload):
    return hashlib.md5(payload).hexdigest()


def rel_to_here(path):
    """相对工作区的显示路径；跨盘符时 os.path.relpath 会抛 ValueError。"""
    try:
        return os.path.relpath(path, HERE)
    except ValueError:
        return path


# ---------------------------------------------------------------------------
# manifest
# ---------------------------------------------------------------------------

PLATFORM_RE = re.compile(r'^([ \t]*platform[ \t]*=[ \t]*)\S*', re.M)
CHECKSUM_RE = re.compile(r'^([ \t]*checksum[ \t]*=[ \t]*)\S*', re.M)


def read_manifest():
    with open(MANIFEST, 'rb') as fh:
        return fh.read().decode('utf-8', 'replace')


def write_manifest(text):
    with open(MANIFEST, 'wb') as fh:
        fh.write(text.encode('utf-8'))


def set_manifest_platform(plat):
    """把 fpk/manifest 的 platform 改成目标架构（构建结束后还原为 x86）。"""
    text = read_manifest()
    if PLATFORM_RE.search(text):
        text = PLATFORM_RE.sub(lambda m: m.group(1) + plat, text, count=1)
    else:
        if not text.endswith('\n'):
            text += '\n'
        text += 'platform=%s\n' % plat
    write_manifest(text)


def manifest_version():
    """读取 fpk/manifest 的 version，注入 Go 二进制的 -X main.version。"""
    m = re.search(r'^[ 	]*version[ 	]*=[ 	]*(\S+)', read_manifest(), re.M)
    return m.group(1) if m else '0.0.0'


def manifest_payload(digest):
    """返回要写进包里的 manifest 字节：platform=目标架构、checksum=md5(app.tgz)。"""
    text = read_manifest()
    if PLATFORM_RE.search(text):
        text = PLATFORM_RE.sub(lambda m: m.group(1) + MANIFEST_PLATFORM, text, count=1)
    else:
        if not text.endswith('\n'):
            text += '\n'
        text += 'platform=%s\n' % MANIFEST_PLATFORM

    if CHECKSUM_RE.search(text):
        text = CHECKSUM_RE.sub(lambda m: m.group(1) + digest, text, count=1)
    else:
        if not text.endswith('\n'):
            text += '\n'
        text += 'checksum              = %s\n' % digest
    return text.encode('utf-8')


# ---------------------------------------------------------------------------
# Go 交叉编译
# ---------------------------------------------------------------------------

def find_go():
    """返回可用的 go 可执行文件路径，找不到返回 None。"""
    candidates = [
        os.path.join(HERE, 'tools', 'go', 'bin', 'go.exe'),
        os.path.join(HERE, 'tools', 'go', 'bin', 'go'),
    ]
    which = shutil.which('go')
    if which:
        candidates.append(which)
    for exe in candidates:
        if not os.path.exists(exe):
            continue
        try:
            proc = subprocess.run([exe, 'version'], capture_output=True)
        except OSError:
            continue
        if proc.returncode == 0:
            ver = (proc.stdout or b'').decode('utf-8', 'replace').strip()
            say('>> 使用 Go 工具链: %s (%s)' % (exe, ver))
            return exe
    return None


def go_build(go, out_path):
    """交叉编译 Go 服务端到 out_path。"""
    if not os.path.isdir(SERVER_SRC):
        fail('找不到 Go 源码目录 server/（%s）' % SERVER_SRC, 2)
    env = os.environ.copy()
    env['GOOS'] = 'linux'
    env['GOARCH'] = GOARCH
    env['CGO_ENABLED'] = '0'
    # 离线环境：不允许 go 为了满足 go.mod 去下载新工具链
    env.setdefault('GOTOOLCHAIN', 'local')
    # 构建缓存与临时目录放在工作区内：某些环境（受限沙箱/只读 profile）不允许
    # go 在 %TEMP% 下自建 go-build* 工作目录，会报 "Access is denied"。
    build_home = os.path.join(HERE, '.gobuild')
    env.setdefault('GOCACHE', os.path.join(build_home, 'cache'))
    env.setdefault('GOTMPDIR', os.path.join(build_home, 'tmp'))
    for key in ('GOCACHE', 'GOTMPDIR'):
        try:
            os.makedirs(env[key], exist_ok=True)
        except OSError as exc:
            fail('无法创建 %s 目录 %s: %s' % (key, env[key], exc))
    # 版本号只写在 manifest 一处：这里把它注入二进制，避免后端自报的版本与包版本不一致。
    ldflags = '-s -w -X main.version=%s' % manifest_version()
    cmd = [go, 'build', '-trimpath', '-buildvcs=false',
           '-ldflags', ldflags, '-o', out_path, '.']
    say('>> 交叉编译服务端: GOOS=linux GOARCH=%s CGO_ENABLED=0' % GOARCH)
    proc = subprocess.run(cmd, cwd=SERVER_SRC, env=env, capture_output=True)
    out = (proc.stdout or b'').decode('utf-8', 'replace').strip()
    err = (proc.stderr or b'').decode('utf-8', 'replace').strip()
    if out:
        say(out)
    if proc.returncode != 0:
        if err:
            sys.stderr.write(err + '\n')
        fail('go build 失败（返回码 %s）' % proc.returncode)
    if err:
        say(err)
    if not os.path.exists(out_path):
        fail('go build 未产出 %s' % out_path)


def fallback_binary():
    """go 不可用时的预置二进制：dl/ztmesh-server-<arch>。"""
    for arch in (PLATFORM, GOARCH):
        cand = os.path.join(DL, 'ztmesh-server-%s' % arch)
        if os.path.exists(cand):
            return cand
    return None


def stage_server_binary(staging_dir):
    """把 ztmesh-server 放到临时 staging 的 app/bin/ 下，返回其路径。"""
    bin_dir = os.path.join(staging_dir, 'app', 'bin')
    os.makedirs(bin_dir, exist_ok=True)
    out = os.path.join(bin_dir, 'ztmesh-server')

    go = find_go()
    if go:
        go_build(go, out)
        say('>> 编译完成: %s (%d 字节)' % (SERVER_REL, os.path.getsize(out)))
    else:
        pre = fallback_binary()
        if not pre:
            fail('未找到可用的 Go 工具链，也没有预置二进制 dl/ztmesh-server-%s。\n'
                 '       请安装 Go 1.21+（或把 go 放到 tools/go/bin/），'
                 '或放置预编译的 dl/ztmesh-server-%s / dl/ztmesh-server-%s。'
                 % (PLATFORM, PLATFORM, GOARCH), 2)
        shutil.copy2(pre, out)
        say('>> Go 不可用，回退使用预置二进制: %s' % pre)

    with open(out, 'rb') as fh:
        head = fh.read(20)
    machine = elf_machine(head)
    if machine is None:
        fail('%s 不是 ELF 可执行文件（期望 linux/%s 静态二进制）' % (SERVER_REL, GOARCH))
    if machine != ELF_MACHINE:
        fail('%s 架构不匹配：e_machine=%d，期望 %d（%s）'
             % (SERVER_REL, machine, ELF_MACHINE, PLATFORM))
    say('>> 架构校验通过: %s e_machine=%d (%s)' % (SERVER_REL, machine, PLATFORM))
    return out


# ---------------------------------------------------------------------------
# tar 构建
# ---------------------------------------------------------------------------

def member_mode(arcname, is_dir):
    if is_dir:
        return DIR_MODE
    name = arcname.rstrip('/')
    if name.startswith('cmd/'):
        return EXEC_MODE
    if name in (SERVER_REL, 'zt/zerotier-one'):
        return EXEC_MODE
    return FILE_MODE


def add_bytes(tar, arcname, payload, mode, mtime):
    info = tarfile.TarInfo(arcname)
    info.type = tarfile.REGTYPE
    info.mode = mode
    info.uid = 0
    info.gid = 0
    info.uname = 'root'
    info.gname = 'root'
    info.mtime = mtime
    info.size = len(payload)
    tar.addfile(info, io.BytesIO(payload))


def add_dir(tar, arcname, mtime):
    info = tarfile.TarInfo(arcname if arcname.endswith('/') else arcname + '/')
    info.type = tarfile.DIRTYPE
    info.mode = DIR_MODE
    info.uid = 0
    info.gid = 0
    info.uname = 'root'
    info.gname = 'root'
    info.mtime = mtime
    info.size = 0
    tar.addfile(info)


def open_gz_sink(target, mtime):
    """target 可以是路径或二进制文件对象；返回 (tarfile 对象, gzip 对象)。"""
    if isinstance(target, str):
        raw = open(target, 'wb')
        close_raw = True
    else:
        raw = target
        close_raw = False
    gz = gzip.GzipFile(filename='', fileobj=raw, mode='wb',
                       compresslevel=9, mtime=mtime)
    tar = tarfile.open(fileobj=gz, mode='w', format=tarfile.GNU_FORMAT)
    return tar, gz, raw, close_raw


def close_gz_sink(tar, gz, raw, close_raw):
    tar.close()
    gz.close()
    if close_raw:
        raw.close()


def collect_app_tree(staged_bin):
    """收集 app/ 树的归档成员：[(arcname, is_dir, path or bytes)]。"""
    entries = []
    if not os.path.isdir(APPSRC):
        fail('找不到应用目录 fpk/app（%s）' % APPSRC)
    for root, dirs, files in os.walk(APPSRC):
        # 源码树里的 app/bin 是构建残留，一律忽略，二进制从 staging 注入
        if os.path.abspath(root) == os.path.abspath(APPSRC):
            dirs[:] = [d for d in dirs if d != 'bin']
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        rel_root = os.path.relpath(root, APPSRC).replace(os.sep, '/')
        if rel_root == '.':
            rel_root = ''
        if rel_root:
            entries.append((rel_root + '/', True, None))
        for name in sorted(files):
            if name in SKIP_FILES:
                continue
            rel = (rel_root + '/' + name) if rel_root else name
            entries.append((rel, False, os.path.join(root, name)))

    # 注入 Go 服务端二进制
    entries.append(('bin/', True, None))
    entries.append((SERVER_REL, False, staged_bin))
    return entries


def build_app_tgz(staged_bin, mtime):
    """生成 app.tgz 字节。"""
    entries = collect_app_tree(staged_bin)
    buf = io.BytesIO()
    tar, gz, raw, close_raw = open_gz_sink(buf, mtime)
    try:
        for arcname, is_dir, path in entries:
            if is_dir:
                add_dir(tar, arcname, mtime)
                continue
            with open(path, 'rb') as fh:
                payload = fh.read()
            add_bytes(tar, arcname, payload, member_mode(arcname, False), mtime)
    finally:
        close_gz_sink(tar, gz, raw, close_raw)
    return buf.getvalue()


def collect_outer():
    """外层归档的静态成员（manifest 与 app.tgz 由调用方单独处理）。"""
    entries = []
    for d in OUTER_DIRS:
        base = os.path.join(SRC, d)
        if not os.path.isdir(base):
            fail('缺少包骨架目录 fpk/%s' % d)
        for root, dirs, files in os.walk(base):
            dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
            rel_root = os.path.relpath(root, SRC).replace(os.sep, '/')
            entries.append((rel_root + '/', True, None))
            for name in sorted(files):
                if name in SKIP_FILES:
                    continue
                entries.append((rel_root + '/' + name, False, os.path.join(root, name)))
    for name in OUTER_FILES:
        path = os.path.join(SRC, name)
        if not os.path.exists(path):
            fail('缺少包图标 fpk/%s' % name)
        entries.append((name, False, path))
    return entries


def verify_skeleton():
    for name in REQUIRED_CMD:
        if not os.path.exists(os.path.join(SRC, 'cmd', name)):
            fail('缺少生命周期脚本 fpk/cmd/%s' % name)
    if not os.path.exists(MANIFEST):
        fail('缺少 fpk/manifest')
    if not os.path.exists(ZT_BIN):
        fail('缺少 ZeroTier 守护进程 fpk/app/zt/zerotier-one')
    # 2.0 之后后端是 Go 二进制，旧的 Node 后端目录不应再进包
    legacy = os.path.join(APPSRC, 'server')
    if os.path.isdir(legacy):
        say('>> 警告: 检测到遗留的 Node 后端目录 fpk/app/server/，它会被一起打进包；'
            '2.0 起应已删除')


def swap_arm_zerotier():
    """arm 构建：若 dl/zerotier-one.arm64 存在则替换，返回还原函数。"""
    if PLATFORM != 'arm':
        return lambda: None
    if not os.path.exists(ARM_ZT_BIN):
        fail('未找到 arm64 版 ZeroTier 守护进程 %s。\n'
             '       请下载 zerotier-one_*_arm64.deb 并把 usr/sbin/zerotier-one 解出为 dl/zerotier-one.arm64；'
             '否则 arm 包里会混进 x86-64 版守护进程，装上跑不起来。'
             % rel_to_here(ARM_ZT_BIN), 2)

    with open(ARM_ZT_BIN, 'rb') as fh:
        arm_machine = elf_machine(fh.read(20))
    if arm_machine != ELF_MACHINE:
        fail('%s 不是 arm64 可执行文件（e_machine=%s，期望 %d）'
             % (rel_to_here(ARM_ZT_BIN), arm_machine, ELF_MACHINE))

    backup = os.path.join(DL, 'zerotier-one.x86-backup')
    shutil.copy2(ZT_BIN, backup)
    shutil.copy2(ARM_ZT_BIN, ZT_BIN)
    say('>> arm 构建: 已用 dl/zerotier-one.arm64 替换 zt/zerotier-one')

    def restore():
        if os.path.exists(backup):
            shutil.copy2(backup, ZT_BIN)
            os.remove(backup)
            say('>> 已还原源码树中的 x86-64 版 zt/zerotier-one')

    return restore


def build_fpk(staged_bin, mtime):
    app_tgz = build_app_tgz(staged_bin, mtime)
    digest = md5_hex(app_tgz)
    say('>> app.tgz 已生成: %d 字节, md5=%s' % (len(app_tgz), digest))

    manifest_bytes = manifest_payload(digest)
    outer = collect_outer()

    tmp_out = FPK + '.tmp'
    try:
        tar, gz, raw, close_raw = open_gz_sink(tmp_out, mtime)
        try:
            add_bytes(tar, 'manifest', manifest_bytes, FILE_MODE, mtime)
            add_bytes(tar, 'app.tgz', app_tgz, FILE_MODE, mtime)
            for arcname, is_dir, path in outer:
                if is_dir:
                    add_dir(tar, arcname, mtime)
                    continue
                with open(path, 'rb') as fh:
                    payload = fh.read()
                add_bytes(tar, arcname, payload, member_mode(arcname, False), mtime)
        finally:
            close_gz_sink(tar, gz, raw, close_raw)

        if os.path.exists(FPK):
            os.remove(FPK)
        os.replace(tmp_out, FPK)
    except BaseException:
        # 失败时不留半成品
        if os.path.exists(tmp_out):
            try:
                os.remove(tmp_out)
            except OSError:
                pass
        raise
    return app_tgz, digest


def self_check(app_tgz, digest):
    """重新打开产物，核对结构、权限与 checksum。"""
    with tarfile.open(FPK, 'r:gz') as t:
        names = [m.name for m in t.getmembers()]
        for required in ('manifest', 'app.tgz'):
            if required not in names:
                fail('产物缺少 %s' % required)

        packed_app = t.extractfile('app.tgz').read()
        if md5_hex(packed_app) != digest:
            fail('app.tgz 落盘后 md5 变化（期望 %s）' % digest)

        declared = None
        found = CHECKSUM_RE.search(
            t.extractfile('manifest').read().decode('utf-8', 'replace'))
        if found:
            declared = found.group(0).split('=', 1)[1].strip()
        if declared != digest:
            fail('manifest.checksum=%s 与 md5(app.tgz)=%s 不一致' % (declared, digest))

        bad = []
        for m in t.getmembers():
            want = DIR_MODE if m.isdir() else member_mode(m.name, False)
            if m.mode != want:
                bad.append('%s %s!=%s' % (m.name, oct(m.mode), oct(want)))
            if m.uid != 0 or m.gid != 0:
                bad.append('%s uid/gid=%d/%d' % (m.name, m.uid, m.gid))
        if bad:
            fail('外层权限/属主异常: ' + '; '.join(bad[:8]))

        say('')
        say('=== 外层归档 (manifest / app.tgz / cmd / config / wizard / ICON) ===')
        for m in t.getmembers():
            say('  %s %9d %s' % (oct(m.mode), m.size, m.name))

        say('')
        say('=== app.tgz (包内 app/ 树) ===')
        with tarfile.open(fileobj=io.BytesIO(packed_app), mode='r:gz') as a:
            inner_bad = []
            for m in a.getmembers():
                want = DIR_MODE if m.isdir() else member_mode(m.name, False)
                if m.mode != want:
                    inner_bad.append('%s %s!=%s' % (m.name, oct(m.mode), oct(want)))
                say('  %s %9d %s' % (oct(m.mode), m.size, m.name))
            if inner_bad:
                fail('app.tgz 权限异常: ' + '; '.join(inner_bad[:8]))
            if SERVER_REL not in [m.name for m in a.getmembers()]:
                fail('app.tgz 缺少 %s' % SERVER_REL)
            # 两个二进制都必须是目标架构（防止 arm 包混进 x86 守护进程）
            for name in (SERVER_REL, 'zt/zerotier-one'):
                member = a.getmember(name)
                machine = elf_machine(a.extractfile(member).read(20))
                if machine != ELF_MACHINE:
                    fail('app.tgz 里 %s 架构不匹配：e_machine=%s，期望 %d（%s）'
                         % (name, machine, ELF_MACHINE, PLATFORM))
                say('>> 架构校验通过: %s e_machine=%d' % (name, machine))

    say('')
    say('>> 校验通过: manifest.checksum == md5(app.tgz) == %s' % digest)


def main():
    say('>> 目标平台: %s (linux/%s, manifest platform=%s)'
        % (PLATFORM, GOARCH, MANIFEST_PLATFORM))
    verify_skeleton()

    mtime = build_timestamp()
    # staging 放在工作区的 .gobuild/ 下（已 gitignore）：某些受限环境不允许
    # go 往 %TEMP% 写可执行文件，且这样也不会污染源码树。
    build_home = os.path.join(HERE, '.gobuild')
    os.makedirs(build_home, exist_ok=True)
    staging = tempfile.mkdtemp(prefix='staging-', dir=build_home)
    restore_zt = lambda: None
    try:
        staged_bin = stage_server_binary(staging)
        restore_zt = swap_arm_zerotier()
        set_manifest_platform(MANIFEST_PLATFORM)
        app_tgz, digest = build_fpk(staged_bin, mtime)
        self_check(app_tgz, digest)
        say('>> 完成: %s (%d 字节)' % (os.path.basename(FPK), os.path.getsize(FPK)))
    finally:
        try:
            restore_zt()
        finally:
            # 源码树保持 canonical：manifest 还原为 platform=x86
            try:
                set_manifest_platform('x86')
            except Exception as exc:  # pragma: no cover - 还原失败要显眼
                sys.stderr.write('警告: 还原 fpk/manifest 失败: %s\n' % exc)
            shutil.rmtree(staging, ignore_errors=True)


if __name__ == '__main__':
    main()
