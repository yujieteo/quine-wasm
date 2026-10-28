// Emscripten JS library (--js-library) for python-html.
//
// Asyncify cannot unwind through the frames of a side module (a C extension
// such as numpy). Thus only a read from the terminal (quine-wasm's fd_read) may
// sleep. Emscripten makes these 3 calls sleep when Asyncify is on, and a C
// extension can call each of them, so here they return at once.

addToLibrary({
  // A C extension's init can import another C extension, which loads it here.
  // The file is in the in-memory file system, so it loads without a wait.
  _dlopen_js__deps: ['$dlopenInternal'],
  _dlopen_js__async: false,
  _dlopen_js: (handle) => dlopenInternal(handle, { loadAsync: false }),

  // `import subprocess` imports selectors, which calls poll(0) to test it.
  // This is Emscripten's poll without Asyncify: the state now, with no wait.
  __syscall_poll__async: false,
  __syscall_poll: (fds, nfds, timeout) => {
    var count = 0;
    for (var i = 0; i < nfds; i++) {
      var pollfd = fds + {{{ C_STRUCTS.pollfd.__size__ }}} * i;
      var fd = {{{ makeGetValue('pollfd', C_STRUCTS.pollfd.fd, 'i32') }}};
      var events = {{{ makeGetValue('pollfd', C_STRUCTS.pollfd.events, 'i16') }}};
      var flags = {{{ cDefs.POLLNVAL }}};
      var stream = FS.getStream(fd);
      if (stream) {
        flags = stream.stream_ops.poll ? stream.stream_ops.poll(stream, -1) : {{{ cDefs.POLLIN | cDefs.POLLOUT }}};
      }
      flags &= events | {{{ cDefs.POLLERR }}} | {{{ cDefs.POLLHUP }}};
      if (flags) count++;
      {{{ makeSetValue('pollfd', C_STRUCTS.pollfd.revents, 'flags', 'i16') }}};
    }
    return count;
  },

  // sqlite3 calls fsync at each commit. The in-memory file system has nothing to sync.
  fd_sync__async: false,
  fd_sync: (fd) => {
    var stream = SYSCALLS.getStreamFromFD(fd);
    return stream.stream_ops?.fsync?.(stream) || 0;
  },

  // -sMAIN_MODULE links the LLVM profile runtime. Before main, it creates
  // default.profraw in the start folder, which Save keeps. Put it in /tmp.
  $pyhtmlEnv__deps: ['$ENV'],
  $pyhtmlEnv__postset: "ENV['LLVM_PROFILE_FILE'] = '/tmp/default.profraw';",
  $pyhtmlEnv: {},
});
extraLibraryFuncs.push('$pyhtmlEnv');
