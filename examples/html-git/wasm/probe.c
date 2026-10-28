#include <emscripten/emscripten.h>
#include <git2.h>
#include <stdio.h>

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
