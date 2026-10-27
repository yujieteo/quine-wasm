// Emscripten JS library (--js-library). It connects the TTY and stdin to the page host,
// which the page passes in as Module.quineHost.

addToLibrary({
  $quineTty__deps: ['$TTY'],
  $quineTty__postset: 'quineTty();',
  $quineTty: () => {
    var host = Module.quineHost;
    var put = (tty, val) => { if (val !== null) host.write(val); };
    Object.assign(TTY.default_tty_ops, {
      get_char: () => host.getChar(),
      put_char: put,
      fsync: () => {},
      ioctl_tcgets: () => host.termios,
      ioctl_tcsets: (tty, op, data) => { host.setTermios(data); return 0; },
      ioctl_tiocgwinsz: () => [host.rows, host.cols],
    });
    Object.assign(TTY.default_tty1_ops, { put_char: put, fsync: () => {} });
  },

  // A blocking read on a TTY with no input sleeps through Asyncify until the page has input.
  // A rewind always comes back through handleSleep, which then returns the stored result.
  fd_read__deps: ['$doReadv', '$quineTty', '$Asyncify'],
  fd_read__async: true,
  fd_read: (fd, iov, iovcnt, pnum) => {
    var read = () => {
      try {
        var stream = SYSCALLS.getStreamFromFD(fd);
        var num = doReadv(stream, iov, iovcnt);
        {{{ makeSetValue('pnum', 0, 'num', SIZE_TYPE) }}};
        return 0;
      } catch (e) {
        if (!(e instanceof FS.ErrnoError)) throw e;
        return e.errno;
      }
    };
    var host = Module.quineHost;
    var stream = FS.getStream(fd);
    var waits = stream?.tty && !(stream.flags & {{{ cDefs.O_NONBLOCK }}}) && !host.hasInput();
    if (!waits && Asyncify.state !== Asyncify.State.Rewinding) return read();
    return Asyncify.handleSleep((wakeUp) => {
      host.sleeping = true;
      host.waitInput().then(() => { host.sleeping = false; wakeUp(read()); });
    });
  },

  // Asks the page to save a new copy of the HTML file. See include/quine.h.
  quine_save: () => { Module.quineHost.requestSave(); },
});
