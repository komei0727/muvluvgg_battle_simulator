# Pull request body

```markdown
## Summary

- <observable outcome>

Closes #<issue>

## Scope

- In scope: <implemented behavior>
- Out of scope: <deferred behavior>
- Rules: <R-_ and Q-_ identifiers, or none>

## Test evidence

- Red: `<focused command>` — failed because <expected reason>
- Green: `<focused command>`
- `mise run format-check`
- `mise run typecheck`
- `mise run lint`
- `mise run test`
- `mise run build`

## Documentation and contracts

- <updated documents, API/Event/Catalog impact, or none>

## Risks

- <residual risk or none>
```

Never state that a command passed when it was skipped. Include environment warnings only when they affect reproducibility or reviewer decisions.
