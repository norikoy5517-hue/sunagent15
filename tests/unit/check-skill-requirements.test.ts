/**
 * Unit tests for scripts/check-skill-requirements.js (F8.2 validator).
 *
 * Covers the pure-function surface of the validator so that future
 * regressions in strict-default behavior, schema shape, or frontmatter
 * parsing fail loudly instead of silently passing every skill.
 *
 * The validator is a plain CommonJS module. These tests load it via
 * require() and exercise the exported pure functions (parseArgs,
 * extractFrontmatter, validateRequires). listSkillFiles is covered
 * implicitly by the CI job `skill-requirements-check` running against
 * the real repo.
 */

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
// The validator under test is a plain CommonJS module (scripts/check-skill-requirements.js)
// with no `.d.ts`, so we intentionally load it via `require()` and disable the TS
// lint rules that forbid it in this one test file.

import * as path from 'path';

const validator = require(path.resolve(
  __dirname,
  '..',
  '..',
  'scripts',
  'check-skill-requirements.js'
));

const { parseArgs, extractFrontmatter, validateRequires, listSkillFiles } = validator;

describe('check-skill-requirements validator (F8.2)', () => {
  describe('parseArgs', () => {
    it('defaults to strict=true (Phase 2 enforcement)', () => {
      const args = parseArgs(['node', 'script']);
      expect(args.strict).toBe(true);
      expect(args.verbose).toBe(false);
      expect(args.githubSummary).toBe(false);
    });

    it('--non-strict flips strict to false', () => {
      const args = parseArgs(['node', 'script', '--non-strict']);
      expect(args.strict).toBe(false);
    });

    it('--no-strict (alias) also flips strict to false', () => {
      const args = parseArgs(['node', 'script', '--no-strict']);
      expect(args.strict).toBe(false);
    });

    it('--strict is accepted as a back-compat no-op (stays true)', () => {
      const args = parseArgs(['node', 'script', '--strict']);
      expect(args.strict).toBe(true);
    });

    it('--strict sets strictDeprecated=true (Phase 2 Cleanup)', () => {
      const args = parseArgs(['node', 'script', '--strict']);
      expect(args.strictDeprecated).toBe(true);
    });

    it('no --strict flag leaves strictDeprecated=false', () => {
      const args = parseArgs(['node', 'script']);
      expect(args.strictDeprecated).toBe(false);
    });

    it('--non-strict does not set strictDeprecated', () => {
      const args = parseArgs(['node', 'script', '--non-strict']);
      expect(args.strictDeprecated).toBe(false);
    });

    it('--verbose sets verbose flag', () => {
      const args = parseArgs(['node', 'script', '--verbose']);
      expect(args.verbose).toBe(true);
    });

    it('--github-summary sets githubSummary flag', () => {
      const args = parseArgs(['node', 'script', '--github-summary']);
      expect(args.githubSummary).toBe(true);
    });

    it('-h / --help set the help flag', () => {
      expect(parseArgs(['node', 'script', '-h']).help).toBe(true);
      expect(parseArgs(['node', 'script', '--help']).help).toBe(true);
    });

    it('later --non-strict wins over earlier --strict', () => {
      const args = parseArgs(['node', 'script', '--strict', '--non-strict']);
      expect(args.strict).toBe(false);
    });

    it('later --strict wins over earlier --non-strict', () => {
      const args = parseArgs(['node', 'script', '--non-strict', '--strict']);
      expect(args.strict).toBe(true);
    });

    it('ignores unknown flags (no throw)', () => {
      expect(() => parseArgs(['node', 'script', '--unknown'])).not.toThrow();
    });
  });

  describe('extractFrontmatter', () => {
    it('parses a simple YAML frontmatter block', () => {
      const text = '---\nname: demo\ndescription: d\n---\n\nbody';
      const fm = extractFrontmatter(text);
      expect(fm).toEqual({ name: 'demo', description: 'd' });
    });

    it('detects empty requires mapping as an explicit field', () => {
      const text = '---\nname: x\nrequires: {}\n---';
      const fm = extractFrontmatter(text);
      expect('requires' in fm).toBe(true);
      expect(fm.requires).toEqual({});
    });

    it('returns null when frontmatter delimiters are missing', () => {
      expect(extractFrontmatter('no frontmatter here')).toBeNull();
    });

    it('surfaces YAML parse errors via __parseError', () => {
      const text = '---\nname: x\n  bad: : indent:\n---';
      const fm = extractFrontmatter(text);
      expect(fm).not.toBeNull();
      expect(fm.__parseError).toBeDefined();
    });

    it('treats bare `requires:` (no value) as field present with null value', () => {
      const text = '---\nname: x\nrequires:\n---';
      const fm = extractFrontmatter(text);
      expect('requires' in fm).toBe(true);
      expect(fm.requires).toBeNull();
    });
  });

  describe('validateRequires', () => {
    const ctx = '[test]';

    it('accepts an empty mapping', () => {
      const { errors } = validateRequires({}, ctx);
      expect(errors).toEqual([]);
    });

    it('rejects a null value (must be a mapping)', () => {
      const { errors } = validateRequires(null, ctx);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/must be a mapping/);
    });

    it('rejects an array at the top level', () => {
      const { errors } = validateRequires([], ctx);
      expect(errors[0]).toMatch(/must be a mapping/);
    });

    it('flags unknown top-level keys', () => {
      const { errors } = validateRequires({ bogus: 1 }, ctx);
      expect(errors.join('\n')).toMatch(/unknown requires\.bogus/);
    });

    describe('requires.node', () => {
      it('accepts a valid SemVer range', () => {
        const { errors } = validateRequires({ node: '>=18' }, ctx);
        expect(errors).toEqual([]);
      });

      it('rejects non-string node field', () => {
        const { errors } = validateRequires({ node: 18 }, ctx);
        expect(errors[0]).toMatch(/requires\.node must be a string/);
      });

      it('rejects an invalid SemVer range', () => {
        const { errors } = validateRequires({ node: 'not-a-range' }, ctx);
        expect(errors[0]).toMatch(/not a valid SemVer range/);
      });
    });

    describe('requires.tools', () => {
      it('accepts a kebab-case lowercase array', () => {
        const { errors } = validateRequires(
          { tools: ['ffmpeg', 'yt-dlp', 'python3'] },
          ctx
        );
        expect(errors).toEqual([]);
      });

      it('rejects a non-array tools field', () => {
        const { errors } = validateRequires({ tools: 'ffmpeg' }, ctx);
        expect(errors[0]).toMatch(/requires\.tools must be an array/);
      });

      it('rejects non-string tool entries', () => {
        const { errors } = validateRequires({ tools: [1] }, ctx);
        expect(errors[0]).toMatch(/must be a string/);
      });

      it('rejects UPPERCASE or invalid characters', () => {
        const { errors } = validateRequires({ tools: ['FFmpeg'] }, ctx);
        expect(errors[0]).toMatch(/kebab-case lowercase/);
      });

      it('warns (not errors) when a reserved Node runtime name is used', () => {
        const { errors, warnings } = validateRequires({ tools: ['node'] }, ctx);
        expect(errors).toEqual([]);
        expect(warnings.join('\n')).toMatch(/Node\.js runtime/);
      });

      it('errors on duplicate tools', () => {
        const { errors } = validateRequires(
          { tools: ['ffmpeg', 'ffmpeg'] },
          ctx
        );
        expect(errors.join('\n')).toMatch(/duplicate "ffmpeg"/);
      });
    });

    describe('requires.env', () => {
      it('accepts UPPER_SNAKE_CASE strings', () => {
        const { errors } = validateRequires(
          { env: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] },
          ctx
        );
        expect(errors).toEqual([]);
      });

      it('accepts object form { name, required }', () => {
        const { errors } = validateRequires(
          { env: [{ name: 'SERPAPI_KEY', required: false }] },
          ctx
        );
        expect(errors).toEqual([]);
      });

      it('rejects non-UPPER_SNAKE env names', () => {
        const { errors } = validateRequires({ env: ['lowerName'] }, ctx);
        expect(errors[0]).toMatch(/UPPER_SNAKE_CASE/);
      });

      it('rejects object form missing name', () => {
        const { errors } = validateRequires(
          { env: [{ required: true }] },
          ctx
        );
        expect(errors[0]).toMatch(/env\[0\]\.name must be a string/);
      });

      it('rejects non-boolean required flag', () => {
        const { errors } = validateRequires(
          { env: [{ name: 'FOO', required: 'yes' }] },
          ctx
        );
        expect(errors[0]).toMatch(/required must be boolean/);
      });

      it('rejects unknown object keys', () => {
        const { errors } = validateRequires(
          { env: [{ name: 'FOO', bogus: 1 }] },
          ctx
        );
        expect(errors[0]).toMatch(/\.bogus is unknown/);
      });

      it('warns on platform-embedded credentials', () => {
        const { errors, warnings } = validateRequires(
          { env: ['GITHUB_TOKEN'] },
          ctx
        );
        expect(errors).toEqual([]);
        expect(warnings.join('\n')).toMatch(/platform-embedded credential/);
      });

      it('errors on duplicate env entries', () => {
        const { errors } = validateRequires(
          { env: ['FOO', 'FOO'] },
          ctx
        );
        expect(errors.join('\n')).toMatch(/duplicate "FOO"/);
      });
    });
  });

  describe('listSkillFiles (integration against real .claude/skills/)', () => {
    // These tests run against the actual repo state (the validator is
    // hardcoded to SKILLS_DIR = <repo>/.claude/skills). They guard that
    // Phase 2 Cleanup invariants hold at HEAD: no lowercase holdouts and
    // the top-level skill count is stable.

    it('returns a non-empty list of SKILL.md files sorted by name', () => {
      const files = listSkillFiles([], []);
      expect(Array.isArray(files)).toBe(true);
      expect(files.length).toBeGreaterThan(0);
      const names = files.map((f: { name: string }) => f.name);
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      expect(names).toEqual(sorted);
    });

    it('yields zero errors on a clean repo (no lowercase skill.md)', () => {
      const warnings: string[] = [];
      const errors: string[] = [];
      listSkillFiles(warnings, errors);
      expect(errors).toEqual([]);
    });

    it('every returned path ends with SKILL.md (uppercase, Phase 2 Cleanup)', () => {
      const files = listSkillFiles([], []);
      for (const f of files as Array<{ path: string }>) {
        expect(path.basename(f.path)).toBe('SKILL.md');
      }
    });
  });
});
