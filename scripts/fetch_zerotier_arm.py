#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""下载并解出 arm64 版 ZeroTier 守护进程到 dl/zerotier-one.arm64。

`pack.py arm` 需要一个 arm64 的 zerotier-one；仓库里只放了 x86-64 版本（
fpk/app/zt/zerotier-one），arm 构建时由本脚本准备好 dl/zerotier-one.arm64。

为什么不用 dpkg-deb / ar / xz 命令
--------------------------------
这些工具在 Windows 上通常没有，而 .deb 就是 ar 归档 + data.tar.xz，
Python 标准库（tarfile + lzma）足够解析，脚本因此在任何平台都能跑。

用法：
    python scripts/fetch_zerotier_arm.py            # 默认 1.16.2
    python scripts/fetch_zerotier_arm.py 1.16.2
"""
import io
import lzma  # noqa: F401  (tarfile 通过它支持 .tar.xz)
import os
import re
import sys
import tarfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DL = os.path.join(ROOT, 'dl')
DEST = os.path.join(DL, 'zerotier-one.arm64')

DEFAULT_VERSION = '1.16.2'
URL_TEMPLATE = ('https://download.zerotier.com/RELEASES/{v}/dist/debian/bookworm/'
                'zerotier-one_{v}_arm64.deb')


def parse_ar(raw):
    """返回 ar 归档里各成员 (name, bytes)。"""
    if raw[:8] != b'!<arch>\n':
        raise SystemExit('不是 ar 归档，文件可能下载不完整')
    off = 8
    members = []
    while off + 60 <= len(raw):
        hdr = raw[off:off + 60]
        name = hdr[0:16].decode('utf-8', 'replace').strip().rstrip('/')
        size = int((hdr[48:58].decode('ascii', 'replace').strip() or '0'))
        members.append((name, raw[off + 60:off + 60 + size]))
        off += 60 + size + (size % 2)
    return members


def main():
    version = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_VERSION
    url = URL_TEMPLATE.format(v=version)
    os.makedirs(DL, exist_ok=True)
    print('>> 下载 %s' % url)
    req = urllib.request.Request(url, headers={'User-Agent': 'fnos-ztmesh-pack'})
    with urllib.request.urlopen(req, timeout=300) as resp:
        raw = resp.read()
    print('>> deb 大小 %d 字节' % len(raw))

    data = None
    for name, payload in parse_ar(raw):
        if name.startswith('data.tar'):
            data = payload
            print('>> 使用成员 %s' % name)
    if data is None:
        raise SystemExit('deb 里没有 data.tar.*')

    with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as tf:
        target = next((m for m in tf.getmembers() if m.name.endswith('sbin/zerotier-one')), None)
        if target is None:
            raise SystemExit('deb 里没有 usr/sbin/zerotier-one')
        payload = tf.extractfile(target).read()

    if payload[:4] != b'\x7fELF':
        raise SystemExit('解出的文件不是 ELF')
    machine = int.from_bytes(payload[18:20], 'little')
    if machine != 183:
        raise SystemExit('架构不对：e_machine=%d（期望 183 = aarch64）' % machine)

    with open(DEST, 'wb') as fh:
        fh.write(payload)
    os.chmod(DEST, 0o755)
    versions = sorted(set(m.decode() for m in re.findall(rb'1\.1[0-9]\.[0-9]+', payload)))
    print('>> 已写出 %s（%d 字节，aarch64，内嵌版本串 %s）'
          % (os.path.relpath(DEST, ROOT), len(payload), ', '.join(versions)))
    print('>> 现在可以执行： python pack.py arm')


if __name__ == '__main__':
    main()
