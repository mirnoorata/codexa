The repository in `/workspace/project` contains a path-target normalization
bug. Fix `normalize_targets` in `src/targets.py` so it:

- trims surrounding whitespace;
- preserves the first-seen order of valid unique targets;
- ignores empty targets;
- rejects absolute paths, Windows drive paths, parent (`..`) segments,
  Unicode control characters (General Category `Cc`, including C0, DEL, and
  C1), and backslashes; and
- remains generic instead of special-casing any example value.

Modify only `src/targets.py` and, if useful, append new cases to
`tests/test_targets.py` without deleting or rewriting its existing tests. Run
the public tests before finishing.
