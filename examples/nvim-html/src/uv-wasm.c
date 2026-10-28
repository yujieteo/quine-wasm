// libuv platform facts for Emscripten, which has no OS to ask.
// The event loop uses the posix-poll backend: with Asyncify, Emscripten's
// poll() yields to the browser until a timer is due or a stream has input.

#include <emscripten.h>
#include <errno.h>
#include <pthread.h>
#include <sched.h>

#include "uv.h"
#include "internal.h"

// Thread scheduling calls that libuv links but Emscripten's libc lacks.
int sched_get_priority_min(int policy) { errno = ENOSYS; return -1; }
int sched_get_priority_max(int policy) { errno = ENOSYS; return -1; }
int pthread_setschedparam(pthread_t t, int policy, const struct sched_param* p) { return ENOSYS; }
int pthread_setname_np(pthread_t t, const char* name) { return ENOSYS; }
int pthread_getname_np(pthread_t t, char* name, size_t len) {
  if (len > 0) name[0] = '\0';
  return 0;
}

int uv_exepath(char* buffer, size_t* size) {
  if (buffer == NULL || size == NULL || *size == 0) return UV_EINVAL;
  *size = (size_t)uv__strscpy(buffer, "/usr/bin/nvim", *size);
  return 0;
}

int uv_resident_set_memory(size_t* rss) {
  *rss = (size_t)EM_ASM_DOUBLE({ return HEAP8.length; });
  return 0;
}

uint64_t uv_get_free_memory(void) { return 0; }
uint64_t uv_get_total_memory(void) { return 2147483648u; }
uint64_t uv_get_constrained_memory(void) { return 0; }
uint64_t uv_get_available_memory(void) { return uv_get_total_memory(); }

void uv_loadavg(double avg[3]) { avg[0] = avg[1] = avg[2] = 0; }

int uv_uptime(double* uptime) {
  *uptime = EM_ASM_DOUBLE({ return performance.now() / 1000; });
  return 0;
}

int uv_cpu_info(uv_cpu_info_t** cpu_infos, int* count) {
  *cpu_infos = uv__calloc(1, sizeof(**cpu_infos));
  if (*cpu_infos == NULL) return UV_ENOMEM;
  (*cpu_infos)->model = uv__strdup("wasm32");
  if ((*cpu_infos)->model == NULL) {
    uv__free(*cpu_infos);
    return UV_ENOMEM;
  }
  *count = 1;
  return 0;
}

int uv_interface_addresses(uv_interface_address_t** addresses, int* count) {
  *addresses = NULL;
  *count = 0;
  return 0;
}
