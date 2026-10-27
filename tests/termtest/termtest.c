// Test program for the terminal: raw keys, size, SIGWINCH, the save API and the runtime block.
#include <signal.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>
#include "quine.h"

static volatile int winch;
static void on_winch(int sig) { winch++; }

int main(void) {
  struct winsize ws;
  struct termios t;
  ioctl(1, TIOCGWINSZ, &ws);
  printf("size %dx%d\n", ws.ws_col, ws.ws_row);
  signal(SIGWINCH, on_winch);
  tcgetattr(0, &t);
  t.c_lflag &= ~(ICANON | ECHO);
  tcsetattr(0, TCSANOW, &t);
  printf("\x1b[?1049h\x1b[38;2;255;0;0mraw\x1b[0m\n");
  fflush(stdout);
  for (;;) {
    unsigned char c;
    if (read(0, &c, 1) != 1) break;
    if (c == 'w') {
      ioctl(1, TIOCGWINSZ, &ws);
      printf("winch %d size %dx%d\n", winch, ws.ws_col, ws.ws_row);
    } else if (c == 's') {
      quine_save();
      printf("save asked\n");
    } else if (c == 'r') {
      char b[64] = {0};
      FILE *f = fopen("/usr/share/termtest/hello.txt", "r");
      if (f) fgets(b, sizeof b, f);
      printf("runtime %s\n", b);
    } else if (c == 'q') {
      break;
    } else {
      printf("key %d\n", c);
    }
    fflush(stdout);
  }
  printf("\x1b[?1049l");
  return 0;
}
