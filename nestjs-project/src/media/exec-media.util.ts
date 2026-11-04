import { execFile, type ExecFileException } from 'child_process';
import { TRANSIENT_STDERR_PATTERNS } from './media.constants';

/** A media binary failed; carries the raw exec error and its stderr. */
export class MediaExecError extends Error {
  constructor(
    public readonly execError: ExecFileException,
    public readonly stderr: string,
  ) {
    super(summarizeStderr(stderr), { cause: execError });
    this.name = 'MediaExecError';
  }

  /**
   * Retry-worthy failures: killed by our timeout; the process never ran or
   * its output overflowed (`code` is a string such as `ENOENT` instead of an
   * exit code — infrastructure, not content); or stderr shows the input
   * could not be read.
   */
  get transient(): boolean {
    return (
      this.execError.killed === true ||
      typeof this.execError.code === 'string' ||
      TRANSIENT_STDERR_PATTERNS.some((pattern) => pattern.test(this.stderr))
    );
  }
}

/**
 * Runs a media binary with arguments passed as an array (no shell, so URLs
 * are never interpreted) and resolves its stdout as a Buffer.
 */
export function runMediaBinary(
  file: string,
  args: string[],
  { timeoutMs, maxBuffer }: { timeoutMs: number; maxBuffer: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'buffer',
        timeout: timeoutMs,
        maxBuffer,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new MediaExecError(error, stderr.toString()));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Last non-empty stderr line: the actionable message, without noise. */
export function summarizeStderr(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? 'no error output';
}
