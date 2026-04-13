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

export interface ShellCommandGuardResult {
  allowed: boolean
  category: ShellGuardCategory
  reason?: string
  suggestedAlternative?: string
}

// NOTICE: Patterns are intentionally broad. False positives are preferred over
// silently allowing bypass of mutation proofing. Each pattern explains why
// it's blocked and what tool to use instead.
interface DenyPattern {
  pattern: RegExp
  category: 'denied_write' | 'denied_destructive' | 'denied_install'
  reason: string
  suggestedAlternative: string
}

const DENY_PATTERNS: DenyPattern[] = [
  // File-modifying commands that bypass applyPatch mutation proofing
  {
    pattern: /\bsed\s+-i/,
    category: 'denied_write',
    reason: 'sed -i modifies files in place, bypassing mutation proofing.',
    suggestedAlternative: 'Use coding_apply_patch to make targeted edits with readback verification.',
  },
  {
    pattern: /\bawk\s+(?:\S.*)?-i\s+inplace/,
    category: 'denied_write',
    reason: 'awk inplace modifies files, bypassing mutation proofing.',
    suggestedAlternative: 'Use coding_apply_patch instead.',
  },
  {
    pattern: /\bperl\s+-[A-Za-oq-z]*p[A-Za-z]*i/,
    category: 'denied_write',
    reason: 'perl -pi modifies files in place, bypassing mutation proofing.',
    suggestedAlternative: 'Use coding_apply_patch instead.',
  },
  {
    // Matches ">" or ">>" redirect but not "2>" (stderr) or "|" (pipe)
    // Anchored to avoid matching comparisons in code strings.
    pattern: /(?:^|[;&|])\s*(?:echo|printf|cat)\s+(?:\S.*)?[^2]\s*>{1,2}\s*\S/,
    category: 'denied_write',
    reason: 'Output redirection to file bypasses mutation proofing.',
    suggestedAlternative: 'Use coding_apply_patch or coding_read_file + coding_apply_patch.',
  },
  {
    pattern: /\btee\s+(?!\/dev\/)/,
    category: 'denied_write',
    reason: 'tee writes to files, bypassing mutation proofing.',
    suggestedAlternative: 'Use coding_apply_patch instead.',
  },
  {
    pattern: /\bdd\s+(?:\S.*)?\bof=/,
    category: 'denied_write',
    reason: 'dd with of= writes to files, bypassing mutation proofing.',
    suggestedAlternative: 'Use coding_apply_patch instead.',
  },

  // Destructive commands
  {
    pattern: /\brm\s+-[A-Za-qs-z]*r[A-Za-z]*f|\brm\s+-[A-Za-eg-z]*f[A-Za-z]*r|\brm\s+-rf\b/,
    category: 'denied_destructive',
    reason: 'rm -rf is destructive and irreversible.',
    suggestedAlternative: 'Review files first with coding_read_file, then remove specific files if necessary.',
  },
  {
    // Plain rm (not rm -rf which is caught above), only when targeting non-temp paths
    pattern: /\brm\s+(?!-rf\b)(?!\/tmp\b)(?!\/var\/tmp\b)\S/,
    category: 'denied_destructive',
    reason: 'rm deletes files irreversibly.',
    suggestedAlternative: 'Verify the file should be deleted, then use a scoped rm command.',
  },
  {
    // mv that renames/moves source files (not just moving to /tmp)
    pattern: /\bmv\s+(?!.*\/tmp\b)\S+\s+\S/,
    category: 'denied_destructive',
    reason: 'mv renames/moves files, which bypasses change tracking.',
    suggestedAlternative: 'Use git mv or coordinate with coding_apply_patch for renames.',
  },

  // Package install commands (warned, not hard-blocked)
  {
    pattern: /\bnpm\s+install\b|\bnpm\s+i\b(?!\s+-)/,
    category: 'denied_install',
    reason: 'npm install changes project dependencies.',
    suggestedAlternative: 'If dependency installation is intentional, use pnpm add <package> through terminal_exec.',
  },
  {
    pattern: /\bpip\s+install\b/,
    category: 'denied_install',
    reason: 'pip install changes Python dependencies.',
    suggestedAlternative: 'If dependency installation is intentional, specify the exact package.',
  },
  {
    pattern: /\bbrew\s+install\b/,
    category: 'denied_install',
    reason: 'brew install changes system-level dependencies.',
    suggestedAlternative: 'System dependency changes should be documented, not automated.',
  },
  {
    pattern: /\bapt\s+install\b|\bapt-get\s+install\b|\byum\s+install\b|\bpacman\s+-S\b/,
    category: 'denied_install',
    reason: 'System package manager install detected.',
    suggestedAlternative: 'System dependency changes should be documented, not automated.',
  },
]

// NOTICE: Allow patterns are checked BEFORE deny patterns. If a command
// matches an allow pattern, it is always permitted. This prevents false
// positives on common safe commands.
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

/**
 * Evaluate a shell command against the allow/deny policy.
 * Returns a structured result indicating whether the command should proceed.
 */
export function evaluateShellCommand(command: string): ShellCommandGuardResult {
  const trimmed = command.trim()

  // Empty commands are always allowed (no-op)
  if (!trimmed) {
    return { allowed: true, category: 'allowed' }
  }

  // Check allow list first — safe commands skip deny checks
  for (const pattern of ALLOW_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { allowed: true, category: 'allowed' }
    }
  }

  // Check deny list
  for (const { pattern, category, reason, suggestedAlternative } of DENY_PATTERNS) {
    if (pattern.test(trimmed)) {
      // Install commands are warned, not hard-blocked
      if (category === 'denied_install') {
        return {
          allowed: true,
          category: 'warned',
          reason: `WARNING: ${reason}`,
          suggestedAlternative,
        }
      }

      return {
        allowed: false,
        category,
        reason,
        suggestedAlternative,
      }
    }
  }

  // Default: allow unknown commands (we can't enumerate everything)
  return { allowed: true, category: 'allowed' }
}
