/**
 * 模拟数据层（Mock Data Layer）
 * ------------------------------------------------------------
 * 这一层只做一件事：产数据、存数据。
 * 它不碰界面、不碰按钮，将来换成真后端时，只需要把这一层的
 * 函数体改成 fetch(...) 调用真实接口，上面的界面代码一行都不用动。
 *
 * 这是「前后端分离」最朴素的形态：
 *   界面  <--调用函数-->  数据层  <--将来换成-->  真实后端
 * 现在中间的箭头是假的（内存 + localStorage），所以叫 Demo。
 */

// 所有数据存在浏览器 localStorage 里的统一前缀
const STORAGE_KEY = 'desktop-ai-assistant-mvp-v1';

// ---------------------------------------------------------------------------
// 默认数据：第一次打开应用时没有历史数据，用这份兜底
// ---------------------------------------------------------------------------
function defaultState() {
  const now = Date.now();
  return {
    // 模型配置（对应设计文档 3.2 节）
    config: {
      apiUrl: 'https://api.openai.com/v1',
      apiKey: '',
      modelName: 'gpt-4o-mini',
    },
    // 人格配置（对应设计文档 3.4 节）
    persona: {
      assistantName: '小助',
      userName: '老大',
      systemPrompt: '你是一个简洁、直接、不说废话的桌面助手。回答时先给结论，再补充必要细节。',
    },
    // 会话列表（对应设计文档 3.3 节），最新的排在最前面
    conversations: [
      {
        id: 'conv-welcome',
        title: '欢迎使用',
        createdAt: now - 1000 * 60 * 60 * 24,
        updatedAt: now - 1000 * 60 * 30,
        messages: [
          {
            id: 'msg-1',
            role: 'assistant',
            content: '你好，我是小助。\n\n这是一个**界面演示版**，所有回答都是模拟的，不会真的调用模型。\n\n你可以试试：\n\n1. 在「设置」里填模型配置，点「测试连接」\n2. 回到聊天页发一条消息，看流式输出效果\n3. 在左侧新建 / 重命名 / 删除会话',
            createdAt: now - 1000 * 60 * 30,
          },
        ],
      },
    ],
    // 当前选中的会话 id（对应「自动恢复最近一次会话」）
    activeConversationId: 'conv-welcome',
  };
}

// ---------------------------------------------------------------------------
// 读写本地存储
// ---------------------------------------------------------------------------
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    // 简单校验，防止手改坏了导致白屏
    if (!parsed || !Array.isArray(parsed.conversations)) return defaultState();
    return parsed;
  } catch (error) {
    console.warn('[mock-data] 读取本地数据失败，使用默认数据', error);
    return defaultState();
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('[mock-data] 保存本地数据失败', error);
  }
}

// ---------------------------------------------------------------------------
// 生成唯一 id（真后端里这一步由数据库负责）
// ---------------------------------------------------------------------------
let idCounter = 0;
export function makeId(prefix) {
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

// ---------------------------------------------------------------------------
// 假回答生成器：根据用户输入拼一段看起来像样的回复
// 真后端里，这一段会被替换成流式调用模型的逻辑
// ---------------------------------------------------------------------------
const CANNED_REPLIES = [
  (input) =>
    `收到，你说的是「${input}」。\n\n这是我按模拟规则生成的回复，重点验证三件事：\n\n- 气泡宽度和换行是否舒服\n- 代码块样式是否清楚\n- 流式输出是否自然\n\n\`\`\`js\n// 真实版本这里会是模型的回答\nconsole.log("hello from mock");\n\`\`\``,
  (input) =>
    `关于「${input}」，我先给结论：界面流程是通的。\n\n需要继续打磨的地方通常是这几类：\n\n1. 输入框的多行体验\n2. 长会话的滚动位置\n3. 错误提示的措辞\n\n现在这些都在 Demo 里跑起来了，你可以直接点着看。`,
  (input) =>
    `「${input}」——这个问题的答案取决于你后面接哪个模型。\n\n目前 Demo 不联网，所以我只能回复固定文案。等你接上真实接口后，这里就会变成真正的模型输出。\n\n> 提示：右上角可以切换浅色 / 深色主题。`,
];

export function pickReply(input) {
  const index = Math.abs(hashCode(input)) % CANNED_REPLIES.length;
  return CANNED_REPLIES[index](input);
}

function hashCode(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

// ---------------------------------------------------------------------------
// 对外的「接口」：所有界面操作都通过这些函数，不直接碰 state
// 这样将来换后端，只需要重写这一组函数
// ---------------------------------------------------------------------------
const api = {
  /** 读取全部状态（返回深拷贝，防止界面直接改内部数据） */
  getState() {
    return structuredClone(loadState());
  },

  /** 保存模型配置，返回是否成功 */
  saveConfig(config) {
    const state = loadState();
    state.config = { ...state.config, ...config };
    saveState(state);
    return { ok: true };
  },

  /** 保存人格配置 */
  savePersona(persona) {
    const state = loadState();
    state.persona = { ...state.persona, ...persona };
    saveState(state);
    return { ok: true };
  },

  /** 模拟「测试连接」：不发真请求，按规则假装成功或失败 */
  testConnection(config) {
    return new Promise((resolve) => {
      const delay = 600 + Math.random() * 700;
      setTimeout(() => {
        if (!config.apiUrl || !config.apiUrl.trim()) {
          resolve({ ok: false, message: '请先填写 API 地址。' });
          return;
        }
        if (!/^https?:\/\//i.test(config.apiUrl.trim())) {
          resolve({ ok: false, message: 'API 地址需要以 http:// 或 https:// 开头。' });
          return;
        }
        if (!config.apiKey || !config.apiKey.trim()) {
          resolve({ ok: false, message: '请先填写 API Key。' });
          return;
        }
        if (!config.modelName || !config.modelName.trim()) {
          resolve({ ok: false, message: '请先填写模型名称。' });
          return;
        }
        resolve({
          ok: true,
          message: `连接成功，模型「${config.modelName}」可用。（模拟结果，未发起真实请求）`,
        });
      }, delay);
    });
  },

  /** 新建会话，返回新会话对象 */
  createConversation() {
    const state = loadState();
    const now = Date.now();
    const conversation = {
      id: makeId('conv'),
      title: '新会话',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    state.conversations.unshift(conversation);
    state.activeConversationId = conversation.id;
    saveState(state);
    return conversation;
  },

  /** 重命名会话 */
  renameConversation(id, title) {
    const state = loadState();
    const target = state.conversations.find((item) => item.id === id);
    if (!target) return { ok: false, message: '会话不存在。' };
    target.title = title.trim() || '未命名会话';
    target.updatedAt = Date.now();
    saveState(state);
    return { ok: true };
  },

  /** 删除会话（界面层负责先弹确认框） */
  deleteConversation(id) {
    const state = loadState();
    state.conversations = state.conversations.filter((item) => item.id !== id);
    // 如果删掉的是当前会话，自动切到第一个；一个都没有就留空
    if (state.activeConversationId === id) {
      state.activeConversationId = state.conversations[0]?.id ?? null;
    }
    saveState(state);
    return { ok: true };
  },

  /** 切换当前会话 */
  setActiveConversation(id) {
    const state = loadState();
    state.activeConversationId = id;
    saveState(state);
    return { ok: true };
  },

  /**
   * 追加一条消息。
   * 第一条用户消息会自动变成会话标题（对应设计文档的会话管理体验）。
   */
  appendMessage(conversationId, message) {
    const state = loadState();
    const target = state.conversations.find((item) => item.id === conversationId);
    if (!target) return { ok: false, message: '会话不存在。' };

    target.messages.push({
      id: makeId('msg'),
      createdAt: Date.now(),
      ...message,
    });
    target.updatedAt = Date.now();

    // 首条用户消息升级为标题
    if (message.role === 'user' && target.title === '新会话') {
      const firstLine = message.content.split('\n')[0].trim();
      target.title = firstLine.length > 18 ? `${firstLine.slice(0, 18)}…` : firstLine || '新会话';
    }

    saveState(state);
    return { ok: true };
  },

  /** 把一段内容写进指定消息（流式输出用，每来一段调用一次） */
  updateMessageContent(conversationId, messageId, content) {
    const state = loadState();
    const target = state.conversations.find((item) => item.id === conversationId);
    if (!target) return { ok: false };
    const message = target.messages.find((item) => item.id === messageId);
    if (!message) return { ok: false };
    message.content = content;
    target.updatedAt = Date.now();
    saveState(state);
    return { ok: true };
  },

  /** 清空全部本地数据（设置页的「重置」用） */
  resetAll() {
    localStorage.removeItem(STORAGE_KEY);
    return { ok: true };
  },

  /** 生成一条模拟回复（真后端里，这一步是调用模型） */
  pickReply,
};

export default api;
