import { tauriFetch } from '../http';

export interface GitHubComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  state: string;
  url: string;
  updatedAt: string;
  comments: GitHubComment[];
}

export interface GitHubCommit {
  sha: string;
  message: string;
  date: string;
}

export interface GitHubActivity {
  pullRequests: GitHubPR[];
  commits: GitHubCommit[];
}

export interface GitHubConfig {
  token: string;
}

async function githubFetchUrl(url: string, token: string): Promise<any> {
  const response = await tauriFetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function githubFetch(endpoint: string, token: string): Promise<any> {
  return githubFetchUrl(`https://api.github.com${endpoint}`, token);
}

const MAX_PRS_WITH_COMMENTS = 8;
const MAX_COMMENTS_PER_PR = 5;
const MAX_COMMENT_LENGTH = 280;

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

async function fetchPRComments(commentsUrl: string, token: string): Promise<GitHubComment[]> {
  try {
    const data = await githubFetchUrl(`${commentsUrl}?per_page=100`, token);
    const comments: GitHubComment[] = (data || []).map((c: any) => ({
      author: c.user?.login || 'unknown',
      body: truncate(c.body || '', MAX_COMMENT_LENGTH),
      createdAt: c.created_at || '',
    }));
    return comments.slice(-MAX_COMMENTS_PER_PR);
  } catch {
    // Best-effort: a failed comment fetch must not break the whole activity fetch.
    return [];
  }
}

export async function fetchGitHubActivity(config: GitHubConfig): Promise<GitHubActivity> {
  // Strip control characters and surrounding whitespace. A leading NUL byte from
  // a corrupted clipboard paste would otherwise make the Authorization header invalid.
  const token = config.token.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!token) {
    return { pullRequests: [], commits: [] };
  }

  const user = await githubFetch('/user', token);
  const username = user.login;

  const since = new Date();
  since.setDate(since.getDate() - 7);
  const sinceISO = since.toISOString();

  const [prsData, eventsData] = await Promise.all([
    githubFetch(`/search/issues?q=author:${username}+type:pr+updated:>=${sinceISO.split('T')[0]}&sort=updated&per_page=15`, token),
    githubFetch(`/users/${username}/events?per_page=30`, token),
  ]);

  const prItems: any[] = prsData.items || [];
  const pullRequests: GitHubPR[] = prItems.map((pr: any) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.html_url,
    updatedAt: pr.updated_at,
    comments: [],
  }));

  // Fetch conversation comments for the most recently updated PRs only.
  // Search results are already sorted by updated desc, so take the first N.
  await Promise.all(
    pullRequests.slice(0, MAX_PRS_WITH_COMMENTS).map(async (pr, i) => {
      const commentsUrl = prItems[i]?.comments_url;
      const commentCount = prItems[i]?.comments ?? 0;
      if (commentsUrl && commentCount > 0) {
        pr.comments = await fetchPRComments(commentsUrl, token);
      }
    })
  );

  const commits: GitHubCommit[] = (eventsData || [])
    .filter((e: any) => e.type === 'PushEvent')
    .flatMap((e: any) =>
      (e.payload?.commits || []).map((c: any) => ({
        sha: c.sha,
        message: c.message?.split('\n')[0] || '',
        date: e.created_at,
      }))
    )
    .slice(0, 15);

  return { pullRequests, commits };
}
