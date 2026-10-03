import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GitError, selectCommits } from '../../src/check/git.ts'
import { formatReport, runCheck } from '../../src/check/run.ts'
import { check } from '../../src/commands/check.ts'
import { config, PR_SIGNATURE, SIGNATURE } from './fixtures.ts'
import { createRepository, HUMAN_EMAIL, type Repository } from './repository.ts'

let repo: Repository
const hash: Record<string, string> = {}

/** The findings of one commit, as kinds. */
function kindsOf(name: string, overrides = {}): string[] {
  const report = runCheck(config(overrides), { cwd: repo.path, ref: hash[name] })
  expect(report.commits).toHaveLength(1)
  return report.commits[0].findings.map((finding) => finding.kind)
}

beforeAll(() => {
  repo = createRepository()
  const add = (name: string, message: string, email?: string) => {
    hash[name] = repo.commit(message, email)
  }

  add('old', 'chore: before the rule')
  add('older-unsigned', 'chore: also before the rule')
  add('signed', `feat: signed\n\nSome prose.\n\n${SIGNATURE}`)
  add('coauthored', `feat: two trailers\n\n${SIGNATURE}\nCo-authored-by: A <a@b.example>`)
  add('unsigned', 'fix: unsigned\n\nSome prose.')
  add('prose', `fix: prose in the paragraph\n\nRefs #3\n${SIGNATURE}`)
  add('fixes', `fix: a trailer before it\n\nFixes: #11\n${SIGNATURE}`)
  add('human', 'docs: by a human', HUMAN_EMAIL)
  add('human-forbidden', 'docs: by a human\n\nClaude-Session: 1234', HUMAN_EMAIL)
  add('session', `feat: session line\n\nClaude-Session: 1234\n\n${SIGNATURE}`)
  add('link', `feat: session link\n\nSee https://claude.ai/code/session_01ab\n\n${SIGNATURE}`)
  add('tracker', `feat: tracker id (WEB-12)\n\n${SIGNATURE}`)
  add('no-version', 'feat: no version\n\nAgent: Claude Opus · implementer')
  add('wrong-pair', 'feat: wrong pair\n\nAgent: GPT-6 Sol · implementer')
  add('subject-only', SIGNATURE)

  repo.git('switch', '--quiet', '-c', 'side', hash.old)
  hash.side = repo.commit(`feat: on a side branch\n\n${SIGNATURE}`)
  repo.git('switch', '--quiet', 'main')
  repo.git('merge', '--quiet', '--no-ff', '--no-gpg-sign', '-m', 'Merge branch side', 'side')
  hash.merge = repo.git('rev-parse', 'HEAD')

  hash.clean1 = repo.commit(`feat: clean one\n\n${SIGNATURE}`)
  hash.clean2 = repo.commit(`feat: clean two\n\n${SIGNATURE}`)
})

afterAll(() => repo.remove())

describe('one commit', () => {
  test('a signature in a trailer block passes', () => {
    expect(kindsOf('signed')).toEqual([])
  })

  test('a Co-authored-by after the signature passes', () => {
    expect(kindsOf('coauthored')).toEqual([])
  })

  test('a trailer before the signature passes', () => {
    expect(kindsOf('fixes')).toEqual([])
  })

  test('an unsigned commit is refused', () => {
    expect(kindsOf('unsigned')).toEqual(['signature-missing'])
  })

  test('prose in the trailer paragraph is named as that case', () => {
    expect(kindsOf('prose')).toEqual(['signature-in-prose'])
  })

  test('the same message passes when the position is last-line', () => {
    expect(kindsOf('prose', { commits: { ...config().commits, position: 'last-line' } })).toEqual([])
  })

  test('a signature as the subject is in no trailer block', () => {
    expect(kindsOf('subject-only')).toEqual(['signature-misplaced'])
  })

  test('a human needs no signature', () => {
    const report = runCheck(config(), { cwd: repo.path, ref: hash.human })
    expect(report.commits[0]).toMatchObject({ exempt: 'human', findings: [] })
    expect(report.ok).toBe(true)
  })

  test('a human is matched whatever the case of the email', () => {
    expect(kindsOf('human', { humans: [HUMAN_EMAIL.toUpperCase()] })).toEqual([])
  })

  test('a human who is not listed must sign', () => {
    expect(kindsOf('human', { humans: [] })).toEqual(['signature-missing'])
  })

  test("a human's commit is still checked for forbidden patterns", () => {
    expect(kindsOf('human-forbidden')).toEqual(['forbidden'])
  })

  test('a merge needs no signature', () => {
    const report = runCheck(config(), { cwd: repo.path, ref: hash.merge })
    expect(report.commits[0]).toMatchObject({ exempt: 'merge', findings: [] })
  })

  test('a merge must sign when the file exempts nothing', () => {
    expect(kindsOf('merge', { commits: { ...config().commits, exemptMerge: false } })).toEqual([
      'signature-missing',
    ])
  })

  test('each default forbidden pattern is refused in a signed commit', () => {
    expect(kindsOf('session')).toEqual(['forbidden'])
    expect(kindsOf('link')).toEqual(['forbidden'])
  })

  test('a tracker id is refused in a public project only', () => {
    expect(kindsOf('tracker')).toEqual(['forbidden'])
    expect(kindsOf('tracker', { public: false })).toEqual([])
  })

  test('a signature without the version, or with a pair no seat had, is refused', () => {
    expect(kindsOf('no-version')).toEqual(['signature-unknown'])
    expect(kindsOf('wrong-pair')).toEqual(['signature-unknown'])
  })

  test('a single ref never reads the history behind it', () => {
    const report = runCheck(config(), { cwd: repo.path, ref: 'main' })
    expect(report.commits.map((commit) => commit.hash)).toEqual([hash.clean2])
    expect(report.ok).toBe(true)
  })
})

describe('a range', () => {
  test('is passed to git as given, newest first', () => {
    const report = runCheck(config(), { cwd: repo.path, ref: `${hash.merge}..main` })
    expect(report.commits.map((commit) => commit.hash)).toEqual([hash.clean2, hash.clean1])
    expect(report.ok).toBe(true)
  })

  test('reports every offending commit', () => {
    const report = runCheck(config(), { cwd: repo.path, ref: `${hash.old}..main` })
    const refused = report.commits.filter((commit) => commit.findings.length > 0).map((commit) => commit.hash)
    expect(new Set(refused)).toEqual(
      new Set(
        [
          'older-unsigned',
          'unsigned',
          'prose',
          'human-forbidden',
          'session',
          'link',
          'tracker',
          'no-version',
          'wrong-pair',
          'subject-only',
        ].map((name) => hash[name]),
      ),
    )
    expect(report.ok).toBe(false)
  })

  test('an empty range is an error', () => {
    expect(() => selectCommits(repo.path, 'main..main')).toThrow('holds no commit')
  })

  test('an unresolvable range or ref is an error', () => {
    expect(() => selectCommits(repo.path, 'nowhere..main')).toThrow(GitError)
    expect(() => selectCommits(repo.path, 'nowhere')).toThrow("doesn't name a commit")
  })

  test('a ref that looks like an option is refused', () => {
    expect(() => selectCommits(repo.path, '--all')).toThrow('is not a ref')
    expect(() => selectCommits(repo.path, 'main', '--all')).toThrow('is not a ref')
  })

  test('a folder that is no repository is an error', () => {
    expect(() => selectCommits('/', 'HEAD')).toThrow(GitError)
  })
})

describe('since', () => {
  test('skips the commit and everything reachable from it', () => {
    const selection = selectCommits(repo.path, `${hash.signed}..main`, hash.merge)
    expect(selection.commits.map((commit) => commit.hash)).toEqual([hash.clean2, hash.clean1])
    expect(selection.since).toBe(hash.merge)
  })

  test('counts what it leaves out of a range', () => {
    const report = runCheck(config({ since: hash.merge }), { cwd: repo.path, ref: `${hash.old}..main` })
    expect(report.commits.map((commit) => commit.hash)).toEqual([hash.clean2, hash.clean1])
    expect(report.skipped).toBe(16)
    expect(report.ok).toBe(true)
  })

  test('passes when it sits behind the range', () => {
    const selection = selectCommits(repo.path, `${hash.merge}..main`, hash.old)
    expect(selection.commits).toHaveLength(2)
    expect(selection.skipped).toBe(0)
  })

  test('the option overrides the file', () => {
    const report = runCheck(config({ since: hash.old }), {
      cwd: repo.path,
      ref: `${hash.old}..main`,
      since: hash.merge,
    })
    expect(report.commits).toHaveLength(2)
  })

  test('a commit that is not reachable from the range is an error', () => {
    expect(() => selectCommits(repo.path, hash.signed, hash.clean1)).toThrow('is not reachable from')
  })

  test('a commit that does not exist is an error', () => {
    expect(() => selectCommits(repo.path, 'main', 'nowhere')).toThrow("doesn't name a commit here")
  })

  test('a range it covers whole passes with nothing checked, and says so', () => {
    const report = runCheck(config({ since: 'main' }), { cwd: repo.path, ref: 'main' })
    expect(report.commits).toEqual([])
    expect(report.ok).toBe(true)
    expect(formatReport(report)).toContain('0 commits checked, 1 skipped (since ')
  })
})

describe('the pull request body', () => {
  test('passes with the signature last', () => {
    const report = runCheck(config(), { cwd: repo.path, ref: 'main', pullRequestBody: `text\n\n${PR_SIGNATURE}\n` })
    expect(report.pullRequest).toEqual([])
    expect(report.ok).toBe(true)
  })

  test('is refused without one, and for a forbidden line', () => {
    const report = runCheck(config(), {
      cwd: repo.path,
      ref: 'main',
      pullRequestBody: 'Closes WEB-3\n\nClaude-Session: 1',
    })
    expect(report.pullRequest?.map((finding) => finding.kind)).toEqual(['forbidden', 'forbidden', 'signature-missing'])
    expect(report.ok).toBe(false)
  })
})

describe('the command', () => {
  const load = () => ({ ok: true as const, config: config() })

  async function run(argv: string[], loader = load as Parameters<typeof check>[2]) {
    let stdout = ''
    let stderr = ''
    const io = {
      stdout: (text: string) => void (stdout += text),
      stderr: (text: string) => void (stderr += text),
      cwd: repo.path,
    }
    const code = await check(argv, io, loader)
    return { code, stdout, stderr }
  }

  test('exits 0 and prints the summary', async () => {
    const result = await run([`${hash.merge}..main`])
    expect(result).toEqual({ code: 0, stdout: 'team check: 2 commits checked: ok\n', stderr: '' })
  })

  test('exits 1 with each offending commit and line', async () => {
    const result = await run([`${hash.human}..${hash.link}`])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe(
      [
        `${hash.link.slice(0, 10)} feat: session link`,
        '  line 3: forbidden pattern https?://claude\\.ai/code/session',
        '    See https://claude.ai/code/session_01ab',
        `${hash.session.slice(0, 10)} feat: session line`,
        '  line 3: forbidden pattern ^Claude-Session:',
        '    Claude-Session: 1234',
        `${hash['human-forbidden'].slice(0, 10)} docs: by a human`,
        '  line 3: forbidden pattern ^Claude-Session:',
        '    Claude-Session: 1234',
        'team check: 3 commits checked, 1 by a human or a merge: 3 commits refused',
        '',
      ].join('\n'),
    )
  })

  test('names the prose case and the missing case apart', async () => {
    const prose = await run([hash.prose])
    expect(prose.stdout).toContain('line 4: the signature shares its paragraph with prose ("Refs #3")')
    const missing = await run([hash.unsigned])
    expect(missing.stdout).toContain('  no signature: expected "Agent: {display} · {role}" in the final trailer block')
  })

  test('reads the pull request body from a file', async () => {
    writeFileSync(join(repo.path, 'body.md'), `text\n\n${PR_SIGNATURE}\n`)
    const passed = await run(['main', '--pr', 'body.md'])
    expect(passed).toMatchObject({ code: 0, stdout: 'team check: 1 commit checked, 1 pull request body checked: ok\n' })

    writeFileSync(join(repo.path, 'body.md'), 'text\n')
    const refused = await run(['main', '--pr=body.md'])
    expect(refused.code).toBe(1)
    expect(refused.stdout).toContain('pull request body\n  no signature: expected "**Agent:** {display} · {role}" in the last line')
    expect(refused.stdout).toContain('the pull request body refused')
  })

  test('exits 2 when the body, the range or since cannot be read', async () => {
    expect(await run(['main', '--pr', 'missing.md'])).toMatchObject({ code: 2, stdout: '' })
    expect(await run(['main..main'])).toEqual({
      code: 2,
      stdout: '',
      stderr: 'team check: the range "main..main" holds no commit\n',
    })
    expect((await run([hash.signed, '--since', hash.clean1])).code).toBe(2)
  })

  test('exits 2 on a usage error', async () => {
    expect((await run([])).stderr).toStartWith('team check: a <ref> is required\n\nusage: team check <ref>')
    expect((await run(['a', 'b'])).code).toBe(2)
    expect((await run(['main', '--force'])).stderr).toStartWith('team check: unknown option --force')
    expect((await run(['main', '--since'])).stderr).toStartWith('team check: --since needs a value')
  })

  test('prints the usage for --help', async () => {
    const result = await run(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toStartWith('usage: team check <ref>')
  })

  test('exits 2 with the line when the team file is refused', async () => {
    const result = await run(['main'], () => ({
      ok: false,
      path: '.agents/team.yaml',
      errors: [{ line: 12, message: 'unknown field "sesion"' }],
    }))
    expect(result).toEqual({
      code: 2,
      stdout: '',
      stderr: 'team check: .agents/team.yaml, line 12: unknown field "sesion"\n',
    })
  })
})
