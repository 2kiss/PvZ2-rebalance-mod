"""Reader/patcher for PvZ2 RSB (1bsr, v4) archives and their RSG packets (pgsr).

Only what the mod needs: list packets, read files out of a packet, and rebuild
a packet with replaced files, then splice it back into the RSB.
"""
import struct
import zlib

PAGE = 0x1000


def _align(n, a=PAGE):
    return (n + a - 1) // a * a


# ---------------------------------------------------------------------------
# PopCap string trie ("compiled map"): used by RSB and RSG file lists.
# Each node is 4 bytes: char (u8) + u24 offset (in 4-byte units, from list
# start) of the sibling branch. char == 0 terminates the key; a fixed-size
# payload follows.
# ---------------------------------------------------------------------------

def read_trie(buf, begin, end, read_payload):
    out = []
    pending = {}  # absolute position -> key prefix
    pos = begin
    key = b""
    while pos < end:
        ch = buf[pos]
        sib = int.from_bytes(buf[pos + 1:pos + 4], "little")
        pos += 4
        if sib:
            pending[begin + sib * 4] = key
        if ch == 0:
            payload, pos = read_payload(buf, pos)
            out.append((key.decode("latin-1"), payload))
            if pos in pending:
                key = pending.pop(pos)
            elif pos < end:
                raise ValueError("trie: dangling position %#x" % pos)
        else:
            key += bytes([ch])
    return out


def write_trie(items, write_payload):
    """items: list of (key:str, payload) in trie order (keys sharing a prefix
    are contiguous), e.g. the order read_trie returned them in."""
    keys = [k.upper().encode("latin-1") for k, _ in items]
    out = bytearray()
    # stack entries: (position of node whose sibling field must be patched, prefix_len)
    # Classic construction: for each key, share the prefix with the previous key.
    open_nodes = []  # list per depth: index into out of the node at that depth
    prev = b""
    for (k, payload), key in zip(items, keys):
        common = 0
        while common < len(prev) and common < len(key) and prev[common] == key[common]:
            common += 1
        if out:
            # The node at depth `common` of the previous key branches to here.
            node = open_nodes[common]
            sib = len(out) // 4
            out[node + 1:node + 4] = sib.to_bytes(3, "little")
        del open_nodes[common:]
        for d in range(common, len(key) + 1):
            open_nodes.append(len(out))
            ch = key[d] if d < len(key) else 0
            out += bytes([ch, 0, 0, 0])
        out += write_payload(payload)
        prev = key
    return bytes(out)


# ---------------------------------------------------------------------------
# RSG packet
# ---------------------------------------------------------------------------

RSG_HEAD = struct.Struct("<4sIQIIIIIIIII20sII")
RSG_HEAD_PAD = 12  # zero bytes between the header struct and the file list


class RSG:
    def __init__(self, data):
        (magic, ver, _pad, self.flags, self.head_len, p0_off, p0_zsize, p0_size,
         _p4, p1_off, p1_zsize, p1_size, _pad20, fl_len, fl_off) = RSG_HEAD.unpack_from(data, 0)
        if magic != b"pgsr":
            raise ValueError("not an RSG packet")
        self.version = ver
        self.part0 = self._part(data, p0_off, p0_zsize, p0_size, self.flags & 2)
        self.part1 = self._part(data, p1_off, p1_zsize, p1_size, self.flags & 1)
        self.p1_raw_size = p1_size

        def payload(buf, pos):
            kind, off, size = struct.unpack_from("<III", buf, pos)
            pos += 12
            extra = None
            if kind == 1:
                extra = buf[pos:pos + 20]
                pos += 20
            return (kind, off, size, extra), pos

        self.entries = read_trie(data, fl_off, fl_off + fl_len, payload)

    @staticmethod
    def _part(data, off, zsize, size, compressed):
        if size == 0:
            return b""
        raw = data[off:off + zsize]
        return zlib.decompress(raw) if compressed and raw[:1] == b"\x78" else raw[:size]

    def files(self):
        """Yield (path, bytes) for every part0 (non-texture) file."""
        for path, (kind, off, size, _) in self.entries:
            if kind == 0:
                yield path, self.part0[off:off + size]

    def build(self, replace):
        """Rebuild the packet with part0 files replaced by `replace` {PATH: bytes}."""
        replace = {k.upper(): v for k, v in replace.items()}
        # Lay file data out in the original offset order, keep trie order for the list.
        part0 = bytearray()
        placed = {}
        res = [(off, path, size) for path, (kind, off, size, _) in self.entries if kind == 0]
        for off, path, size in sorted(res):
            blob = replace.get(path.upper(), self.part0[off:off + size])
            placed[path] = (len(part0), len(blob))
            part0 += blob
            part0 += b"\0" * (_align(len(part0)) - len(part0))
        entries = []
        for path, (kind, off, size, extra) in self.entries:
            if kind == 0:
                entries.append((path, (0,) + placed[path] + (None,)))
            else:
                entries.append((path, (kind, off, size, extra)))

        def wp(p):
            kind, off, size, extra = p
            return struct.pack("<III", kind, off, size) + (extra or b"")

        flist = write_trie(entries, wp)
        fl_off = RSG_HEAD.size + RSG_HEAD_PAD
        head_len = _align(fl_off + len(flist))
        p0_raw = bytes(part0)
        p0_size = _align(len(p0_raw))
        p0_raw += b"\0" * (p0_size - len(p0_raw))
        p0_blob = zlib.compress(p0_raw, 9) if self.flags & 2 else p0_raw
        p0_blob += b"\0" * (_align(len(p0_blob)) - len(p0_blob))
        p1_off = head_len + len(p0_blob)
        p1_blob = b""
        p1_size = 0
        if self.part1:
            p1_size = self.p1_raw_size
            p1_raw = self.part1 + b"\0" * (p1_size - len(self.part1))
            p1_blob = zlib.compress(p1_raw, 9) if self.flags & 1 else p1_raw
            p1_blob += b"\0" * (_align(len(p1_blob)) - len(p1_blob))
        head = RSG_HEAD.pack(b"pgsr", self.version, 0, self.flags, head_len,
                             head_len, len(p0_blob), p0_size, 0,
                             p1_off, len(p1_blob), p1_size,
                             b"\0" * 20, len(flist), fl_off)
        out = bytearray(head) + b"\0" * RSG_HEAD_PAD + flist
        out += b"\0" * (head_len - len(out))
        out += p0_blob + p1_blob
        # Mirror of the header that the RSB keeps in the packet info record.
        info = (self.flags, head_len, head_len, len(p0_blob), p0_size, p0_size,
                p1_off, len(p1_blob), p1_size)
        return bytes(out), info


# ---------------------------------------------------------------------------
# RSB archive
# ---------------------------------------------------------------------------

RSB_HEAD = struct.Struct("<4sI" + "I" * 26)
PKT_INFO_NUMS = 19  # u32 fields after the 128-byte packet name


class RSB:
    def __init__(self, path):
        self.data = bytearray(open(path, "rb").read())
        h = RSB_HEAD.unpack_from(self.data, 0)
        if h[0] != b"1bsr":
            raise ValueError("not an RSB archive")
        self.head = list(h)
        self.pkt_count, self.pkt_base, self.pkt_each = h[10], h[11], h[12]

    def _info_off(self, i):
        return self.pkt_base + i * self.pkt_each

    def packets(self):
        for i in range(self.pkt_count):
            o = self._info_off(i)
            name = bytes(self.data[o:o + 128]).split(b"\0")[0].decode()
            off, ln = struct.unpack_from("<II", self.data, o + 128)
            yield i, name, off, ln

    def find(self, name):
        for i, n, off, ln in self.packets():
            if n.lower() == name.lower():
                return i, off, ln
        raise KeyError(name)

    def rsg(self, name):
        _, off, ln = self.find(name)
        return RSG(bytes(self.data[off:off + ln]))

    def replace_packet(self, name, blob, info):
        """Swap a packet's bytes; packets after it are shifted."""
        idx, off, ln = self.find(name)
        delta = len(blob) - ln
        self.data[off:off + ln] = blob
        for i, _, o2, _ in self.packets():
            io = self._info_off(i)
            if i == idx:
                struct.pack_into("<II", self.data, io + 128, off, len(blob))
                # Mirror of the packet header kept in the info record.
                struct.pack_into("<9I", self.data, io + 128 + 12, *info)
            elif o2 > off:
                struct.pack_into("<I", self.data, io + 128, o2 + delta)

    def save(self, path):
        open(path, "wb").write(self.data)
