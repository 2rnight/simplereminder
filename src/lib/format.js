// @ts-check
/**
 * SimpleReminder · 纯展示函数
 * 没有副作用,break 页和 popup 共用,也方便单测。
 */

/**
 * 剩余时间文案。`Math.ceil` 是故意的 —— 显示「还有 0 秒」却还没结束会很怪。
 * @param {number} sec
 */
export function remainText(sec) {
  sec = Math.max(0, Math.ceil(sec));
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `还有 ${m} 分 ${s} 秒` : `还有 ${m} 分钟`;
  }
  return `还有 ${sec} 秒`;
}

/**
 * 时间戳 → `14:32`。popup 里「下次休息 14:32」比「还有 18 分钟」更好用 ——
 * 一个绝对时刻能让人判断「这件事我来得及做完吗」。
 * @param {number} ts
 */
export function clockText(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 切换某条内容的勾选状态。
 *
 * **不允许全部取消勾选** —— 最后一条锁住。想完全停用应该用「暂停」,
 * 而不是把内容清空(那会变成一个沉默的坏掉的扩展)。
 *
 * @param {{id:string, enabled:boolean}[]} ideas
 * @param {string} id
 * @returns {{ ideas: {id:string, enabled:boolean}[], refused: boolean }}
 */
export function toggleIdea(ideas, id) {
  const target = ideas.find((i) => i.id === id);
  if (!target) return { ideas, refused: false };

  const enabledCount = ideas.filter((i) => i.enabled).length;
  if (target.enabled && enabledCount <= 1) {
    return { ideas, refused: true };           // 这是最后一条,拒绝
  }
  return {
    ideas: ideas.map((i) => (i.id === id ? { ...i, enabled: !i.enabled } : i)),
    refused: false,
  };
}

/**
 * 后果预览:「间隔 5 分钟 → 一天约 96 次提醒」。
 *
 * 比硬性限制输入范围好 —— 不替用户做决定,只让代价可见。
 * 按一天 8 小时在电脑前估算。
 * @param {number} intervalMinutes
 */
export function dailyCount(intervalMinutes) {
  return Math.round((8 * 60) / Math.max(1, intervalMinutes));
}
