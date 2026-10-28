"""Notebook kernel for python-html.

The page writes a request to REQUEST and calls pyhtml_kernel() in the engine
(src/pyhtml.c), which runs handle(). handle() runs the cell in the namespace of
__main__, which the terminal REPL also uses, and writes the outputs in nbformat 4
to REPLY. The page calls it only while Python waits for terminal input.
"""

import ast
import base64
import builtins
import io
import json
import linecache
import sys
import traceback

REQUEST = "/tmp/pyhtml/request.json"
REPLY = "/tmp/pyhtml/reply.json"


class _Stream(io.TextIOBase):
    def __init__(self, name, outputs):
        self.name = name
        self.outputs = outputs

    def writable(self):
        return True

    def write(self, text):
        last = self.outputs[-1] if self.outputs else None
        if last and last["output_type"] == "stream" and last["name"] == self.name:
            last["text"] += text
        else:
            self.outputs.append({"output_type": "stream", "name": self.name, "text": text})
        return len(text)


def _no_input(prompt=""):
    # A cell runs inside a call from the page, which cannot wait for a key.
    raise RuntimeError("input() works in the terminal, not in a notebook cell")


def _figures(outputs):
    # Each open matplotlib figure becomes a PNG output, as with %matplotlib inline.
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    for num in plt.get_fignums():
        fig = plt.figure(num)
        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight")
        outputs.append({
            "output_type": "display_data",
            "data": {"image/png": base64.b64encode(buf.getvalue()).decode("ascii"), "text/plain": repr(fig)},
            "metadata": {},
        })
    plt.close("all")


def run(code, count):
    """Runs one cell. Returns its outputs as nbformat 4 output dicts."""
    namespace = sys.modules["__main__"].__dict__
    outputs = []
    saved = sys.stdout, sys.stderr, sys.stdin, builtins.input
    sys.stdout, sys.stderr = _Stream("stdout", outputs), _Stream("stderr", outputs)
    sys.stdin, builtins.input = io.StringIO(), _no_input
    name = f"<cell {count}>"
    # Tracebacks show the lines of the cell.
    linecache.cache[name] = (len(code), None, code.splitlines(True), name)
    try:
        tree = ast.parse(code, name)
        last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        exec(compile(tree, name, "exec"), namespace)
        if last is not None:
            value = eval(compile(ast.Expression(last.value), name, "eval"), namespace)
            if value is not None:
                namespace["_"] = value
                outputs.append({"output_type": "execute_result", "execution_count": count,
                                "data": {"text/plain": repr(value)}, "metadata": {}})
        _figures(outputs)
    except BaseException as e:  # SystemExit and KeyboardInterrupt too: the kernel must reply.
        tb = traceback.format_exception(e)
        # Drop the frames of this file.
        tb = [frame for frame in tb if 'pyhtml_kernel.py"' not in frame]
        outputs.append({"output_type": "error", "ename": type(e).__name__, "evalue": str(e),
                        "traceback": [line.rstrip("\n") for line in tb]})
    finally:
        sys.stdout, sys.stderr, sys.stdin, builtins.input = saved
    return outputs


def handle():
    with open(REQUEST, encoding="utf-8") as f:
        request = json.load(f)
    reply = {"outputs": run(request["code"], request["count"])}
    with open(REPLY, "w", encoding="utf-8") as f:
        json.dump(reply, f)
