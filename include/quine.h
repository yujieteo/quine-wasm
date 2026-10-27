/* quine-wasm program API. */
#ifndef QUINE_H
#define QUINE_H

#include <emscripten.h>

/* Ask the page to save a new copy of the HTML file with the current files.
   The page saves at once if a key or a click came in the last 5 seconds,
   else it saves at the next key or click. The call returns at once. */
void quine_save(void);

/* Optional flush hook. Define it with QUINE_FLUSH_HOOK to write your
   buffered state to files before each save:

     QUINE_FLUSH_HOOK { fflush(my_file); }
*/
#define QUINE_FLUSH_HOOK EMSCRIPTEN_KEEPALIVE void quine_flush(void)

#endif
