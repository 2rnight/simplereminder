// @ts-check
/**
 * SimpleReminder · 内置休息内容(打包在扩展内)
 *
 * 设计约束(PRODUCT.md):
 * - 内容必须是**行动指令**,不是信息消费 —— 遮罩是触发器,不是容器
 * - 文案**不得包含具体时长**(时长由用户自定义,内容不与时长绑定)
 * - v0.1 只做 3 条。无 category,无 minSeconds。
 */

/**
 * @typedef {Object} BreakIdea
 * @property {string} id
 * @property {string} emoji            v0.1 不在遮罩上显示,留给 popup / 统计
 * @property {{zh:string, en:string}} action
 * @property {{zh:string, en:string}} hint   允许为空字符串
 * @property {string} bg               遮罩背景,HSL 三元组(深色低饱和,绝不纯白)
 * @property {string} accent           强调色,用于长按进度环
 * @property {string} [animation]      v0.2
 */

/** @type {BreakIdea[]} */
export const IDEAS = [
  {
    id: 'stand',
    emoji: '🧍',
    action: { zh: '站起来,走两步', en: 'Stand up, take a few steps' },
    hint:   { zh: '让腰背松一松',   en: 'Loosen your back' },
    bg:     '32 38% 8%',     // 暖琥珀
    accent: '#e8a33d',
  },
  {
    id: 'eyes',
    emoji: '👁',
    action: { zh: '看看窗外最远的地方', en: 'Look at the farthest thing outside' },
    hint:   { zh: '给眼睛对个远焦',     en: 'Let your eyes refocus far away' },
    bg:     '158 32% 7%',    // 深墨绿
    accent: '#5fbf96',
  },
  {
    id: 'water',
    emoji: '💧',
    action: { zh: '去接杯水', en: 'Go get a glass of water' },
    hint:   { zh: '',         en: '' },
    bg:     '192 36% 8%',    // 深青
    accent: '#4fb0c9',
  },
];

/** @type {Record<string, BreakIdea>} */
export const IDEA_BY_ID = Object.fromEntries(IDEAS.map((i) => [i.id, i]));

export const DEFAULT_IDEA = IDEAS[0];
