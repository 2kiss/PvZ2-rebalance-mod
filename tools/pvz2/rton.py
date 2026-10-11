"""RTON <-> JSON for PvZ2 (unencrypted RTON v1).

Decoding produces plain JSON values; references come out as "RTID(...)" strings
like every community tool does. Encoding picks canonical type codes, which the
game accepts since it reads values by the field's declared type.
"""
import struct


class Int(int):
    """int that remembers its original RTON type code (re-encoded the same way)."""

    def __new__(cls, v, t):
        o = int.__new__(cls, v)
        o.t = t
        return o

    def __deepcopy__(self, memo):
        return self


class Float(float):
    """float that remembers its original RTON type code."""

    def __new__(cls, v, t):
        o = float.__new__(cls, v)
        o.t = t
        return o

    def __deepcopy__(self, memo):
        return self


class PlainStr(str):
    """A plain string that merely looks like "RTID(...)"; kept as a string."""


def _plain(s):
    return PlainStr(s) if s.startswith("RTID(") else s


class _Reader:
    def __init__(self, data):
        self.b = data
        self.p = 0
        self.ascii_cache = []
        self.utf8_cache = []

    def u8(self):
        v = self.b[self.p]
        self.p += 1
        return v

    def take(self, n):
        v = self.b[self.p:self.p + n]
        self.p += n
        return v

    def unpack(self, fmt):
        v = struct.unpack_from(fmt, self.b, self.p)[0]
        self.p += struct.calcsize(fmt)
        return v

    def uvar(self):
        shift = res = 0
        while True:
            c = self.u8()
            res |= (c & 0x7F) << shift
            if not c & 0x80:
                return res
            shift += 7

    def svar(self):
        n = self.uvar()
        return (n >> 1) ^ -(n & 1)

    def ascii(self):
        # Despite the name, PopCap stores UTF-8 bytes here for non-ASCII text.
        return self.take(self.uvar()).decode("utf-8", "surrogateescape")

    def utf8(self):
        self.uvar()  # code point count
        return self.take(self.uvar()).decode("utf-8", "surrogateescape")


_FIXED = {
    0x08: "<b", 0x0A: "<B", 0x10: "<h", 0x12: "<H", 0x20: "<i", 0x22: "<f",
    0x26: "<I", 0x40: "<q", 0x42: "<d", 0x46: "<Q",
    0xB0: "<h", 0xB2: "<H", 0xB4: "<i", 0xB6: "<I", 0xB8: "<q", 0xBA: "<Q",
}
_ZERO = {0x09, 0x0B, 0x11, 0x13, 0x21, 0x27, 0x41, 0x47,
         0xB1, 0xB3, 0xB5, 0xB7, 0xB9, 0xBB}
_FZERO = {0x23, 0x43}
_UVAR = {0x24, 0x28, 0x44, 0x48}
_SVAR = {0x25, 0x29, 0x45, 0x49}


def _value(r, t):
    if t == 0x00:
        return False
    if t == 0x01:
        return True
    if t == 0x02:
        return None
    if t in _FIXED:
        v = r.unpack(_FIXED[t])
        return Float(v, t) if isinstance(v, float) else Int(v, t)
    if t in _ZERO:
        return Int(0, t)
    if t in _FZERO:
        return Float(0.0, t)
    if t in _UVAR:
        return Int(r.uvar(), t)
    if t in _SVAR:
        return Int(r.svar(), t)
    if t == 0xBC:
        return r.u8() != 0
    if t == 0x81:
        return _plain(r.ascii())
    if t == 0x82:
        return _plain(r.utf8())
    if t == 0x90:
        s = _plain(r.ascii())
        r.ascii_cache.append(s)
        return s
    if t == 0x91:
        return r.ascii_cache[r.uvar()]
    if t == 0x92:
        s = _plain(r.utf8())
        r.utf8_cache.append(s)
        return s
    if t == 0x93:
        return r.utf8_cache[r.uvar()]
    if t == 0x83:
        sub = r.u8()
        if sub == 0x00:
            return "RTID(0)"
        if sub == 0x02:
            sheet = r.utf8()
            a = r.uvar()
            b = r.uvar()
            c = r.unpack("<I")
            return "RTID(%d.%d.%08x@%s)" % (b, a, c, sheet)
        if sub == 0x03:
            sheet = r.utf8()
            name = r.utf8()
            return "RTID(%s@%s)" % (name, sheet)
        raise ValueError("RTON: unknown RTID subtype %#x at %#x" % (sub, r.p))
    if t == 0x84:
        return "RTID(0)"
    if t == 0x85:
        return _object(r)
    if t == 0x86:
        if r.u8() != 0xFD:
            raise ValueError("RTON: bad array at %#x" % r.p)
        n = r.uvar()
        arr = [_value(r, r.u8()) for _ in range(n)]
        if r.u8() != 0xFE:
            raise ValueError("RTON: unterminated array at %#x" % r.p)
        return arr
    if t == 0x87:
        r.u8()
        s = r.ascii()
        return "$BINARY(\"%s\", %d)" % (s, r.uvar())
    raise ValueError("RTON: unknown type %#x at %#x" % (t, r.p - 1))


DUP = "\u0000dup"  # suffix marking a repeated key inside one object


def _object(r):
    obj = {}
    while True:
        t = r.u8()
        if t == 0xFF:
            return obj
        key = _value(r, t)
        if key in obj:
            n = 1
            while "%s%s%d" % (key, DUP, n) in obj:
                n += 1
            dup = "%s%s%d" % (key, DUP, n)
            key = PlainStr(dup) if isinstance(key, PlainStr) else dup
        obj[key] = _value(r, r.u8())


def decode(data):
    if data[:4] != b"RTON":
        raise ValueError("not RTON (encrypted or other format)")
    r = _Reader(data)
    r.p = 8
    obj = _object(r)
    if data[r.p:r.p + 4] != b"DONE":
        raise ValueError("RTON: missing DONE")
    return obj


class _Writer:
    def __init__(self):
        self.out = bytearray()
        self.ascii_cache = {}
        self.utf8_cache = {}

    def uvar(self, n):
        while True:
            c = n & 0x7F
            n >>= 7
            if n:
                self.out.append(c | 0x80)
            else:
                self.out.append(c)
                return

    def svar(self, n):
        self.uvar((n << 1) ^ (n >> 63) if n < 0 else n << 1)

    def utf8_raw(self, s):
        b = s.encode("utf-8", "surrogateescape")
        self.uvar(len(s))
        self.uvar(len(b))
        self.out += b

    def string(self, s):
        if s.startswith("RTID(") and s.endswith(")") and not isinstance(s, PlainStr):
            return self.rtid(s[5:-1])
        # Plain strings (0x90) carry raw UTF-8 bytes, which is how PopCap's own
        # tools store non-ASCII text too; 0x92 is only used by the game for RTIDs.
        b = s.encode("utf-8", "surrogateescape")
        if s in self.ascii_cache:
            self.out.append(0x91)
            self.uvar(self.ascii_cache[s])
            return
        self.ascii_cache[s] = len(self.ascii_cache)
        self.out.append(0x90)
        self.uvar(len(b))
        self.out += b

    def rtid(self, inner):
        if inner == "0":
            self.out.append(0x84)
            return
        name, _, sheet = inner.rpartition("@")
        parts = name.split(".")
        if len(parts) == 3 and all(parts) and parts[0].isdigit() and parts[1].isdigit():
            try:
                c = int(parts[2], 16)
            except ValueError:
                c = None
            if c is not None and len(parts[2]) == 8:
                self.out += b"\x83\x02"
                self.utf8_raw(sheet)
                self.uvar(int(parts[1]))
                self.uvar(int(parts[0]))
                self.out += struct.pack("<I", c)
                return
        self.out += b"\x83\x03"
        self.utf8_raw(sheet)
        self.utf8_raw(name)

    def value(self, v):
        if v is None:
            self.out.append(0x02)
        elif v is True:
            self.out.append(0x01)
        elif v is False:
            self.out.append(0x00)
        elif isinstance(v, (Int, Float)) and self.typed(v):
            pass
        elif isinstance(v, int):
            if v == 0:
                self.out.append(0x21)
            elif 0 < v < 2 ** 32:
                self.out.append(0x24)
                self.uvar(v)
            elif -2 ** 31 <= v < 0:
                self.out.append(0x25)
                self.svar(v)
            elif v > 0:
                self.out.append(0x44)
                self.uvar(v)
            else:
                self.out.append(0x45)
                self.svar(v)
        elif isinstance(v, float):
            if v == 0.0:
                self.out.append(0x23)
            elif struct.unpack("<f", struct.pack("<f", v))[0] == v:
                self.out.append(0x22)
                self.out += struct.pack("<f", v)
            else:
                self.out.append(0x42)
                self.out += struct.pack("<d", v)
        elif isinstance(v, str):
            self.string(v)
        elif isinstance(v, list):
            self.out += b"\x86\xfd"
            self.uvar(len(v))
            for x in v:
                self.value(x)
            self.out.append(0xFE)
        elif isinstance(v, dict):
            self.out.append(0x85)
            self.obj_body(v)
        else:
            raise TypeError(type(v))

    def typed(self, v):
        """Write v with its remembered type code; False if it no longer fits."""
        t = v.t
        try:
            if t in _FIXED:
                b = struct.pack(_FIXED[t], v)
                if struct.unpack(_FIXED[t], b)[0] != v:
                    return False
                self.out.append(t)
                self.out += b
            elif t in _ZERO or t in _FZERO:
                if v != 0:
                    return False
                self.out.append(t)
            elif t in _UVAR:
                if v < 0:
                    return False
                self.out.append(t)
                self.uvar(int(v))
            elif t in _SVAR:
                self.out.append(t)
                self.svar(int(v))
            else:
                return False
        except struct.error:
            return False
        return True

    def obj_body(self, d):
        for k, v in d.items():
            if DUP in k:
                base = k.split(DUP, 1)[0]
                k = PlainStr(base) if isinstance(k, PlainStr) else base
            self.string(k)
            self.value(v)
        self.out.append(0xFF)


def encode(obj):
    w = _Writer()
    w.out += b"RTON" + struct.pack("<I", 1)
    w.obj_body(obj)
    w.out += b"DONE"
    return bytes(w.out)
