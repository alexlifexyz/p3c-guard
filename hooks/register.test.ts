import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { addedViolations, applyEdit } from './register'

const HOME = '/home/dev'
const FILE = '/repo/src/OrderService.java'

type Found = { rule: string; beginline: number; priority: number; description: string }

const POOL: Found = {
  rule: 'ThreadPoolCreationRule',
  beginline: 12,
  priority: 1,
  description: '手动创建线程池，效果会更好哦。',
}
const AUTHOR: Found = {
  rule: 'ClassMustHaveAuthorRule',
  beginline: 7,
  priority: 3,
  description: '【OrderService】缺少包含@author的注释信息',
}

type World = {
  files?: Record<string, string>
  before?: Found[]
  after?: Found[]
  isAfterBroken?: boolean
  exitCode?: number
}

/** Stands for the engine beneath the mod: a disk, a PMD that answers from `world`, a Write and an Edit that count. */
const stand = (on: On, world: World) => {
  const ran = { writes: 0, pmd: 0 }
  mock.env(on, { HOME })
  mock.clock(on)
  on('fs.exists', (_$, e) => ({ value: e.path.endsWith('.jar') || e.path in (world.files ?? {}) }))
  on('fs.read', (_$, e) => {
    const text = world.files?.[e.path]

    if (text === undefined) {
      throw new Error('ENOENT')
    }

    return { value: text }
  })
  on('fs.write', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    if (e.argv[0] !== 'java') {
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }

    ran.pmd += 1
    const dir = e.argv[e.argv.indexOf('-d') + 1]
    const report = {
      files: [
        { filename: `${dir}/before/OrderService.java`, violations: world.before ?? [] },
        { filename: `${dir}/after/OrderService.java`, violations: world.after ?? [] },
      ],
      processingErrors: world.isAfterBroken === true
        ? [{ filename: `${dir}/after/OrderService.java` }]
        : [],
    }

    return {
      value: {
        exitCode: world.exitCode ?? 0,
        stdout: JSON.stringify(report),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('tool.call', () => {
    ran.writes += 1

    return { result: {} as never }
  })

  return ran
}

test('applyEdit replaces the first match, or all of them', () => {
  expect(applyEdit('a b a', 'a', '$&x', false)).toBe('$&x b a')
  expect(applyEdit('a b a', 'a', 'c', true)).toBe('c b c')
  expect(applyEdit('a b a', 'z', 'c', false)).toBe(undefined)
})

test('addedViolations keeps only what the write adds at the blocking level', () => {
  const v = (rule: string, priority: number, line = 1) =>
    ({ rule, priority, line, description: rule })

  expect(addedViolations([], [v('A', 1), v('B', 3)], 2).map(one => one.rule)).toEqual(['A'])
  expect(addedViolations([v('A', 1, 5)], [v('A', 1, 9)], 2)).toEqual([])
  expect(addedViolations([v('A', 1)], [v('A', 1), v('A', 1, 7)], 2)).toHaveLength(1)
  expect(addedViolations([], [v('B', 3)], 3)).toHaveLength(1)
})

test('a Write that adds a violation is refused and never reaches the tool', async ($, on) => {
  const ran = stand(on, { after: [AUTHOR, POOL], exitCode: 4 })
  const answer = await $.tool.call({ tool: 'Write', file_path: FILE, content: 'class OrderService {}' })

  expect(answer.deny).toContain('ThreadPoolCreationRule')
  expect(answer.deny).toContain('第 12 行')
  expect(answer.deny).toContain('改法：用 new ThreadPoolExecutor')
  expect(answer.deny).not.toContain('ClassMustHaveAuthorRule')
  expect(ran.writes).toBe(0)
})

test('a Write whose violations the file already had goes through', async ($, on) => {
  const ran = stand(on, {
    files: { [FILE]: 'class OrderService {}' },
    before: [POOL],
    after: [{ ...POOL, beginline: 20 }, AUTHOR],
    exitCode: 4,
  })
  const answer = await $.tool.call({ tool: 'Write', file_path: FILE, content: 'class OrderService { }' })

  expect(answer.deny).toBe(undefined)
  expect(ran.pmd).toBe(1)
  expect(ran.writes).toBe(1)
})

test('an Edit is judged on the file as it would stand after it', async ($, on) => {
  const ran = stand(on, { files: { [FILE]: 'class OrderService { int a; }' }, after: [POOL], exitCode: 4 })
  const answer = await $.tool.call({
    tool: 'Edit',
    file_path: FILE,
    old_string: 'int a;',
    new_string: 'Object p = java.util.concurrent.Executors.newCachedThreadPool();',
  })

  expect(answer.deny).toContain('新增 1 处')
  expect(ran.writes).toBe(0)
})

test('an Edit that does not apply is left to the tool', async ($, on) => {
  const ran = stand(on, { files: { [FILE]: 'class OrderService {}' }, after: [POOL] })
  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'missing', new_string: 'x' })

  expect(ran.pmd).toBe(0)
  expect(ran.writes).toBe(1)
})

test('a file that is not Java is not checked', async ($, on) => {
  const ran = stand(on, { after: [POOL] })
  await $.tool.call({ tool: 'Write', file_path: '/repo/README.md', content: '# hi' })

  expect(ran.pmd).toBe(0)
  expect(ran.writes).toBe(1)
})

test('a file that does not parse goes through', async ($, on) => {
  const ran = stand(on, { after: [POOL], isAfterBroken: true, exitCode: 5 })
  const answer = await $.tool.call({ tool: 'Write', file_path: FILE, content: 'class {' })

  expect(answer.deny).toBe(undefined)
  expect(ran.pmd).toBe(1)
  expect(ran.writes).toBe(1)
})

test('a guard that fails lets the write through', async ($, on) => {
  const ran = stand(on, { after: [POOL], exitCode: 1 })
  const answer = await $.tool.call({ tool: 'Write', file_path: FILE, content: 'class OrderService {}' })

  expect(answer.deny).toBe(undefined)
  expect(ran.pmd).toBe(1)
  expect(ran.writes).toBe(1)
})

test('blockPriority 3 also refuses the mildest rules', { options: { blockPriority: '3' } }, async ($, on) => {
  stand(on, { after: [AUTHOR], exitCode: 4 })
  const answer = await $.tool.call({ tool: 'Write', file_path: FILE, content: 'class OrderService {}' })

  expect(answer.deny).toContain('ClassMustHaveAuthorRule')
})

test('/p3c off pauses the guard', async ($, on) => {
  const ran = stand(on, { after: [POOL], exitCode: 4 })
  const said = await $.command.run({ command: 'p3c', args: 'off' })
  await $.tool.call({ tool: 'Write', file_path: FILE, content: 'class OrderService {}' })

  expect(said.text).toContain('已暂停')
  expect(ran.pmd).toBe(0)
  expect(ran.writes).toBe(1)
})
