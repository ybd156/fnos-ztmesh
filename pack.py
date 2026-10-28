#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 ./fpk 打包成 .fpk 安装包（纯 Python，不依赖 fnpack.exe）。

为什么自己打
------------
1. `fnpack.exe` 只能在 Windows 上跑，而且早期版本写出来的 tar 成员权限全是 0666：
   `cmd/*` 不可执行、`zt/zerotier-one` 不可执行，装到 fnOS 上守护进程根本起不来。
   直接用标准库 `tarfile` 生成两级归档，权限一次写对。
2. 后端已经从 Node 换成一个 Go 静态二进制（源码在 `server/`，包内路径
   `app/bin/ztmesh-server`）。这里用 `go build` 交叉编译，产物写进临时 staging，
   绝不在源码树里留下二进制。

产物结构（与 fnOS 约定一致）
---------------------------
外层：gzip'd tar，成员为 `manifest`、`app.tgz`、`cmd/*`、`config/*`、`wizard/*`、
      `ICON.PNG`、`ICON_256.PNG`。
内层 `app.tgz`：`app/` 目录树的 gzip'd tar（成员名相对 `app/`，即 `ui/config`、
      `www/index.html`、`zt/zerotier-one`、`bin/ztmesh-server`）。

单包多架构
----------
`python pack.py` 只生成 **`ztmesh-all.fpk`**，manifest 写 `platform=all`，
包内同时带两套二进制，安装时由 `cmd/install_callback` 按 `uname -m` 链接：

    bin/ztmesh-server-amd64        zt/zerotier-one-x86_64
    bin/ztmesh-server-arm64        zt/zerotier-one-aarch64

一个包通吃两种架构，不再区分 x86 / arm 安装包。

arm64 守护进程从哪来
--------------------
仓库里只放了 x86-64 版 `fpk/app/zt/zerotier-one`。arm 需要
`dl/zerotier-one.arm64`，用 `python scripts/fetch_zerotier_arm.py` 从官方 deb
里取一份（一次性，约 10MB，`dl/` 不进仓库）。

权限：目录 0755；`cmd/*`、`bin/ztmesh-server*`、`zt/zerotier-one*` 0755；其余 0644；
      所有成员 uid/gid=0、属主 root。
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

#: 源码树里恒为 x86-64 的守护进程；arm64 的从 dl/ 取
ZT_CORE_X86 = os.path.join(APPSRC, 'zt', 'zerotier-one')
ZT_CORE_ARM = os.path.join(DL, 'zerotier-one.arm64')

#: 包内 Go 二进制路径（相对 app/）
SERVER_REL = 'bin/ztmesh-server'

DIR_MODE = 0o755
FILE_MODE = 0o644
EXEC_MODE = 0o755

#: 源码树里永远不打包的东西
SKIP_DIRS = {'__pycache__', '.git', '.idea', '.vscode'}
SKIP_FILES = {'.DS_Store', 'Thumbs.db'}

#: 架构元组: (GOARCH, ELF e_machine, 包内后缀)
ARCH_AMD64 = ('amd64', 62, 'x86_64')
ARCH_ARM64 = ('arm64', 183, 'aarch64')

#: 只出单包多架构：一个 .fpk 同时带 x86-64 与 arm64 两套二进制
ARCHES = [ARCH_AMD64, ARCH_ARM64]
MANIFEST_PLATFORM = 'all'
FPK_NAME = 'ztmesh-all.fpk'

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

if len(sys.argv) > 1:
    sys.stderr.write('用法: python pack.py    （只构建 ztmesh-all.fpk：一个包同时支持 x86-64 与 arm64）\n')
    sys.exit(2)

FPK = os.path.join(HERE, FPK_NAME)


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


def manifest_version():
    """读取 fpk/manifest 的 version，注入 Go 二进制的 -X main.version。"""
    m = re.search(r'^[ \t]*version[ \t]*=[ \t]*(\S+)', read_manifest(), re.M)
    return m.group(1) if m else '0.0.0'


def manifest_payload(digest, platform):
    """返回要写进包里的 manifest 字节：platform=目标架构、checksum=md5(app.tgz)。

    源码树里的 fpk/manifest 不会被改写（它始终保持 platform=all 的 canonical 状态）。
    """
    text = read_manifest()
    if PLATFORM_RE.search(text):
        text = PLATFORM_RE.sub(lambda m: m.group(1) + platform, text, count=1)
    else:
        if not text.endswith('\n'):
            text += '\n'
        text += 'platform=%s\n' % platform

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


def go_build(go, out_path, goarch):
    """交叉编译 Go 服务端到 out_path。"""
    if not os.path.isdir(SERVER_SRC):
        fail('找不到 Go 源码目录 server/（%s）' % SERVER_SRC, 2)
    env = os.environ.copy()
    env['GOOS'] = 'linux'
    env['GOARCH'] = goarch
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
    # 版本号只在 manifest 维护一处：注入二进制，避免后端自报版本与包版本不一致
    ldflags = '-s -w -X main.version=%s' % manifest_version()
    cmd = [go, 'build', '-trimpath', '-buildvcs=false',
           '-ldflags', ldflags, '-o', out_path, '.']
    say('>> 交叉编译服务端: GOOS=linux GOARCH=%s CGO_ENABLED=0' % goarch)
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


def fallback_binary(goarch):
    """go 不可用时的预置二进制：dl/ztmesh-server-<arch>。"""
    for arch in (goarch, 'x86_64' if goarch == 'amd64' else 'arm'):
        cand = os.path.join(DL, 'ztmesh-server-%s' % arch)
        if os.path.exists(cand):
            return cand
    return None


def build_server_binary(out_path, goarch, machine):
    """产出并校验一个 Go 二进制。"""
    go = find_go()
    if go:
        go_build(go, out_path, goarch)
        say('>> 编译完成: %s (%d 字节)' % (os.path.basename(out_path), os.path.getsize(out_path)))
    else:
        pre = fallback_binary(goarch)
        if not pre:
            fail('未找到可用的 Go 工具链，也没有预置二进制 dl/ztmesh-server-%s。\n'
                 '       请安装 Go 1.21+（或把 go 放到 tools/go/bin/）。' % goarch, 2)
        shutil.copy2(pre, out_path)
        say('>> Go 不可用，回退使用预置二进制: %s' % pre)

    with open(out_path, 'rb') as fh:
        got = elf_machine(fh.read(20))
    if got is None:
        fail('%s 不是 ELF 可执行文件（期望 linux/%s 静态二进制）'
             % (os.path.basename(out_path), goarch))
    if got != machine:
        fail('%s 架构不匹配：e_machine=%d，期望 %d（%s）'
             % (os.path.basename(out_path), got, machine, goarch))
    say('>> 架构校验通过: %s e_machine=%d (%s)'
        % (os.path.basename(out_path), got, goarch))


# ---------------------------------------------------------------------------
# tar 构建
# ---------------------------------------------------------------------------

def member_mode(arcname, is_dir):
    if is_dir:
        return DIR_MODE
    name = arcname.rstrip('/')
    if name.startswith('cmd/'):
        return EXEC_MODE
    base = name.rsplit('/', 1)[-1]
    if base.startswith('ztmesh-server') or base.startswith('zerotier-one'):
        return EXEC_MODE
    return FILE_MODE


def normalize_payload(payload):
    """文本成员统一成 LF。

    为什么必须在打包时做：在 Windows 上编辑过的 `cmd/main` 会带 CRLF，写进包后
    Linux 上 shebang 变成 `#!/bin/bash^M`，直接报
    "bad interpreter: No such file or directory"，整个应用起不来。
    二进制（ELF/PNG）里含 NUL 字节，据此区分，不会被误伤。
    """
    if b"\x00" in payload[:4096]:
        return payload
    return payload.replace(b"\r\n", b"\n")


def read_member(path):
    with open(path, 'rb') as fh:
        return normalize_payload(fh.read())


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


def stage_app_tree(staging, goarch_pairs):
    """把 app/ 树复制到 staging，并按目标架构放入二进制。

    goarch_pairs: [(goarch, machine, tag)]；单架构时用不带后缀的名字。
    返回 staging/app 路径。
    """
    app_root = os.path.join(staging, 'app')
    if not os.path.isdir(APPSRC):
        fail('找不到应用目录 fpk/app（%s）' % APPSRC)

    # 复制除 bin/ 与守护进程之外的整棵树（守护进程按架构单独放）
    def ignore(dirpath, names):
        skipped = set()
        for name in names:
            if name in SKIP_DIRS or name in SKIP_FILES:
                skipped.add(name)
        if os.path.abspath(dirpath) == os.path.abspath(APPSRC):
            if 'bin' in names:
                skipped.add('bin')
        if os.path.abspath(dirpath) == os.path.abspath(os.path.join(APPSRC, 'zt')):
            for name in names:
                if name.startswith('zerotier-one'):
                    skipped.add(name)
        return skipped

    shutil.copytree(APPSRC, app_root, ignore=ignore)
    bin_dir = os.path.join(app_root, 'bin')
    zt_dir = os.path.join(app_root, 'zt')
    os.makedirs(bin_dir, exist_ok=True)
    os.makedirs(zt_dir, exist_ok=True)

    for goarch, machine, tag in goarch_pairs:
        suffix = '-' + goarch
        server_out = os.path.join(bin_dir, 'ztmesh-server' + suffix)
        build_server_binary(server_out, goarch, machine)

        core_src = ZT_CORE_X86 if goarch == 'amd64' else ZT_CORE_ARM
        if not os.path.exists(core_src):
            if goarch == 'arm64':
                fail('未找到 arm64 版 ZeroTier 守护进程 %s。\n'
                     '       先执行 python scripts/fetch_zerotier_arm.py'
                     % rel_to_here(core_src), 2)
            fail('未找到 ZeroTier 守护进程 %s' % rel_to_here(core_src), 2)
        with open(core_src, 'rb') as fh:
            got = elf_machine(fh.read(20))
        if got != machine:
            fail('%s 架构不匹配（e_machine=%s，期望 %d）'
                 % (rel_to_here(core_src), got, machine))
        core_suffix = '-' + tag
        shutil.copy2(core_src, os.path.join(zt_dir, 'zerotier-one' + core_suffix))
        say('>> 放入守护进程: zt/zerotier-one%s (%s, e_machine=%d)'
            % (core_suffix, tag, got))

    return app_root


def build_app_tgz(app_root, mtime):
    """把 staging 里的 app/ 树打成 app.tgz 字节。"""
    buf = io.BytesIO()
    tar, gz, raw, close_raw = open_gz_sink(buf, mtime)
    try:
        entries = []
        for root, dirs, files in os.walk(app_root):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
            rel_root = os.path.relpath(root, app_root).replace(os.sep, '/')
            if rel_root == '.':
                rel_root = ''
            if rel_root:
                entries.append((rel_root + '/', True, None))
            for name in sorted(files):
                if name in SKIP_FILES:
                    continue
                rel = (rel_root + '/' + name) if rel_root else name
                entries.append((rel, False, os.path.join(root, name)))

        for arcname, is_dir, path in entries:
            if is_dir:
                add_dir(tar, arcname, mtime)
                continue
            add_bytes(tar, arcname, read_member(path), member_mode(arcname, False), mtime)
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
    if not os.path.exists(ZT_CORE_X86):
        fail('缺少 ZeroTier 守护进程 fpk/app/zt/zerotier-one')
    legacy = os.path.join(APPSRC, 'server')
    if os.path.isdir(legacy):
        say('>> 警告: 检测到遗留的 Node 后端目录 fpk/app/server/，它会被一起打进包；'
            '2.0 起应已删除')


# ---------------------------------------------------------------------------
# 组装
# ---------------------------------------------------------------------------

def build_fpk(app_tgz, mtime):
    digest = md5_hex(app_tgz)
    say('>> app.tgz 已生成: %d 字节, md5=%s' % (len(app_tgz), digest))

    manifest_bytes = normalize_payload(manifest_payload(digest, MANIFEST_PLATFORM))
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
                add_bytes(tar, arcname, read_member(path), member_mode(arcname, False), mtime)
        finally:
            close_gz_sink(tar, gz, raw, close_raw)

        if os.path.exists(FPK):
            os.remove(FPK)
        os.replace(tmp_out, FPK)
    except BaseException:
        if os.path.exists(tmp_out):
            try:
                os.remove(tmp_out)
            except OSError:
                pass
        raise
    return digest


def self_check(app_tgz, digest):
    """重新打开产物，核对结构、权限、checksum 与两个二进制的架构。"""
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

        # 生命周期脚本必须是 LF：CRLF 会让 shebang 失效
        for m in t.getmembers():
            if m.isdir() or not (m.name.startswith('cmd/') or m.name == 'manifest'):
                continue
            if bytes([13]) in t.extractfile(m).read():
                fail('%s 里含 CR（CRLF），Linux 上 shebang 会失效' % m.name)

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

            inner_names = [m.name for m in a.getmembers()]
            for goarch, machine, tag in ARCHES:
                server_rel = '%s-%s' % (SERVER_REL, goarch)
                core_rel = 'zt/zerotier-one-%s' % tag
                for rel in (server_rel, core_rel):
                    if rel not in inner_names:
                        fail('app.tgz 缺少 %s' % rel)
                    got = elf_machine(a.extractfile(a.getmember(rel)).read(20))
                    if got != machine:
                        fail('app.tgz 里 %s 架构不匹配：e_machine=%s，期望 %d（%s）'
                             % (rel, got, machine, goarch))
                    say('>> 架构校验通过: %s e_machine=%d (%s)' % (rel, got, goarch))

    say('')
    say('>> 校验通过: manifest.checksum == md5(app.tgz) == %s' % digest)


def main():
    say('>> 目标: 单包多架构 (manifest platform=%s, 架构: %s)'
        % (MANIFEST_PLATFORM, ', '.join(a[0] for a in ARCHES)))
    verify_skeleton()

    mtime = build_timestamp()
    # staging 放在工作区的 .gobuild/ 下（已 gitignore）：某些受限环境不允许
    # go 往 %TEMP% 写可执行文件，且这样也不会污染源码树。
    build_home = os.path.join(HERE, '.gobuild')
    os.makedirs(build_home, exist_ok=True)
    staging = tempfile.mkdtemp(prefix='staging-', dir=build_home)
    try:
        app_root = stage_app_tree(staging, ARCHES)
        app_tgz = build_app_tgz(app_root, mtime)
        digest = build_fpk(app_tgz, mtime)
        self_check(app_tgz, digest)
        say('>> 完成: %s (%d 字节)' % (os.path.basename(FPK), os.path.getsize(FPK)))
    finally:
        shutil.rmtree(staging, ignore_errors=True)


if __name__ == '__main__':
    main()
