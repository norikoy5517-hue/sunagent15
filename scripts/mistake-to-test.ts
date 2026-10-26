#!/usr/bin/env npx ts-node
/**
 * Mistake to Test Generator - Memory++
 *
 * mistakes.md から回帰テスト雛形を生成
 * 再発防止を"テストで固定"する
 *
 * Usage:
 *   npx ts-node scripts/mistake-to-test.ts
 *   npm run mistake:testgen
 */

import * as fs from 'fs';
import * as path from 'path';

interface ParsedMistake {
  id: string;
  date: string;
  name: string;
  symptom: string;
  rootCause: string;
  location: string;
  fix: string;
  prevention: string[];
}

/**
 * Parse mistakes.md into structured data
 */
function parseMistakes(): ParsedMistake[] {
  const mistakesPath = path.join(process.cwd(), '.claude', 'rules', 'mistakes.md');

  if (!fs.existsSync(mistakesPath)) {
    console.error('❌ mistakes.md が見つかりません');
    process.exit(1);
  }

  const content = fs.readFileSync(mistakesPath, 'utf-8');
  const mistakes: ParsedMistake[] = [];

  // Split by mistake entries
  const sections = content.split(/(?=## \d{4}-\d{2}-\d{2} Mistake:)/);

  for (const section of sections) {
    const headerMatch = section.match(/## (\d{4}-\d{2}-\d{2}) Mistake: (.+)/);
    if (!headerMatch) continue;

    const [, date, name] = headerMatch;

    const symptomMatch = section.match(/\*\*Symptom\*\*:\s*(.+)/);
    const rootCauseMatch = section.match(/\*\*Root cause\*\*:\s*(.+)/);
    const locationMatch = section.match(/\*\*Where it happened[^*]*\*\*:\s*(.+)/);
    const fixMatch = section.match(/\*\*Fix\*\*:\s*(.+)/);

    // Extract prevention items
    const preventionMatch = section.match(
      /\*\*Prevention[^*]*\*\*:\s*([\s\S]*?)(?=\*\*|---|\n##|$)/
    );
    const preventionItems: string[] = [];
    if (preventionMatch) {
      const items = preventionMatch[1].match(/- \[[ x]\]\s*.+/g);
      if (items) {
        preventionItems.push(...items.map((i) => i.replace(/- \[[ x]\]\s*/, '')));
      }
    }

    mistakes.push({
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      date,
      name,
      symptom: symptomMatch ? symptomMatch[1] : '',
      rootCause: rootCauseMatch ? rootCauseMatch[1] : '',
      location: locationMatch ? locationMatch[1] : '',
      fix: fixMatch ? fixMatch[1] : '',
      prevention: preventionItems,
    });
  }

  return mistakes;
}

/**
 * Generate test template for a mistake
 */
function generateTestTemplate(mistake: ParsedMistake): string {
  const testName = mistake.name
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  return `/**
 * Regression Test: ${testName}
 *
 * Date: ${mistake.date}
 * Location: ${mistake.location}
 * Root Cause: ${mistake.rootCause}
 *
 * This test ensures the mistake does not recur.
 */

describe('Regression: ${testName}', () => {
  /**
   * Symptom: ${mistake.symptom}
   * Fix: ${mistake.fix}
   */
  it('should not exhibit the original symptom', () => {
    // TODO: Implement regression test
    // Prevention checks:
${mistake.prevention.map((p) => `    // - ${p}`).join('\n')}

    // Example assertions:
    // expect(result.success).toBe(false); // Not true on error
    // expect(spawnSync).toHaveBeenCalled(); // Not execSync

    expect(true).toBe(true); // Placeholder - replace with actual test
  });

  it('should follow the prevention guidelines', () => {
    // TODO: Verify prevention measures are in place
${mistake.prevention.map((p, i) => `    // ${i + 1}. ${p}`).join('\n')}

    expect(true).toBe(true); // Placeholder - replace with actual test
  });
});
`;
}

/**
 * Generate index file for regression tests
 */
function generateIndexFile(mistakes: ParsedMistake[]): string {
  return `/**
 * Regression Test Suite Index
 *
 * Auto-generated from mistakes.md
 * Run: npm run mistake:testgen
 *
 * These tests ensure past mistakes do not recur.
 */

// Import all regression tests
${mistakes.map((m) => `import './${m.id}.test';`).join('\n')}

describe('Regression Suite', () => {
  it('should have ${mistakes.length} regression tests', () => {
    expect(${mistakes.length}).toBeGreaterThan(0);
  });
});
`;
}

/**
 * Main function
 */
function main(): void {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🧪 Mistake to Test Generator - Memory++');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const mistakes = parseMistakes();
  console.log(`📋 Found ${mistakes.length} mistakes in mistakes.md\n`);

  if (mistakes.length === 0) {
    console.log('No mistakes to generate tests for.');
    return;
  }

  // Create regression tests directory
  const regressionDir = path.join(process.cwd(), 'tests', 'regression');
  if (!fs.existsSync(regressionDir)) {
    fs.mkdirSync(regressionDir, { recursive: true });
    console.log(`📁 Created ${regressionDir}\n`);
  }

  // Generate test files
  for (const mistake of mistakes) {
    const testPath = path.join(regressionDir, `${mistake.id}.test.ts`);

    // Don't overwrite existing tests
    if (fs.existsSync(testPath)) {
      console.log(`⏭️  Skipping ${mistake.id} (test already exists)`);
      continue;
    }

    const testContent = generateTestTemplate(mistake);
    fs.writeFileSync(testPath, testContent);
    console.log(`✅ Generated ${mistake.id}.test.ts`);
  }

  // Generate index file
  const indexPath = path.join(regressionDir, 'index.test.ts');
  if (!fs.existsSync(indexPath)) {
    const indexContent = generateIndexFile(mistakes);
    fs.writeFileSync(indexPath, indexContent);
    console.log(`✅ Generated index.test.ts`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ Regression test generation complete');
  console.log(`   Run: npm test -- --testPathPatterns=regression`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main();
