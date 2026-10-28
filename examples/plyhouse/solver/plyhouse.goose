// plyhouse: homogenized and laminate properties of a stack of plies.
//
// The plies stack along z, ply 0 at the bottom. Each ply is orthotropic in its
// material axes (1 along the fibre, 3 along z) and turns by its angle about z.
// Voigt order is 11, 22, 33, 23, 13, 12, with engineering shear strains.
//
// The page and the tests call the exported functions: lam_clear, ply_add and the
// set_ functions give the input, solve computes everything, and res reads a result.

import math;
import std;

let MAXP = 64;                     // plies
let MAXEL = 4;                     // finite elements per ply
let MAXD = 3 * MAXP * MAXEL;       // unknowns of the cell problem
let NENV = 72;                     // points of the failure envelope
let NFREQ = 6;                     // plate frequencies
let NCRIT = 5;                     // max stress, max strain, Tsai-Hill, Tsai-Wu, Hashin
let BIG = 1e30;                    // strength ratio when a ply carries no stress
let SMALL = 1e-9;                  // relative size below which a coupling term is zero
let DISCOUNT = 1e-6;               // stiffness factor of a failed ply

struct Ply {
    t: f64, ang: f64,
    e1: f64, e2: f64, e3: f64, g12: f64, g13: f64, g23: f64, n12: f64, n13: f64, n23: f64,
    k1: f64, k2: f64, k3: f64, rho: f64, c: f64,
    xt: f64, xc: f64, yt: f64, yc: f64, s: f64,
}

// Input.
var plies: Ply[MAXP];
var np = 0;
var load_mode = 0;                 // 0: N and M given, 1: mid-plane strains and curvatures given
var load_in: f64[6] = [0.0; 6];
var plate_a = 500.0;
var plate_b = 250.0;
var env_ia = 0;
var env_ib = 1;
var env_crit = 3;
var lpf_crit = 0;

// Per-ply stiffness in global axes.
var cg: f64[MAXP * 36] = [0.0; MAXP * 36];    // 3D stiffness
var kg: f64[MAXP * 9] = [0.0; MAXP * 9];      // conductivity
var qm: f64[MAXP * 9] = [0.0; MAXP * 9];      // plane-stress reduced stiffness, material axes
var qg: f64[MAXP * 9] = [0.0; MAXP * 9];      // plane-stress reduced stiffness, global axes
var zb: f64[MAXP + 1] = [0.0; MAXP + 1];      // CLT interface z, mid-plane at 0

// Cell problem.
var kmat: f64[MAXD * MAXD] = [0.0; MAXD * MAXD];
var rhs: f64[MAXD * 6] = [0.0; MAXD * 6];

// Results.
var status = 0;
var ceff: f64[36] = [0.0; 36];
var seff: f64[36] = [0.0; 36];
var eng3: f64[9] = [0.0; 9];
var keff: f64[9] = [0.0; 9];
var scal: f64[4] = [0.0; 4];                  // density, specific heat, thickness, areal mass
var chm_sig: f64[6 * MAXP * 6] = [0.0; 6 * MAXP * 6];
var chm_q: f64[3 * MAXP * 3] = [0.0; 3 * MAXP * 3];
var abd: f64[36] = [0.0; 36];
var abdi: f64[36] = [0.0; 36];
var lamc: f64[12] = [0.0; 12];
var coup: f64[10] = [0.0; 10];                // 5 ratios, then 5 flags
var mid: f64[12] = [0.0; 12];                 // strains and curvatures, then N and M
var plyr: f64[MAXP * 24] = [0.0; MAXP * 24];  // bottom then top: strain, stress (global), strain, stress (material)
var ratio: f64[MAXP * NCRIT] = [0.0; MAXP * NCRIT];
var hmode: f64[MAXP] = [0.0; MAXP];           // Hashin mode: 0 fibre tension, 1 fibre compression, 2 matrix tension, 3 matrix compression
var fpf: f64[NCRIT * 2] = [0.0; NCRIT * 2];
var lpf: f64[2] = [0.0; 2];
var lpf_step: f64[MAXP * 2] = [0.0; MAXP * 2];
var env: f64[NENV * 2] = [0.0; NENV * 2];
var plate: f64[5] = [0.0; 5];
var freq: f64[NFREQ * 3] = [0.0; NFREQ * 3];

// ---- small dense linear algebra ----

// Inverts the n x n row-major matrix a into out by Gauss-Jordan with partial pivots.
// Returns false when a pivot is zero relative to the size of the matrix.
fn invert(n: i64, a: f64[:], out: f64[:]) -> bool {
    var w: f64[72] = [0.0; 72];
    var big = 0.0;
    for i in n {
        for j in n {
            w[i * 2 * n + j] = a[i * n + j];
            w[i * 2 * n + n + j] = if i == j { 1.0 } else { 0.0 };
            big = max(big, abs(a[i * n + j]));
        }
    }
    let m = 2 * n;
    for col in n {
        var p = col;
        for r in col + 1..n { if abs(w[r * m + col]) > abs(w[p * m + col]) { p = r; } }
        if !(abs(w[p * m + col]) > 1e-14 * big) { return false; }
        if p != col { for j in m { swap(w[p * m + j], w[col * m + j]); } }
        let d = w[col * m + col];
        for j in m { w[col * m + j] /= d; }
        for r in n {
            if r == col { continue; }
            let f = w[r * m + col];
            if f == 0.0 { continue; }
            for j in m { w[r * m + j] -= f * w[col * m + j]; }
        }
    }
    for i in n { for j in n { out[i * n + j] = w[i * m + n + j]; } }
    return true;
}

// The stress transformation from material to global axes for a turn of deg about z.
fn tsig(deg: f64, t: f64[:]) {
    let a = radians(deg);
    let m = cos(a);
    let n = sin(a);
    for i in 36 { t[i] = 0.0; }
    t[0] = m * m;      t[1] = n * n;      t[5] = -2.0 * m * n;
    t[6] = n * n;      t[7] = m * m;      t[11] = 2.0 * m * n;
    t[14] = 1.0;
    t[21] = m;         t[22] = n;
    t[27] = -n;        t[28] = m;
    t[30] = m * n;     t[31] = -m * n;    t[35] = m * m - n * n;
}

// out = t c t^T for n x n matrices.
fn congruent(n: i64, t: f64[:], c: f64[:], out: f64[:]) {
    var tc: f64[36] = [0.0; 36];
    for i in n { for j in n {
        var s = 0.0;
        for k in n { s += t[i * n + k] * c[k * n + j]; }
        tc[i * n + j] = s;
    } }
    for i in n { for j in n {
        var s = 0.0;
        for k in n { s += tc[i * n + k] * t[j * n + k]; }
        out[i * n + j] = s;
    } }
}

// ---- ply stiffness ----

fn ply_compliance(p: Ply, s: f64[:]) {
    for i in 36 { s[i] = 0.0; }
    s[0] = 1.0 / p.e1;           s[1] = -p.n12 / p.e1;   s[2] = -p.n13 / p.e1;
    s[6] = s[1];                 s[7] = 1.0 / p.e2;      s[8] = -p.n23 / p.e2;
    s[12] = s[2];                s[13] = s[8];           s[14] = 1.0 / p.e3;
    s[21] = 1.0 / p.g23;
    s[28] = 1.0 / p.g13;
    s[35] = 1.0 / p.g12;
}

// The shear terms of the compliance are positive, so it is positive definite when the
// leading minors of its normal block are positive.
fn pos_def(s: f64[:]) -> bool {
    let m2 = s[0] * s[7] - s[1] * s[1];
    let m3 = s[0] * (s[7] * s[14] - s[8] * s[8]) - s[1] * (s[1] * s[14] - s[8] * s[2]) +
             s[2] * (s[1] * s[8] - s[7] * s[2]);
    return s[0] > 0.0 && m2 > 0.0 && m3 > 0.0;
}

// The 3D stiffness, the conductivity and the reduced stiffness of each ply.
fn ply_stiffness() -> bool {
    for i in np {
        let p = plies[i];
        var s: f64[36] = [0.0; 36];
        var cm: f64[36] = [0.0; 36];
        var t: f64[36] = [0.0; 36];
        ply_compliance(p, s);
        if !pos_def(s) { return false; }
        if !invert(6, s, cm) { return false; }
        tsig(p.ang, t);
        congruent(6, t, cm, cg[i * 36..i * 36 + 36]);
        // Conductivity: R diag(k1, k2, k3) R^T, R turns by the angle about z.
        let a = radians(p.ang);
        let m = cos(a);
        let n = sin(a);
        let k = kg[i * 9..i * 9 + 9];
        k[0] = m * m * p.k1 + n * n * p.k2;
        k[1] = m * n * (p.k1 - p.k2);
        k[3] = k[1];
        k[4] = n * n * p.k1 + m * m * p.k2;
        k[2] = 0.0; k[5] = 0.0; k[6] = 0.0; k[7] = 0.0;
        k[8] = p.k3;
        // Plane stress: the in-plane block of the compliance, inverted.
        var s3: f64[9] = [s[0], s[1], 0.0, s[6], s[7], 0.0, 0.0, 0.0, s[35]];
        if !invert(3, s3, qm[i * 9..i * 9 + 9]) { return false; }
        var t3: f64[9] = [t[0], t[1], t[5], t[6], t[7], t[11], t[30], t[31], t[35]];
        congruent(3, t3, qm[i * 9..i * 9 + 9], qg[i * 9..i * 9 + 9]);
    }
    return true;
}

// ---- computational homogenization of the periodic cell ----

// Solves kmat x = rhs (nrhs columns) in place by Gauss elimination with partial pivots.
fn solve_dense(n: i64, nrhs: i64) -> bool {
    var big = 0.0;
    for i in n * n { big = max(big, abs(kmat[i])); }
    for col in n {
        var p = col;
        for r in col + 1..n { if abs(kmat[r * n + col]) > abs(kmat[p * n + col]) { p = r; } }
        if !(abs(kmat[p * n + col]) > 1e-14 * big) { return false; }
        if p != col {
            for j in n { swap(kmat[p * n + j], kmat[col * n + j]); }
            for j in nrhs { swap(rhs[p * 6 + j], rhs[col * 6 + j]); }
        }
        let d = kmat[col * n + col];
        for r in col + 1..n {
            let f = kmat[r * n + col] / d;
            if f == 0.0 { continue; }
            for j in col..n { kmat[r * n + j] -= f * kmat[col * n + j]; }
            for j in nrhs { rhs[r * 6 + j] -= f * rhs[col * 6 + j]; }
        }
    }
    var i = n - 1;
    while i >= 0 {
        for j in nrhs {
            var s = rhs[i * 6 + j];
            for k in i + 1..n { s -= kmat[i * n + k] * rhs[k * 6 + j]; }
            rhs[i * 6 + j] = s / kmat[i * n + i];
        }
        i -= 1;
    }
    return true;
}

// The unknown index of component a at node `node`, or -1 for node 0, which is fixed.
// Node ne is node 0 again: the cell is periodic along z.
fn dof(node: i64, ne: i64, ncomp: i64, a: i64) -> i64 {
    let k = node % ne;
    if k == 0 { -1 } else { (k - 1) * ncomp + a }
}

// The fluctuation u(z) is periodic and linear in each element. Its derivative u' adds
// to the macro strain E only in the components zz, yz and xz: eps = E + G u'.
let GIDX: i64[3] = [4, 3, 2];      // the Voigt component that u_x', u_y', u_z' change

fn homogenize(nel: i64) -> bool {
    let ne = np * nel;
    var h = 0.0;
    for i in np { h += plies[i].t; }
    // Mechanics: 6 load cases, each a unit macro strain.
    let n = 3 * (ne - 1);
    for i in n * n { kmat[i] = 0.0; }
    for i in n * 6 { rhs[i] = 0.0; }
    for e in ne {
        let p = e / nel;
        let le = plies[p].t / nel;
        let c = cg[p * 36..p * 36 + 36];
        for a in 3 {
            for b in 3 {
                let kab = c[GIDX[a] * 6 + GIDX[b]] / le;
                for x in 2 { for y in 2 {
                    let r = dof(e + x, ne, 3, a);
                    let s = dof(e + y, ne, 3, b);
                    if r >= 0 && s >= 0 { kmat[r * n + s] += if x == y { kab } else { -kab }; }
                } }
            }
            for j in 6 {
                let f = c[GIDX[a] * 6 + j];
                let r0 = dof(e, ne, 3, a);
                let r1 = dof(e + 1, ne, 3, a);
                if r0 >= 0 { rhs[r0 * 6 + j] += f; }
                if r1 >= 0 { rhs[r1 * 6 + j] -= f; }
            }
        }
    }
    if n > 0 && !solve_dense(n, 6) { return false; }
    for i in 36 { ceff[i] = 0.0; }
    for i in 6 * MAXP * 6 { chm_sig[i] = 0.0; }
    for e in ne {
        let p = e / nel;
        let le = plies[p].t / nel;
        let c = cg[p * 36..p * 36 + 36];
        for j in 6 {
            var eps: f64[6] = [0.0; 6];
            eps[j] = 1.0;
            for a in 3 {
                let r0 = dof(e, ne, 3, a);
                let r1 = dof(e + 1, ne, 3, a);
                let u0 = if r0 >= 0 { rhs[r0 * 6 + j] } else { 0.0 };
                let u1 = if r1 >= 0 { rhs[r1 * 6 + j] } else { 0.0 };
                eps[GIDX[a]] += (u1 - u0) / le;
            }
            for i in 6 {
                var s = 0.0;
                for k in 6 { s += c[i * 6 + k] * eps[k]; }
                ceff[i * 6 + j] += s * le / h;
                chm_sig[(j * MAXP + p) * 6 + i] += s / nel;
            }
        }
    }
    // Conduction: 3 load cases, each a unit macro temperature gradient. The flux is
    // q = -k (g + e_z theta'), and the effective conductivity maps g to -<q>.
    let nt = ne - 1;
    for i in nt * nt { kmat[i] = 0.0; }
    for i in nt * 6 { rhs[i] = 0.0; }
    for e in ne {
        let p = e / nel;
        let le = plies[p].t / nel;
        let k = kg[p * 9..p * 9 + 9];
        for x in 2 { for y in 2 {
            let r = dof(e + x, ne, 1, 0);
            let s = dof(e + y, ne, 1, 0);
            if r >= 0 && s >= 0 { kmat[r * nt + s] += if x == y { k[8] / le } else { -k[8] / le }; }
        } }
        for j in 3 {
            let r0 = dof(e, ne, 1, 0);
            let r1 = dof(e + 1, ne, 1, 0);
            if r0 >= 0 { rhs[r0 * 6 + j] += k[6 + j]; }
            if r1 >= 0 { rhs[r1 * 6 + j] -= k[6 + j]; }
        }
    }
    if nt > 0 && !solve_dense(nt, 3) { return false; }
    for i in 9 { keff[i] = 0.0; }
    for i in 3 * MAXP * 3 { chm_q[i] = 0.0; }
    for e in ne {
        let p = e / nel;
        let le = plies[p].t / nel;
        let k = kg[p * 9..p * 9 + 9];
        for j in 3 {
            var g: f64[3] = [0.0; 3];
            g[j] = 1.0;
            let r0 = dof(e, ne, 1, 0);
            let r1 = dof(e + 1, ne, 1, 0);
            let t0 = if r0 >= 0 { rhs[r0 * 6 + j] } else { 0.0 };
            let t1 = if r1 >= 0 { rhs[r1 * 6 + j] } else { 0.0 };
            g[2] += (t1 - t0) / le;
            for i in 3 {
                let f = k[i * 3] * g[0] + k[i * 3 + 1] * g[1] + k[i * 3 + 2] * g[2];
                keff[i * 3 + j] += f * le / h;
                chm_q[(j * MAXP + p) * 3 + i] -= f / nel;
            }
        }
    }
    if !invert(6, ceff, seff) { return false; }
    eng3[0] = 1.0 / seff[0];
    eng3[1] = 1.0 / seff[7];
    eng3[2] = 1.0 / seff[14];
    eng3[3] = 1.0 / seff[35];
    eng3[4] = 1.0 / seff[28];
    eng3[5] = 1.0 / seff[21];
    eng3[6] = -seff[1] / seff[0];
    eng3[7] = -seff[2] / seff[0];
    eng3[8] = -seff[8] / seff[7];
    var m = 0.0;
    var mc = 0.0;
    for i in np {
        m += plies[i].rho * plies[i].t;
        mc += plies[i].rho * plies[i].c * plies[i].t;
    }
    scal[0] = m / h;
    scal[1] = if m > 0.0 { mc / m } else { 0.0 };
    scal[2] = h;
    scal[3] = m;
    return true;
}

// ---- classical laminate theory ----

// The ABD matrix of the plies; a ply with failed[i] true keeps DISCOUNT of its stiffness.
fn build_abd(failed: bool[:], out: f64[:]) {
    for i in 36 { out[i] = 0.0; }
    for p in np {
        let f = if failed[p] { DISCOUNT } else { 1.0 };
        let z0 = zb[p];
        let z1 = zb[p + 1];
        for i in 3 {
            for j in 3 {
                let q = f * qg[p * 9 + i * 3 + j];
                out[i * 6 + j] += q * (z1 - z0);
                out[i * 6 + j + 3] += q * (z1 * z1 - z0 * z0) / 2.0;
                out[(i + 3) * 6 + j] += q * (z1 * z1 - z0 * z0) / 2.0;
                out[(i + 3) * 6 + j + 3] += q * (z1 * z1 * z1 - z0 * z0 * z0) / 3.0;
            }
        }
    }
}

// Mid-plane strains and curvatures for the generalized forces nm, through the inverse ABD.
fn deform(inv: f64[:], nm: f64[:], ek: f64[:]) {
    for i in 6 {
        var s = 0.0;
        for j in 6 { s += inv[i * 6 + j] * nm[j]; }
        ek[i] = s;
    }
}

// Strain and stress of ply p at z, in global then material axes: out holds 12 values.
fn ply_state(p: i64, ek: f64[:], z: f64, out: f64[:]) {
    var t: f64[36] = [0.0; 36];
    tsig(plies[p].ang, t);
    for i in 3 { out[i] = ek[i] + z * ek[i + 3]; }
    for i in 3 {
        var s = 0.0;
        for j in 3 { s += qg[p * 9 + i * 3 + j] * out[j]; }
        out[3 + i] = s;
    }
    // Material strains: eps_m = T^T eps_g, on the in-plane rows and columns (0, 1, 5).
    let ix: i64[3] = [0, 1, 5];
    for i in 3 {
        var s = 0.0;
        for j in 3 { s += t[ix[j] * 6 + ix[i]] * out[j]; }
        out[6 + i] = s;
    }
    for i in 3 {
        var s = 0.0;
        for j in 3 { s += qm[p * 9 + i * 3 + j] * out[6 + j]; }
        out[9 + i] = s;
    }
}

// ---- strength ----

// Positive root of a r^2 + b r = 1, or BIG.
fn quad_ratio(a: f64, b: f64) -> f64 {
    if a > 1e-300 { return (-b + sqrt(b * b + 4.0 * a)) / (2.0 * a); }
    if b > 0.0 { return 1.0 / b; }
    return BIG;
}

fn lin_ratio(fi: f64) -> f64 { if fi > 0.0 { 1.0 / fi } else { BIG } }

// The strength ratio of each criterion for the material state st (12 values from
// ply_state), and the Hashin mode that governs.
fn strength(p: Ply, st: f64[:], r: f64[:]) -> f64 {
    let e1 = st[6];
    let e2 = st[7];
    let g = st[8];
    let s1 = st[9];
    let s2 = st[10];
    let t = st[11];
    let x = if s1 >= 0.0 { p.xt } else { p.xc };
    let y = if s2 >= 0.0 { p.yt } else { p.yc };
    // Max stress.
    r[0] = lin_ratio(max(abs(s1) / x, max(abs(s2) / y, abs(t) / p.s)));
    // Max strain, with the strain allowables of a linear ply.
    let ex = if e1 >= 0.0 { p.xt / p.e1 } else { p.xc / p.e1 };
    let ey = if e2 >= 0.0 { p.yt / p.e2 } else { p.yc / p.e2 };
    r[1] = lin_ratio(max(abs(e1) / ex, max(abs(e2) / ey, abs(g) / (p.s / p.g12))));
    // Tsai-Hill.
    r[2] = quad_ratio(s1 * s1 / (x * x) - s1 * s2 / (x * x) + s2 * s2 / (y * y) + t * t / (p.s * p.s), 0.0);
    // Tsai-Wu, F12 = -sqrt(F11 F22) / 2.
    let f1 = 1.0 / p.xt - 1.0 / p.xc;
    let f2 = 1.0 / p.yt - 1.0 / p.yc;
    let f11 = 1.0 / (p.xt * p.xc);
    let f22 = 1.0 / (p.yt * p.yc);
    let f66 = 1.0 / (p.s * p.s);
    let f12 = -0.5 * sqrt(f11 * f22);
    r[3] = quad_ratio(f11 * s1 * s1 + f22 * s2 * s2 + f66 * t * t + 2.0 * f12 * s1 * s2, f1 * s1 + f2 * s2);
    // Hashin (1980), plane stress, with the transverse shear strength Yc / 2.
    let tt = t * t / (p.s * p.s);
    let rf = if s1 >= 0.0 { quad_ratio(s1 * s1 / (p.xt * p.xt) + tt, 0.0) }
             else { quad_ratio(s1 * s1 / (p.xc * p.xc), 0.0) };
    let rm = if s2 >= 0.0 { quad_ratio(s2 * s2 / (p.yt * p.yt) + tt, 0.0) }
             else { quad_ratio(s2 * s2 / (p.yc * p.yc) + tt, 0.0) };
    r[4] = min(rf, rm);
    return if rf <= rm { if s1 >= 0.0 { 0.0 } else { 1.0 } } else { if s2 >= 0.0 { 2.0 } else { 3.0 } };
}

// The least strength ratio of ply p over its bottom and top for the strains ek.
fn ply_ratio(p: i64, ek: f64[:], crit: i64) -> f64 {
    var st: f64[12] = [0.0; 12];
    var r: f64[NCRIT] = [0.0; NCRIT];
    var best = BIG;
    for k in 2 {
        ply_state(p, ek, zb[p + k], st);
        strength(plies[p], st, r);
        best = min(best, r[crit]);
    }
    return best;
}

// Generalized forces of the input load.
fn load_nm(nm: f64[:]) {
    if load_mode == 0 {
        for i in 6 { nm[i] = load_in[i]; }
    } else {
        for i in 6 {
            var s = 0.0;
            for j in 6 { s += abd[i * 6 + j] * load_in[j]; }
            nm[i] = s;
        }
    }
}

fn laminate() -> bool {
    var h = 0.0;
    for i in np { h += plies[i].t; }
    zb[0] = -h / 2.0;
    for i in np { zb[i + 1] = zb[i] + plies[i].t; }
    var none: bool[MAXP] = [false; MAXP];
    build_abd(none[..np], abd);
    if !invert(6, abd, abdi) { return false; }
    // Apparent constants of the free laminate, from the inverse ABD.
    lamc[0] = 1.0 / (h * abdi[0]);
    lamc[1] = 1.0 / (h * abdi[7]);
    lamc[2] = 1.0 / (h * abdi[14]);
    lamc[3] = -abdi[1] / abdi[0];
    lamc[4] = -abdi[1] / abdi[7];
    lamc[5] = abdi[2] / abdi[0];
    lamc[6] = abdi[8] / abdi[7];
    lamc[7] = 12.0 / (h * h * h * abdi[21]);
    lamc[8] = 12.0 / (h * h * h * abdi[28]);
    lamc[9] = 12.0 / (h * h * h * abdi[35]);
    lamc[10] = -abdi[22] / abdi[21];
    lamc[11] = -abdi[22] / abdi[28];
    // Couplings: B against A h, A16 and A26 against A11 and A22, D16 and D26 against D11 and D22.
    var bmax = 0.0;
    for i in 3 { for j in 3 { bmax = max(bmax, abs(abd[i * 6 + j + 3])); } }
    coup[0] = bmax / (h * max(abd[0], abd[7]));
    coup[1] = abs(abd[2]) / abd[0];
    coup[2] = abs(abd[8]) / abd[7];
    coup[3] = abs(abd[23]) / abd[21];
    coup[4] = abs(abd[29]) / abd[28];
    for i in 5 { coup[5 + i] = if coup[i] > SMALL { 1.0 } else { 0.0 }; }
    // The load.
    var nm: f64[6] = [0.0; 6];
    load_nm(nm);
    deform(abdi, nm, mid[..6]);
    for i in 6 { mid[6 + i] = nm[i]; }
    for p in np {
        for k in 2 { ply_state(p, mid[..6], zb[p + k], plyr[p * 24 + k * 12..p * 24 + k * 12 + 12]); }
    }
    // Strength ratios and first-ply failure.
    for c in NCRIT { fpf[c * 2] = BIG; fpf[c * 2 + 1] = -1.0; }
    for p in np {
        var r: f64[NCRIT] = [0.0; NCRIT];
        for c in NCRIT { ratio[p * NCRIT + c] = BIG; }
        for k in 2 {
            hmode[p] = strength(plies[p], plyr[p * 24 + k * 12..p * 24 + k * 12 + 12], r);
            for c in NCRIT { ratio[p * NCRIT + c] = min(ratio[p * NCRIT + c], r[c]); }
        }
        // The Hashin mode of the end of the ply with the lower ratio.
        var r0: f64[NCRIT] = [0.0; NCRIT];
        let m0 = strength(plies[p], plyr[p * 24..p * 24 + 12], r0);
        if r0[4] <= ratio[p * NCRIT + 4] { hmode[p] = m0; }
        for c in NCRIT {
            if ratio[p * NCRIT + c] < fpf[c * 2] { fpf[c * 2] = ratio[p * NCRIT + c]; fpf[c * 2 + 1] = p; }
        }
    }
    // Last-ply failure by ply discount: the failed ply keeps DISCOUNT of its stiffness,
    // the load factor at each failure is the larger of the last one and the new ratio.
    var failed: bool[MAXP] = [false; MAXP];
    var lf = 0.0;
    var steps = 0;
    var deg: f64[36] = [0.0; 36];
    var degi: f64[36] = [0.0; 36];
    var ek: f64[6] = [0.0; 6];
    for step in np {
        build_abd(failed[..np], deg);
        if !invert(6, deg, degi) { break; }
        deform(degi, nm, ek);
        var rmin = BIG;
        var pmin = -1;
        for p in np {
            if failed[p] { continue; }
            let r = ply_ratio(p, ek, lpf_crit);
            if r < rmin { rmin = r; pmin = p; }
        }
        if pmin < 0 || rmin >= BIG { break; }
        lf = max(lf, rmin);
        failed[pmin] = true;
        lpf_step[steps * 2] = pmin;
        lpf_step[steps * 2 + 1] = lf;
        steps += 1;
    }
    lpf[0] = if steps == np { lf } else { BIG };
    lpf[1] = steps;
    // First-ply failure envelope in the plane of load components env_ia and env_ib.
    for i in NENV {
        let a = TAU * i / NENV;
        var dir: f64[6] = [0.0; 6];
        dir[env_ia] += cos(a);
        dir[env_ib] += sin(a);
        deform(abdi, dir, ek);
        var rmin = BIG;
        for p in np { rmin = min(rmin, ply_ratio(p, ek, env_crit)); }
        env[i * 2] = rmin * cos(a);
        env[i * 2 + 1] = rmin * sin(a);
    }
    return true;
}

// ---- simply supported rectangular plate ----

// Specially orthotropic plate (Whitney, Structural Analysis of Laminated Anisotropic
// Plates, 1987): the closed forms use D11, D12, D22, D66 and drop B, D16 and D26.
fn plate_solve() {
    let a = plate_a;
    let b = plate_b;
    let d11 = abd[21];
    let d12 = abd[22];
    let d22 = abd[28];
    let d66 = abd[35];
    fn stiff(m: f64, n: f64) -> f64 {
        let x = m / a;
        let y = n / b;
        d11 * x * x * x * x + 2.0 * (d12 + 2.0 * d66) * x * x * y * y + d22 * y * y * y * y
    }
    plate[0] = BIG;
    plate[2] = BIG;
    for m in 1..41 {
        // Uniaxial Nx: n = 1 gives the least load. Uniaxial Ny: m = 1, with n here.
        let nx = PI * PI * stiff(m, 1.0) * a * a / (m * m);
        if nx < plate[0] { plate[0] = nx; plate[1] = m; }
        let ny = PI * PI * stiff(1.0, m) * b * b / (m * m);
        if ny < plate[2] { plate[2] = ny; plate[3] = m; }
    }
    plate[4] = if coup[5] + coup[8] + coup[9] > 0.0 { 1.0 } else { 0.0 };
    // Frequencies f_mn = pi / 2 sqrt(stiff / rho h), the lowest NFREQ for m, n up to 20.
    for i in NFREQ { freq[i * 3] = BIG; }
    for m in 1..21 {
        for n in 1..21 {
            var f = PI / 2.0 * sqrt(stiff(m, n) / scal[3]);
            var fm: f64 = m;
            var fn_: f64 = n;
            for i in NFREQ {
                if f < freq[i * 3] {
                    swap(f, freq[i * 3]);
                    swap(fm, freq[i * 3 + 1]);
                    swap(fn_, freq[i * 3 + 2]);
                }
            }
        }
    }
}

// ---- the exported interface ----

export fn lam_clear() { np = 0; }

// Adds a ply on top of the stack. Returns its index, or -1 when the stack is full.
export fn ply_add(t: f64, ang: f64,
                  e1: f64, e2: f64, e3: f64, g12: f64, g13: f64, g23: f64,
                  n12: f64, n13: f64, n23: f64, k1: f64, k2: f64, k3: f64, rho: f64, c: f64,
                  xt: f64, xc: f64, yt: f64, yc: f64, s: f64) -> i32 {
    if np >= MAXP { return -1; }
    plies[np] = Ply { t, ang, e1, e2, e3, g12, g13, g23, n12, n13, n23, k1, k2, k3, rho, c,
                      xt, xc, yt, yc, s };
    np += 1;
    return (np - 1) as i32;
}

export fn set_load(mode: i32, a: f64, b: f64, c: f64, d: f64, e: f64, f: f64) {
    load_mode = mode;
    load_in = [a, b, c, d, e, f];
}

export fn set_plate(a: f64, b: f64) { plate_a = a; plate_b = b; }
export fn set_envelope(ia: i32, ib: i32, crit: i32) { env_ia = ia % 6; env_ib = ib % 6; env_crit = crit % NCRIT; }
export fn set_lpf(crit: i32) { lpf_crit = crit % NCRIT; }

// Status codes of solve.
let OK = 0;
let ERR_EMPTY = 1;
let ERR_INPUT = 2;
let ERR_PLY = 3;
let ERR_CELL = 4;
let ERR_ABD = 5;

fn valid(p: Ply) -> bool {
    p.t > 0.0 && abs(p.ang) < BIG && p.e1 > 0.0 && p.e2 > 0.0 && p.e3 > 0.0 && p.g12 > 0.0 && p.g13 > 0.0 &&
    p.g23 > 0.0 && p.k1 >= 0.0 && p.k2 >= 0.0 && p.k3 > 0.0 && p.rho >= 0.0 && p.c >= 0.0 &&
    p.xt > 0.0 && p.xc > 0.0 && p.yt > 0.0 && p.yc > 0.0 && p.s > 0.0
}

fn all_valid() -> bool {
    for i in np { if !valid(plies[i]) { return false; } }
    return true;
}

// Computes every result with nel finite elements through each ply. Returns a status code.
export fn solve(nel: i32) -> i32 {
    status = block {
        guard np > 0 else { break ERR_EMPTY; }
        guard nel >= 1 && nel <= MAXEL && plate_a > 0.0 && plate_b > 0.0 else { break ERR_INPUT; }
        guard all_valid() else { break ERR_INPUT; }
        guard ply_stiffness() else { break ERR_PLY; }
        guard homogenize(nel) else { break ERR_CELL; }
        guard laminate() else { break ERR_ABD; }
        plate_solve();
        OK
    };
    return status as i32;
}

fn pick(xs: f64[:], k: i64) -> f64 { if k >= 0 && k < xs.len { xs[k] } else { 0.0 } }

// Result kinds of res.
let R_CEFF = 0;       // effective stiffness, (i, j) of 6 x 6
let R_SEFF = 1;       // effective compliance
let R_ENG3 = 2;       // i: Ex Ey Ez Gxy Gxz Gyz nuxy nuxz nuyz
let R_KEFF = 3;       // effective conductivity, (i, j) of 3 x 3
let R_SCAL = 4;       // i: density, specific heat, thickness, areal mass
let R_CHMSIG = 5;     // stress of load case i in ply j / 6, component j % 6
let R_CHMQ = 6;       // heat flux of gradient case i in ply j / 3, component j % 3
let R_ABD = 7;        // (i, j) of 6 x 6
let R_ABDI = 8;       // inverse ABD
let R_LAMC = 9;       // i: Ex Ey Gxy nuxy nuyx etaxs etays, flexural Ex Ey Gxy nuxy nuyx
let R_COUP = 10;      // i: B, A16, A26, D16, D26 ratio; 5 + i the flag
let R_MID = 11;       // i: mid-plane strains and curvatures, then N and M
let R_PLY = 12;       // ply i, j: 12 values at the bottom, then 12 at the top
let R_Z = 13;         // ply i, j: z of the bottom (0) and top (1)
let R_RATIO = 14;     // ply i, criterion j: strength ratio
let R_HMODE = 15;     // ply i: Hashin mode
let R_FPF = 16;       // criterion i, j: ratio (0), ply (1)
let R_LPF = 17;       // i: load factor, number of failures
let R_LPFSTEP = 18;   // failure i, j: ply (0), load factor (1)
let R_ENV = 19;       // point i, j: first (0) and second (1) load component
let R_PLATE = 20;     // i: Nx cr, m, Ny cr, n, flag for B, D16 or D26
let R_FREQ = 21;      // mode i, j: frequency (0), m (1), n (2)
let R_STATUS = 22;
let R_NPLY = 23;

export fn res(kind: i32, i: i32, j: i32) -> f64 {
    let a: i64 = i;
    let b: i64 = j;
    return match kind {
        R_CEFF => pick(ceff, a * 6 + b),
        R_SEFF => pick(seff, a * 6 + b),
        R_ENG3 => pick(eng3, a),
        R_KEFF => pick(keff, a * 3 + b),
        R_SCAL => pick(scal, a),
        R_CHMSIG => if b >= 0 && b < np * 6 { pick(chm_sig, (a * MAXP + b / 6) * 6 + b % 6) } else { 0.0 },
        R_CHMQ => if b >= 0 && b < np * 3 { pick(chm_q, (a * MAXP + b / 3) * 3 + b % 3) } else { 0.0 },
        R_ABD => pick(abd, a * 6 + b),
        R_ABDI => pick(abdi, a * 6 + b),
        R_LAMC => pick(lamc, a),
        R_COUP => pick(coup, a),
        R_MID => pick(mid, a),
        R_PLY => if b >= 0 && b < 24 { pick(plyr, a * 24 + b) } else { 0.0 },
        R_Z => if b >= 0 && b < 2 { pick(zb, a + b) } else { 0.0 },
        R_RATIO => if b >= 0 && b < NCRIT { pick(ratio, a * NCRIT + b) } else { 0.0 },
        R_HMODE => pick(hmode, a),
        R_FPF => pick(fpf, a * 2 + b),
        R_LPF => pick(lpf, a),
        R_LPFSTEP => pick(lpf_step, a * 2 + b),
        R_ENV => pick(env, a * 2 + b),
        R_PLATE => pick(plate, a),
        R_FREQ => pick(freq, a * 3 + b),
        R_STATUS => status,
        R_NPLY => np,
        _ => 0.0,
    };
}
