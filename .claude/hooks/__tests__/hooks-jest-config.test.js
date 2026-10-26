const path = require('path');

describe('hooks Jest project config', () => {
  test('excludes custom Phase3 TestSuite runner from Jest discovery', () => {
    const config = require(path.join(__dirname, '..', '..', '..', 'jest.config.js'));
    const hooksProject = config.projects.find((p) => p.displayName === 'hooks');

    expect(hooksProject).toBeDefined();
    const ignores = hooksProject.testPathIgnorePatterns.map((p) => new RegExp(p));
    const isIgnored = (file) => ignores.some((re) => re.test(file));

    // Patterns are written with '/'; Jest converts it to the OS separator before matching
    expect(isIgnored('/repo/.claude/hooks/__tests__/unified-guard-phase3.test.js')).toBe(true);
    expect(isIgnored('/repo/.claude/hooks/__tests__/unified-guard-phase2.test.js')).toBe(false);
    expect(isIgnored('/repo/.claude/hooks/__tests__/hooks-jest-config.test.js')).toBe(false);
  });
});
