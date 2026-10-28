#include <emscripten/emscripten.h>
#include <git2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <errno.h>

/* Libgit2 omits encoding conversion and external filter commands. */
static int check_stage_attributes(git_repository *repo, const char *path)
{
    const char *filter, *encoding;
    const char *commands[] = { "clean", "process" };
    git_config *config = NULL;
    git_config_entry *entry = NULL;
    char *key = NULL, *fullpath = NULL;
    struct stat st;
    int rc, required;

    fullpath = malloc(strlen(path) + sizeof("/repo/"));
    if (!fullpath) return -1;
    sprintf(fullpath, "/repo/%s", path);
    rc = stat(fullpath, &st);
    free(fullpath);
    if (rc < 0) return errno == ENOENT ? 0 : -1;
    if ((rc = git_attr_get(&encoding, repo, 0, path, "working-tree-encoding")) < 0) return rc;
    if (GIT_ATTR_HAS_VALUE(encoding)) return GIT_EINVALIDSPEC;
    if ((rc = git_attr_get(&filter, repo, 0, path, "filter")) < 0) return rc;
    if (!GIT_ATTR_HAS_VALUE(filter)) return 0;
    if ((rc = git_repository_config_snapshot(&config, repo)) < 0) return rc;
    key = malloc(strlen(filter) + sizeof("filter..required"));
    if (!key) { rc = -1; goto done; }
    for (size_t i = 0; i < sizeof(commands) / sizeof(commands[0]); i++) {
        sprintf(key, "filter.%s.%s", filter, commands[i]);
        rc = git_config_get_entry(&entry, config, key);
        if (rc == GIT_ENOTFOUND) continue;
        if (rc < 0) goto done;
        if (entry->value && entry->value[0]) { rc = GIT_EINVALIDSPEC; goto done; }
        git_config_entry_free(entry);
        entry = NULL;
    }
    sprintf(key, "filter.%s.required", filter);
    rc = git_config_get_bool(&required, config, key);
    if (rc == GIT_ENOTFOUND) rc = 0;
    else if (rc == 0 && required) rc = GIT_EINVALIDSPEC;

done:
    git_config_entry_free(entry);
    git_config_free(config);
    free(key);
    return rc;
}

/* Stage one literal path. The host supplies UTF-8 bytes in /stage-path. */
EMSCRIPTEN_KEEPALIVE int html_git_stage_probe(void)
{
    git_repository *repo = NULL;
    git_index *index = NULL;
    char *path = NULL;
    size_t capacity = 0;
    FILE *input = fopen("/stage-path", "r");
    int rc, tracked, ignored;

    if (!input) return -1;
    rc = getdelim(&path, &capacity, '\0', input) > 0 ? 0 : -1;
    fclose(input);
    if (rc < 0) { free(path); return rc; }
    if ((rc = git_libgit2_init()) < 0) { free(path); return rc; }
    if ((rc = git_repository_open(&repo, "/repo")) < 0) goto done;
    if ((rc = git_repository_index(&index, repo)) < 0) goto done;
    /* Folder handles omit modes. Preserve index modes, as the JS engine does. */
    if ((rc = git_index_set_caps(index,
            git_index_caps(index) | GIT_INDEX_CAPABILITY_NO_FILEMODE)) < 0) goto done;
    tracked = 0;
    for (int stage = 0; stage <= 3; stage++) {
        if (git_index_get_bypath(index, path, stage)) { tracked = 1; break; }
    }
    if (!tracked) {
        if ((rc = git_ignore_path_is_ignored(&ignored, repo, path)) < 0) goto done;
        if (ignored) { rc = GIT_EINVALIDSPEC; goto done; }
    }
    if ((rc = check_stage_attributes(repo, path)) < 0) goto done;
    rc = git_index_add_bypath(index, path);
    if (rc == GIT_ENOTFOUND && tracked) rc = git_index_remove_bypath(index, path);
    if (rc == 0) rc = git_index_write(index);

done:
    git_index_free(index);
    git_repository_free(repo);
    git_libgit2_shutdown();
    free(path);
    return rc;
}

/* Unstage one literal path from /stage-path without a worktree write. */
EMSCRIPTEN_KEEPALIVE int html_git_unstage_probe(void)
{
    git_repository *repo = NULL;
    git_index *index = NULL;
    git_object *tree = NULL;
    git_tree_entry *entry = NULL;
    git_index_entry restored = {0};
    char *path = NULL;
    size_t capacity = 0;
    FILE *input = fopen("/stage-path", "r");
    int rc, known = 0;

    if (!input) return -1;
    rc = getdelim(&path, &capacity, '\0', input) > 0 ? 0 : -1;
    fclose(input);
    if (rc < 0) { free(path); return rc; }
    if ((rc = git_libgit2_init()) < 0) { free(path); return rc; }
    if ((rc = git_repository_open(&repo, "/repo")) < 0) goto done;
    if ((rc = git_repository_index(&index, repo)) < 0) goto done;
    if ((rc = git_repository_head_unborn(repo)) < 0) goto done;
    if (!rc) {
        if ((rc = git_revparse_single(&tree, repo, "HEAD^{tree}")) < 0) goto done;
        rc = git_tree_entry_bypath(&entry, (git_tree *)tree, path);
        if (rc < 0 && rc != GIT_ENOTFOUND) goto done;
        if (entry && git_tree_entry_type(entry) == GIT_OBJECT_TREE) {
            rc = GIT_EINVALIDSPEC;
            goto done;
        }
    }
    for (int stage = 0; stage <= 3; stage++) {
        if (git_index_get_bypath(index, path, stage)) { known = 1; break; }
    }
    if (!entry && !known) { rc = GIT_ENOTFOUND; goto done; }
    for (int stage = 0; stage <= 3; stage++) {
        rc = git_index_remove(index, path, stage);
        if (rc < 0 && rc != GIT_ENOTFOUND) goto done;
    }
    if (entry) {
        restored.path = path;
        restored.mode = git_tree_entry_filemode(entry);
        git_oid_cpy(&restored.id, git_tree_entry_id(entry));
        if ((rc = git_index_add(index, &restored)) < 0) goto done;
    }
    rc = git_index_write(index);

done:
    git_tree_entry_free(entry);
    git_object_free(tree);
    git_index_free(index);
    git_repository_free(repo);
    git_libgit2_shutdown();
    free(path);
    return rc;
}

/* Init test. The host supplies an empty /repo directory. */
EMSCRIPTEN_KEEPALIVE int html_git_init_probe(void)
{
    git_repository *repo = NULL;
    git_repository_init_options options = GIT_REPOSITORY_INIT_OPTIONS_INIT;
    int rc;

    options.flags = GIT_REPOSITORY_INIT_MKPATH;
    options.initial_head = "main";
    if ((rc = git_libgit2_init()) < 0) return rc;
    rc = git_repository_init_ext(&repo, "/repo", &options);
    git_repository_free(repo);
    git_libgit2_shutdown();
    return rc;
}

/* Read-only build probe. The host supplies /repo, outside the quine store. */
EMSCRIPTEN_KEEPALIVE int html_git_probe(void)
{
    git_repository *repo = NULL;
    git_object *head = NULL;
    git_commit *commit = NULL;
    git_index *index = NULL;
    size_t entries;
    char head_hex[GIT_OID_HEXSZ + 1], tree_hex[GIT_OID_HEXSZ + 1];
    FILE *out = NULL;
    int rc;

    remove("/probe-result");
    git_libgit2_init();
    if ((rc = git_repository_open(&repo, "/repo")) < 0) goto done;
    if ((rc = git_revparse_single(&head, repo, "HEAD")) < 0) goto done;
    if ((rc = git_commit_lookup(&commit, repo, git_object_id(head))) < 0) goto done;
    if ((rc = git_repository_index(&index, repo)) < 0) goto done;
    entries = git_index_entrycount(index);
    git_oid_tostr(head_hex, sizeof(head_hex), git_object_id(head));
    git_oid_tostr(tree_hex, sizeof(tree_hex), git_commit_tree_id(commit));
    out = fopen("/probe-result", "w");
    if (!out) { rc = -1; goto done; }
    fprintf(out, "%s\n%s\n%zu\n%s", head_hex, tree_hex, entries, git_commit_message(commit));
    if (fclose(out)) rc = -1;

done:
    if (rc < 0) {
        const git_error *error = git_error_last();
        fprintf(stderr, "libgit2 probe: %s\n", error ? error->message : "file error");
    }
    git_index_free(index);
    git_commit_free(commit);
    git_object_free(head);
    git_repository_free(repo);
    git_libgit2_shutdown();
    return rc;
}

int main(void)
{
    int major, minor, revision;
    git_libgit2_version(&major, &minor, &revision);
    printf("libgit2 %d.%d.%d\n", major, minor, revision);
    return 0;
}
