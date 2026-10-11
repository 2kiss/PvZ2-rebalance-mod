"""PopCap PopAnim (.pam) reader, following PopCap's own PopAnim layout.

All values little-endian. Coordinates are stored in 1/20 px ("twips"),
matrices as 16.16 fixed point (image matrices additionally scaled by 20).

Frame flags (u8):    0x01 removes, 0x02 appends, 0x04 moves, 0x08 label,
                     0x10 stop, 0x20 commands.
Append record:       u16 v -> index = v & 0x7FF (0x7FF: u32 follows),
                     0x8000 sprite, 0x4000 additive, 0x2000 preload frame (u16),
                     0x1000 instance name (str), 0x0800 time scale (s32/65536);
                     then resource u8 (0xFF: u16 follows).
Move record:         u16 v -> index = v & 0x3FF (0x3FF: u32 follows),
                     0x1000 matrix (4 x s32/65536) else 0x4000 rotate (s16/1000 rad),
                     translation always: 0x0800 long (2 x s32) else short (2 x s16), /20,
                     0x8000 src rect (4 x s16/20), 0x2000 color (u8 r,g,b,a),
                     0x0400 sprite frame number (s16).
"""
import math
import struct

MAGIC = 0xBAF01954


class PamError(ValueError):
    pass


class _R:
    def __init__(self, d):
        self.d, self.p = d, 0

    def take(self, fmt):
        n = struct.calcsize(fmt)
        if self.p + n > len(self.d):
            raise PamError("truncated at %#x" % self.p)
        v = struct.unpack_from(fmt, self.d, self.p)
        self.p += n
        return v if len(v) > 1 else v[0]

    def string(self):
        n = self.take("<H")
        s = self.d[self.p:self.p + n].decode("latin-1")
        self.p += n
        return s


def _count(r):
    n = r.take("<B")
    return r.take("<H") if n == 0xFF else n


def _frame(r):
    fl = r.take("<B")
    f = {}
    if fl & 0x01:
        rem = []
        for _ in range(_count(r)):
            v = r.take("<H")
            idx = v & 0x7FF
            rem.append(r.take("<I") if idx == 0x7FF else idx)
        f["r"] = rem
    if fl & 0x02:
        app = []
        for _ in range(_count(r)):
            v = r.take("<H")
            idx = v & 0x7FF
            if idx == 0x7FF:
                idx = r.take("<I")
            res = r.take("<B")
            if res == 0xFF:
                res = r.take("<H")
            a = {"id": idx, "sprite": bool(v & 0x8000), "res": res}
            if v & 0x4000:
                a["additive"] = True
            if v & 0x2000:
                a["preload"] = r.take("<H")
            if v & 0x1000:
                a["name"] = r.string()
            if v & 0x0800:
                a["timescale"] = r.take("<i") / 65536.0
            app.append(a)
        f["a"] = app
    if fl & 0x04:
        moves = []
        for _ in range(_count(r)):
            v = r.take("<H")
            idx = v & 0x3FF
            if idx == 0x3FF:
                idx = r.take("<I")
            m = {"id": idx}
            if v & 0x1000:
                a, c, b, d = (x / 65536.0 for x in r.take("<4i"))
                m["m"] = [a, b, c, d]  # x' = a*x + c*y ; y' = b*x + d*y
            elif v & 0x4000:
                ang = r.take("<h") / 1000.0
                cs, sn = math.cos(ang), math.sin(ang)
                m["m"] = [cs, sn, -sn, cs]
                m["rot"] = ang
            if v & 0x0800:
                tx, ty = r.take("<2i")
            else:
                tx, ty = r.take("<2h")
            m["t"] = [tx / 20.0, ty / 20.0]
            if v & 0x8000:
                m["src"] = [x / 20.0 for x in r.take("<4h")]
            if v & 0x2000:
                m["color"] = [x / 255.0 for x in r.take("<4B")]
            if v & 0x0400:
                m["frame"] = r.take("<h")
            moves.append(m)
        f["c"] = moves
    if fl & 0x08:
        f["l"] = r.string()
    if fl & 0x10:
        f["s"] = True
    if fl & 0x20:
        f["k"] = [[r.string(), r.string()] for _ in range(_count(r))]
    if fl & 0xC0:
        raise PamError("unknown frame flags %#x" % fl)
    return f


def _sprite(r, version):
    name = r.string()
    desc = r.string() if version >= 4 else ""
    fps = r.take("<i") / 65536.0
    n = r.take("<H")
    work = r.take("<2H") if version >= 5 else (0, n - 1)
    return {"name": name, "desc": desc, "fps": fps, "work": list(work),
            "frames": [_frame(r) for _ in range(n)]}


def parse(data):
    r = _R(data)
    if r.take("<I") != MAGIC:
        raise PamError("bad magic")
    version = r.take("<I")
    fps = r.take("<B")
    pos = [x / 20.0 for x in r.take("<2h")]
    size = [x / 20.0 for x in r.take("<2H")]
    images = []
    for _ in range(r.take("<H")):
        name = r.string()
        w, h = r.take("<2H") if version >= 4 else (0, 0)
        a, c, b, d = (x / 1310720.0 for x in r.take("<4i"))
        tx, ty = (x / 20.0 for x in r.take("<2h"))
        base, _, rid = name.partition("|")
        images.append({"name": base, "id": rid, "size": [w, h], "m": [a, b, c, d], "t": [tx, ty]})
    sprites = [_sprite(r, version) for _ in range(r.take("<H"))]
    main = _sprite(r, version)
    if r.p != len(data):
        raise PamError("parsed %d of %d bytes" % (r.p, len(data)))
    return {"version": version, "fps": fps, "pos": pos, "size": size,
            "images": images, "sprites": sprites, "main": main}
