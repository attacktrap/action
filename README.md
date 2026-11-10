# Woozle Trap

A GitHub Action step that runs quietly alongside your workflow.

```yaml
- uses: <owner>/<repo>@v1
```

It takes no inputs. It never fails your build. If anything goes wrong or it runs past its time budget, it prints a warning and exits successfully.

## Pipeline check

On the runner, the Action reads the running workflow from your checkout and looks at the steps that run after it and can see its checkout: later steps in its job, and every job that depends on that job through `needs`, directly or transitively, including same-repo reusable workflows those jobs call. Earlier steps and jobs that run in parallel are not checked. `if:` conditions are ignored, so a conditional step still counts.

Each later `run:` step is followed one level into the repo: `make <target>`, `npm`, `yarn` and `pnpm` scripts (including shortcuts such as `npm test`), and script files such as `./a/b.sh` or `python a/b.py`. Local composite actions (`uses: ./a`) are read the same way.

It reports these, from fixed lists:

| Kind | Matches |
| --- | --- |
| Public publish | `npm publish`, `JS-DevTools/npm-publish`, `twine upload`, `pypa/gh-action-pypi-publish`, `poetry publish`, `uv publish`, a `public.ecr.aws` image tag |
| Public upload | `gh release create`, `softprops/action-gh-release`, `actions/upload-artifact`, `actions/deploy-pages`, `actions/upload-pages-artifact`, `peaceiris/actions-gh-pages`. These matter only on public repos. |
| Commit | `git add`, `git commit`, `git push`, and auto-commit actions |
| Scanner | TruffleHog, Gitleaks, ggshield, Trivy, Snyk, Semgrep, Checkov, Docker Scout and Amazon Inspector, as actions or commands |

Not reported: Grype, Trivy with `--scanners` that leaves out `secret`, Docker Scout without its `secrets` option, and pushes to Docker Hub, GHCR or private ECR.

Only the findings leave the runner, as closed lists of values. The workflow and the files it calls are never sent, logged or stored.

The check can't see other workflows, scanners that run on a registry or a schedule, third-party platforms, a parallel job that pulls an image this job pushed, remote composite actions, reusable workflows in other repos, or calls more than one level deep, such as a script that calls another script. When it knows it couldn't follow something, the result is marked incomplete and your dashboard shows "pipeline check incomplete". If you run a scanner that fails on findings, check that note.

## API

The Action talks to one server API, described in [`openapi/action-v1.yaml`](openapi/action-v1.yaml). The `v1` API only grows: CI fails on any breaking change to it.

## Development

Requires the Node version in `.nvmrc`.

```sh
npm ci
npm run typecheck
npm test
npm run build       # rebuild dist/, commit it with every source change
npm run check:dist  # fails if dist/ is out of date
```
