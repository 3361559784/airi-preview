import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

export interface PersistCodingEvalReportOptions {
  reportPath?: string
  cwd?: string
}

export interface PersistCodingEvalReportResult {
  wrote: boolean
  path?: string
}

export function resolveCodingEvalReportPath(reportPath: string | undefined, cwd = process.cwd()): string | undefined {
  const trimmed = reportPath?.trim()
  if (!trimmed)
    return undefined

  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed)
}

/**
 * Persist the final manual coding eval report when explicitly requested.
 * This helper never reads environment variables itself, which keeps API keys
 * and provider credentials out of the report writer boundary.
 */
export async function persistCodingEvalReport(
  report: unknown,
  options: PersistCodingEvalReportOptions = {},
): Promise<PersistCodingEvalReportResult> {
  const path = resolveCodingEvalReportPath(options.reportPath, options.cwd)
  if (!path) {
    return { wrote: false }
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  return { wrote: true, path }
}
