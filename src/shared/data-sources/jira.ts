export interface JiraComment {
  author: string;
  body: string;
  created: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  assignee: string;
  updated: string;
  url: string;
  comments: JiraComment[];
}

export interface JiraActivity {
  issues: JiraIssue[];
}

const MAX_COMMENTS_PER_ISSUE = 5;
const MAX_COMMENT_LENGTH = 280;

/** Flattens an Atlassian Document Format (ADF) node tree into plain text. */
function adfToText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');

  let text = '';
  if (node.type === 'text' && typeof node.text === 'string') {
    text += node.text;
  }
  if (Array.isArray(node.content)) {
    text += node.content.map(adfToText).join('');
  }
  if (node.type === 'hardBreak') {
    text += '\n';
  }
  if (node.type === 'paragraph') {
    text += '\n';
  }
  return text;
}

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export async function fetchJiraActivity(config: JiraConfig): Promise<JiraActivity> {
  if (!config.baseUrl || !config.email || !config.apiToken) {
    return { issues: [] };
  }

  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');

  const jql = `assignee = currentUser() AND updated >= -7d ORDER BY updated DESC`;
  // Atlassian removed the legacy /rest/api/3/search endpoint (returns 410 Gone).
  // Use the enhanced JQL search endpoint instead. See CHANGE-2046.
  const url = `${baseUrl}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=20&fields=summary,status,assignee,updated,comment`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`JIRA API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  const issues: JiraIssue[] = (data.issues || []).map((issue: any) => {
    const rawComments: any[] = issue.fields?.comment?.comments || [];
    const comments: JiraComment[] = rawComments.slice(-MAX_COMMENTS_PER_ISSUE).map((c: any) => {
      const body = adfToText(c.body).replace(/\n{2,}/g, '\n').trim();
      return {
        author: c.author?.displayName || 'Unknown',
        body: body.length > MAX_COMMENT_LENGTH ? `${body.slice(0, MAX_COMMENT_LENGTH)}…` : body,
        created: c.created || '',
      };
    });

    return {
      key: issue.key,
      summary: issue.fields?.summary || '',
      status: issue.fields?.status?.name || 'Unknown',
      assignee: issue.fields?.assignee?.displayName || 'Unassigned',
      updated: issue.fields?.updated || '',
      url: `${baseUrl}/browse/${issue.key}`,
      comments,
    };
  });

  return { issues };
}
