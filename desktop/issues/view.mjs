export function issuePage(issues, query, page) {
  if (!Array.isArray(issues) || typeof query !== 'string' || query.length > 256 || !Number.isSafeInteger(page) || page < 0) throw Error('Invalid Issue page');
  const term = query.trim().toLowerCase(), matches = term ? issues.filter(issue => ('#' + issue.number + ' ' + issue.title).toLowerCase().includes(term)) : issues;
  const pages = Math.ceil(matches.length / 50); page = Math.min(page, Math.max(0, pages - 1));
  return { rows: matches.slice(page * 50, (page + 1) * 50), count: matches.length, pages, page };
}
