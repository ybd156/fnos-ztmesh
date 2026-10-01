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

Usage:  python pack.py [x86|arm]

With an argument, builds a platform-specific package:
  x86  -> ztmesh-x86.fpk   (manifest platform=x86, binary from fpk/app/zt/)
  arm  -> ztmesh-arm.fpk   (manifest platform=arm, binary from dl/zerotier-one.arm64)

Without an argument, builds the default x86 package for backward compatibility.
"""
import hashlib
import io
import os
import re
import shutil
import subprocess
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
FNPACK = os.path.join(HERE, 'tools', 'fnpack.exe')
SRC = os.path.join(HERE, 'fpk')
DL = os.path.join(HERE, 'dl')

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

# ---------------------------------------------------------------------------
# platform helpers
# ---------------------------------------------------------------------------

PLATFORM = sys.argv[1] if len(sys.argv) > 1 else 'x86'
if PLATFORM not in ('x86', 'arm'):
    sys.exit('usage: python pack.py [x86|arm]')

FPK = os.path.join(HERE, f'ztmesh-{PLATFORM}.fpk')

MANIFEST = os.path.join(SRC, 'manifest')
ZT_BIN_DIR = os.path.join(SRC, 'app', 'zt')
ZT_BIN = os.path.join(ZT_BIN_DIR, 'zerotier-one')
ARM_BIN = os.path.join(DL, 'zerotier-one.arm64')


def read_manifest():
    with open(MANIFEST, 'rb') as fh:
        return fh.read().decode('utf-8', 'replace')


def write_manifest(text):
    with open(MANIFEST, 'wb') as fh:
        fh.write(text.encode('utf-8'))


def set_manifest_platform(plat):
    text = read_manifest()
    text = re.sub(r'^platform\s*=\s*\S*', f'platform={plat}', text, flags=re.M)
    write_manifest(text)


def prepare_platform():
    """Ensure the binary in fpk/app/zt matches the requested platform."""
    if PLATFORM == 'x86':
        # nothing to swap; the repo already contains the x86-64 build
        return
    if not os.path.exists(ARM_BIN):
        sys.exit('arm64 binary not found at %s\n'
                 'download zerotier-one_1.16.2_arm64.deb and extract '
                 'usr/sbin/zerotier-one into dl/' % ARM_BIN)
    print('>> using arm64 binary from dl/zerotier-one.arm64')
    shutil.copy2(ARM_BIN, ZT_BIN)


def restore_platform():
    """Restore the x86 binary after building the arm package."""
    if PLATFORM == 'arm':
        # The repo must always ship the x86-64 build so that a bare
        # `python pack.py` continues to produce the x86 package.
        # We cannot restore from git because the file may be modified;
        # instead we keep a copy before overwriting.
        pass


def main():
    # For arm builds, save the x86 binary outside the package tree so it does
    # not get packed into the arm fpk.
    x86_backup = None
    if PLATFORM == 'arm':
        x86_backup = os.path.join(DL, 'zerotier-one.x86-backup')
        shutil.copy2(ZT_BIN, x86_backup)

    try:
        prepare_platform()
        set_manifest_platform(PLATFORM)

        run_fnpack()
        before = os.path.getsize(FPK)
        with open(FPK, 'rb') as fh:
            raw = fh.read()
        fixed = repack_fpk(raw)
        with open(FPK, 'wb') as fh:
            fh.write(fixed)

        # --- report -------------------------------------------------------
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
    finally:
        if x86_backup and os.path.exists(x86_backup):
            shutil.copy2(x86_backup, ZT_BIN)
            os.remove(x86_backup)
        # restore manifest to x86 so the source tree stays canonical
        set_manifest_platform('x86')


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
    print('>> fnpack build (%s)' % PLATFORM)
    # fnpack always writes <appname>.fpk next to the source directory
    default_fpk = os.path.join(HERE, 'ztmesh.fpk')
    if os.path.exists(default_fpk):
        os.remove(default_fpk)
    proc = subprocess.run([FNPACK, 'build', '--directory', SRC],
                          cwd=HERE, capture_output=True)
    out = (proc.stdout or b'').decode('utf-8', 'replace').strip()
    err = (proc.stderr or b'').decode('utf-8', 'replace').strip()
    if out:
        print(out)
    if err:
        print(err)
    if proc.returncode != 0 or not os.path.exists(default_fpk):
        sys.exit('fnpack build failed (rc=%s)' % proc.returncode)
    if default_fpk != FPK:
        shutil.move(default_fpk, FPK)


if __name__ == '__main__':
    main()
