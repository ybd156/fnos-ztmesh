#!/usr/bin/env python3
"""Build ztmesh.fpk from ./fpk and repair POSIX permission bits.

Why this exists
---------------
`fnpack.exe` on Windows cannot store UNIX mode bits: every file it packs is
written as mode 0666. That leaves `cmd/*` non-executable and, fatally, leaves
`app/zt/zerotier-one` non-executable, so the daemon could never start on fnOS.

The .fpk produced by fnpack is a gzip'd tar whose members are the package
skeleton plus a nested `app.tgz` holding the whole `app/` tree. This script
runs fnpack and then rewrites BOTH archives with correct modes:

  * directories                     -> 0755
  * cmd/* lifecycle scripts         -> 0755
  * app/zt/zerotier-one             -> 0755
  * everything else                 -> 0644

Usage:  python pack.py
"""
import hashlib
import io
import os
import re
import subprocess
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
FNPACK = os.path.join(HERE, 'tools', 'fnpack.exe')
SRC = os.path.join(HERE, 'fpk')
FPK = os.path.join(HERE, 'ztmesh.fpk')

#: basenames that must be executable after installation
EXEC_NAMES = {
    'zerotier-one',
    'main',
    'install_init', 'install_callback',
    'upgrade_init', 'upgrade_callback',
    'uninstall_init', 'uninstall_callback',
    'config_init', 'config_callback',
}

DIR_MODE = 0o755
FILE_MODE = 0o644
EXEC_MODE = 0o755


def wanted_mode(member):
    """Correct mode for a tar member, given fnpack wrote 0666/0777."""
    if member.isdir():
        return DIR_MODE
    if member.issym() or member.islnk():
        return 0o777
    if os.path.basename(member.name.rstrip('/')) in EXEC_NAMES:
        return EXEC_MODE
    return FILE_MODE


def emit(dst, src, member):
    """Copy one member from src into dst with a corrected mode."""
    m = tarfile.TarInfo(member.name)
    m.type = member.type
    m.mode = wanted_mode(member)
    m.uid = 0
    m.gid = 0
    m.uname = 'root'
    m.gname = 'root'
    m.mtime = member.mtime

    if member.issym() or member.islnk():
        m.linkname = member.linkname
        m.size = 0
        dst.addfile(m)
        return
    if member.isdir():
        m.size = 0
        dst.addfile(m)
        return

    handle = src.extractfile(member)
    payload = handle.read() if handle is not None else b''
    m.size = len(payload)
    dst.addfile(m, io.BytesIO(payload))


def fix_inner_app_tgz(raw):
    """Rewrite the nested app/ archive with corrected modes."""
    out = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as src, \
            tarfile.open(fileobj=out, mode='w:gz', compresslevel=9) as dst:
        for member in src.getmembers():
            emit(dst, src, member)
    return out.getvalue()


#: fnpack records md5(app.tgz) as `checksum = <hex>` in the manifest.
CHECKSUM_RE = re.compile(rb'(^[ \t]*checksum[ \t]*=[ \t]*)\S*', re.M)


def set_checksum(payload, digest):
    """Point manifest.checksum at the digest of the archive we actually ship.

    Repacking app.tgz to repair its modes changes its bytes, which invalidates
    the digest fnpack computed from the original. Leaving the stale value in
    place risks an integrity failure at install time.
    """
    new = CHECKSUM_RE.sub(lambda m: m.group(1) + digest.encode('ascii'), payload, count=1)
    if new == payload and not CHECKSUM_RE.search(payload):
        if not payload.endswith(b'\n'):
            payload += b'\n'
        new = payload + b'checksum              = ' + digest.encode('ascii') + b'\n'
    return new


def add_file(dst, name, mode, mtime, payload):
    m = tarfile.TarInfo(name)
    m.type = tarfile.REGTYPE
    m.mode = mode
    m.uid = 0
    m.gid = 0
    m.uname = 'root'
    m.gname = 'root'
    m.mtime = mtime
    m.size = len(payload)
    dst.addfile(m, io.BytesIO(payload))


def repack_fpk(raw):
    """Rewrite the outer archive, fixing modes and the nested app.tgz."""
    src = tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz')
    members = src.getmembers()

    # Pre-pass: the manifest must carry the digest of app.tgz's FINAL bytes,
    # and the manifest is written after app.tgz in the archive, so rebuild the
    # nested archive before emitting anything.
    new_app = None
    for member in members:
        if member.isreg() and member.name == 'app.tgz':
            new_app = fix_inner_app_tgz(src.extractfile(member).read())
    if new_app is None:
        sys.exit('app.tgz not found in the archive fnpack produced')
    digest = hashlib.md5(new_app).hexdigest()

    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w:gz', compresslevel=9) as dst:
        for member in members:
            if member.isreg() and member.name == 'app.tgz':
                add_file(dst, member.name, FILE_MODE, member.mtime, new_app)
            elif member.isreg() and member.name == 'manifest':
                patched = set_checksum(src.extractfile(member).read(), digest)
                add_file(dst, member.name, FILE_MODE, member.mtime, patched)
            else:
                emit(dst, src, member)
    print('>> manifest checksum := md5(app.tgz) = %s' % digest)
    return out.getvalue()


def run_fnpack():
    if not os.path.exists(FNPACK):
        sys.exit('fnpack not found at %s' % FNPACK)
    print('>> fnpack build')
    proc = subprocess.run([FNPACK, 'build', '--directory', SRC],
                          cwd=HERE, capture_output=True)
    out = (proc.stdout or b'').decode('utf-8', 'replace').strip()
    err = (proc.stderr or b'').decode('utf-8', 'replace').strip()
    if out:
        print(out)
    if err:
        print(err)
    if proc.returncode != 0 or not os.path.exists(FPK):
        sys.exit('fnpack build failed (rc=%s)' % proc.returncode)


def main():
    run_fnpack()
    before = os.path.getsize(FPK)
    with open(FPK, 'rb') as fh:
        raw = fh.read()
    fixed = repack_fpk(raw)
    with open(FPK, 'wb') as fh:
        fh.write(fixed)

    # --- report -----------------------------------------------------------
    print('>> mode repair: %d -> %d bytes' % (before, len(fixed)))
    with tarfile.open(fileobj=io.BytesIO(fixed), mode='r:gz') as t:
        app = t.extractfile('app.tgz').read()
        print('-- outer --')
        for m in t.getmembers():
            print('  %s %9d %s' % (oct(m.mode), m.size, m.name))
        print('-- app.tgz --')
        with tarfile.open(fileobj=io.BytesIO(app), mode='r:gz') as a:
            for m in a.getmembers():
                print('  %s %9d %s' % (oct(m.mode), m.size, m.name))

        # self-check: the digest we declared must match the archive we shipped
        found = re.search(rb'^[ \t]*checksum[ \t]*=[ \t]*(\S+)',
                          t.extractfile('manifest').read(), re.M)
        actual = hashlib.md5(app).hexdigest()
        if not found or found.group(1).decode('ascii') != actual:
            sys.exit('checksum mismatch: manifest=%s actual=%s'
                     % (found.group(1).decode('ascii') if found else None, actual))
        print('>> checksum verified: manifest == md5(app.tgz) == %s' % actual)
    print('>> wrote %s' % FPK)


if __name__ == '__main__':
    main()
