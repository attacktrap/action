# Woozle Trap

A GitHub Action step that runs quietly alongside your workflow.

```yaml
- uses: <owner>/<repo>@v1
```

It takes no inputs. It never fails your build. If anything goes wrong or it runs past its time budget, it prints a warning and exits successfully.

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
