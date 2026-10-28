// Tests of the solver against closed-form and published references.
// Run: goose solver/test.goose (the run fails if one check fails).

import plyhouse;

var fails = 0;
var checks = 0;

fn check(name: const u8[:], got: f64, want: f64, rtol: f64, atol: f64 = 0.0) {
    checks += 1;
    if !(abs(got - want) <= rtol * abs(want) + atol) {
        fails += 1;
        print("FAIL ", name, ": got ", got, ", want ", want);
    }
}

// ---- materials ----

struct Mat {
    e1: f64, e2: f64, e3: f64, g12: f64, g13: f64, g23: f64, n12: f64, n13: f64, n23: f64,
    k1: f64, k2: f64, k3: f64, rho: f64, c: f64, xt: f64, xc: f64, yt: f64, yc: f64, s: f64,
}

fn iso(e: f64, nu: f64, k: f64, rho: f64, c: f64) -> Mat {
    let g = e / (2.0 * (1.0 + nu));
    return Mat { e, e, e, g, g, g, nu, nu, nu, k, k, k, rho, c, 100.0, 100.0, 100.0, 100.0, 50.0 };
}

// femahoy grid-laminate-cell, derivation.md.
let ALU = iso(70000.0, 0.33, 200.0, 2.7e-9, 9.0e8);
let POLY = iso(3000.0, 0.38, 0.25, 1.2e-9, 1.5e9);
// Carbon/epoxy T300/5208: elastic constants and strengths of S. W. Tsai and H. T. Hahn,
// Introduction to Composite Materials, 1980, table 7.1 (MPa); typical out-of-plane values.
let CE = Mat { 181000.0, 10300.0, 10300.0, 7170.0, 7170.0, 3456.4, 0.28, 0.28, 0.49,
               7.0, 0.8, 0.8, 1.6e-9, 1.1e9, 1500.0, 1500.0, 40.0, 246.0, 68.0 };
// A glass/epoxy, for a stack of 3 materials.
let GE = Mat { 38600.0, 8270.0, 8270.0, 4140.0, 4140.0, 2900.0, 0.26, 0.26, 0.43,
               1.1, 0.35, 0.35, 1.8e-9, 0.9e9, 1062.0, 610.0, 31.0, 118.0, 72.0 };

fn add(m: Mat, t: f64, ang: f64) {
    ply_add(t, ang, m.e1, m.e2, m.e3, m.g12, m.g13, m.g23, m.n12, m.n13, m.n23,
            m.k1, m.k2, m.k3, m.rho, m.c, m.xt, m.xc, m.yt, m.yc, m.s);
}

fn quasi_iso(t: f64) {
    lam_clear();
    for a in [0.0, 45.0, -45.0, 90.0, 90.0, -45.0, 45.0, 0.0] { add(CE, t, a); }
}

// ---- an independent reference: tensor rotation and exact layer theory ----

// The Voigt index of the tensor pair (i, j).
fn voigt(i: i64, j: i64) -> i64 {
    if i == j { i } else { 6 - i - j }
}

// The global 3D stiffness of a ply by rotation of the 4th-order tensor about z.
fn ref_stiffness(m: Mat, ang: f64, out: f64[:]) {
    var s: f64[36] = [0.0; 36];
    var c: f64[36] = [0.0; 36];
    s[0] = 1.0 / m.e1; s[1] = -m.n12 / m.e1; s[2] = -m.n13 / m.e1;
    s[6] = s[1]; s[7] = 1.0 / m.e2; s[8] = -m.n23 / m.e2;
    s[12] = s[2]; s[13] = s[8]; s[14] = 1.0 / m.e3;
    s[21] = 1.0 / m.g23; s[28] = 1.0 / m.g13; s[35] = 1.0 / m.g12;
    assert(invert(6, s, c));
    let a = radians(ang);
    let r: f64[9] = [cos(a), -sin(a), 0.0, sin(a), cos(a), 0.0, 0.0, 0.0, 1.0];
    for i in 3 { for j in 3 { for k in 3 { for l in 3 {
        var v = 0.0;
        for p in 3 { for q in 3 { for u in 3 { for w in 3 {
            v += r[i * 3 + p] * r[j * 3 + q] * r[k * 3 + u] * r[l * 3 + w] * c[voigt(p, q) * 6 + voigt(u, w)];
        } } } }
        out[voigt(i, j) * 6 + voigt(k, l)] = v;
    } } } }
}

// Exact effective stiffness and conductivity of a stack: in-plane strains and the
// stresses across the plies are the same in each ply (R. M. Jones, Mechanics of
// Composite Materials, 1999, chapter 4; the partition of femahoy's derivation.md).
fn ref_layers(mats: Mat[:], angs: f64[:], ts: f64[:], ce: f64[:], ke: f64[:]) {
    let pi: i64[3] = [0, 1, 5];
    let ni: i64[3] = [2, 3, 4];
    var h = 0.0;
    for t in ts { h += t; }
    var inn: f64[9] = [0.0; 9];    // <Cnn^-1>
    var inp: f64[9] = [0.0; 9];    // <Cnn^-1 Cnp>
    var pnn: f64[9] = [0.0; 9];    // <Cpn Cnn^-1>
    var ppp: f64[9] = [0.0; 9];    // <Cpp - Cpn Cnn^-1 Cnp>
    var kzz = 0.0;
    var kz: f64[2] = [0.0; 2];
    var kpp: f64[4] = [0.0; 4];
    for m, l in mats {
        let f = ts[l] / h;
        var c: f64[36] = [0.0; 36];
        ref_stiffness(m, angs[l], c);
        var nn: f64[9] = [0.0; 9];
        var nni: f64[9] = [0.0; 9];
        for i in 3 { for j in 3 { nn[i * 3 + j] = c[ni[i] * 6 + ni[j]]; } }
        assert(invert(3, nn, nni));
        for i in 3 { for j in 3 {
            inn[i * 3 + j] += f * nni[i * 3 + j];
            var a = 0.0;
            var b = 0.0;
            var d = 0.0;
            for k in 3 {
                a += nni[i * 3 + k] * c[ni[k] * 6 + pi[j]];
                b += c[pi[i] * 6 + ni[k]] * nni[k * 3 + j];
                for q in 3 { d += c[pi[i] * 6 + ni[k]] * nni[k * 3 + q] * c[ni[q] * 6 + pi[j]]; }
            }
            inp[i * 3 + j] += f * a;
            pnn[i * 3 + j] += f * b;
            ppp[i * 3 + j] += f * (c[pi[i] * 6 + pi[j]] - d);
        } }
        // Conductivity: the angle turns k1, k2 in the plane; k3 is along z.
        let a = radians(angs[l]);
        let cs = cos(a);
        let sn = sin(a);
        let kxy: f64[4] = [cs * cs * m.k1 + sn * sn * m.k2, cs * sn * (m.k1 - m.k2),
                           cs * sn * (m.k1 - m.k2), sn * sn * m.k1 + cs * cs * m.k2];
        kzz += f / m.k3;
        for i in 4 { kpp[i] += f * kxy[i]; }
    }
    var cnn: f64[9] = [0.0; 9];
    assert(invert(3, inn, cnn));
    for i in 36 { ce[i] = 0.0; }
    for i in 3 { for j in 3 {
        ce[ni[i] * 6 + ni[j]] = cnn[i * 3 + j];
        var a = 0.0;
        var d = 0.0;
        for k in 3 {
            a += cnn[i * 3 + k] * inp[k * 3 + j];
            for q in 3 { d += pnn[i * 3 + k] * cnn[k * 3 + q] * inp[q * 3 + j]; }
        }
        ce[ni[i] * 6 + pi[j]] = a;
        ce[pi[j] * 6 + ni[i]] = a;
        ce[pi[i] * 6 + pi[j]] = ppp[i * 3 + j] + d;
    } }
    for i in 9 { ke[i] = 0.0; }
    ke[0] = kpp[0]; ke[1] = kpp[1]; ke[3] = kpp[2]; ke[4] = kpp[3];
    ke[8] = 1.0 / kzz;
}

fn check_layers(name: const u8[:], mats: Mat[:], angs: f64[:], ts: f64[:]) {
    lam_clear();
    for m, i in mats { add(m, ts[i], angs[i]); }
    check(str(name, " status"), solve(2), 0.0, 0.0);
    var ce: f64[36] = [0.0; 36];
    var ke: f64[9] = [0.0; 9];
    ref_layers(mats, angs, ts, ce, ke);
    var cmax = 0.0;
    for v in ce { cmax = max(cmax, abs(v)); }
    for i: i32 in 0..6 { for j: i32 in 0..6 { check(str(name, " C", i + 1, j + 1), res(R_CEFF, i, j), ce[i * 6 + j], 1e-9, 1e-12 * cmax); } }
    for i: i32 in 0..3 { for j: i32 in 0..3 { check(str(name, " k", i + 1, j + 1), res(R_KEFF, i, j), ke[i * 3 + j], 1e-9, 1e-12); } }
}

// ---- tests ----

// femahoy validation case grid-laminate-cell: check.toml and derivation.md.
fn test_femahoy() {
    for nel in [1 as i32, 4] {
        lam_clear();
        add(ALU, 0.3, 0.0);
        add(POLY, 0.7, 0.0);
        check("femahoy status", solve(nel), 0.0, 0.0);
        check("femahoy kxx", res(R_KEFF, 0, 0), 60.175, 1e-6);
        check("femahoy kyy", res(R_KEFF, 1, 1), 60.175, 1e-6);
        check("femahoy kzz", res(R_KEFF, 2, 2), 0.3569516331, 1e-6);
        check("femahoy c11", res(R_CEFF, 0, 0), 28629.36401, 1e-6);
        check("femahoy c12", res(R_CEFF, 0, 1), 11318.1512, 1e-6);
        check("femahoy c13", res(R_CEFF, 0, 2), 4522.533011, 1e-6);
        check("femahoy c33", res(R_CEFF, 2, 2), 7840.818918, 1e-6);
        check("femahoy c44", res(R_CEFF, 3, 3), 1525.78578, 1e-6);
        check("femahoy c55", res(R_CEFF, 4, 4), 1525.78578, 1e-6);
        check("femahoy c66", res(R_CEFF, 5, 5), 8655.606407, 1e-6);
        check("femahoy density", res(R_SCAL, 0, 0), 1.65e-9, 1e-6);
        check("femahoy specific heat", res(R_SCAL, 1, 0), 1205454545.0, 1e-6);
        // Across the plies the stress of the zz case is the same in each ply: C33*.
        check("femahoy szz ply 0", res(R_CHMSIG, 2, 0 * 6 + 2), 7840.818918, 1e-6);
        check("femahoy szz ply 1", res(R_CHMSIG, 2, 1 * 6 + 2), 7840.818918, 1e-6);
        // The flux of the z gradient case is -kzz* in each ply.
        check("femahoy qz ply 1", res(R_CHMQ, 2, 1 * 3 + 2), -0.3569516331, 1e-6);
    }
}

fn test_layer_theory() {
    let qi: Mat[8] = [CE; 8];
    check_layers("[0/45/-45/90]s", qi, [0.0, 45.0, -45.0, 90.0, 90.0, -45.0, 45.0, 0.0], [0.125; 8]);
    // Not balanced, not symmetric, 3 materials and unequal thicknesses: all 36 terms.
    check_layers("[30/-60/15]", [CE, GE, ALU], [30.0, -60.0, 15.0], [0.2, 0.35, 0.1]);
}

// Classical laminate theory.
fn test_clt() {
    // A quasi-isotropic laminate is isotropic in its plane.
    quasi_iso(0.125);
    check("qi status", solve(2), 0.0, 0.0);
    let ex = res(R_LAMC, 0, 0);
    let nu = res(R_LAMC, 3, 0);
    check("qi Ey = Ex", res(R_LAMC, 1, 0), ex, 1e-12);
    check("qi Gxy = Ex / 2(1 + nu)", res(R_LAMC, 2, 0), ex / (2.0 * (1.0 + nu)), 1e-12);
    check("qi A16", res(R_ABD, 0, 2), 0.0, 0.0, 1e-9 * res(R_ABD, 0, 0));
    // The periodic cell and CLT give the same in-plane constants for a symmetric laminate.
    check("qi Ex cell = CLT", res(R_ENG3, 0, 0), ex, 1e-9);
    check("qi Gxy cell = CLT", res(R_ENG3, 3, 0), res(R_LAMC, 2, 0), 1e-9);
    check("qi nuxy cell = CLT", res(R_ENG3, 6, 0), nu, 1e-9);
    check("qi B flag", res(R_COUP, 5, 0), 0.0, 0.0);
    check("qi A16 flag", res(R_COUP, 6, 0), 0.0, 0.0);
    check("qi D16 flag", res(R_COUP, 8, 0), 1.0, 0.0);

    // An isotropic plate: A = E h / (1 - nu^2) [1 nu 0; nu 1 0; 0 0 (1 - nu) / 2], D = A h^2 / 12.
    lam_clear();
    add(ALU, 2.0, 0.0);
    check("iso status", solve(1), 0.0, 0.0);
    let q = 70000.0 / (1.0 - 0.33 * 0.33);
    check("iso A11", res(R_ABD, 0, 0), q * 2.0, 1e-12);
    check("iso A12", res(R_ABD, 0, 1), 0.33 * q * 2.0, 1e-12);
    check("iso A66", res(R_ABD, 2, 2), 70000.0 / 2.66 * 2.0, 1e-12);
    check("iso D11", res(R_ABD, 3, 3), q * 8.0 / 12.0, 1e-12);
    check("iso B11", res(R_ABD, 0, 3), 0.0, 0.0, 1e-9);
    check("iso flexural E", res(R_LAMC, 7, 0), 70000.0, 1e-12);

    // An antisymmetric cross-ply [0/90], each ply t: B11 = -B22 = t^2 (Q22 - Q11) / 2.
    let t = 0.25;
    lam_clear();
    add(CE, t, 0.0);
    add(CE, t, 90.0);
    check("[0/90] status", solve(1), 0.0, 0.0);
    let n21 = CE.n12 * CE.e2 / CE.e1;
    let q11 = CE.e1 / (1.0 - CE.n12 * n21);
    let q22 = CE.e2 / (1.0 - CE.n12 * n21);
    let q12 = CE.n12 * q22;
    let q66 = CE.g12;
    check("[0/90] B11", res(R_ABD, 0, 3), t * t * (q22 - q11) / 2.0, 1e-12);
    check("[0/90] B22", res(R_ABD, 1, 4), t * t * (q11 - q22) / 2.0, 1e-12);
    check("[0/90] B flag", res(R_COUP, 5, 0), 1.0, 0.0);
    check("[0/90] A16 flag", res(R_COUP, 6, 0), 0.0, 0.0);

    // One off-axis ply: A16 = h Qbar16 (Jones, equation 2.85).
    lam_clear();
    add(CE, 1.0, 30.0);
    check("[30] status", solve(1), 0.0, 0.0);
    let m = cos(radians(30.0));
    let n = sin(radians(30.0));
    let q16 = (q11 - q12 - 2.0 * q66) * m * m * m * n + (q12 - q22 + 2.0 * q66) * m * n * n * n;
    let q26 = (q11 - q12 - 2.0 * q66) * m * n * n * n + (q12 - q22 + 2.0 * q66) * m * m * m * n;
    check("[30] A16", res(R_ABD, 0, 2), q16, 1e-12);
    check("[30] A26", res(R_ABD, 1, 2), q26, 1e-12);
    check("[30] A16 flag", res(R_COUP, 6, 0), 1.0, 0.0);
    check("[30] D16 flag", res(R_COUP, 8, 0), 1.0, 0.0);
}

// Ply strains and stresses for a load.
fn test_loads() {
    // A moment on an isotropic plate: sigma_x = 6 M / h^2 at the top, -6 M / h^2 at the bottom.
    lam_clear();
    add(ALU, 2.0, 0.0);
    set_load(0, 0.0, 0.0, 0.0, 100.0, 0.0, 0.0);
    check("Mx status", solve(1), 0.0, 0.0);
    check("Mx top sx", res(R_PLY, 0, 12 + 3), 6.0 * 100.0 / 4.0, 1e-12);
    check("Mx bottom sx", res(R_PLY, 0, 3), -6.0 * 100.0 / 4.0, 1e-12);
    // Strains given: a curvature kx gives sigma_x = E / (1 - nu^2) z kx and Mx = D11 kx.
    set_load(1, 0.0, 0.0, 0.0, 1e-3, 0.0, 0.0);
    check("kx status", solve(1), 0.0, 0.0);
    let q = 70000.0 / (1.0 - 0.33 * 0.33);
    check("kx top sx", res(R_PLY, 0, 12 + 3), q * 1.0 * 1e-3, 1e-12);
    check("kx Mx", res(R_MID, 9, 0), q * 8.0 / 12.0 * 1e-3, 1e-12);
    // A 45 ply under sigma_x: sigma_1 = sigma_2 = sigma_x / 2, tau_12 = -sigma_x / 2.
    lam_clear();
    add(CE, 0.5, 45.0);
    set_load(0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    check("45 status", solve(1), 0.0, 0.0);
    check("45 s1", res(R_PLY, 0, 9), 1.0, 1e-12);
    check("45 s2", res(R_PLY, 0, 10), 1.0, 1e-12);
    check("45 t12", res(R_PLY, 0, 11), -1.0, 1e-12);
}

// Strength of one ply under one stress: every criterion gives the strength itself.
fn uniaxial(name: const u8[:], ang: f64, n: f64, nxy: f64, want: f64) {
    lam_clear();
    add(CE, 1.0, ang);
    set_load(0, n, 0.0, nxy, 0.0, 0.0, 0.0);
    check(str(name, " status"), solve(1), 0.0, 0.0);
    for c: i32 in 0..NCRIT { check(str(name, " criterion ", c), res(R_RATIO, 0, c), want, 1e-9); }
}

fn test_strength() {
    uniaxial("0 tension", 0.0, 1.0, 0.0, CE.xt);
    uniaxial("0 compression", 0.0, -1.0, 0.0, CE.xc);
    uniaxial("90 tension", 90.0, 1.0, 0.0, CE.yt);
    uniaxial("90 compression", 90.0, -1.0, 0.0, CE.yc);
    uniaxial("0 shear", 0.0, 0.0, 1.0, CE.s);
    // Off-axis tension of a ply at angle a: sigma_1 = c^2 s, sigma_2 = s^2 s, tau_12 = -c s s.
    lam_clear();
    add(CE, 1.0, 30.0);
    set_load(0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    check("30 status", solve(1), 0.0, 0.0);
    let c = cos(radians(30.0));
    let s = sin(radians(30.0));
    // Max stress (Jones, section 2.9.2): the least of X / c^2, Y / s^2, S / (c s).
    check("30 max stress", res(R_RATIO, 0, 0), min(CE.xt / (c * c), min(CE.yt / (s * s), CE.s / (c * s))), 1e-12);
    // Tsai-Hill (V. D. Azzi and S. W. Tsai, Exp. Mech. 5, 1965):
    // 1 / sx^2 = c^4 / X^2 + (1 / S^2 - 1 / X^2) c^2 s^2 + s^4 / Y^2.
    let x = CE.xt;
    let y = CE.yt;
    let th = c * c * c * c / (x * x) + (1.0 / (CE.s * CE.s) - 1.0 / (x * x)) * c * c * s * s + s * s * s * s / (y * y);
    check("30 Tsai-Hill", res(R_RATIO, 0, 2), 1.0 / sqrt(th), 1e-12);
    // Tsai-Wu: F1 c^2 sx + F2 s^2 sx + (F11 c^4 + F22 s^4 + (F66 + 2 F12) c^2 s^2) sx^2 = 1.
    let f11 = 1.0 / (CE.xt * CE.xc);
    let f22 = 1.0 / (CE.yt * CE.yc);
    let f12 = -0.5 * sqrt(f11 * f22);
    let qa = f11 * c * c * c * c + f22 * s * s * s * s + (1.0 / (CE.s * CE.s) + 2.0 * f12) * c * c * s * s;
    let qb = (1.0 / CE.xt - 1.0 / CE.xc) * c * c + (1.0 / CE.yt - 1.0 / CE.yc) * s * s;
    check("30 Tsai-Wu", res(R_RATIO, 0, 3), (-qb + sqrt(qb * qb + 4.0 * qa)) / (2.0 * qa), 1e-12);
    // Hashin: the matrix tension mode, (sigma_2 / Yt)^2 + (tau_12 / S)^2 = 1.
    check("30 Hashin", res(R_RATIO, 0, 4), 1.0 / sqrt(s * s * s * s / (y * y) + c * c * s * s / (CE.s * CE.s)), 1e-12);
    check("30 Hashin mode", res(R_HMODE, 0, 0), 2.0, 0.0);

    // Cross-ply [0/90]s under Nx, max stress. First-ply failure: the 90 plies at
    // sigma_2 = Yt. Last-ply failure: the 0 plies carry Nx alone, sigma_1 = Nx / h0 = Xt.
    let t = 0.25;
    lam_clear();
    add(CE, t, 0.0); add(CE, t, 90.0); add(CE, t, 90.0); add(CE, t, 0.0);
    set_load(0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    set_lpf(0);
    check("[0/90]s status", solve(1), 0.0, 0.0);
    let n21 = CE.n12 * CE.e2 / CE.e1;
    let q11 = CE.e1 / (1.0 - CE.n12 * n21);
    let q22 = CE.e2 / (1.0 - CE.n12 * n21);
    let q12 = CE.n12 * q22;
    let a11 = 2.0 * t * (q11 + q22);
    let a12 = 4.0 * t * q12;
    let ex = a11 / (a11 * a11 - a12 * a12);
    let ey = -a12 / (a11 * a11 - a12 * a12);
    check("[0/90]s first-ply failure", res(R_FPF, 0, 0), CE.yt / (q22 * ex + q12 * ey), 1e-9);
    check("[0/90]s first ply", res(R_FPF, 0, 1), 1.0, 0.0);
    check("[0/90]s failures", res(R_LPF, 1, 0), 4.0, 0.0);
    check("[0/90]s last-ply failure", res(R_LPF, 0, 0), CE.xt * 2.0 * t, 1e-4);

    // Envelope of one 0 ply in Nx, Ny with max stress: Xt h, Yt h, -Xc h, -Yc h on the axes.
    lam_clear();
    add(CE, 1.0, 0.0);
    set_envelope(0, 1, 0);
    check("envelope status", solve(1), 0.0, 0.0);
    check("envelope Nx+", res(R_ENV, 0, 0), CE.xt, 1e-9);
    check("envelope Ny+", res(R_ENV, NENV / 4, 1), CE.yt, 1e-9);
    check("envelope Nx-", res(R_ENV, NENV / 2, 0), -CE.xc, 1e-9);
    check("envelope Ny-", res(R_ENV, 3 * NENV / 4, 1), -CE.yc, 1e-9);
    set_envelope(0, 1, 3);
}

// A simply supported isotropic plate (S. P. Timoshenko and J. M. Gere, Theory of
// Elastic Stability, 1961; A. W. Leissa, Vibration of Plates, NASA SP-160, 1969).
fn test_plate() {
    let h = 2.0;
    let d = 70000.0 * h * h * h / (12.0 * (1.0 - 0.33 * 0.33));
    let rh = 2.7e-9 * h;
    lam_clear();
    add(ALU, h, 0.0);
    for ar in [1.0, 2.0, 3.0] {
        let b = 200.0;
        set_plate(ar * b, b);
        check("plate status", solve(1), 0.0, 0.0);
        // A long plate buckles in square half-waves: Nx = 4 pi^2 D / b^2, m = a / b.
        check(str("plate a/b ", ar, " Nx"), res(R_PLATE, 0, 0), 4.0 * PI * PI * d / (b * b), 1e-12);
        check(str("plate a/b ", ar, " m"), res(R_PLATE, 1, 0), ar, 0.0);
        // f11 = pi / 2 (1 / a^2 + 1 / b^2) sqrt(D / rho h).
        let a = ar * b;
        check(str("plate a/b ", ar, " f11"), res(R_FREQ, 0, 0), PI / 2.0 * (1.0 / (a * a) + 1.0 / (b * b)) * sqrt(d / rh), 1e-12);
    }
    // A square plate: f12 = f21 = pi / 2 (5 / a^2) sqrt(D / rho h) are modes 2 and 3.
    set_plate(200.0, 200.0);
    check("square status", solve(1), 0.0, 0.0);
    check("square f12", res(R_FREQ, 1, 0), PI / 2.0 * 5.0 / 40000.0 * sqrt(d / rh), 1e-12);
    check("square f21", res(R_FREQ, 2, 0), PI / 2.0 * 5.0 / 40000.0 * sqrt(d / rh), 1e-12);
    check("square approximation flag", res(R_PLATE, 4, 0), 0.0, 0.0);
    quasi_iso(0.125);
    check("qi plate status", solve(1), 0.0, 0.0);
    check("qi approximation flag (D16)", res(R_PLATE, 4, 0), 1.0, 0.0);
    set_plate(500.0, 250.0);
}

fn test_input() {
    lam_clear();
    check("empty", solve(1), ERR_EMPTY, 0.0);
    add(CE, 0.0, 0.0);
    check("zero thickness", solve(1), ERR_INPUT, 0.0);
    lam_clear();
    add(CE, 1.0, 0.0);
    check("too many elements", solve(MAXEL + 1), ERR_INPUT, 0.0);
    lam_clear();
    add(iso(1000.0, 0.6, 1.0, 1.0, 1.0), 1.0, 0.0);
    check("nu = 0.6", solve(1), ERR_PLY, 0.0);
    lam_clear();
    add(CE, 1.0, 0.0 / 0.0);
    check("NaN angle", solve(1), ERR_INPUT, 0.0);
    lam_clear();
    for i in MAXP { add(CE, 0.1, 0.0); }
    check("full stack", ply_add(0.1, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0,
                                1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0), -1.0, 0.0);
    check("full stack status", solve(MAXEL), OK, 0.0);
}

fn main() {
    test_femahoy();
    test_layer_theory();
    test_clt();
    test_loads();
    test_strength();
    test_plate();
    test_input();
    print(checks - fails, " of ", checks, " checks pass");
    if fails > 0 { exit(1); }
}
