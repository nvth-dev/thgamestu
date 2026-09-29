export function planNext(job, answer) {
  const chain = Array.isArray(job.return_chain) && job.return_chain.length
    ? job.return_chain : job.return_agent_id ? [job.return_agent_id] : [];
  const handoff = answer.handoff;
  const valid = handoff && handoff.agent !== job.agent_id && typeof handoff.task === 'string' && handoff.task.length <= 5000;
  const caller = chain.at(-1);

  if (valid && handoff.agent === caller && job.depth < 9) {
    return {
      agent: caller,
      prompt: `${handoff.task}\n\nBáo cáo từ @${job.agent_id}:\n${answer.reply}`,
      returnChain: chain.slice(0, -1), handoffCount: job.handoff_count
    };
  }
  if (valid && job.handoff_count < 3 && job.depth < 8) {
    return {
      agent: handoff.agent,
      prompt: `Nhiệm vụ được @${job.agent_id} giao:\n${handoff.task}\n\nBàn giao ngắn:\n${answer.reply}`,
      returnChain: [...chain, job.agent_id], handoffCount: job.handoff_count + 1
    };
  }
  if (caller && job.depth < 9) {
    return {
      agent: caller,
      prompt: `@${job.agent_id} đã hoàn thành công việc bạn giao. Báo cáo:\n${answer.reply}\n\nĐưa ra quyết định ngắn. Chỉ gọi reviewer nếu cần kiểm chứng; tránh lặp lại phân tích.`,
      returnChain: chain.slice(0, -1), handoffCount: job.handoff_count
    };
  }
  return null;
}
