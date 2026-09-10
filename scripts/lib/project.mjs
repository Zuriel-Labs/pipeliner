// Read-only GitHub Project retrieval; ghJson is injected for offline failure tests.
const CONNECTIONS = {
  repositories: 'id nameWithOwner',
  fields: '... on ProjectV2FieldCommon { id name } ... on ProjectV2SingleSelectField { options { name } }',
  views: 'id name layout',
  workflows: 'id name enabled',
};

export async function collectConnection(fetchPage) {
  const nodes = [], ids = new Set(), cursors = new Set();
  let cursor = null, expected;
  do {
    const connection = await fetchPage(cursor);
    if (!connection || !Array.isArray(connection.nodes) || !Number.isInteger(connection.totalCount) || connection.totalCount < 0 || typeof connection.pageInfo?.hasNextPage !== 'boolean') throw new Error('incomplete Project connection');
    expected ??= connection.totalCount;
    if (expected !== connection.totalCount) throw new Error('Project connection changed during pagination; retry audit');
    for (const node of connection.nodes) {
      if (!node || typeof node.id !== 'string' || !node.id) throw new Error('unreadable Project node');
      if (ids.has(node.id)) throw new Error('duplicate Project node during pagination');
      ids.add(node.id); nodes.push(node);
    }
    if (nodes.length > expected) throw new Error('incomplete or inconsistent Project connection');
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor) || !connection.nodes.length) throw new Error('invalid or repeated pagination cursor');
    cursors.add(cursor);
  } while (true);
  if (nodes.length !== expected) throw new Error('incomplete Project connection');
  return nodes;
}

export async function fetchProjectSnapshot(profile, ghJson) {
  const args = ['project', 'view', String(profile.project.number), '--owner', profile.project.owner, '--format', 'json'];
  const project = await ghJson(args);
  if (!project?.id || project.number !== profile.project.number || project.owner?.login?.toLowerCase() !== profile.project.owner.toLowerCase() || !['User', 'Organization'].includes(project.owner.type) || typeof project.public !== 'boolean' || typeof project.title !== 'string') throw new Error('Project identity unavailable or mismatched');
  const collections = {};
  for (const [name, selection] of Object.entries(CONNECTIONS)) {
    collections[name] = await collectConnection(async cursor => {
      const query = `query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{${name}(first:100,after:$cursor){totalCount nodes{${selection}} pageInfo{hasNextPage endCursor}}}}}`;
      const result = await ghJson(['api', 'graphql', '-f', `query=${query}`, '-f', `id=${project.id}`, ...(cursor === null ? [] : ['-f', `cursor=${cursor}`])]);
      if (result.errors?.length) throw new Error('GitHub returned partial Project data; audit cannot pass');
      return result.data?.node?.[name];
    });
  }
  const readback = await ghJson(args);
  if (['id', 'number', 'title', 'public'].some(key => readback?.[key] !== project[key]) || readback?.owner?.login !== project.owner.login) throw new Error('Project identity changed during audit; retry');
  return { project: project.url, snapshot: {
    title: project.title, public: project.public,
    repositories: collections.repositories.map(repository => repository.nameWithOwner),
    fields: collections.fields.map(field => ({ name: field.name, options: (field.options ?? []).map(option => option.name) })),
    views: collections.views.map(({ name, layout }) => ({ name, layout })),
    workflows: collections.workflows.map(({ name, enabled }) => ({ name, enabled })),
  } };
}
