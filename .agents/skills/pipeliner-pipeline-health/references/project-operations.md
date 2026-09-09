# GitHub Project operations

- Discover Project, field, option, view, workflow, item, and repository-link identities at runtime. Do not reuse IDs from another organization or historical run.
- Treat the Issue as the work unit, Project Status as the lane, and assignee or configured ownership field as the baton.
- Count the configured In Progress and In Review statuses to establish the active slot.
- Read before every mutation and immediately read the result back. Report partial state if one step succeeds and a later step fails.
- Keep `Pull request merged` completion behavior disabled. Release verification and PM Testing determine Done.
- Project copy is the preferred bootstrap path when exact built-in views and workflow configuration matter. The public CLI does not expose every view and built-in workflow authoring control.
- Use `gh` and structured JSON where supported. Quote URLs containing query strings in shells, and never print tokens or authorization headers.
