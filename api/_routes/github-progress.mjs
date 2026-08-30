const json = (response, status, body) => {
  response.status(status)
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900')
  response.send(JSON.stringify(body))
}

const githubRequest = async (path, token) => {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'AetherAC-Progress-Sync'
    }
  })
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`)
  return response.json()
}

export default async function handler(request, response) {
  const requested = request?.query?.repository
  const repositoryName = requested || process.env.GITHUB_REPOSITORY
  const token = process.env.GITHUB_TOKEN
  if (!repositoryName || !token || !repositoryName.includes('/')) {
    return json(response, 200, {
      configured: false,
      message: '在 Vercel 中配置 GITHUB_REPOSITORY（owner/repo）和只读 GITHUB_TOKEN 后启用实时同步。'
    })
  }

  try {
    const encodedRepository = repositoryName.split('/').map(encodeURIComponent).join('/')
    const [repository, issues, milestones] = await Promise.all([
      githubRequest(`/repos/${encodedRepository}`, token),
      githubRequest(`/repos/${encodedRepository}/issues?state=all&sort=updated&direction=desc&per_page=100`, token),
      githubRequest(`/repos/${encodedRepository}/milestones?state=all&sort=due_on&direction=asc&per_page=100`, token)
    ])
    const realIssues = issues.filter(issue => !issue.pull_request)
    const closedIssues = realIssues.filter(issue => issue.state === 'closed').length
    const completion = realIssues.length ? Math.round((closedIssues / realIssues.length) * 100) : 0

    return json(response, 200, {
      configured: true,
      repository: {
        name: repository.full_name,
        url: repository.html_url,
        description: repository.description,
        updatedAt: repository.updated_at
      },
      totals: {
        openIssues: realIssues.length - closedIssues,
        closedIssues,
        milestones: milestones.length,
        completion
      },
      milestones: milestones.slice(0, 8).map(milestone => ({
        title: milestone.title,
        open: milestone.open_issues,
        closed: milestone.closed_issues,
        percent: milestone.open_issues + milestone.closed_issues
          ? Math.round((milestone.closed_issues / (milestone.open_issues + milestone.closed_issues)) * 100)
          : 0,
        url: milestone.html_url
      })),
      recentIssues: realIssues.slice(0, 8).map(issue => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        url: issue.html_url,
        labels: issue.labels.map(label => typeof label === 'string' ? label : label.name),
        updatedAt: issue.updated_at
      })),
      syncedAt: new Date().toISOString()
    })
  } catch (error) {
    console.error('[github-progress]', error)
    return json(response, 502, { configured: true, message: 'GitHub 同步失败，请检查仓库名称、Token 权限和 API 配额。' })
  }
}
