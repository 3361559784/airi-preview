import { describe, expect, it } from 'vitest'

import { evaluateShellCommand } from './shell-command-guard'

describe('shellCommandGuard', () => {
  function expectDenied(command: string) {
    const result = evaluateShellCommand(command)
    expect(result.allowed).toBe(false)
    return result
  }

  describe('deny patterns', () => {
    it('blocks sed -i (file-modifying)', () => {
      const result = evaluateShellCommand('sed -i "s/foo/bar/" file.ts')
      expect(result.allowed).toBe(false)
      expect(result.category).toBe('denied_write')
      expect(result.code).toBe('dangerous_file_mutation')
      expect(result.suggestedAlternative).toContain('coding_apply_patch')
    })

    it('blocks rm -rf (destructive)', () => {
      const result = evaluateShellCommand('rm -rf src/')
      expect(result.allowed).toBe(false)
      expect(result.category).toBe('denied_destructive')
      expect(result.code).toBe('dangerous_file_delete')
    })

    it('blocks echo redirect (file-modifying)', () => {
      const result = evaluateShellCommand('echo "hello" > file.ts')
      expect(result.allowed).toBe(false)
      expect(result.category).toBe('denied_write')
    })

    it('blocks tee to file (file-modifying)', () => {
      const result = evaluateShellCommand('cat input.txt | tee output.txt')
      expect(result.allowed).toBe(false)
      expect(result.category).toBe('denied_write')
    })

    it('blocks perl -pi (file-modifying)', () => {
      const result = evaluateShellCommand('perl -pi -e "s/foo/bar/" file.ts')
      expect(result.allowed).toBe(false)
      expect(result.category).toBe('denied_write')
    })

    it('blocks dd of= (file-modifying)', () => {
      const result = evaluateShellCommand('dd if=/dev/zero of=output.bin bs=1M count=1')
      expect(result.allowed).toBe(false)
      expect(result.category).toBe('denied_write')
    })
  })

  describe('wrapped proof-bypass commands', () => {
    it('blocks shell wrappers before outer allowlist behavior can accept them', () => {
      const cases = [
        'bash -lc "sed -i \'s/foo/bar/\' src/a.ts"',
        'sh -c "echo hi > src/a.ts"',
        'zsh -c "cat x | tee src/a.ts"',
        '/bin/bash -lc "mv src/a.ts src/b.ts"',
        'env bash -lc "rm -rf src/foo.ts"',
        '/usr/bin/env bash -lc "echo hi > src/a.ts"',
      ]

      for (const command of cases) {
        const result = expectDenied(command)
        expect(result.category).toMatch(/^denied_/)
      }
    })

    it('labels shell-wrapper-only denial paths with a stable code', () => {
      const result = expectDenied('bash -lc "node -e \\"require(\'fs\').writeFileSync(\'src/a.ts\', \'x\')\\""')
      expect(result.code).toBe('shell_wrapper_mutation')
    })

    it('blocks package runner wrappers that contain denied commands', () => {
      const cases = [
        'pnpm exec bash -lc "cat x | tee src/a.ts"',
        'pnpm exec -- bash -lc "echo hi > src/a.ts"',
        'pnpm dlx bash -lc "sed -i \'s/foo/bar/\' src/a.ts"',
        'npx shx rm -rf src/a.ts',
        'npm exec -- bash -lc "echo hi > src/a.ts"',
        'yarn exec bash -lc "echo hi > src/a.ts"',
        'bunx bash -lc "echo hi > src/a.ts"',
      ]

      for (const command of cases) {
        expectDenied(command)
      }
    })

    it('labels package-runner-only denial paths with a stable code', () => {
      const result = expectDenied('pnpm exec node -e "require(\'fs\').writeFileSync(\'src/a.ts\', \'x\')"')
      expect(result.code).toBe('package_runner_wrapped_mutation')
    })

    it('denies unparseable shell wrappers instead of allowing by accident', () => {
      const result = expectDenied('bash -lc "')
      expect(result.code).toBe('guard_parse_failed_for_wrapper')
    })
  })

  describe('inline interpreter proof-bypass commands', () => {
    it('blocks node inline script entrypoints', () => {
      const cases = [
        'node -e "require(\'fs\').writeFileSync(\'src/a.ts\', \'x\')"',
        'node --eval "require(\'fs\').writeFileSync(\'src/a.ts\', \'x\')"',
        'node --eval=require("fs").writeFileSync("src/a.ts","x")',
        'node -p "require(\'fs\').writeFileSync(\'src/a.ts\', \'x\')"',
        'node --print "require(\'fs\').writeFileSync(\'src/a.ts\', \'x\')"',
        'node --print=require("fs").writeFileSync("src/a.ts","x")',
      ]

      for (const command of cases) {
        const result = expectDenied(command)
        expect(result.code).toBe('inline_interpreter')
      }
    })

    it('blocks python, ruby, and perl inline script entrypoints', () => {
      const cases = [
        'python -c "open(\'src/a.ts\', \'w\').write(\'x\')"',
        'python3 -c "open(\'src/a.ts\', \'w\').write(\'x\')"',
        'ruby -e "File.write(\'src/a.ts\', \'x\')"',
        'perl -e "open my $fh, \'>\', \'src/a.ts\'"',
      ]

      for (const command of cases) {
        const result = expectDenied(command)
        expect(result.code).toBe('inline_interpreter')
      }
    })

    it('blocks heredoc-fed inline interpreters', () => {
      const python = `python - <<'PY'
open('src/a.ts', 'w').write('x')
PY`
      const node = `node - <<'JS'
require('fs').writeFileSync('src/a.ts', 'x')
JS`

      expect(expectDenied(python).code).toBe('heredoc_inline_interpreter')
      expect(expectDenied(node).code).toBe('heredoc_inline_interpreter')
    })
  })

  describe('allow patterns', () => {
    it('allows pnpm test', () => {
      const result = evaluateShellCommand('pnpm test')
      expect(result.allowed).toBe(true)
      expect(result.category).toBe('allowed')
    })

    it('allows pnpm run build', () => {
      const result = evaluateShellCommand('pnpm run build')
      expect(result.allowed).toBe(true)
      expect(result.category).toBe('allowed')
    })

    it('allows echo without redirect', () => {
      const result = evaluateShellCommand('echo "hello"')
      expect(result.allowed).toBe(true)
      expect(result.category).toBe('allowed')
    })

    it('allows git status', () => {
      const result = evaluateShellCommand('git status')
      expect(result.allowed).toBe(true)
      expect(result.category).toBe('allowed')
    })

    it('allows git diff', () => {
      const result = evaluateShellCommand('git diff')
      expect(result.allowed).toBe(true)
      expect(result.category).toBe('allowed')
    })

    it('allows cat (read-only)', () => {
      const result = evaluateShellCommand('cat file.ts')
      expect(result.allowed).toBe(true)
      expect(result.category).toBe('allowed')
    })

    it('allows grep', () => {
      const result = evaluateShellCommand('grep -rn "pattern" src/')
      expect(result.allowed).toBe(true)
      expect(result.category).toBe('allowed')
    })

    it('allows vitest', () => {
      const result = evaluateShellCommand('vitest run src/test.ts')
      expect(result.allowed).toBe(true)
      expect(result.category).toBe('allowed')
    })

    it('allows node', () => {
      const result = evaluateShellCommand('node check.js')
      expect(result.allowed).toBe(true)
      expect(result.category).toBe('allowed')
    })

    it('allows python script and module validation commands', () => {
      const script = evaluateShellCommand('python check.py')
      expect(script.allowed).toBe(true)
      expect(script.category).toBe('allowed')

      const pytest = evaluateShellCommand('python -m pytest')
      expect(pytest.allowed).toBe(true)
      expect(pytest.category).toBe('allowed')
    })

    it('allows package runner validation commands', () => {
      const vitest = evaluateShellCommand('pnpm exec vitest run src/foo.test.ts')
      expect(vitest.allowed).toBe(true)
      expect(vitest.category).toBe('allowed')

      const test = evaluateShellCommand('pnpm test')
      expect(test.allowed).toBe(true)
      expect(test.category).toBe('allowed')
    })

    it('allows quoted validation through shell wrappers when inner command is safe', () => {
      const result = evaluateShellCommand('bash -lc "pnpm test"')
      expect(result.allowed).toBe(true)
      expect(result.category).toBe('allowed')
    })
  })

  describe('warn patterns (install commands)', () => {
    it('warns but allows npm install', () => {
      const result = evaluateShellCommand('npm install lodash')
      expect(result.allowed).toBe(true)
      expect(result.category).toBe('warned')
      expect(result.code).toBe('dependency_install_warning')
      expect(result.reason).toContain('WARNING')
    })

    it('warns but allows pip install', () => {
      const result = evaluateShellCommand('pip install requests')
      expect(result.allowed).toBe(true)
      expect(result.category).toBe('warned')
    })

    it('warns but allows brew install', () => {
      const result = evaluateShellCommand('brew install jq')
      expect(result.allowed).toBe(true)
      expect(result.category).toBe('warned')
    })
  })

  describe('edge cases', () => {
    it('allows empty command', () => {
      const result = evaluateShellCommand('')
      expect(result.allowed).toBe(true)
      expect(result.category).toBe('allowed')
    })

    it('allows unknown commands by default', () => {
      const result = evaluateShellCommand('some_custom_binary --flag')
      expect(result.allowed).toBe(true)
      expect(result.category).toBe('allowed')
    })

    it('allows tee to /dev/null', () => {
      const result = evaluateShellCommand('echo test | tee /dev/null')
      expect(result.allowed).toBe(true)
    })
  })
})
