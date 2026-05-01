// Test-only helpers shared across command test files.
// Filename underscore-prefixed so it's clearly not a runtime module.

export class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

export interface CaptureResult {
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export async function captureOutputAsync(fn: () => Promise<unknown> | unknown): Promise<CaptureResult> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let exitCode: number | undefined;

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit.bind(process);

  const restore = (): void => {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  };

  const patchedExit = (code?: number): never => {
    exitCode = code ?? 0;
    restore();
    throw new ExitError(code ?? 0);
  };

  process.stdout.write = (chunk: unknown): boolean => {
    stdoutChunks.push(Buffer.from(chunk as string));
    return true;
  };
  process.stderr.write = (chunk: unknown): boolean => {
    stderrChunks.push(Buffer.from(chunk as string));
    return true;
  };
  (process as NodeJS.Process).exit = patchedExit as typeof process.exit;

  try {
    await fn();
  } catch (e) {
    if (!(e instanceof ExitError)) {
      restore();
      throw e;
    }
  } finally {
    restore();
  }

  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exitCode,
  };
}

export function captureOutput(fn: () => void): CaptureResult {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let exitCode: number | undefined;

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit.bind(process);

  const restore = (): void => {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  };

  const patchedExit = (code?: number): never => {
    exitCode = code ?? 0;
    restore();
    throw new ExitError(code ?? 0);
  };

  process.stdout.write = (chunk: unknown): boolean => {
    stdoutChunks.push(Buffer.from(chunk as string));
    return true;
  };
  process.stderr.write = (chunk: unknown): boolean => {
    stderrChunks.push(Buffer.from(chunk as string));
    return true;
  };
  (process as NodeJS.Process).exit = patchedExit as typeof process.exit;

  try {
    fn();
  } catch (e) {
    if (!(e instanceof ExitError)) {
      restore();
      throw e;
    }
  } finally {
    restore();
  }

  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exitCode,
  };
}

export async function withEnvAsync<T>(
  name: string,
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = prev;
    }
  }
}

export function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = prev;
    }
  }
}
