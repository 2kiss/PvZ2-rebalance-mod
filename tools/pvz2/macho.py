"""Minimal thin arm64 Mach-O editing: drop injected LC_LOAD_DYLIB commands."""
import struct

MH_MAGIC_64 = 0xFEEDFACF
LC_LOAD_DYLIB = 0xC
LC_LOAD_WEAK_DYLIB = 0x80000018


def load_dylibs(data):
    magic, _, _, _, ncmds, _, _, _ = struct.unpack_from("<8I", data, 0)
    if magic != MH_MAGIC_64:
        raise ValueError("expected a thin 64-bit Mach-O")
    off = 32
    for _ in range(ncmds):
        cmd, size = struct.unpack_from("<II", data, off)
        if cmd in (LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB):
            name_off = struct.unpack_from("<I", data, off + 8)[0]
            name = bytes(data[off + name_off:off + size]).split(b"\0")[0].decode()
            yield off, size, name
        off += size


def remove_dylibs(data, should_remove):
    """Return (new_bytes, removed_names). Removed commands must come after
    every dylib the binary actually links against, or bind ordinals shift."""
    data = bytearray(data)
    magic, cpu, sub, ftype, ncmds, sizeofcmds, flags, res = struct.unpack_from("<8I", data, 0)
    dylibs = list(load_dylibs(data))
    keep_idx = [i for i, (_, _, n) in enumerate(dylibs) if not should_remove(n)]
    drop_idx = [i for i, (_, _, n) in enumerate(dylibs) if should_remove(n)]
    if drop_idx and keep_idx and min(drop_idx) < max(keep_idx):
        raise ValueError("injected dylib sits before a real one; refusing to shift ordinals")
    drop = {dylibs[i][0] for i in drop_idx}
    cmds = bytearray()
    off = 32
    kept = 0
    for _ in range(ncmds):
        cmd, size = struct.unpack_from("<II", data, off)
        if off not in drop:
            cmds += data[off:off + size]
            kept += 1
        off += size
    region = 32 + sizeofcmds
    data[32:region] = cmds + b"\0" * (sizeofcmds - len(cmds))
    struct.pack_into("<8I", data, 0, magic, cpu, sub, ftype, kept, len(cmds), flags, res)
    return bytes(data), [dylibs[i][2] for i in drop_idx]
