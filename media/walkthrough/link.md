# Link code that must change together

1. Select the lines that must stay in sync, e.g. a constant.
2. Press **Ctrl+Alt+L** (**Cmd+Alt+L** on macOS), or right-click → **Link Selection…**
3. Select the matching code in any other file, in any language, and press it again.
4. Accept the suggested label.

Twinlock writes the directives for you, in each file's own comment syntax:

```ts
// LINT.IfChange(upload_limit)
maxUploadMb: 25,
// LINT.ThenChange(//server/settings.py:upload_limit)
```

You can also type them by hand. Twinlock picks them up immediately.
