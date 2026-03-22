async function jiraRequest(config, path, method = 'GET', body = null) {
  const credentials = Buffer.from(`${config.email}:${config.token}`).toString('base64');
  const url = `https://${config.domain}${path}`;

  const options = {
    method,
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Atlassian-Token': 'no-check',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const raw = await response.text();
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (_e) {
      data = { raw };
    }
  }

  if (!response.ok) {
    const details = data?.errorMessages?.join(', ') || data?.message || response.statusText;
    throw new Error(`Jira API error (${response.status}): ${details}`);
  }

  return data;
}

async function validateJiraConnection(config) {
  // Evita JQL en la prueba inicial para no chocar con políticas de consultas amplias.
  return jiraRequest(config, '/rest/api/3/myself', 'GET');
}

function extractTextFromAdf(node) {
  if (!node) return '';
  if (Array.isArray(node)) {
    return node.map(extractTextFromAdf).filter(Boolean).join(' ').trim();
  }
  if (typeof node === 'string') return node;

  const ownText = typeof node.text === 'string' ? node.text : '';
  const childText = extractTextFromAdf(node.content || []);
  return `${ownText} ${childText}`.replace(/\s+/g, ' ').trim();
}

function getIssueDescriptionText(issue) {
  const desc = issue?.fields?.description;
  if (!desc) return '';
  if (typeof desc === 'string') return desc.trim();
  return extractTextFromAdf(desc).trim();
}

function normalizeIssueWithDetail(issue, detail) {
  const source = detail || issue || {};
  const fields = source?.fields || {};

  return {
    key: source.key || issue?.key,
    summary: fields.summary || '(sin resumen)',
    description: getIssueDescriptionText(source),
    status: fields?.status?.name || 'N/A',
    assignee: fields?.assignee?.displayName || 'Sin asignar',
    issueType: fields?.issuetype?.name || 'Issue',
    updated: fields?.updated || null,
    created: fields?.created || null,
    priority: fields?.priority?.name || null,
    reporter: fields?.reporter?.displayName || null,
    labels: Array.isArray(fields?.labels) ? fields.labels : [],
    components: Array.isArray(fields?.components)
      ? fields.components.map((c) => c?.name).filter(Boolean)
      : [],
    raw: source,
  };
}

async function getIssueFullDetail(config, issueKey) {
  return jiraRequest(
    config,
    `/rest/api/3/issue/${encodeURIComponent(
      issueKey
    )}?fields=*all&expand=names,schema,renderedFields,changelog,transitions,operations,editmeta`,
    'GET'
  );
}

async function enrichIssuesWithDetails(config, issues = []) {
  const detailed = await Promise.all(
    issues.map(async (issue) => {
      try {
        const full = await getIssueFullDetail(config, issue.key);
        return normalizeIssueWithDetail(issue, full);
      } catch (_e) {
        // Fallback al issue parcial si falla el detalle de uno concreto.
        return normalizeIssueWithDetail(issue, issue);
      }
    })
  );
  return detailed;
}

async function getRecentIssues(config, maxResults = 5) {
  if (!config.project) {
    return [];
  }

  const rawJql = `project = "${config.project}" AND updated >= -30d ORDER BY updated DESC`;
  const jql = encodeURIComponent(rawJql);
  const data = await jiraRequest(
    config,
    `/rest/api/3/search/jql?jql=${jql}&maxResults=${maxResults}&fields=key`,
    'GET'
  );

  const issues = Array.isArray(data.issues) ? data.issues : [];
  return enrichIssuesWithDetails(config, issues);
}

async function searchProjectIssues(config, { text = '', maxResults = 10 } = {}) {
  if (!config.project) {
    return [];
  }

  const safeMax = Math.max(1, Math.min(Number(maxResults) || 10, 25));
  const escapedText = String(text || '').replace(/"/g, '\\"').trim();

  const runJqlSearch = async (rawJql) => {
    const jql = encodeURIComponent(rawJql);
    const data = await jiraRequest(
      config,
      `/rest/api/3/search/jql?jql=${jql}&maxResults=${safeMax}&fields=key`,
      'GET'
    );
    return Array.isArray(data.issues) ? data.issues : [];
  };

  // 1) Intento específico por texto (summary/description)
  if (escapedText) {
    try {
      const specificJql = `project = "${config.project}" AND updated >= -365d AND (summary ~ "${escapedText}" OR description ~ "${escapedText}") ORDER BY updated DESC`;
      const specificIssues = await runJqlSearch(specificJql);
      if (specificIssues.length) {
        return enrichIssuesWithDetails(config, specificIssues);
      }
    } catch (_e) {
      // Si la query de texto falla por sintaxis/capacidades, caemos a fallback.
    }
  }

  // 2) Fallback robusto: tickets recientes del proyecto (evita "sin resultados" constante)
  const fallbackJql = `project = "${config.project}" AND updated >= -365d ORDER BY updated DESC`;
  const fallbackIssues = await runJqlSearch(fallbackJql);
  return enrichIssuesWithDetails(config, fallbackIssues);
}

async function getProjectStatuses(config) {
  if (!config.project) return [];

  const data = await jiraRequest(
    config,
    `/rest/api/3/project/${encodeURIComponent(config.project)}/statuses`,
    'GET'
  );

  const issueTypes = Array.isArray(data) ? data : [];
  const statusesMap = new Map();

  issueTypes.forEach((it) => {
    (it.statuses || []).forEach((st) => {
      if (!statusesMap.has(st.id)) {
        statusesMap.set(st.id, {
          id: st.id,
          name: st.name,
          category: st?.statusCategory?.name || 'N/A',
        });
      }
    });
  });

  return Array.from(statusesMap.values());
}

async function getIssueTransitions(config, issueKey) {
  const data = await jiraRequest(
    config,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    'GET'
  );

  return Array.isArray(data.transitions) ? data.transitions : [];
}

async function promoteIssueToNextStatus(config, issueKey) {
  const issue = await jiraRequest(
    config,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=status`,
    'GET'
  );

  const currentStatus = issue?.fields?.status?.name || 'N/A';
  const transitions = await getIssueTransitions(config, issueKey);
  if (!transitions.length) {
    throw new Error(`No hay transiciones disponibles para ${issueKey}.`);
  }

  // Jira ya suele entregar las transiciones válidas en un orden natural de workflow.
  const next = transitions[0];

  await jiraRequest(
    config,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    'POST',
    { transition: { id: next.id } }
  );

  return {
    key: issueKey,
    fromStatus: currentStatus,
    toStatus: next?.to?.name || 'N/A',
  };
}

async function deleteIssue(config, issueKey) {
  await jiraRequest(
    config,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}?deleteSubtasks=true`,
    'DELETE'
  );
  return { key: issueKey, deleted: true };
}

function normalizeLabels(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function normalizeCsv(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

async function findUserAccountId(config, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('accountId:')) return raw.replace('accountId:', '').trim();

  const data = await jiraRequest(
    config,
    `/rest/api/3/user/search?query=${encodeURIComponent(raw)}&maxResults=10`,
    'GET'
  );

  const users = Array.isArray(data) ? data : [];
  const exact = users.find(
    (u) =>
      String(u?.displayName || '').toLowerCase() === raw.toLowerCase() ||
      String(u?.emailAddress || '').toLowerCase() === raw.toLowerCase()
  );
  return (exact || users[0])?.accountId || null;
}

async function findPriorityName(config, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const data = await jiraRequest(config, '/rest/api/3/priority/search?maxResults=200', 'GET');
  const priorities = Array.isArray(data?.values) ? data.values : [];
  const exact = priorities.find((p) => String(p?.name || '').toLowerCase() === raw.toLowerCase());
  return (exact || priorities.find((p) => String(p?.name || '').toLowerCase().includes(raw.toLowerCase())))?.name || raw;
}

async function findProjectComponents(config, names) {
  const wanted = normalizeCsv(names);
  if (!wanted.length) return [];

  const data = await jiraRequest(
    config,
    `/rest/api/3/project/${encodeURIComponent(config.project)}/components`,
    'GET'
  );
  const components = Array.isArray(data) ? data : [];

  return wanted.map((name) => {
    const hit = components.find((c) => String(c?.name || '').toLowerCase() === name.toLowerCase());
    return { name: hit?.name || name };
  });
}

async function findProjectVersions(config, names) {
  const wanted = normalizeCsv(names);
  if (!wanted.length) return [];

  const data = await jiraRequest(
    config,
    `/rest/api/3/project/${encodeURIComponent(config.project)}/versions`,
    'GET'
  );
  const versions = Array.isArray(data) ? data : [];

  return wanted.map((name) => {
    const hit = versions.find((v) => String(v?.name || '').toLowerCase() === name.toLowerCase());
    return { name: hit?.name || name };
  });
}

async function getIssueEditMeta(config, issueKey) {
  const data = await jiraRequest(
    config,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/editmeta`,
    'GET'
  );
  return data?.fields || {};
}

function findEditableFieldKeyByName(editFields, candidates = []) {
  const wanted = candidates.map((c) => c.toLowerCase());
  for (const [fieldKey, fieldMeta] of Object.entries(editFields || {})) {
    const name = String(fieldMeta?.name || '').toLowerCase();
    if (wanted.some((w) => name === w || name.includes(w))) {
      return fieldKey;
    }
  }
  return null;
}

async function buildIssueUpdatePayload(config, issueKey, updates) {
  const fields = {};

  if (!updates || typeof updates !== 'object') {
    throw new Error('No hay campos para actualizar.');
  }

  if (updates.summary || updates.description || updates.title) {
    throw new Error('Summary/description no están permitidos en esta operación.');
  }

  const editFields = await getIssueEditMeta(config, issueKey);

  // Estructura extensible: añadir nuevos campos aquí.
  const handlers = {
    labels: (value) => {
      fields.labels = normalizeLabels(value);
    },
    duedate: (value) => {
      fields.duedate = String(value || '').trim();
    },
    environment: (value) => {
      fields.environment = String(value || '').trim();
    },
    priority: async (value) => {
      const name = await findPriorityName(config, value);
      fields.priority = { name };
    },
    assignee: async (value) => {
      const accountId = await findUserAccountId(config, value);
      if (!accountId) throw new Error(`No encontré usuario para assignee: ${value}`);
      fields.assignee = { accountId };
    },
    reporter: async (value) => {
      const accountId = await findUserAccountId(config, value);
      if (!accountId) throw new Error(`No encontré usuario para reporter: ${value}`);
      fields.reporter = { accountId };
    },
    components: async (value) => {
      fields.components = await findProjectComponents(config, value);
    },
    fixversions: async (value) => {
      fields.fixVersions = await findProjectVersions(config, value);
    },
    parent: (value) => {
      fields.parent = { key: String(value || '').trim().toUpperCase() };
    },
    storypoints: (value) => {
      const key = findEditableFieldKeyByName(editFields, ['story points', 'story point estimate']);
      if (!key) throw new Error('No encontré el campo editable de Story Points en este issue.');
      fields[key] = Number(value);
    },
    epiclink: (value) => {
      const key = findEditableFieldKeyByName(editFields, ['epic link']);
      if (!key) throw new Error('No encontré el campo editable Epic Link en este issue.');
      fields[key] = String(value || '').trim().toUpperCase();
    },
    sprint: (value) => {
      const key = findEditableFieldKeyByName(editFields, ['sprint']);
      if (!key) throw new Error('No encontré el campo editable Sprint en este issue.');
      fields[key] = Number(value);
    },
  };

  for (const [field, value] of Object.entries(updates || {})) {
    const key = String(field || '').trim().toLowerCase();
    const handler = handlers[key];
    if (!handler) {
      throw new Error(`Campo no soportado para actualización: ${key}`);
    }
    await handler(value);
  }

  if (!Object.keys(fields).length) {
    throw new Error('No hay campos válidos para actualizar.');
  }

  return { fields };
}

async function updateIssueFields(config, issueKey, updates) {
  const payload = await buildIssueUpdatePayload(config, issueKey, updates);
  await jiraRequest(
    config,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    'PUT',
    payload
  );

  return {
    key: issueKey,
    updatedFields: Object.keys(payload.fields),
    updates: payload.fields,
  };
}

async function createJiraIssue(config, { summary, description }) {
  const payload = {
    fields: {
      project: { key: config.project },
      summary,
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: description }],
          },
        ],
      },
      issuetype: { name: 'Story' },
    },
  };

  return jiraRequest(config, '/rest/api/3/issue', 'POST', payload);
}

module.exports = {
  validateJiraConnection,
  getRecentIssues,
  searchProjectIssues,
  getProjectStatuses,
  promoteIssueToNextStatus,
  updateIssueFields,
  deleteIssue,
  createJiraIssue,
};
