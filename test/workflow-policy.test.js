import test from 'node:test';
import assert from 'node:assert/strict';
import { isSeriousProjectRequest } from '../src/workflow-policy.js';
import { roles } from '../src/db.js';

test('routes project creation and changes through the serious pipeline', () => {
  assert.equal(isSeriousProjectRequest('@developer sửa bug username trong app'), true);
  assert.equal(isSeriousProjectRequest('@architect phân tích architecture cho API'), true);
  assert.equal(isSeriousProjectRequest('tiếp tục review project'), true);
});

test('keeps ordinary conversation direct unless it belongs to an existing task', () => {
  assert.equal(isSeriousProjectRequest('@lead giải thích khái niệm'), false);
  assert.equal(isSeriousProjectRequest('@designer cho tôi vài ý tưởng màu sắc'), false);
  assert.equal(isSeriousProjectRequest('sửa lỗi còn lại', { existingTask: true }), true);
});

test('seeds the requested model defaults for a fresh clone', () => {
  const byId = new Map(roles.map(role => [role.id, role]));
  assert.deepEqual([byId.get('lead').model, byId.get('lead').effort], ['gpt-5.6-sol', 'medium']);
  for (const id of ['designer', 'architect', 'developer', 'reviewer', 'art-ux']) {
    assert.deepEqual([byId.get(id).model, byId.get(id).effort], ['gpt-5.6-luna', 'xhigh']);
  }
});
