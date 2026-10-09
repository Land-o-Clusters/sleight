# sleight

A Claude Code plugin (MCP server, relay and mod) that drives Mac apps through the computer-use engine
bundled with the ChatGPT desktop app. See README.md for how it fits together.

## Checks

Run `npm run check` before committing: relay tests, `claude plugin validate`, and the mod's tests.
`npm run typecheck` needs the types Claude Code writes when it loads the mod.

## Writing

Docs, skills, commit messages and anything else people read go through the same bar:

- Run `npm run lint:prose` (Vale with the ai-tells pack) on any doc you change, and fix what it flags
  rather than suppressing it. Add files to the script as the docs grow.
- For a larger rewrite, use the humanizer skill in `.claude/skills/humanizer/`.
- State facts we measured, with the number. Write "12/12 on four tasks", not "works reliably".
- Put limitations in `docs/known-problems.md` as soon as we find them, and say plainly what we don't know.
- Use commas, periods and parentheses where an em dash would go. Start list items with the point
  itself, without a bold label. State a claim directly, without first denying something nobody said.
- Write less. The plugin is about 5,700 lines of code (2026-10-09), and the docs shouldn't outweigh it.
