# Agent instructions

This repository is public. Anything committed here, and any branch, commit message or pull request, is visible to everyone.

## Before starting a task

Task context lives in a private planning repository cloned beside this one at `../planning`. Read `../planning/guidelines.md` and the task file before you start.

## Keep everything here generic

- Code, tests, fixtures, docs, commit messages and pull request text stay generic.
- Never paste task or planning text into this repository.
- Name branches `<issue>-t-<nnn>` and nothing more descriptive.
- Use neutral placeholders in tests, such as `a/b.txt` and `content`.

## Checks

```sh
npm ci
npm test
npm run check:dist
```

`dist/` is the bundle the action runs. Run `npm run build` and commit `dist/` with every source change. CI fails when `dist/` is stale.
