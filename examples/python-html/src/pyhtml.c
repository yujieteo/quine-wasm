/* python-html entry point: CPython's main, plus the call that the notebook uses. */
#include <Python.h>
#include <stdlib.h>
#include <emscripten.h>

int main(int argc, char **argv)
{
    /* The runtime block holds the standard library at /usr/local. */
    setenv("PYTHONHOME", "/usr/local", 0);
    /* No __pycache__ folders in the user folder: Save would keep them. */
    setenv("PYTHONDONTWRITEBYTECODE", "1", 0);
    /* matplotlib (python-sci.html): draw to files, and keep its cache out of the user folder. */
    setenv("MPLBACKEND", "Agg", 0);
    setenv("MPLCONFIGDIR", "/tmp/matplotlib", 0);
    return Py_BytesMain(argc, argv);
}

/* Runs one notebook request. The page calls it while Python waits for terminal
   input, so the main thread state is detached and the GIL is free. The request
   and the reply are files; see src/python/pyhtml_kernel.py. */
EMSCRIPTEN_KEEPALIVE int pyhtml_kernel(void)
{
    PyGILState_STATE state = PyGILState_Ensure();
    int status = PyRun_SimpleString("import pyhtml_kernel\npyhtml_kernel.handle()\n");
    PyGILState_Release(state);
    return status;
}
