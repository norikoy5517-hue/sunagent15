import * as fs from 'fs';
import { renameSyncWithRetry } from './fs-retry';

// `import * as fs` namespaces are not spy-able, so replace renameSync at module level
jest.mock('fs', () => ({ ...jest.requireActual('fs'), renameSync: jest.fn() }));
const renameSync = fs.renameSync as unknown as jest.Mock;

function errnoError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: mocked rename failure`);
  err.code = code;
  return err;
}

describe('renameSyncWithRetry', () => {
  const originalPlatform = process.platform;

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform });
  }

  afterEach(() => {
    setPlatform(originalPlatform);
    renameSync.mockReset();
  });

  test('retries transient EPERM on Windows and succeeds', () => {
    setPlatform('win32');
    renameSync
      .mockImplementationOnce(() => { throw errnoError('EPERM'); })
      .mockImplementationOnce(() => { throw errnoError('EBUSY'); })
      .mockImplementationOnce(() => undefined);

    expect(() => renameSyncWithRetry('a.tmp', 'a')).not.toThrow();
    expect(renameSync).toHaveBeenCalledTimes(3);
  });

  test('gives up after the attempt limit on Windows', () => {
    setPlatform('win32');
    renameSync.mockImplementation(() => { throw errnoError('EACCES'); });

    expect(() => renameSyncWithRetry('a.tmp', 'a')).toThrow('EACCES');
    expect(renameSync).toHaveBeenCalledTimes(10);
  });

  test('does not retry on non-Windows platforms', () => {
    setPlatform('linux');
    renameSync.mockImplementation(() => { throw errnoError('EPERM'); });

    expect(() => renameSyncWithRetry('a.tmp', 'a')).toThrow('EPERM');
    expect(renameSync).toHaveBeenCalledTimes(1);
  });

  test('does not retry non-transient errors such as ENOENT', () => {
    setPlatform('win32');
    renameSync.mockImplementation(() => { throw errnoError('ENOENT'); });

    expect(() => renameSyncWithRetry('a.tmp', 'a')).toThrow('ENOENT');
    expect(renameSync).toHaveBeenCalledTimes(1);
  });
});
