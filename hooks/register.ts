import type { EngineInterface, Register } from 'claude-code'

const JAR_VERSION = '3.0.1'
const JAR_NAME = `p3c-pmd-jdk21-${JAR_VERSION}-cli.jar`
const JAR_URL = `https://repo1.maven.org/maven2/io/github/loong95/p3c-pmd-jdk21/${JAR_VERSION}/${JAR_NAME}`
const JAR_SHA256 = '4caf54a3a8f33cc079a16857147168f268cae7e86072413e9ab07365dc311a16'
const RULESET = 'rulesets/java/ali-all.xml'
const MAX_LISTED = 10

// How to fix the rules whose own message does not say; shown after it.
const FIXES: Readonly<Record<string, string>> = {
  ThreadPoolCreationRule:
    '用 new ThreadPoolExecutor(...) 显式给出核心数、最大数、有界队列和带名字的 ThreadFactory；Spring 项目注入已配置的 ThreadPoolTaskExecutor。',
  AvoidManuallyCreateThreadRule: '把任务提交给已有的线程池，不要 new Thread()。',
  ThreadShouldSetNameRule: '给 ThreadFactory 或线程池设置有业务含义的线程名前缀。',
  AvoidCallStaticSimpleDateFormatRule:
    '改用线程安全的 DateTimeFormatter，或每次调用新建 SimpleDateFormat。',
  ThreadLocalShouldRemoveRule: '在 finally 里调用 remove()。',
  AvoidUseTimerRule: '改用 ScheduledThreadPoolExecutor。',
  LockShouldWithTryFinallyRule: 'lock() 紧接 try，unlock() 放在 finally 的第一行。',
  DontModifyInForeachCircleRule: '改用 Iterator.remove() 或 Collection.removeIf(...)。',
  WrapperTypeEqualityRule: '用 Objects.equals(a, b) 比较包装类型。',
  AvoidDoubleOrFloatEqualCompareRule: '用 BigDecimal.compareTo，或比较差值是否小于给定误差。',
  AvoidApacheBeanUtilsCopyRule: '改用 Spring BeanUtils 或 MapStruct。',
  AvoidNewDateGetTimeRule: '改用 System.currentTimeMillis()。',
  AvoidPatternCompileInMethodRule: '把 Pattern.compile(...) 提成 private static final 常量。',
  EqualsAvoidNullRule: '把常量或确定非空的值放在 equals 左边，或用 Objects.equals。',
}

// PMD exits 4 when it found violations and 5 when a file did not parse.
const PMD_OK = [0, 4, 5]

type Engine = EngineInterface

export type Violation = {
  rule: string
  line: number
  priority: number
  description: string
}

type PmdReport = {
  files?: {
    filename: string
    violations: {
      rule: string
      beginline: number
      priority: number
      description: string
    }[]
  }[]
  processingErrors?: { filename: string }[]
}

/** The file's text once the edit is applied, or undefined when it would not apply. */
export const applyEdit = (
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string | undefined => {
  if (oldString === '' || !text.includes(oldString)) {
    return undefined
  }

  return replaceAll
    ? text.split(oldString).join(newString)
    : text.replace(oldString, () => newString)
}

/** The violations in `after` that `before` did not already have, at or above the blocking level. */
export const addedViolations = (
  before: readonly Violation[],
  after: readonly Violation[],
  blockPriority: number,
): Violation[] => {
  const known = new Map<string, number>()

  for (const one of before) {
    const key = `${one.rule}\n${one.description}`
    known.set(key, (known.get(key) ?? 0) + 1)
  }

  return after.filter(one => {
    if (one.priority > blockPriority) {
      return false
    }

    const key = `${one.rule}\n${one.description}`
    const left = known.get(key) ?? 0
    known.set(key, left - 1)

    return left <= 0
  })
}

const state = {
  blockPriority: 2,
  isEnabled: true,
  blocked: 0,
  passed: 0,
  jar: undefined as Promise<string> | undefined,
  isJarReady: false,
}

const fetchJar = async ($: Engine): Promise<string> => {
  const home = await $.env.get('HOME')

  if (home === undefined) {
    throw new Error('HOME is not set')
  }

  const dir = `${home}/.cache/p3c-guard`
  const path = `${dir}/${JAR_NAME}`

  if (!(await $.fs.exists(path))) {
    const part = `${path}.part`
    await $.process.run(['mkdir', '-p', dir])
    const got = await $.process.run(
      ['curl', '-fsSL', '-o', part, JAR_URL],
      { timeoutMs: 300_000 },
    )

    if (got.exitCode !== 0) {
      throw new Error(`download failed: ${got.stderr.slice(0, 200)}`)
    }

    // sha256sum ships with GNU coreutils; shasum comes with perl, which minimal Linux images lack.
    const sum = await $.process.run([
      'sh', '-c', 'sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"', 'sh', part,
    ])

    if (!sum.stdout.startsWith(JAR_SHA256)) {
      await $.process.run(['rm', '-f', part])
      throw new Error('the downloaded jar does not match its checksum')
    }

    await $.process.run(['mv', part, path])
  }

  state.isJarReady = true

  return path
}

const check = async (
  $: Engine,
  jarPath: string,
  id: string,
  name: string,
  before: string | undefined,
  after: string,
): Promise<Violation[] | undefined> => {
  const dir = `${jarPath.slice(0, jarPath.lastIndexOf('/'))}/work/${id}`

  try {
    await $.fs.write(`${dir}/after/${name}`, after)

    if (before !== undefined) {
      await $.fs.write(`${dir}/before/${name}`, before)
    }

    const ran = await $.process.run(
      [
        'java', '-XX:TieredStopAtLevel=1', '-jar', jarPath, 'check',
        '-d', dir, '-R', RULESET, '-f', 'json', '--no-cache', '--no-progress',
      ],
      { timeoutMs: 20_000 },
    )

    if (!PMD_OK.includes(ran.exitCode)) {
      throw new Error(`pmd exited ${ran.exitCode}: ${ran.stderr.slice(0, 200)}`)
    }

    const report = JSON.parse(ran.stdout) as PmdReport
    const isAfter = (path: string) => path.includes(`/${id}/after/`)

    // A file that does not parse is the compiler's to refuse, not ours.
    if (report.processingErrors?.some(one => isAfter(one.filename))) {
      return undefined
    }

    const read = (wanted: boolean): Violation[] =>
      (report.files ?? [])
        .filter(file => isAfter(file.filename) === wanted)
        .flatMap(file => file.violations)
        .map(one => ({
          rule: one.rule,
          line: one.beginline,
          priority: one.priority,
          description: one.description,
        }))

    return addedViolations(read(false), read(true), state.blockPriority)
  } finally {
    await $.process.run(['rm', '-rf', dir]).catch(() => undefined)
  }
}

const showCounts = ($: Engine) =>
  $.ui.status(`p3c 拦 ${state.blocked} · 过 ${state.passed}`)

/** Answers a refusal for the write, or undefined to let it through. */
const judge = async (
  $: Engine,
  id: string,
  filePath: string,
  before: string | undefined,
  after: string,
): Promise<string | undefined> => {
  try {
    state.jar ??= fetchJar($)

    // The first Java write of a machine starts the download and is not held for it.
    if (!state.isJarReady) {
      void state.jar.catch(() => {
        state.jar = undefined
      })
      const ready = await Promise.race([
        state.jar.then(() => true, () => false),
        $.clock.sleep(1500).then(() => false),
      ])

      if (!ready) {
        $.ui.status('p3c 正在准备规则引擎，本次未检查')

        return undefined
      }
    }

    const name = filePath.slice(filePath.lastIndexOf('/') + 1)
    const added = await check($, await state.jar, id, name, before, after)

    if (added === undefined || added.length === 0) {
      state.passed += 1
      showCounts($)

      return undefined
    }

    state.blocked += 1
    showCounts($)
    const listed = added
      .slice(0, MAX_LISTED)
      .map(one => {
        const fix = FIXES[one.rule]

        return `- 第 ${one.line} 行 [${one.rule}] ${one.description}${fix === undefined ? '' : ` 改法：${fix}`}`
      })
    const more = added.length > MAX_LISTED
      ? [`- 另有 ${added.length - MAX_LISTED} 处未列出`]
      : []

    return [
      `p3c-guard：这次写入会给 ${name} 新增 ${added.length} 处阿里 Java 规约违规，未写入。`,
      ...listed,
      ...more,
      '行号是写入后文件里的行号。请修正后重新写入；文件原有的违规不在此列。',
    ].join('\n')
  } catch (error) {
    // A jar that went missing is fetched again by the next write.
    state.jar = undefined
    state.isJarReady = false
    $.ui.status(`p3c 未检查：${String(error).slice(0, 60)}`)

    return undefined
  }
}

export const register: Register = (on, options) => {
  state.blockPriority = Number(options?.blockPriority ?? '2') || 2
  state.isEnabled = true
  state.blocked = 0
  state.passed = 0
  state.jar = undefined
  state.isJarReady = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'p3c',
      description: 'p3c-guard：/p3c 看状态，/p3c off 暂停，/p3c on 恢复',
    })

    return next(e)
  })

  on('command.run', { command: 'p3c' }, (_$, e) => {
    const arg = e.args.trim()

    if (arg === 'off' || arg === 'on') {
      state.isEnabled = arg === 'on'
    }

    return {
      text: `p3c-guard ${state.isEnabled ? '已开启' : '已暂停'}：拦截级别 ${state.blockPriority}，本会话拦 ${state.blocked} 次、放行 ${state.passed} 次。`,
    }
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (!state.isEnabled || !e.file_path.endsWith('.java')) {
      return next(e)
    }

    const before = (await $.fs.exists(e.file_path))
      ? await $.fs.read(e.file_path).catch(() => undefined)
      : undefined
    const deny = await judge($, e.tool_use_id, e.file_path, before, e.content)

    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    if (!state.isEnabled || !e.file_path.endsWith('.java')) {
      return next(e)
    }

    const before = await $.fs.read(e.file_path).catch(() => undefined)
    const after = before === undefined
      ? undefined
      : applyEdit(before, e.old_string, e.new_string, e.replace_all === true)

    // An edit that does not apply is the tool's own to refuse.
    if (after === undefined) {
      return next(e)
    }

    const deny = await judge($, e.tool_use_id, e.file_path, before, after)

    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) => next(e))
}
