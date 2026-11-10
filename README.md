# Woozle Trap

A GitHub Action step that runs quietly alongside your workflow.

```yaml
- uses: <owner>/<repo>@v1
```

It takes no inputs. It never fails your build. If anything goes wrong or it runs past its time budget, it prints a warning and exits successfully.

## Development

Requires the Node version in `.nvmrc`.

```sh
npm ci
npm run typecheck
npm test
npm run build       # rebuild dist/, commit it with every source change
npm run check:dist  # fails if dist/ is out of date
```
