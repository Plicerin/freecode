---
description: Write a clear git commit message in Conventional Commits format. Use whenever you are about to commit staged changes or the user asks for a commit message.
---
# Conventional Commit Message

Produce a commit message in **Conventional Commits** format from the *actually staged* changes.

## Procedure
1. Inspect what is staged — run `git diff --staged` (and `git status --short`). Base the message on the real diff, not assumptions. If nothing is staged, say so and stop.
2. Pick the single most accurate **type**:
   - `feat` — a new user-facing capability
   - `fix` — a bug fix
   - `docs` — documentation only
   - `refactor` — behavior-preserving code change
   - `perf` — a performance improvement
   - `test` — adding or fixing tests
   - `build` / `ci` — build system or CI configuration
   - `chore` — tooling, dependencies, housekeeping
3. Add an optional **scope** in parentheses — the affected area (module, package, command). Omit it if the change is broad.
4. Write the **subject** as `type(scope): summary`
   - imperative mood ("add", not "added"/"adds")
   - ≤ 50 characters, no trailing period, lower-case after the colon
5. If the change isn't self-explanatory, add a **body** after a blank line: wrap at ~72 columns, explain the *why* (and the non-obvious *what*) — never just narrate the diff.
6. **Footers** when relevant:
   - `BREAKING CHANGE: <what broke + the migration>` for any incompatible change (or a `!` after the type/scope, e.g. `feat(api)!:`)
   - `Refs #123` / `Closes #123` to link issues
7. One logical change per commit. If the diff mixes unrelated changes, recommend splitting it rather than writing a vague catch-all message.

## Output
Return ONLY the finished commit message (subject + optional body/footers), ready to pass to `git commit`. No preamble, no surrounding prose.

## Example
```
feat(auth): add token refresh on 401

Retry once with a refreshed token before surfacing the error, so a
silently-expired session doesn't bubble up to the user as a hard failure.

Closes #214
```
