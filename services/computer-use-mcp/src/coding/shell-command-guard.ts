/**
 * Shell Command Guard
 *
 * Evaluates terminal commands against an allow/deny policy before execution.
 * Blocks commands that bypass mutation proofing (e.g., sed -i, echo >, rm)
 * and warns on potentially risky operations (e.g., package installs).
 *
 * This guard is intentionally conservative: it blocks known dangerous patterns
 * and warns on ambiguous ones. It does NOT try to be a sandbox.
 */

export type ShellGuardCategory
  = | 'allowed'
    | 'denied_write'
    | 'denied_destructive'
    | 'denied_install'
    | 'warned'

export type ShellCommandGuardCode
  = | 'dangerous_file_mutation'
    | 'dangerous_file_delete'
    | 'dependency_install_warning'
    | 'inline_interpreter'
    | 'heredoc_inline_interpreter'
    | 'shell_wrapper_mutation'
    | 'package_runner_wrapped_mutation'
    | 'guard_parse_failed_for_wrapper'

export interface ShellCommandGuardResult {
  allowed: boolean
  category: ShellGuardCategory
  code?: ShellCommandGuardCode
  reason?: string
  suggestedAlternative?: string
}

// NOTICE: Patterns are intentionally broad. False positives are preferred over
// silently allowing bypass of mutation proofing. Each pattern explains why
// it's blocked and what tool to use instead.
interface DenyPattern {
  pattern?: RegExp
  matches?: (command: string) => boolean
  category: 'denied_write' | 'denied_destructive' | 'denied_install'
  code: ShellCommandGuardCode
  reason: string
  suggestedAlternative: string
}

const TOKEN_SPLIT_WHITESPACE_RE = /\s+/
const TOKEN_WHITESPACE_RE = /\s/
const SHELL_C_FLAG_RE = /^-[A-Zabd-z]*c[A-Za-z]*$/
const WRAPPED_SHELL_COMMAND_RE = /\b(?:bash|sh|zsh)\b[\s\S]*\s-[A-Zabd-z]*c\b/
const WRAPPED_PACKAGE_RUNNER_RE = /\b(?:pnpm\s+(?:exec|dlx)|npx|npm\s+exec|yarn\s+exec|bunx)\b/
const TOKEN_NEEDS_QUOTES_RE = /[\s"'\\$`]/
const TOKEN_QUOTE_ESCAPE_RE = /(["\\$`])/g
const SIMPLE_OUTPUT_WRITERS = new Set(['echo', 'printf', 'cat'])
const PATH_SEPARATORS = [';', '&', '|']

const DENY_PATTERNS: DenyPattern[] = [
  // File-modifying commands that bypass applyPatch mutation proofing
  {
    pattern: /\bsed\s+-i/,
    category: 'denied_write',
    code: 'dangerous_file_mutation',
    reason: 'sed -i modifies files in place, bypassing mutation proofing.',
    suggestedAlternative: 'Use coding_apply_patch to make targeted edits with readback verification.',
  },
  {
    pattern: /\bawk\s+(?:\S.*)?-i\s+inplace/,
    category: 'denied_write',
    code: 'dangerous_file_mutation',
    reason: 'awk inplace modifies files, bypassing mutation proofing.',
    suggestedAlternative: 'Use coding_apply_patch instead.',
  },
  {
    pattern: /\bperl\s+-[A-Za-oq-z]*p[A-Za-z]*i/,
    category: 'denied_write',
    code: 'dangerous_file_mutation',
    reason: 'perl -pi modifies files in place, bypassing mutation proofing.',
    suggestedAlternative: 'Use coding_apply_patch instead.',
  },
  {
    // Matches ">" or ">>" redirect but not "2>" (stderr) or "|" (pipe)
    // Anchored to avoid matching comparisons in code strings.
    matches: hasSimpleWriterOutputRedirect,
    category: 'denied_write',
    code: 'dangerous_file_mutation',
    reason: 'Output redirection to file bypasses mutation proofing.',
    suggestedAlternative: 'Use coding_apply_patch or coding_read_file + coding_apply_patch.',
  },
  {
    pattern: /\btee\s+(?!\/dev\/)/,
    category: 'denied_write',
    code: 'dangerous_file_mutation',
    reason: 'tee writes to files, bypassing mutation proofing.',
    suggestedAlternative: 'Use coding_apply_patch instead.',
  },
  {
    matches: command => hasExecutableToken(command, 'dd') && command.includes('of='),
    category: 'denied_write',
    code: 'dangerous_file_mutation',
    reason: 'dd with of= writes to files, bypassing mutation proofing.',
    suggestedAlternative: 'Use coding_apply_patch instead.',
  },

  // Destructive commands
  {
    matches: hasRecursiveForceRm,
    category: 'denied_destructive',
    code: 'dangerous_file_delete',
    reason: 'rm -rf is destructive and irreversible.',
    suggestedAlternative: 'Review files first with coding_read_file, then remove specific files if necessary.',
  },
  {
    // Plain rm (not rm -rf which is caught above), only when targeting non-temp paths
    matches: hasTrackedPlainRm,
    category: 'denied_destructive',
    code: 'dangerous_file_delete',
    reason: 'rm deletes files irreversibly.',
    suggestedAlternative: 'Verify the file should be deleted, then use a scoped rm command.',
  },
  {
    // mv that renames/moves source files (not just moving to /tmp)
    matches: hasTrackedMv,
    category: 'denied_destructive',
    code: 'dangerous_file_delete',
    reason: 'mv renames/moves files, which bypasses change tracking.',
    suggestedAlternative: 'Use git mv or coordinate with coding_apply_patch for renames.',
  },

  // Package install commands (warned, not hard-blocked)
  {
    pattern: /\bnpm\s+install\b|\bnpm\s+i\b(?!\s+-)/,
    category: 'denied_install',
    code: 'dependency_install_warning',
    reason: 'npm install changes project dependencies.',
    suggestedAlternative: 'If dependency installation is intentional, use pnpm add <package> through terminal_exec.',
  },
  {
    pattern: /\bpip\s+install\b/,
    category: 'denied_install',
    code: 'dependency_install_warning',
    reason: 'pip install changes Python dependencies.',
    suggestedAlternative: 'If dependency installation is intentional, specify the exact package.',
  },
  {
    pattern: /\bbrew\s+install\b/,
    category: 'denied_install',
    code: 'dependency_install_warning',
    reason: 'brew install changes system-level dependencies.',
    suggestedAlternative: 'System dependency changes should be documented, not automated.',
  },
  {
    pattern: /\bapt\s+install\b|\bapt-get\s+install\b|\byum\s+install\b|\bpacman\s+-S\b/,
    category: 'denied_install',
    code: 'dependency_install_warning',
    reason: 'System package manager install detected.',
    suggestedAlternative: 'System dependency changes should be documented, not automated.',
  },
]

const ALLOW_PATTERNS: RegExp[] = [
  // Read-only commands
  /^\s*cat\s+\S+\s*$/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*wc\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*tree\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*which\b/,
  /^\s*type\b/,
  /^\s*whoami\b/,
  /^\s*pwd\b/,
  /^\s*echo\s[^>]*$/,

  // Git read-only
  /^\s*git\s+status\b/,
  /^\s*git\s+diff\b/,
  /^\s*git\s+log\b/,
  /^\s*git\s+show\b/,
  /^\s*git\s+branch\b/,
  /^\s*git\s+remote\b/,
  /^\s*git\s+rev-parse\b/,

  // Build/test/lint — expected workflow commands
  /^\s*(?:npm|pnpm|yarn|bun)\s+(?:test|run|exec|why|list|ls|outdated|audit)\b/,
  /^\s*(?:npm|pnpm|yarn|bun)\s+(?:typecheck|lint|lint:fix|build|dev|start)\b/,
  /^\s*make\b/,
  /^\s*cargo\s+(?:test|build|check|clippy|run)\b/,
  /^\s*python\s+-m\s+pytest\b/,
  /^\s*go\s+(?:test|build|vet|run)\b/,
  /^\s*tsc\b/,
  /^\s*vitest\b/,
  /^\s*eslint\b/,
  /^\s*node\b/,
  /^\s*npx\b/,
]

const MAX_GUARD_RECURSION_DEPTH = 4
const SHELL_NAMES = new Set(['bash', 'sh', 'zsh'])
const INLINE_INTERPRETER_NAMES = new Set(['node', 'python', 'python3', 'ruby', 'perl'])

/**
 * Evaluate a shell command against the allow/deny policy.
 * Returns a structured result indicating whether the command should proceed.
 */
export function evaluateShellCommand(command: string): ShellCommandGuardResult {
  return evaluateShellCommandInner(command, { depth: 0, source: 'raw' })
}

function evaluateShellCommandInner(command: string, context: {
  depth: number
  source: 'raw' | 'shell_wrapper' | 'package_runner'
}): ShellCommandGuardResult {
  const trimmed = command.trim()

  // Empty commands are always allowed (no-op)
  if (!trimmed) {
    return { allowed: true, category: 'allowed' }
  }

  const rawDeny = evaluateDenyPatterns(trimmed)
  if (!rawDeny.allowed) {
    return wrapDeniedFromContext(rawDeny, context)
  }
  if (rawDeny.category === 'warned') {
    return rawDeny
  }

  if (context.depth >= MAX_GUARD_RECURSION_DEPTH) {
    return {
      allowed: false,
      category: 'denied_write',
      code: 'guard_parse_failed_for_wrapper',
      reason: 'Shell command guard recursion limit reached while evaluating wrapped commands.',
      suggestedAlternative: 'Run a direct validation command, or use coding_apply_patch for file changes.',
    }
  }

  const tokens = tokenizeShellLikeForGuard(trimmed)
  if (!tokens) {
    if (looksLikeWrappedCommand(trimmed)) {
      return {
        allowed: false,
        category: 'denied_write',
        code: 'guard_parse_failed_for_wrapper',
        reason: 'Command appears to wrap an inner shell command, but the guard could not parse it safely.',
        suggestedAlternative: 'Run a direct validation command, or use coding_apply_patch for file changes.',
      }
    }
    return { allowed: true, category: 'allowed' }
  }

  if (isInlineHeredocInterpreter(trimmed, tokens)) {
    return {
      allowed: false,
      category: 'denied_write',
      code: 'heredoc_inline_interpreter',
      reason: 'Heredoc-fed inline interpreter commands can write files while bypassing mutation proofing.',
      suggestedAlternative: 'Run a script file for validation, or use coding_apply_patch for file changes.',
    }
  }

  const shellInnerCommand = unwrapShellCommand(tokens)
  if (shellInnerCommand === undefined && looksLikeShellWrapperTokens(tokens)) {
    return {
      allowed: false,
      category: 'denied_write',
      code: 'guard_parse_failed_for_wrapper',
      reason: 'Shell wrapper command could not be safely unwrapped for guard evaluation.',
      suggestedAlternative: 'Run the validation command directly, or use coding_apply_patch for file changes.',
    }
  }
  if (shellInnerCommand) {
    const innerResult = evaluateShellCommandInner(shellInnerCommand, {
      depth: context.depth + 1,
      source: 'shell_wrapper',
    })
    if (!innerResult.allowed) {
      return wrapDeniedFromContext(innerResult, { source: 'shell_wrapper' })
    }
    if (innerResult.category === 'warned') {
      return innerResult
    }
  }

  const packageRunnerInnerCommand = unwrapPackageRunnerCommand(tokens)
  if (packageRunnerInnerCommand) {
    const innerResult = evaluateShellCommandInner(packageRunnerInnerCommand, {
      depth: context.depth + 1,
      source: 'package_runner',
    })
    if (!innerResult.allowed) {
      return wrapDeniedFromContext(innerResult, { source: 'package_runner' })
    }
    if (innerResult.category === 'warned') {
      return innerResult
    }
  }

  if (isInlineInterpreterCommand(tokens)) {
    return {
      allowed: false,
      category: 'denied_write',
      code: 'inline_interpreter',
      reason: 'Inline interpreter commands can write files while bypassing mutation proofing.',
      suggestedAlternative: 'Run a script file for validation, or use coding_apply_patch for file changes.',
    }
  }

  for (const pattern of ALLOW_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { allowed: true, category: 'allowed' }
    }
  }

  // Default: allow unknown commands (we can't enumerate everything)
  return { allowed: true, category: 'allowed' }
}

function evaluateDenyPatterns(command: string): ShellCommandGuardResult {
  for (const { pattern, matches, category, code, reason, suggestedAlternative } of DENY_PATTERNS) {
    if (!pattern?.test(command) && !matches?.(command)) {
      continue
    }

    // Install commands are warned, not hard-blocked
    if (category === 'denied_install') {
      return {
        allowed: true,
        category: 'warned',
        code,
        reason: `WARNING: ${reason}`,
        suggestedAlternative,
      }
    }

    return {
      allowed: false,
      category,
      code,
      reason,
      suggestedAlternative,
    }
  }

  return { allowed: true, category: 'allowed' }
}

function hasSimpleWriterOutputRedirect(command: string): boolean {
  for (let i = 0; i < command.length; i++) {
    if (command[i] !== '>' || command[i - 1] === '2') {
      continue
    }

    const commandSegment = sliceAfterLastSeparator(command.slice(0, i))
    const firstToken = getCommandTokens(commandSegment)[0]
    if (firstToken && SIMPLE_OUTPUT_WRITERS.has(executableName(firstToken))) {
      return true
    }
  }

  return false
}

function hasExecutableToken(command: string, executable: string): boolean {
  return getCommandTokens(command).some(token => executableName(token) === executable)
}

function hasRecursiveForceRm(command: string): boolean {
  const tokens = getCommandTokens(command)
  for (let i = 0; i < tokens.length; i++) {
    if (executableName(tokens[i]!) !== 'rm') {
      continue
    }

    const flags = collectFlagTokens(tokens, i + 1)
    if (flags.includes('r') && flags.includes('f')) {
      return true
    }
  }

  return false
}

function hasTrackedPlainRm(command: string): boolean {
  const tokens = getCommandTokens(command)
  for (let i = 0; i < tokens.length; i++) {
    if (executableName(tokens[i]!) !== 'rm') {
      continue
    }

    const target = firstNonFlagToken(tokens, i + 1)
    if (target && !isTempPath(target)) {
      return true
    }
  }

  return false
}

function hasTrackedMv(command: string): boolean {
  const tokens = getCommandTokens(command)
  for (let i = 0; i < tokens.length; i++) {
    if (executableName(tokens[i]!) !== 'mv') {
      continue
    }

    const source = firstNonFlagToken(tokens, i + 1)
    const destination = source ? firstNonFlagToken(tokens, tokens.indexOf(source, i + 1) + 1) : undefined
    if (source && destination && !isTempPath(source) && !isTempPath(destination)) {
      return true
    }
  }

  return false
}

function getCommandTokens(command: string): string[] {
  return tokenizeShellLikeForGuard(command)
    ?? command.trim().split(TOKEN_SPLIT_WHITESPACE_RE).filter(Boolean)
}

function sliceAfterLastSeparator(command: string): string {
  let lastIndex = -1
  for (const separator of PATH_SEPARATORS) {
    lastIndex = Math.max(lastIndex, command.lastIndexOf(separator))
  }

  return command.slice(lastIndex + 1).trim()
}

function collectFlagTokens(tokens: string[], startIndex: number): string {
  let flags = ''
  for (let i = startIndex; i < tokens.length; i++) {
    const token = tokens[i]!
    if (!token.startsWith('-')) {
      break
    }
    flags += token.slice(1)
  }

  return flags
}

function firstNonFlagToken(tokens: string[], startIndex: number): string | undefined {
  for (let i = startIndex; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '--') {
      return tokens[i + 1]
    }
    if (!token.startsWith('-')) {
      return token
    }
  }

  return undefined
}

function isTempPath(value: string): boolean {
  return value.startsWith('/tmp') || value.startsWith('/var/tmp')
}

function wrapDeniedFromContext(result: ShellCommandGuardResult, context: {
  source: 'raw' | 'shell_wrapper' | 'package_runner'
}): ShellCommandGuardResult {
  if (result.allowed || context.source === 'raw') {
    return result
  }

  if (context.source === 'shell_wrapper') {
    return {
      ...result,
      code: 'shell_wrapper_mutation',
      reason: `Shell wrapper contains denied command: ${result.reason || 'proof-bypass command detected.'}`,
    }
  }

  return {
    ...result,
    code: 'package_runner_wrapped_mutation',
    reason: `Package runner wraps denied command: ${result.reason || 'proof-bypass command detected.'}`,
  }
}

// NOTICE: Guard-only tokenizer. It intentionally does not implement shell
// expansion, globbing, command substitution, or full POSIX shell grammar.
function tokenizeShellLikeForGuard(command: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: '\'' | '"' | undefined
  let escaping = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!

    if (escaping) {
      current += char
      escaping = false
      continue
    }

    if (char === '\\') {
      escaping = true
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = undefined
      }
      else {
        current += char
      }
      continue
    }

    if (char === '\'' || char === '"') {
      quote = char
      continue
    }

    if (TOKEN_WHITESPACE_RE.test(char)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (escaping || quote) {
    return null
  }

  if (current.length > 0) {
    tokens.push(current)
  }

  return tokens
}

function unwrapShellCommand(tokens: string[]): string | null | undefined {
  const shellIndex = getShellInvocationIndex(tokens)
  if (shellIndex === -1) {
    return null
  }

  const commandIndex = findShellCommandStringIndex(tokens, shellIndex + 1)
  if (commandIndex === -1) {
    return undefined
  }

  return tokens[commandIndex] || undefined
}

function looksLikeShellWrapperTokens(tokens: string[]): boolean {
  const shellIndex = getShellInvocationIndex(tokens)
  return shellIndex !== -1 && tokens.some((token, index) => index > shellIndex && token.startsWith('-') && token.includes('c'))
}

function getShellInvocationIndex(tokens: string[]): number {
  if (tokens.length === 0) {
    return -1
  }

  if (isShellExecutable(tokens[0]!)) {
    return 0
  }

  const first = executableName(tokens[0]!)
  if ((first === 'env' || tokens[0] === '/usr/bin/env') && tokens[1] && isShellExecutable(tokens[1])) {
    return 1
  }

  return -1
}

function findShellCommandStringIndex(tokens: string[], startIndex: number): number {
  for (let i = startIndex; i < tokens.length; i++) {
    const token = tokens[i]!
    if (!token.startsWith('-')) {
      continue
    }

    if (token === '-c') {
      return i + 1 < tokens.length ? i + 1 : -1
    }

    if (SHELL_C_FLAG_RE.test(token)) {
      return i + 1 < tokens.length ? i + 1 : -1
    }
  }

  return -1
}

function unwrapPackageRunnerCommand(tokens: string[]): string | null {
  if (tokens.length < 2) {
    return null
  }

  const executable = executableName(tokens[0]!)
  let innerStart = -1

  if (executable === 'pnpm') {
    const runnerIndex = tokens.findIndex((token, index) => index > 0 && (token === 'exec' || token === 'dlx'))
    innerStart = runnerIndex === -1 ? -1 : firstNonOptionIndex(tokens, runnerIndex + 1)
  }
  else if (executable === 'npx' || executable === 'bunx') {
    innerStart = firstNonOptionIndex(tokens, 1)
  }
  else if (executable === 'npm') {
    const execIndex = tokens.findIndex((token, index) => index > 0 && token === 'exec')
    innerStart = execIndex === -1 ? -1 : firstNonOptionIndex(tokens, execIndex + 1)
  }
  else if (executable === 'yarn') {
    const execIndex = tokens.findIndex((token, index) => index > 0 && token === 'exec')
    innerStart = execIndex === -1 ? -1 : firstNonOptionIndex(tokens, execIndex + 1)
  }

  if (innerStart < 0 || innerStart >= tokens.length) {
    return null
  }

  return joinTokensForGuard(tokens.slice(innerStart))
}

function firstNonOptionIndex(tokens: string[], startIndex: number): number {
  for (let i = startIndex; i < tokens.length; i++) {
    if (tokens[i] === '--') {
      return i + 1
    }
    if (!tokens[i]!.startsWith('-')) {
      return i
    }
  }

  return tokens.length
}

function isInlineInterpreterCommand(tokens: string[]): boolean {
  if (tokens.length < 2 || !isInlineInterpreter(tokens[0]!)) {
    return false
  }

  const executable = executableName(tokens[0]!)
  return tokens.slice(1).some((token) => {
    if (executable === 'node') {
      return token === '-e'
        || token === '--eval'
        || token.startsWith('--eval=')
        || token === '-p'
        || token === '--print'
        || token.startsWith('--print=')
    }

    if (executable === 'python' || executable === 'python3') {
      return token === '-c'
    }

    return token === '-e'
  })
}

function isInlineHeredocInterpreter(command: string, tokens: string[]): boolean {
  return command.includes('<<') && tokens.length > 0 && isInlineInterpreter(tokens[0]!)
}

function looksLikeWrappedCommand(command: string): boolean {
  return WRAPPED_SHELL_COMMAND_RE.test(command)
    || WRAPPED_PACKAGE_RUNNER_RE.test(command)
}

function isShellExecutable(value: string): boolean {
  return SHELL_NAMES.has(executableName(value))
}

function isInlineInterpreter(value: string): boolean {
  return INLINE_INTERPRETER_NAMES.has(executableName(value))
}

function executableName(value: string): string {
  return value.split('/').filter(Boolean).at(-1) || value
}

function joinTokensForGuard(tokens: string[]): string {
  return tokens.map(quoteTokenForGuard).join(' ')
}

function quoteTokenForGuard(token: string): string {
  if (!TOKEN_NEEDS_QUOTES_RE.test(token)) {
    return token
  }

  return `"${token.replace(TOKEN_QUOTE_ESCAPE_RE, '\\$1')}"`
}
