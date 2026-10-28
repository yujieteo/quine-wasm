"""Write the standard library as a zip of .pyc files.

Usage: BUILD_PYTHON stdlib_zip.py LIB_DIR SYSCONFIGDATA OUT_ZIP

Run it with CPython's native build Python, which has the same bytecode version
as the wasm Python. CPython's own wasm zip leaves out more modules, for example
http and concurrent.futures.thread. Pyodide's packages import those, so this
zip leaves out only what Pyodide leaves out.
"""

import importlib.util
import pathlib
import sys
import zipfile
from importlib._bootstrap_external import _code_to_hash_pyc

EXCLUDE = {
    "test", "ensurepip", "venv", "lib2to3", "idlelib", "tkinter", "turtledemo", "curses",
    "pydoc_data", "turtle.py", "_pydecimal.py", "_osx_support.py", "_aix_support.py",
    "_android_support.py", "_ios_support.py", "_apple_support.py",
}
# Tracebacks show this path, not the path on the build machine.
RUNTIME_LIB = "/usr/local/lib/python3.14"

lib, sysconfigdata, out = map(pathlib.Path, sys.argv[1:])


def sources():
    yield sysconfigdata, sysconfigdata.name
    for entry in sorted(lib.iterdir()):
        if entry.name in EXCLUDE:
            continue
        if entry.suffix == ".py":
            yield entry, entry.name
        elif (entry / "__init__.py").exists():
            for py in sorted(entry.rglob("*.py")):
                rel = py.relative_to(lib)
                if not {"test", "tests", "__pycache__"} & set(rel.parts):
                    yield py, rel.as_posix()


with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for py, rel in sources():
        source = py.read_bytes()
        code = compile(source, f"{RUNTIME_LIB}/{rel}", "exec", dont_inherit=True)
        # unchecked-hash: the zip has no source to compare with.
        pyc = _code_to_hash_pyc(code, importlib.util.source_hash(source), checked=False)
        zf.writestr(zipfile.ZipInfo(rel[:-3] + ".pyc", (1980, 1, 1, 0, 0, 0)), bytes(pyc),
                    compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
print(f"{out}: {out.stat().st_size / 1048576:.1f} MB")
