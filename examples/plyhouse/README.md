# plyhouse

Homogenised mechanical and thermal properties of a laminate, in one HTML file.

Open `plyhouse.html` in a browser. It works offline and needs no server. Edit the layup or the material library, and the page solves again at once.

## What it computes

The laminate is a stack of plies along z. Ply 1 is at the bottom. Each ply is orthotropic in its material axes (1 along the fibre, 3 along z) or isotropic, and turns by any angle about z. Units are consistent. The defaults are SI-mm: mm, MPa, t/mm³.

- **Homogenisation (CHM).** The solver solves the periodic cell problem through the thickness with linear finite elements: 6 unit strain cases and 3 unit temperature gradient cases. It gives the effective stiffness C (6 x 6), the compliance, the engineering constants of a mechanical test (Ex, Ey, Ez, Gxy, Gxz, Gyz, νxy, νxz, νyz), the effective conductivity (3 x 3), the density and the specific heat (⟨ρc⟩/⟨ρ⟩). The stress and the heat flux of each case in each ply go to the 3D view. The result is for a stack that repeats along z. There is no thermal expansion.
- **Classical laminate theory.** The A, B and D matrices and the inverse of ABD. The apparent in-plane and flexural engineering constants, and the shear coupling coefficients. The flag and the size of each coupling: extension-bending (B), extension-shear (A16, A26) and bend-twist (D16, D26).
- **Load.** Forces and moments (N, M), or mid-plane strains and curvatures. The strain and the stress at the bottom and top of each ply, in global and in material axes, as a table, a through-thickness plot and a colour map in the 3D view.
- **Strength.** Ply strengths Xt, Xc, Yt, Yc and S. The strength ratio of each ply for max stress, max strain, Tsai-Hill, Tsai-Wu (F12 = −√(F11 F22)/2) and Hashin (plane stress, 1980, with the transverse shear strength Yc/2). First-ply failure, last-ply failure by ply discount, and the first-ply failure envelope in a plane of 2 load components.
- **Plate.** A simply supported rectangular plate: the buckling load under Nx or Ny alone and the 6 lowest natural frequencies. These closed forms are for a specially orthotropic plate. The page shows a warning when B, D16 or D26 is not zero.

Out of scope: other cells than a ply stack, thermal expansion and hygrothermal effects, free-edge interlaminar stresses.

## Layout

| Path | Contents |
|---|---|
| `solver/plyhouse.goose` | The solver, in [Goose](https://aardappel.github.io/goose/) |
| `solver/test.goose` | The tests |
| `web/page.html` | The page: editors, tables, plots and the WebGL2 3D view |
| `web/host.c` | The C entry point that starts the Goose runtime |
| `build.sh` | Goose to C, C to WebAssembly with emcc, then one HTML file |
| `plyhouse.html` | The built page |

## Build

You need the Goose compiler and the emsdk environment (emcc on `PATH`).

```sh
source /path/to/emsdk/emsdk_env.sh
GOOSE=/path/to/goose ./build.sh
```

The script writes `plyhouse.html`. The intermediate files go to `build/`. The same sources give the same `plyhouse.html`.

## Tests

```sh
/path/to/goose solver/test.goose
```

The run prints the number of checks that pass. If a check fails, the run prints it and exits with status 1. The references are:

- femahoy validation case `grid-laminate-cell` (aluminium 0.3 mm and polymer 0.7 mm): the values of its `check.toml`.
- The exact layer theory: a closed form for a stack of plies (R. M. Jones, *Mechanics of Composite Materials*, 1999, chapter 4), with an independent rotation of the stiffness tensor. All 36 terms of C and all 9 terms of k for carbon/epoxy [0/45/−45/90]s and for an unsymmetric stack of 3 materials.
- Classical laminate theory: a quasi-isotropic laminate is isotropic in its plane, and the cell and CLT give the same in-plane constants. The A, B and D terms of an isotropic plate, of [0/90] and of one off-axis ply.
- Ply stresses: the bending stress 6M/h², and the stress of a 45° ply in material axes.
- Strength: the uniaxial strengths, off-axis tension for max stress (Jones, section 2.9), Tsai-Hill (Azzi and Tsai 1965), Tsai-Wu and Hashin, first-ply and last-ply failure of [0/90]s, and the envelope of one ply.
- Plate: buckling and frequencies of a simply supported isotropic plate (Timoshenko and Gere 1961, Leissa 1969).
