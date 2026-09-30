import test from 'node:test';
import assert from 'node:assert/strict';
import { planDecision } from '../src/plan-decision.js';

test('recognizes explicit plan review commands with task and Lead prefixes', () => {
  assert.equal(planDecision('@lead duyệt plan'), 'approve');
  assert.equal(planDecision('task #53 @lead duyệt plan và triển khai'), 'approve');
  assert.equal(planDecision('@lead sửa plan: bỏ multiplayer ở bản đầu'), 'changes');
});

test('does not treat a project brief mentioning later approval as a decision', () => {
  assert.equal(planDecision('Hãy xây dựng game, đưa plan để tôi review và chờ tôi duyệt plan'), null);
  assert.equal(planDecision('Designer và Architect góp ý. Chỉ viết code sau khi tôi duyệt plan'), null);
});
