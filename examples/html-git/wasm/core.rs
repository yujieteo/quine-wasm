// Original implementation. No external crates or generated source.
use std::slice;

const LIMIT: usize = 256 * 1024 * 1024;
static mut OUTPUT_PTR: *mut u8 = std::ptr::null_mut();
static mut OUTPUT_LEN: usize = 0;
static mut OUTPUT_CAP: usize = 0;
static mut END: usize = 0;
#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    if n > LIMIT {
        return std::ptr::null_mut();
    }
    Box::into_raw(vec![0u8; n].into_boxed_slice()) as *mut u8
}
#[no_mangle]
pub unsafe extern "C" fn free(p: *mut u8, n: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(p, n)));
}
#[no_mangle]
pub unsafe extern "C" fn result_len() -> usize {
    OUTPUT_LEN
}
#[no_mangle]
pub unsafe extern "C" fn stream_end() -> usize {
    END
}
#[no_mangle]
pub unsafe extern "C" fn compute(
    op: u32,
    p: *const u8,
    n: usize,
    q: *const u8,
    m: usize,
) -> *const u8 {
    let a = slice::from_raw_parts(p, n);
    let b = slice::from_raw_parts(q, m);
    END = 0;
    let result = match op {
        0 => Ok(sha1(a)),
        1 => inflate(a).map(|(out, end)| {
            END = end;
            out
        }),
        2 => Ok(deflate(a)),
        3 => delta(a, b),
        4 => Ok(adler(a).to_be_bytes().to_vec()),
        _ => Err(()),
    };
    match result {
        Ok(out) => {
            if !OUTPUT_PTR.is_null() {
                drop(Vec::from_raw_parts(OUTPUT_PTR, OUTPUT_LEN, OUTPUT_CAP));
            }
            let mut out = std::mem::ManuallyDrop::new(out);
            OUTPUT_PTR = out.as_mut_ptr();
            OUTPUT_LEN = out.len();
            OUTPUT_CAP = out.capacity();
            OUTPUT_PTR
        }
        Err(()) => std::ptr::null(),
    }
}
fn sha1(data: &[u8]) -> Vec<u8> {
    let total = (data.len() + 9 + 63) / 64 * 64;
    let mut block = [0u8; 64];
    let mut h = [
        0x67452301u32,
        0xefcdab89,
        0x98badcfe,
        0x10325476,
        0xc3d2e1f0,
    ];
    let length = (data.len() as u64 * 8).to_be_bytes();
    for off in (0..total).step_by(64) {
        for i in 0..64 {
            let at = off + i;
            block[i] = if at < data.len() {
                data[at]
            } else if at == data.len() {
                128
            } else if at >= total - 8 {
                length[at - (total - 8)]
            } else {
                0
            };
        }
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes(block[i * 4..i * 4 + 4].try_into().unwrap());
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for i in 0..80 {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5a827999u32),
                20..=39 => (b ^ c ^ d, 0x6ed9eba1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1bbcdc),
                _ => (b ^ c ^ d, 0xca62c1d6),
            };
            let t = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(w[i]);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        for (i, x) in [a, b, c, d, e].into_iter().enumerate() {
            h[i] = h[i].wrapping_add(x);
        }
    }
    h.iter().flat_map(|v| v.to_be_bytes()).collect()
}
fn adler(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for chunk in data.chunks(3800) {
        for &v in chunk {
            a += v as u32;
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    b << 16 | a
}
const LB: [usize; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LE: [u32; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DB: [usize; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DE: [u32; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];
struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
    buf: u32,
    count: u32,
}
impl<'a> Bits<'a> {
    fn get(&mut self, n: u32) -> Result<usize, ()> {
        while self.count < n {
            self.buf |= (*self.data.get(self.pos).ok_or(())? as u32) << self.count;
            self.pos += 1;
            self.count += 8;
        }
        let v = self.buf & ((1 << n) - 1);
        self.buf >>= n;
        self.count -= n;
        Ok(v as usize)
    }
}
struct Huff {
    count: [usize; 16],
    symbol: Vec<usize>,
}
impl Huff {
    fn new(lengths: &[usize]) -> Result<Self, ()> {
        let mut count = [0; 16];
        for &n in lengths {
            if n > 15 {
                return Err(());
            }
            count[n] += 1;
        }
        let mut remaining = 1i32;
        for n in 1..16 {
            remaining = remaining * 2 - count[n] as i32;
            if remaining < 0 {
                return Err(());
            }
        }
        let mut offsets = [0; 16];
        for n in 1..15 {
            offsets[n + 1] = offsets[n] + count[n];
        }
        let mut symbol = vec![0; lengths.len()];
        for (s, &n) in lengths.iter().enumerate() {
            if n != 0 {
                symbol[offsets[n]] = s;
                offsets[n] += 1;
            }
        }
        Ok(Self { count, symbol })
    }
    fn decode(&self, bits: &mut Bits) -> Result<usize, ()> {
        let (mut code, mut first, mut index) = (0, 0, 0);
        for n in 1..16 {
            code |= bits.get(1)?;
            if code >= first && code - first < self.count[n] {
                return self.symbol.get(index + code - first).copied().ok_or(());
            }
            index += self.count[n];
            first = (first + self.count[n]) << 1;
            code <<= 1;
        }
        Err(())
    }
}
fn inflate(data: &[u8]) -> Result<(Vec<u8>, usize), ()> {
    if data.len() < 6
        || data[0] & 15 != 8
        || data[0] >> 4 > 7
        || ((data[0] as u32) << 8 | data[1] as u32) % 31 != 0
        || data[1] & 32 != 0
    {
        return Err(());
    }
    let mut bits = Bits {
        data,
        pos: 2,
        buf: 0,
        count: 0,
    };
    let mut out = Vec::new();
    loop {
        let last = bits.get(1)?;
        let kind = bits.get(2)?;
        if kind == 0 {
            bits.buf = 0;
            bits.count = 0;
            let len = bits.get(16)?;
            let inverse = bits.get(16)?;
            if len != (!inverse & 65535) || out.len() + len > LIMIT {
                return Err(());
            }
            let end = bits.pos.checked_add(len).ok_or(())?;
            out.extend_from_slice(data.get(bits.pos..end).ok_or(())?);
            bits.pos = end;
        } else if kind == 1 || kind == 2 {
            let (lit, dist) = if kind == 1 {
                let lengths: Vec<usize> = (0..288)
                    .map(|i| {
                        if i < 144 {
                            8
                        } else if i < 256 {
                            9
                        } else if i < 280 {
                            7
                        } else {
                            8
                        }
                    })
                    .collect();
                (Huff::new(&lengths)?, Huff::new(&[5; 32])?)
            } else {
                let nl = bits.get(5)? + 257;
                let nd = bits.get(5)? + 1;
                let nc = bits.get(4)? + 4;
                if nl > 286 {
                    return Err(());
                }
                let order = [
                    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
                ];
                let mut cl = [0; 19];
                for i in 0..nc {
                    cl[order[i]] = bits.get(3)?;
                }
                let codes = Huff::new(&cl)?;
                let mut lengths = Vec::new();
                while lengths.len() < nl + nd {
                    let sym = codes.decode(&mut bits)?;
                    let (val, rep) = match sym {
                        0..=15 => (sym, 1),
                        16 => (*lengths.last().ok_or(())?, bits.get(2)? + 3),
                        17 => (0, bits.get(3)? + 3),
                        18 => (0, bits.get(7)? + 11),
                        _ => return Err(()),
                    };
                    if lengths.len() + rep > nl + nd {
                        return Err(());
                    }
                    lengths.resize(lengths.len() + rep, val);
                }
                if lengths[256] == 0 {
                    return Err(());
                }
                (Huff::new(&lengths[..nl])?, Huff::new(&lengths[nl..])?)
            };
            loop {
                let sym = lit.decode(&mut bits)?;
                if sym < 256 {
                    if out.len() >= LIMIT {
                        return Err(());
                    }
                    out.push(sym as u8);
                } else if sym == 256 {
                    break;
                } else {
                    let s = sym - 257;
                    if s >= 29 {
                        return Err(());
                    }
                    let len = LB[s] + bits.get(LE[s])?;
                    let ds = dist.decode(&mut bits)?;
                    if ds >= 30 {
                        return Err(());
                    }
                    let distance = DB[ds] + bits.get(DE[ds])?;
                    if distance > out.len() || out.len() + len > LIMIT {
                        return Err(());
                    }
                    for _ in 0..len {
                        out.push(out[out.len() - distance]);
                    }
                }
            }
        } else {
            return Err(());
        }
        if last != 0 {
            break;
        }
    }
    let end = bits.pos + 4;
    let checksum = u32::from_be_bytes(
        data.get(bits.pos..end)
            .ok_or(())?
            .try_into()
            .map_err(|_| ())?,
    );
    if checksum != adler(&out) {
        return Err(());
    }
    Ok((out, end))
}
struct Writer {
    out: Vec<u8>,
    buf: u32,
    count: u32,
}
impl Writer {
    fn put(&mut self, value: usize, n: u32) {
        self.buf |= (value as u32) << self.count;
        self.count += n;
        while self.count >= 8 {
            self.out.push(self.buf as u8);
            self.buf >>= 8;
            self.count -= 8;
        }
    }
    fn symbol(&mut self, s: usize) {
        let (code, n) = if s < 144 {
            (0x30 + s, 8)
        } else if s < 256 {
            (0x190 + s - 144, 9)
        } else if s < 280 {
            (s - 256, 7)
        } else {
            (0xc0 + s - 280, 8)
        };
        self.put((code as u32).reverse_bits() as usize >> (32 - n), n);
    }
}
fn deflate(data: &[u8]) -> Vec<u8> {
    let mut w = Writer {
        out: vec![0x78, 0x01],
        buf: 0,
        count: 0,
    };
    w.put(1, 1);
    w.put(1, 2);
    let mut head = vec![usize::MAX; 32768];
    let mut prev = vec![usize::MAX; 32768];
    let hash = |i: usize| {
        ((data[i] as usize) << 10 ^ (data[i + 1] as usize) << 5 ^ data[i + 2] as usize) & 32767
    };
    let mut i = 0;
    while i < data.len() {
        let (mut best, mut distance) = (0, 0);
        if i + 2 < data.len() {
            let max = 258.min(data.len() - i);
            let mut j = head[hash(i)];
            let mut chain = 0;
            while j < i && i - j <= 32768 && chain < 64 {
                chain += 1;
                if data[j + best] == data[i + best] {
                    let mut len = 0;
                    while len < max && data[j + len] == data[i + len] {
                        len += 1;
                    }
                    if len > best {
                        best = len;
                        distance = i - j;
                        if len == max {
                            break;
                        }
                    }
                }
                let next = prev[j & 32767];
                if next >= j {
                    break;
                }
                j = next;
            }
            let h = hash(i);
            prev[i & 32767] = head[h];
            head[h] = i;
        }
        if best >= 3 {
            let s = (0..29).rev().find(|&s| LB[s] <= best).unwrap();
            w.symbol(257 + s);
            w.put(best - LB[s], LE[s]);
            let d = (0..30).rev().find(|&d| DB[d] <= distance).unwrap();
            w.put((d as u32).reverse_bits() as usize >> 27, 5);
            w.put(distance - DB[d], DE[d]);
            for k in 1..best {
                if i + k + 2 < data.len() {
                    let h = hash(i + k);
                    prev[(i + k) & 32767] = head[h];
                    head[h] = i + k;
                }
            }
            i += best;
        } else {
            w.symbol(data[i] as usize);
            i += 1;
        }
    }
    w.symbol(256);
    if w.count > 0 {
        w.out.push(w.buf as u8);
    }
    w.out.extend_from_slice(&adler(data).to_be_bytes());
    w.out
}
fn variable(data: &[u8], pos: &mut usize) -> Result<usize, ()> {
    let (mut value, mut shift) = (0usize, 0);
    loop {
        let c = *data.get(*pos).ok_or(())?;
        *pos += 1;
        if shift >= 32 {
            return Err(());
        }
        value |= ((c & 127) as usize) << shift;
        if c & 128 == 0 {
            return Ok(value);
        }
        shift += 7;
    }
}
fn delta(base: &[u8], data: &[u8]) -> Result<Vec<u8>, ()> {
    let mut p = 0;
    if variable(data, &mut p)? != base.len() {
        return Err(());
    }
    let size = variable(data, &mut p)?;
    if size > LIMIT {
        return Err(());
    }
    let mut out = Vec::with_capacity(size);
    while p < data.len() {
        let op = data[p];
        p += 1;
        if op & 128 != 0 {
            let (mut offset, mut len) = (0usize, 0usize);
            for i in 0..4 {
                if op & (1 << i) != 0 {
                    offset |= (*data.get(p).ok_or(())? as usize) << (i * 8);
                    p += 1;
                }
            }
            for i in 0..3 {
                if op & (16 << i) != 0 {
                    len |= (*data.get(p).ok_or(())? as usize) << (i * 8);
                    p += 1;
                }
            }
            if len == 0 {
                len = 65536;
            }
            if out.len() + len > size {
                return Err(());
            }
            out.extend_from_slice(
                base.get(offset..offset.checked_add(len).ok_or(())?)
                    .ok_or(())?,
            );
        } else if op != 0 {
            let end = p + op as usize;
            if out.len() + op as usize > size {
                return Err(());
            }
            out.extend_from_slice(data.get(p..end).ok_or(())?);
            p = end;
        } else {
            return Err(());
        }
    }
    if out.len() != size {
        return Err(());
    }
    Ok(out)
}
