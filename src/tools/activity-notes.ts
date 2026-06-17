import { JiraActivity } from '../shared/data-sources/jira';
import { GitHubActivity } from '../shared/data-sources/github';

const SYSTEM_PROMPT = `You are a developer assistant that turns recent JIRA and GitHub activity into a Slack-native status update that works for both a daily standup and a work handoff. The output is pasted directly into a Slack message.

Format (Slack mrkdwn):
:white_check_mark: *Shipped / Done*
- (completed items, each leading with the ticket ID and/or PR number, then a short description)

:hourglass_flowing_sand: *In Progress*
- (current items, one short line each, with status and an ETA when it can be inferred)

:construction: *Blockers & Open Questions*
- (be specific about what is stuck and what/who is needed to unblock it; name the person or team to tag when known; write "None" if nothing is blocked)

:dart: *Next / Handoff*
- (upcoming priorities or items to hand off to someone else)

Slack formatting rules:
- This is Slack mrkdwn for everything except links. Use *single asterisks* for bold; never use ** or ## headings (Slack shows them as literal text). For links only, use Markdown [text](url) syntax (the Slack composer turns it into a hyperlink on send).
- Use "-" for bullets. Keep one short, scannable line per item, ideally 3-5 bullets per section.
- Lead each section with the emoji shortcode shown above; you may add an occasional inline status emoji (e.g. :rocket:, :eyes:) but do not overuse them.
- Reference work by its ticket ID and PR number. When the input provides a URL for an item (shown as "(URL: ...)"), turn the reference into a Markdown link like [PROJ-123](url) or [PR #45](url). Never fabricate or guess a URL; if no URL is provided, use plain text (e.g. PROJ-123).
- Group related work by ticket when possible: when a PR, commit, or comment can be tied to a ticket (e.g. the ticket key appears in the PR title, branch, or comment), present them together under that ticket rather than as scattered separate bullets.
- Use the comments provided for each ticket and PR to detect blockers: open questions, "waiting on", "blocked by", requested review changes, and failing checks are all blocker signals. Surface them in the Blockers section with the relevant ticket/PR link and the person or team to tag.
- Never bury blockers; surface them clearly and say "None" explicitly when there are none.
- If additional context from selected text is provided, incorporate it.
- Output ONLY the Slack message, nothing else.`;

export function buildActivityNotesPrompt(): string {
  return SYSTEM_PROMPT;
}

export function buildActivityNotesContent(
  jiraActivity: JiraActivity | null,
  githubActivity: GitHubActivity | null,
  additionalContext: string
): string {
  const parts: string[] = [];

  if (jiraActivity && jiraActivity.issues.length > 0) {
    parts.push('=== JIRA Activity ===');
    for (const issue of jiraActivity.issues) {
      parts.push(`- ${issue.key}: ${issue.summary} [${issue.status}] (URL: ${issue.url})`);
      for (const comment of issue.comments) {
        parts.push(`    comment by ${comment.author}: ${comment.body}`);
      }
    }
  }

  if (githubActivity) {
    if (githubActivity.pullRequests.length > 0) {
      parts.push('\n=== GitHub Pull Requests ===');
      for (const pr of githubActivity.pullRequests) {
        parts.push(`- PR #${pr.number}: ${pr.title} [${pr.state}] (URL: ${pr.url})`);
        for (const comment of pr.comments) {
          parts.push(`    comment by ${comment.author}: ${comment.body}`);
        }
      }
    }
    if (githubActivity.commits.length > 0) {
      parts.push('\n=== Recent Commits ===');
      for (const commit of githubActivity.commits) {
        parts.push(`- ${commit.sha.slice(0, 7)}: ${commit.message}`);
      }
    }
  }

  if (additionalContext.trim()) {
    parts.push(`\n=== Additional Context ===\n${additionalContext}`);
  }

  if (parts.length === 0) {
    return 'No activity data available. Please configure JIRA and/or GitHub in Settings.';
  }

  return parts.join('\n');
}
