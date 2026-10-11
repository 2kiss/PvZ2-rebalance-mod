"""Decoders for PvZ2 PTX texture payloads.

Android packs use format 147: ETC1 RGB blocks followed by a separate 8-bit
alpha plane (width*height bytes). Format 0 is plain RGBA8888.
"""
import numpy as np

_MODS = np.array([[2, 8, -2, -8], [5, 17, -5, -17], [9, 29, -9, -29], [13, 42, -13, -42],
                  [18, 60, -18, -60], [24, 80, -24, -80], [33, 106, -33, -106],
                  [47, 183, -47, -183]], dtype=np.int32)


def _expand4(c):
    return (c << 4) | c


def _expand5(c):
    return (c << 3) | (c >> 2)


def decode_etc1(data, w, h):
    """ETC1 (big-endian 64-bit blocks, row-major) -> uint8 array (h, w, 3)."""
    bw, bh = (w + 3) // 4, (h + 3) // 4
    blocks = np.frombuffer(data[:bw * bh * 8], dtype=">u8").astype(np.uint64)
    hi = (blocks >> np.uint64(32)).astype(np.int64)
    lo = (blocks & np.uint64(0xFFFFFFFF)).astype(np.int64)

    diff = (hi >> 1) & 1
    flip = hi & 1
    cw1 = (hi >> 5) & 7
    cw2 = (hi >> 2) & 7

    # Individual mode: 4-bit pairs.
    r1i, r2i = _expand4((hi >> 28) & 15), _expand4((hi >> 24) & 15)
    g1i, g2i = _expand4((hi >> 20) & 15), _expand4((hi >> 16) & 15)
    b1i, b2i = _expand4((hi >> 12) & 15), _expand4((hi >> 8) & 15)

    # Differential mode: 5-bit base + 3-bit signed delta.
    def sdelta(v):
        return np.where(v >= 4, v - 8, v)

    r5, g5, b5 = (hi >> 27) & 31, (hi >> 19) & 31, (hi >> 11) & 31
    r5b = (r5 + sdelta((hi >> 24) & 7)) & 31
    g5b = (g5 + sdelta((hi >> 16) & 7)) & 31
    b5b = (b5 + sdelta((hi >> 8) & 7)) & 31

    base1 = np.where(diff[:, None] == 1,
                     np.stack([_expand5(r5), _expand5(g5), _expand5(b5)], 1),
                     np.stack([r1i, g1i, b1i], 1))
    base2 = np.where(diff[:, None] == 1,
                     np.stack([_expand5(r5b), _expand5(g5b), _expand5(b5b)], 1),
                     np.stack([r2i, g2i, b2i], 1))

    out = np.zeros((bh * 4, bw * 4, 3), dtype=np.uint8)
    view = out.reshape(bh, 4, bw, 4, 3)
    bi = np.arange(blocks.size)
    by, bx = bi // bw, bi % bw
    for x in range(4):
        for y in range(4):
            i = x * 4 + y
            msb = (lo >> (16 + i)) & 1
            lsb = (lo >> i) & 1
            idx = (msb << 1) | lsb
            second = np.where(flip == 1, y >= 2, x >= 2)
            cw = np.where(second, cw2, cw1)
            base = np.where(second[:, None], base2, base1)
            mod = _MODS[cw, idx]
            px = np.clip(base + mod[:, None], 0, 255).astype(np.uint8)
            view[by, y, bx, x] = px
    return out[:h, :w]


def decode_ptx(data, w, h, fmt):
    """Return an RGBA uint8 array (h, w, 4) for a PTX payload."""
    if fmt == 147:
        rgb = decode_etc1(data, w, h)
        etc_size = ((w + 3) // 4) * ((h + 3) // 4) * 8
        alpha = np.frombuffer(data[etc_size:etc_size + w * h], dtype=np.uint8).reshape(h, w)
        return np.dstack([rgb, alpha])
    if fmt == 0:
        return np.frombuffer(data[:w * h * 4], dtype=np.uint8).reshape(h, w, 4).copy()
    raise NotImplementedError("PTX format %d" % fmt)
