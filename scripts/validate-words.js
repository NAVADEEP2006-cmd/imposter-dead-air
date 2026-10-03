'use strict';
/**
 * Build-time Word Database & Fuzzy Match Safety Validator
 *
 * Enforces:
 * 1. Exactly 8 categories with 35–40 words each (approx 280–320 total).
 * 2. Only 'easy' and 'medium' difficulties (no 'hard').
 * 3. Schema conformity: word, category, difficulty, aliases, forbiddenVariants, compoundVariants, notes.
 * 4. Fuzzy Match Collision Prevention: Ensures no two distinct entries or their aliases
 *    are dangerously close under the game's normalization and fuzzy matching rules.
 */

const WORDS = require('../words.js');

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/(?:es|s)$/, '');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,      // deletion
        d[i][j - 1] + 1,      // insertion
        d[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return d[m][n];
}

function isDangerousFuzzyMatch(w1, w2) {
  const n1 = normalize(w1);
  const n2 = normalize(w2);
  if (n1 === n2) return true;
  // If either word is short (< 5 chars), fuzzy match distance must be 0 (exact only)
  const minLen = Math.min(n1.length, n2.length);
  if (minLen < 5) return false;
  const dist = levenshtein(n1, n2);
  // Dangerous if distance is 1 for length >= 5, or distance 2 for length >= 8
  if (dist <= 1) return true;
  if (minLen >= 8 && dist <= 2) return true;
  return false;
}

function validateWordDatabase() {
  const errors = [];
  const categories = Object.keys(WORDS);

  if (categories.length !== 8) {
    errors.push(`Expected exactly 8 categories, got ${categories.length}`);
  }

  const allWords = [];
  const lookup = new Map(); // normalized term -> { word, category }

  for (const cat of categories) {
    const list = WORDS[cat];
    if (!Array.isArray(list)) {
      errors.push(`Category "${cat}" must be an array of word objects`);
      continue;
    }
    if (list.length < 35 || list.length > 40) {
      errors.push(`Category "${cat}" has ${list.length} words (expected 35-40)`);
    }

    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item.word || typeof item.word !== 'string') {
        errors.push(`Category "${cat}" item #${i} missing valid word string`);
        continue;
      }
      if (item.category !== cat) {
        errors.push(`Word "${item.word}" category mismatch: "${item.category}" vs "${cat}"`);
      }
      if (!['easy', 'medium'].includes(item.difficulty)) {
        errors.push(`Word "${item.word}" has invalid difficulty "${item.difficulty}". Only easy/medium allowed.`);
      }
      if (!Array.isArray(item.aliases)) {
        errors.push(`Word "${item.word}" missing aliases array`);
      }
      if (!Array.isArray(item.forbiddenVariants)) {
        errors.push(`Word "${item.word}" missing forbiddenVariants array`);
      }
      if (!Array.isArray(item.compoundVariants)) {
        errors.push(`Word "${item.word}" missing compoundVariants array`);
      }

      allWords.push(item);
    }
  }

  // Cross-word collision & fuzzy danger check
  for (let i = 0; i < allWords.length; i++) {
    const a = allWords[i];
    const termsA = [a.word, ...(a.aliases || []), ...(a.compoundVariants || [])];

    for (let j = i + 1; j < allWords.length; j++) {
      const b = allWords[j];
      const termsB = [b.word, ...(b.aliases || []), ...(b.compoundVariants || [])];

      for (const ta of termsA) {
        for (const tb of termsB) {
          if (normalize(ta) === normalize(tb)) {
            errors.push(`Collision between "${a.word}" (${a.category}) and "${b.word}" (${b.category}): exact normalized term "${ta}"`);
          } else if (isDangerousFuzzyMatch(ta, tb)) {
            errors.push(`Dangerous fuzzy collision between "${a.word}" ("${ta}") and "${b.word}" ("${tb}")`);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error('Word Database Validation FAILED with errors:');
    errors.forEach(e => console.error('  - ' + e));
    process.exit(1);
  }

  console.log(`Word Database Validated: 8 categories, ${allWords.length} words total (all easy/medium, 0 fuzzy collisions).`);
}

if (require.main === module) {
  validateWordDatabase();
}

module.exports = { validateWordDatabase, normalize, isDangerousFuzzyMatch, levenshtein };
