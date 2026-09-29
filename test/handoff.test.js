import test from 'node:test';
import assert from 'node:assert/strict';
import { planNext } from '../src/handoff.js';

test('a developer returning to the caller wakes Lead once', () => {
  const next = planNext({ agent_id:'developer', depth:1, handoff_count:1, return_chain:['lead'] }, {
    reply:'File đã được tạo và kiểm tra.', handoff:{ agent:'lead', task:'Kết luận công việc.' }
  });
  assert.equal(next.agent, 'lead');
  assert.deepEqual(next.returnChain, []);
  assert.equal(next.handoffCount, 1);
  assert.match(next.prompt, /File đã được tạo/);
  assert.equal(planNext({ agent_id:'lead', depth:2, handoff_count:1, return_chain:[] }, { reply:'Đã xong.', handoff:null }), null);
});

test('nested handoffs return in reverse order without losing the original caller', () => {
  const reviewer = planNext({ agent_id:'developer', depth:1, handoff_count:1, return_chain:['lead'] }, {
    reply:'Code xong.', handoff:{ agent:'reviewer', task:'Kiểm tra diff.' }
  });
  assert.deepEqual(reviewer.returnChain, ['lead','developer']);
  const developer = planNext({ agent_id:'reviewer', depth:2, handoff_count:2, return_chain:reviewer.returnChain }, {
    reply:'Approve.', handoff:null
  });
  assert.equal(developer.agent, 'developer');
  assert.deepEqual(developer.returnChain, ['lead']);
  const lead = planNext({ agent_id:'developer', depth:3, handoff_count:2, return_chain:developer.returnChain }, {
    reply:'Đã tích hợp.', handoff:null
  });
  assert.equal(lead.agent, 'lead');
  assert.deepEqual(lead.returnChain, []);
});
