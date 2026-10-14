/* ============================================================================
   桌面 AI 助手 MVP —— 界面演示（Demo）
   ----------------------------------------------------------------------------
   这一层只干两件事：
     1. 把 mock-data 里的数据画到屏幕上
     2. 把用户的点击翻译成对 mock-data 的调用
   不写业务规则（比如"标题怎么起"），那些都在 mock-data 里。

   文件结构（按你在 PRODUCT_DESIGN.md 里定的页面来）：
     §1  主题与工具函数
     §2  全局状态
     §3  侧边栏：会话列表
     §4  聊天页：消息区 + 输入区
     §5  设置页：模型配置 / 人格配置 / 数据目录
     §6  确认弹窗、Toast 提示
     §7  流式输出模拟器
     §8  启动
   ========================================================================== */

/* ---------------------------------------------------------------------------
   §0 引入数据层
   界面层不自己造数据，所有业务数据都通过 API 这组函数来读写
   --------------------------------------------------------------------------- */
import API, { pickReply } from './src/mock-data.js';

/* ---------------------------------------------------------------------------
   §1 主题与工具函数
   --------------------------------------------------------------------------- */

/** 极简 Markdown 渲染：只支持 Demo 需要的几种语法 */
function renderMarkdown(text) {
  // 先做 HTML 转义，防止把用户的尖括号当成标签（XSS 防护的基本意识）
  const escapeHtml = (str) =>
    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const blocks = [];
  // 把代码块先抠出来占位，避免里面的符号被当作 Markdown 解析
  const withoutCode = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const index = blocks.length;
    blocks.push(
      `<pre class="code-block" data-lang="${escapeHtml(lang)}"><code>${escapeHtml(
        code.replace(/\n$/, '')
      )}</code></pre>`
    );
    return `\u0000BLOCK${index}\u0000`;
  });

  let html = escapeHtml(withoutCode);

  // 行内代码 `code`
  html = html.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  // 加粗 **text**
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // 引用 > text
  html = html.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');
  // 无序列表
  html = html.replace(/^[-*]\s+(.*)$/gm, '<li>$1</li>');
  // 有序列表
  html = html.replace(/^\d+\.\s+(.*)$/gm, '<li data-ordered="1">$1</li>');
  // 把连续的 li 包成 ul
  html = html.replace(/(<li[\s\S]*?<\/li>)(?![\s\S]*?<li)/g, (match) => {
    const items = match.replace(/<li data-ordered="1">/g, '<li>');
    const ordered = /data-ordered/.test(match);
    return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
  });

  // 段落：按空行切
  html = html
    .split(/\n{2,}/)
    .map((chunk) => {
      const trimmed = chunk.trim();
      if (!trimmed) return '';
      if (/^<(ul|ol|blockquote|pre|h\d)/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');

  // 把代码块放回去
  html = html.replace(/\u0000BLOCK(\d+)\u0000/g, (_, index) => blocks[Number(index)]);
  return html;
}

/** 把时间戳格式化成侧边栏要的样子 */
function formatListTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function formatClockTime(timestamp) {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 取会话的摘要文案（列表里显示的最后一条消息） */
function conversationPreview(conversation) {
  const last = conversation.messages[conversation.messages.length - 1];
  if (!last) return '还没有消息';
  return last.content.replace(/[#*`>\n]/g, ' ').trim().slice(0, 40) || '还没有消息';
}

/* ---------------------------------------------------------------------------
   §2 全局状态（只存界面自己的状态，业务数据都在 mock-data 里）
   --------------------------------------------------------------------------- */
const ui = {
  page: 'chat', // 'chat' | 'settings'
  isStreaming: false, // 是否正在流式输出
  abortStream: null, // 用来中断流式输出的函数
  editingConversationId: null, // 正在重命名的会话 id
  pendingDeleteId: null, // 等待确认删除的会话 id
};

let state = API.getState();

/** 重新从数据层拉一遍数据并重绘 */
function refresh() {
  state = API.getState();
  render();
}

/** 当前会话对象 */
function activeConversation() {
  return state.conversations.find((item) => item.id === state.activeConversationId) ?? null;
}

/* ---------------------------------------------------------------------------
   §3 侧边栏：会话列表
   --------------------------------------------------------------------------- */
function renderSidebar() {
  const list = document.getElementById('conversation-list');
  list.innerHTML = '';

  if (state.conversations.length === 0) {
    list.innerHTML = '<div class="empty-hint">还没有会话<br>点上方「新建会话」开始</div>';
    return;
  }

  for (const conversation of state.conversations) {
    const item = document.createElement('div');
    item.className = 'conv-item';
    if (conversation.id === state.activeConversationId) item.classList.add('active');
    item.dataset.id = conversation.id;

    // 正在重命名时，把标题换成输入框
    if (ui.editingConversationId === conversation.id) {
      item.innerHTML = `
        <div class="conv-rename">
          <input class="conv-rename-input" type="text" value="${escapeAttr(conversation.title)}" maxlength="30">
        </div>
      `;
      list.appendChild(item);
      const input = item.querySelector('.conv-rename-input');
      input.focus();
      input.select();
      const commit = () => {
        const value = input.value;
        ui.editingConversationId = null;
        API.renameConversation(conversation.id, value);
        refresh();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') input.blur();
        if (event.key === 'Escape') {
          ui.editingConversationId = null;
          refresh();
        }
      });
      continue;
    }

    item.innerHTML = `
      <div class="conv-main">
        <div class="conv-title">${escapeAttr(conversation.title)}</div>
        <div class="conv-preview">${escapeAttr(conversationPreview(conversation))}</div>
      </div>
      <div class="conv-meta">
        <span class="conv-time">${formatListTime(conversation.updatedAt)}</span>
        <div class="conv-actions">
          <button class="icon-btn tiny" data-action="rename" title="重命名">✎</button>
          <button class="icon-btn tiny danger" data-action="delete" title="删除">🗑</button>
        </div>
      </div>
    `;

    item.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'rename') {
        event.stopPropagation();
        ui.editingConversationId = conversation.id;
        render();
        return;
      }
      if (action === 'delete') {
        event.stopPropagation();
        ui.pendingDeleteId = conversation.id;
        render();
        return;
      }
      if (ui.isStreaming) return; // 流式输出时不允许切会话，避免状态错乱
      API.setActiveConversation(conversation.id);
      refresh();
    });

    list.appendChild(item);
  }
}

/* ---------------------------------------------------------------------------
   §4 聊天页
   --------------------------------------------------------------------------- */
function renderChat() {
  const conversation = activeConversation();
  const container = document.getElementById('messages');
  container.innerHTML = '';

  if (!conversation) {
    container.innerHTML = `
      <div class="chat-empty">
        <div class="chat-empty-icon">💬</div>
        <p>还没有选中会话</p>
        <button class="btn primary" data-action="new-conversation">新建一个会话</button>
      </div>
    `;
    return;
  }

  if (conversation.messages.length === 0) {
    container.innerHTML = `
      <div class="chat-empty">
        <div class="chat-empty-icon">✨</div>
        <p>这是「${escapeAttr(conversation.title)}」的第一条消息</p>
        <span class="chat-empty-sub">在下面输入点什么，试试流式输出效果</span>
      </div>
    `;
    return;
  }

  const persona = state.persona;
  for (const message of conversation.messages) {
    const isUser = message.role === 'user';
    const wrapper = document.createElement('div');
    wrapper.className = `message ${isUser ? 'user' : 'assistant'}`;
    wrapper.dataset.messageId = message.id;

    wrapper.innerHTML = `
      <div class="avatar">${isUser ? escapeAttr((persona.userName || '我').slice(0, 1)) : escapeAttr((persona.assistantName || 'AI').slice(0, 1))}</div>
      <div class="bubble-wrap">
        <div class="bubble">
          <div class="bubble-content">${isUser ? escapeAttr(message.content).replace(/\n/g, '<br>') : renderMarkdown(message.content)}</div>
        </div>
        <div class="message-foot">
          <span class="message-time">${formatClockTime(message.createdAt)}</span>
          ${isUser ? '' : '<button class="icon-btn tiny" data-action="copy" title="复制回复">⧉</button>'}
        </div>
      </div>
    `;

    // 助手回复：挂上气泡下方的操作条（复制 / 重新生成）
    if (!isUser) {
      wrapper.querySelector('[data-action="copy"]')?.addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(message.content);
          toast('已复制到剪贴板', 'success');
        } catch {
          toast('复制失败，请手动选中复制', 'error');
        }
      });
    }

    container.appendChild(wrapper);
  }

  scrollToBottom();
}

function scrollToBottom() {
  const container = document.getElementById('messages');
  container.scrollTop = container.scrollHeight;
}

/** 发送消息（Demo 的核心流程） */
async function handleSend() {
  if (ui.isStreaming) return;
  const input = document.getElementById('composer-input');
  const text = input.value.trim();
  if (!text) return;

  let conversation = activeConversation();
  if (!conversation) {
    // 没有会话时自动建一个，避免用户卡住
    conversation = API.createConversation();
    refresh();
    conversation = activeConversation();
  }

  const conversationId = conversation.id;

  // 1. 先把用户消息落库
  API.appendMessage(conversationId, { role: 'user', content: text });
  input.value = '';
  autoResizeInput();
  ui.isStreaming = true;
  state = API.getState();
  render();

  // 2. 造一条空的助手消息占位，然后一段一段往里填（模拟流式）
  API.appendMessage(conversationId, { role: 'assistant', content: '' });
  state = API.getState();
  render();

  const target = API.getState()
    .conversations.find((item) => item.id === conversationId);
  const placeholder = target.messages[target.messages.length - 1];
  const fullText = pickReply(text);

  ui.abortStream = streamText({
    fullText,
    onChunk: (partial) => {
      API.updateMessageContent(conversationId, placeholder.id, partial);
      const node = document.querySelector(`[data-message-id="${placeholder.id}"] .bubble-content`);
      if (node) node.innerHTML = renderMarkdown(partial);
      scrollToBottom();
    },
    onDone: () => {
      ui.isStreaming = false;
      ui.abortStream = null;
      refresh();
    },
  });
}

/** 停止生成 */
function handleStop() {
  if (ui.abortStream) {
    ui.abortStream();
    ui.abortStream = null;
  }
  ui.isStreaming = false;
  refresh();
  toast('已停止生成', 'info');
}

/* ---------------------------------------------------------------------------
   §5 设置页
   --------------------------------------------------------------------------- */
function renderSettings() {
  const { config, persona } = state;

  // 用 value 属性直接回填，避免重绘时丢失用户正在输入的内容
  const setValue = (id, value) => {
    const node = document.getElementById(id);
    if (node && document.activeElement !== node) node.value = value;
  };

  setValue('cfg-api-url', config.apiUrl);
  setValue('cfg-api-key', config.apiKey);
  setValue('cfg-model-name', config.modelName);
  setValue('cfg-assistant-name', persona.assistantName);
  setValue('cfg-user-name', persona.userName);
  setValue('cfg-system-prompt', persona.systemPrompt);

  const dirNode = document.getElementById('data-dir-path');
  if (dirNode) dirNode.textContent = 'D:\\项目\\data\\   （Demo 阶段：数据实际存在浏览器 localStorage）';
}

/* ---------------------------------------------------------------------------
   §6 确认弹窗 / Toast
   --------------------------------------------------------------------------- */
function renderConfirmDialog() {
  const dialog = document.getElementById('confirm-dialog');
  const conversation = state.conversations.find((item) => item.id === ui.pendingDeleteId);
  if (!conversation) {
    dialog.hidden = true;
    return;
  }
  dialog.hidden = false;
  document.getElementById('confirm-text').innerHTML =
    `确定要删除会话「<strong>${escapeAttr(conversation.title)}</strong>」吗？<br>` +
    `<span class="muted">该会话的 ${conversation.messages.length} 条消息将一并删除，且无法恢复。</span>`;
}

let toastTimer = null;
function toast(message, type = 'info') {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.className = 'toast';
  }, 2600);
}

/* ---------------------------------------------------------------------------
   §7 流式输出模拟器
   真后端里，这一段会被替换成对 SSE / fetch ReadableStream 的读取
   --------------------------------------------------------------------------- */
function streamText({ fullText, onChunk, onDone }) {
  let index = 0;
  let stopped = false;
  let timer = null;

  const step = () => {
    if (stopped) return;
    // 每次吐 1~3 个字符，看起来像真的在逐字生成
    const chunkSize = 1 + Math.floor(Math.random() * 3);
    index = Math.min(index + chunkSize, fullText.length);
    onChunk(fullText.slice(0, index));
    if (index >= fullText.length) {
      onDone();
      return;
    }
    timer = setTimeout(step, 18 + Math.random() * 26);
  };

  timer = setTimeout(step, 260); // 首次延迟，模拟"思考中"

  return () => {
    stopped = true;
    clearTimeout(timer);
    onChunk(fullText.slice(0, index)); // 保留已生成的部分
    onDone();
  };
}

/* ---------------------------------------------------------------------------
   §8 总渲染 + 事件绑定 + 启动
   --------------------------------------------------------------------------- */

/** 总渲染：根据当前页面决定画哪一块 */
function render() {
  document.getElementById('app').dataset.page = ui.page;

  // 顶栏按钮状态
  document.querySelectorAll('[data-nav]').forEach((button) => {
    button.classList.toggle('active', button.dataset.nav === ui.page);
  });

  renderSidebar();
  renderChat();
  renderSettings();
  renderConfirmDialog();

  // 发送 / 停止按钮的切换
  const sendBtn = document.getElementById('btn-send');
  const stopBtn = document.getElementById('btn-stop');
  sendBtn.hidden = ui.isStreaming;
  stopBtn.hidden = !ui.isStreaming;

  // 输入框在流式输出时禁用
  document.getElementById('composer-input').disabled = ui.isStreaming;
}

/** 输入框高度自适应 */
function autoResizeInput() {
  const input = document.getElementById('composer-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

/** HTML 属性转义（用于 value="..." 这类场景） */
function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 绑定所有静态事件 */
function bindEvents() {
  // 顶栏导航
  document.querySelectorAll('[data-nav]').forEach((button) => {
    button.addEventListener('click', () => {
      if (ui.isStreaming) {
        toast('正在生成回复，请先停止', 'info');
        return;
      }
      ui.page = button.dataset.nav;
      render();
    });
  });

  // 新建会话
  document.querySelectorAll('[data-action="new-conversation"]').forEach((button) => {
    button.addEventListener('click', () => {
      if (ui.isStreaming) {
        toast('正在生成回复，请先停止', 'info');
        return;
      }
      API.createConversation();
      ui.page = 'chat';
      refresh();
      document.getElementById('composer-input').focus();
    });
  });

  // 发送 / 停止
  document.getElementById('btn-send').addEventListener('click', handleSend);
  document.getElementById('btn-stop').addEventListener('click', handleStop);

  // 输入框：回车发送，Shift+回车换行
  const input = document.getElementById('composer-input');
  input.addEventListener('input', autoResizeInput);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      handleSend();
    }
  });

  // 消息区里的「新建会话」按钮（空状态时出现）
  document.getElementById('messages').addEventListener('click', (event) => {
    if (event.target.closest('[data-action="new-conversation"]')) {
      API.createConversation();
      refresh();
    }
  });

  // 设置页：保存
  document.getElementById('btn-save-config').addEventListener('click', () => {
    API.saveConfig({
      apiUrl: document.getElementById('cfg-api-url').value,
      apiKey: document.getElementById('cfg-api-key').value,
      modelName: document.getElementById('cfg-model-name').value,
    });
    refresh();
    toast('模型配置已保存', 'success');
  });

  // 设置页：测试连接
  document.getElementById('btn-test-connection').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const resultNode = document.getElementById('test-result');
    const config = {
      apiUrl: document.getElementById('cfg-api-url').value,
      apiKey: document.getElementById('cfg-api-key').value,
      modelName: document.getElementById('cfg-model-name').value,
    };

    button.disabled = true;
    button.textContent = '测试中…';
    resultNode.className = 'test-result loading';
    resultNode.textContent = '正在连接（模拟）…';

    const result = await API.testConnection(config);

    button.disabled = false;
    button.textContent = '测试连接';
    resultNode.className = `test-result ${result.ok ? 'ok' : 'fail'}`;
    resultNode.textContent = result.message;
  });

  // 设置页：保存人格
  document.getElementById('btn-save-persona').addEventListener('click', () => {
    API.savePersona({
      assistantName: document.getElementById('cfg-assistant-name').value,
      userName: document.getElementById('cfg-user-name').value,
      systemPrompt: document.getElementById('cfg-system-prompt').value,
    });
    refresh();
    toast('人格配置已保存', 'success');
  });

  // 设置页：重置全部数据
  document.getElementById('btn-reset-data').addEventListener('click', () => {
    ui.pendingReset = true;
    renderResetDialog();
  });

  // 删除确认弹窗
  document.getElementById('confirm-cancel').addEventListener('click', () => {
    ui.pendingDeleteId = null;
    render();
  });
  document.getElementById('confirm-delete').addEventListener('click', () => {
    const id = ui.pendingDeleteId;
    ui.pendingDeleteId = null;
    if (id) {
      API.deleteConversation(id);
      refresh();
      toast('会话已删除', 'success');
    }
  });

  // 重置确认弹窗
  document.getElementById('reset-cancel').addEventListener('click', () => {
    ui.pendingReset = false;
    document.getElementById('reset-dialog').hidden = true;
  });
  document.getElementById('reset-delete').addEventListener('click', () => {
    ui.pendingReset = false;
    document.getElementById('reset-dialog').hidden = true;
    API.resetAll();
    refresh();
    toast('本地数据已重置', 'success');
  });

  // 主题切换
  document.getElementById('btn-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('desktop-ai-assistant-theme', next);
  });

  // API Key 显隐
  document.getElementById('btn-toggle-key').addEventListener('click', () => {
    const keyInput = document.getElementById('cfg-api-key');
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
  });
}

function renderResetDialog() {
  document.getElementById('reset-dialog').hidden = !ui.pendingReset;
}

// 启动
document.addEventListener('DOMContentLoaded', () => {
  // 恢复上次的主题
  const savedTheme = localStorage.getItem('desktop-ai-assistant-theme');
  document.documentElement.dataset.theme = savedTheme === 'dark' ? 'dark' : 'light';

  bindEvents();
  render();
  autoResizeInput();
});
