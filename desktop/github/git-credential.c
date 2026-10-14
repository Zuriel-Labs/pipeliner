#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>

// Trusted packaged Git helper. Credentials arrive only over descriptor three.
static int bounded(int fd, char *buffer, size_t limit) {
  size_t length = 0;
  while (length <= limit) {
    ssize_t n = read(fd, buffer + length, limit + 1 - length);
    if (n < 0) { if (errno == EINTR) continue; return -1; }
    if (!n) { buffer[length] = 0; return (int)length; }
    length += (size_t)n;
  }
  return -1;
}
static int ascii_name(const char *value, size_t limit, int repo) {
  size_t length = strlen(value);
  if (!length || length > limit || (repo && (!strcmp(value, ".") || !strcmp(value, "..")))) return 0;
  for (size_t i = 0; i < length; i++) {
    unsigned char c = (unsigned char)value[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || (repo && (c == '.' || c == '_')))) return 0;
  }
  return 1;
}
static int utf8(const unsigned char *value, size_t length) {
  for (size_t i = 0; i < length;) {
    uint32_t point = value[i++]; int count; uint32_t minimum;
    if (point < 0x80) { if (!point || point == '\r') return 0; continue; }
    if (point >= 0xc2 && point <= 0xdf) { count = 1; point &= 0x1f; minimum = 0x80; }
    else if (point >= 0xe0 && point <= 0xef) { count = 2; point &= 0x0f; minimum = 0x800; }
    else if (point >= 0xf0 && point <= 0xf4) { count = 3; point &= 7; minimum = 0x10000; }
    else return 0;
    if (i + (size_t)count > length) return 0;
    while (count--) { unsigned char c = value[i++]; if ((c & 0xc0) != 0x80) return 0; point = (point << 6) | (c & 0x3f); }
    if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return 0;
  }
  return 1;
}
static int request(char *input, const char *owner, const char *repository) {
  char expected[146];
  if (snprintf(expected, sizeof expected, "%s/%s.git", owner, repository) < 0) return 0;
  const char *keys[] = {"protocol", "host", "path", "username"};
  const char *values[] = {"https", "github.com", expected, "x-access-token"};
  unsigned fields = 0;
  for (char *line = input; line;) {
    char *next = strchr(line, '\n'); if (next) *next++ = 0;
    if (*line) {
      char *separator = strchr(line, '='); if (!separator || separator == line) return 0; *separator++ = 0;
      if (strcmp(line, "wwwauth[]") && strcmp(line, "capability[]")) {
        int field;
        for (field = 0; field < 4; field++) if (!strcmp(line, keys[field])) break;
        if (field == 4 || (fields & (1U << field)) || strcmp(separator, values[field])) return 0;
        fields |= 1U << field;
      }
    }
    line = next;
  }
  return (fields & 7U) == 7U;
}
static void clear(char *buffer, size_t length) { volatile char *p = buffer; while (length--) *p++ = 0; }
int main(int argc, const char *argv[]) {
  if (argc != 4 || !ascii_name(argv[1], 39, 0) || !ascii_name(argv[2], 100, 1)) return 1;
  if (!strcmp(argv[3], "store") || !strcmp(argv[3], "erase")) return 0;
  if (strcmp(argv[3], "get")) return 1;
  char input[1025]; int size = bounded(STDIN_FILENO, input, 1024);
  if (size < 0 || !utf8((unsigned char *)input, (size_t)size) || !request(input, argv[1], argv[2])) return 1;
  char token[257]; size = bounded(3, token, 256); close(3);
  int valid = size >= 12 && size <= 204 && !memcmp(token, "ghu_", 4);
  for (int i = 4; valid && i < size; i++) { unsigned char c = (unsigned char)token[i]; if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_')) valid = 0; }
  int written = valid ? printf("username=x-access-token\npassword=%s\n\n", token) : -1;
  clear(token, sizeof token); return written > 0 && fflush(stdout) == 0 ? 0 : 1;
}
