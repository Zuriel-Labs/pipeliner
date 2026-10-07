#include <sys/stat.h>
#include <sys/mount.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <inttypes.h>
#include <limits.h>
#include <errno.h>
#include <string.h>

// Host-only filesystem primitive. The installer must authenticate both builds,
// quiesce work and persist replacing intent before invocation. Never auto-retry.
static int number(const char *text, uintmax_t *value) {
    if (!text || text[0] < '1' || text[0] > '9' || strlen(text) > 20) return 0;
    for (const char *p = text; *p; ++p) if (*p < '0' || *p > '9') return 0;
    errno = 0; char *end; *value = strtoumax(text, &end, 10);
    return errno == 0 && *end == '\0';
}
static int identity(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_uid == b->st_uid && a->st_mode == b->st_mode;
}
static int protected(int fd, struct stat *info, int parent) {
    if (fstat(fd, info) != 0 || !S_ISDIR(info->st_mode) || (info->st_mode & 0022)
        || (parent ? info->st_uid != getuid() : info->st_uid != getuid() && info->st_uid != 0)) return 0;
    filesec_t security = filesec_init(); if (!security) return 0;
    struct stat inspected; int present = -1;
    int valid = fstatx_np(fd, &inspected, security) == 0 && identity(info, &inspected)
        && filesec_query_property(security, FILESEC_ACL, &present) == 0 && present == 0;
    filesec_free(security); return valid;
}
static int named(int fd, const char *path, const struct stat *original) {
    struct stat held, named;
    return protected(fd, &held, 1) && lstat(path, &named) == 0 && identity(original, &held) && identity(original, &named);
}
static int entry(int parent, int fd, const struct stat *original, int before) {
    struct stat held, slot;
    if (!protected(fd, &held, 0) || fstatat(parent, "Pipeliner.app", &slot, AT_SYMLINK_NOFOLLOW) != 0
        || !identity(original, &held) || !identity(original, &slot)) return 0;
    return !before || (held.st_mtimespec.tv_sec == original->st_mtimespec.tv_sec && held.st_mtimespec.tv_nsec == original->st_mtimespec.tv_nsec
        && held.st_ctimespec.tv_sec == original->st_ctimespec.tv_sec && held.st_ctimespec.tv_nsec == original->st_ctimespec.tv_nsec);
}
int main(int argc, char **argv) {
    int parents[2] = {-1, -1}, bundles[2] = {-1, -1}, code = 2, attempted = 0;
    struct stat roots[2], apps[2]; uintmax_t values[4]; char canonical[PATH_MAX];
    if (argc != 7 || getuid() == 0 || getuid() != geteuid() || getgid() != getegid()) goto done;
    for (int i = 0; i < 4; ++i) if (!number(argv[i + 3], &values[i])) goto done;
    for (int i = 0; i < 2; ++i) {
        const char *path = argv[i + 1]; size_t length = strlen(path);
        if (!length || length >= PATH_MAX || path[0] != '/') goto done;
        for (size_t n = 0; n < length; ++n) if ((unsigned char)path[n] < 32 || (unsigned char)path[n] == 127) goto done;
        if (!realpath(path, canonical) || strcmp(path, canonical) != 0) goto done;
        parents[i] = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW_ANY);
        if (parents[i] < 0 || !protected(parents[i], &roots[i], 1)) goto done;
        struct statfs volume;
        if (fstatfs(parents[i], &volume) != 0 || strcmp(volume.f_fstypename, "apfs") != 0
            || volume.f_flags & (MNT_RDONLY | MNT_IGNORE_OWNERSHIP)) goto done;
        bundles[i] = openat(parents[i], "Pipeliner.app", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW_ANY);
        if (bundles[i] < 0 || !protected(bundles[i], &apps[i], 0)
            || (uintmax_t)apps[i].st_dev != values[i * 2] || (uintmax_t)apps[i].st_ino != values[i * 2 + 1]) goto done;
    }
    if (roots[0].st_dev != roots[1].st_dev || apps[0].st_dev != roots[0].st_dev || apps[1].st_dev != roots[1].st_dev
        || roots[0].st_ino == roots[1].st_ino || apps[0].st_ino == apps[1].st_ino) goto done;
    if (fsync(parents[0]) != 0 || fsync(parents[1]) != 0) goto done;
    for (int i = 0; i < 2; ++i) if (!named(parents[i], argv[i + 1], &roots[i]) || !entry(parents[i], bundles[i], &apps[i], 1)) goto done;
    attempted = 1; code = 3;
    if (renameatx_np(parents[0], "Pipeliner.app", parents[1], "Pipeliner.app",
        RENAME_SWAP | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH) != 0) {
        for (int i = 0; i < 2; ++i) if (!named(parents[i], argv[i + 1], &roots[i]) || !entry(parents[i], bundles[i], &apps[i], 1)) goto done;
        code = 2; goto done; // Report no effects only after the original bindings are read back.
    }
    for (int i = 0; i < 2; ++i) if (!named(parents[i], argv[i + 1], &roots[i]) || !entry(parents[i], bundles[1 - i], &apps[1 - i], 0)) goto done;
    if (fsync(parents[0]) != 0 || fsync(parents[1]) != 0) goto done;
    code = 0;
done:
    for (int i = 0; i < 2; ++i) {
        if (bundles[i] >= 0 && close(bundles[i]) != 0) code = attempted ? 3 : 2;
        if (parents[i] >= 0 && close(parents[i]) != 0) code = attempted ? 3 : 2;
    }
    if (code == 0) { if (puts("pipeliner-update-exchanged") < 0 || fflush(stdout) != 0) return 3; }
    else fputs(code == 3 ? "update-swap-recovery-required\n" : "update-swap-refused\n", stderr);
    return code;
}
