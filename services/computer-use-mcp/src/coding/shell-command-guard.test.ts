import { describe, expect, it } from 'vitest'

import { evaluateShellCommand } from './shell-command-guard'

describe('shellCommandGuard', () => {
  describe('deny patterns', () => {
    it('blocks sed -i (file-modifying)', () => {
      const result = evaluateShellCommand('sed -i "s/foo/bar/" file.ts')
      expect(result.allowed).toBe(false)
      expect(result.category).toBe('denied_write')
      expect(result.suggestedAlternative).toContain('coding_apply_patch')
    })

    it('blocks rm -rf (destructive)', () => {
      const result = evaluateShellCommand('rm -rf src/')
      expect(result.allowed).toBe(false)
      expect(result.category).toBe('denied_destructive')
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
      const result = evaluateShellCommand('node script.js')
      expect(result.allowed).toBe(true)
      expect(result.category).toBe('allowed')
    })
  })

  describe('warn patterns (install commands)', () => {
    it('warns but allows npm install', () => {
      const result = evaluateShellCommand('npm install lodash')
      expect(result.allowed).toBe(true)
      expect(result.category).toBe('warned')
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
