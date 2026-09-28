#include <stdio.h>
#include <string.h>
#include <unistd.h>

/* Synthetic foreground helper. No files, network, credentials or service registration. */
int main(void) {
  char line[32];
  setbuf(stdout, NULL);
  while (fgets(line, sizeof line, stdin)) {
    if (strcmp(line, "ping\n") == 0) {
      printf("{\"reply\":\"pong\",\"pid\":%d,\"architecture\":\"arm64\"}\n", getpid());
    } else if (strcmp(line, "stop\n") == 0) {
      return 0;
    } else if (strcmp(line, "fail\n") == 0) {
      return 23;
    } else {
      fprintf(stderr, "Invalid helper command\n");
      return 2;
    }
  }
  return 0; /* Parent exit closes stdin; never remain as a background worker. */
}
