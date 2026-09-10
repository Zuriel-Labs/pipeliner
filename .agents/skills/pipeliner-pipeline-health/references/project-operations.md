# GitHub Project operations

- Discover Project, field, option, view, workflow, item, and repository-link identities at runtime. Do not reuse IDs from another organization or historical run.
- Treat the Issue as the work unit, Project Status as the lane, and assignee or configured ownership field as the baton.
- Count the configured In Progress and In Review statuses to establish the active slot.
- Read before every mutation and immediately read the result back. Report partial state if one step succeeds and a later step fails.
- Keep `Pull request merged` completion behavior disabled. Release verification and PM Testing determine Done.
- Project copy is the preferred bootstrap path when exact built-in views and workflow configuration matter. The public CLI does not expose every view and built-in workflow authoring control.
- Use `gh` and structured JSON where supported. Quote URLs containing query strings in shells, and never print tokens or authorization headers.
- Audit expected identity and mapped fields from the target profile, not blueprint workingExample. project.visibility is optional; when absent report observed visibility without requiring PUBLIC or changing it. Resolve the Project node ID for either user or organization ownership and paginate every audited connection. Access errors, partial responses or incomplete pages cannot pass. The structural auditor checks fields/views/workflow names and enabled states; it does not prove workflow trigger destinations, active-slot health or candidate acceptance. Inspect those separately from live cards and workflow settings.
