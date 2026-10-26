import React, { useState } from 'react'
import { ChangedFile, CommitSummary, PullRequestSummary, RepoInfo } from '../../src/protocol'
import { absoluteTime, avatarForEmail, relativeTime } from '../format'
import { post } from '../vscode-api'
import { Avatar, Icon, IconButton, Stats } from './Common'

function sumStats(files: ReadonlyArray<ChangedFile> | null) {
  if (!files) {
    return {}
  }
  return {
    additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
    deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
  }
}

function Description(props: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  if (!props.text) {
    return null
  }
  const long = props.text.split('\n').length > 4 || props.text.length > 400
  return (
    <div className={`header-description ${long && !expanded ? 'collapsed' : ''}`}>
      <pre>{props.text}</pre>
      {long ? (
        <button className="expand-button" onClick={() => setExpanded(!expanded)} title={expanded ? 'Collapse' : 'Expand'}>
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} />
        </button>
      ) : null}
    </div>
  )
}

export function commitAvatar(commit: CommitSummary, repo: RepoInfo): string | undefined {
  return commit.avatarUrl ?? (repo.github ? avatarForEmail(commit.authorEmail) : undefined)
}

export function CommitHeader(props: { commit: CommitSummary; files: ReadonlyArray<ChangedFile> | null; repo: RepoInfo }) {
  const { commit, repo } = props
  const stats = sumStats(props.files)
  return (
    <div className="details-header">
      <div className="header-title">{commit.summary}</div>
      <Description text={commit.body} />
      <div className="header-meta">
        <span className="meta-item">
          <Avatar url={commitAvatar(commit, repo)} name={commit.authorName} />
          <span title={commit.authorEmail}>{commit.authorName}</span>
        </span>
        <span className="meta-item" title={absoluteTime(commit.date)}>
          {relativeTime(commit.date)}
        </span>
        <span className="meta-item sha" title={commit.sha}>
          <Icon name="git-commit" />
          {commit.shortSha}
          <IconButton icon="copy" title="Copy SHA" onClick={() => post({ type: 'copy', text: commit.sha })} />
        </span>
        <Stats {...stats} />
        {commit.refs.map(ref => (
          <span key={ref} className="ref-badge">
            {ref}
          </span>
        ))}
      </div>
    </div>
  )
}

export function PullRequestStateBadge(props: { pr: PullRequestSummary }) {
  const { pr } = props
  const state = pr.draft && pr.state === 'open' ? 'draft' : pr.state
  const icon = state === 'merged' ? 'git-merge' : state === 'closed' ? 'git-pull-request-closed' : state === 'draft' ? 'git-pull-request-draft' : 'git-pull-request'
  return <Icon name={icon} className={`pr-state pr-${state}`} title={state} />
}

export function PullRequestHeader(props: { pr: PullRequestSummary; commitCount: number; currentBranch: string | null }) {
  const { pr } = props
  const checkedOut = props.currentBranch === (pr.fromFork ? `pr/${pr.number}` : pr.headBranch)
  return (
    <div className="details-header">
      <div className="header-title">
        <PullRequestStateBadge pr={pr} />
        <span>
          {pr.title} <span className="pr-number">#{pr.number}</span>
        </span>
        <span className="spacer" />
        {pr.state === 'open' ? (
          checkedOut ? (
            <span className="checked-out" title="This pull request is the current branch">
              <Icon name="check" /> Checked out
            </span>
          ) : (
            <button
              className="secondary-button"
              title={`Fetch and check out ${pr.fromFork ? `pr/${pr.number}` : pr.headBranch}`}
              onClick={() => post({ type: 'checkoutPullRequest', number: pr.number })}
            >
              <Icon name="git-branch" /> Checkout
            </button>
          )
        ) : null}
        <IconButton icon="link-external" title="View on GitHub" onClick={() => post({ type: 'openExternal', url: pr.url })} />
      </div>
      {/* PR templates leave HTML comments behind that GitHub hides when rendering. */}
      <Description text={pr.body.replace(/<!--[\s\S]*?-->/g, '').trim()} />
      <div className="header-meta">
        <span className="meta-item">
          <Avatar url={pr.avatarUrl} name={pr.author} />
          {pr.author}
        </span>
        <span className="meta-item branch-flow">
          <span className="branch-name">{pr.baseRef}</span>
          <Icon name="arrow-left" />
          <span className="branch-name">{pr.headRef}</span>
        </span>
        <span className="meta-item" title={absoluteTime(pr.updatedAt)}>
          {relativeTime(pr.updatedAt)}
        </span>
        <span className="meta-item">
          <Icon name="git-commit" /> {props.commitCount}
        </span>
        <Stats additions={pr.additions} deletions={pr.deletions} />
      </div>
    </div>
  )
}

/** Header for a range of selected commits, like GitHub Desktop's multi-commit diff. */
export function MultiCommitHeader(props: {
  commits: ReadonlyArray<CommitSummary>
  files: ReadonlyArray<ChangedFile> | null
  repo: RepoInfo
  contiguous: boolean
}) {
  const { commits, repo } = props
  const newest = commits[0]
  const oldest = commits[commits.length - 1]
  const authors = [...new Map(commits.map(c => [c.authorEmail || c.authorName, c])).values()]
  return (
    <div className="details-header">
      <div className="header-title">{commits.length} commits selected</div>
      <div className="header-meta">
        <span className="meta-item">
          {authors.slice(0, 5).map(c => (
            <Avatar key={c.sha} url={commitAvatar(c, repo)} name={c.authorName} />
          ))}
          {authors.length === 1 ? authors[0].authorName : `${authors.length} authors`}
        </span>
        {props.contiguous ? (
          <span className="meta-item sha" title={`${oldest.sha}^..${newest.sha}`}>
            <Icon name="git-commit" />
            {oldest.shortSha}..{newest.shortSha}
          </span>
        ) : null}
        <Stats {...sumStats(props.files)} />
      </div>
    </div>
  )
}
