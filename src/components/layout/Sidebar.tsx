import { useEffect, useRef, useState } from 'react';
import { Check, Pencil, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { Conversation } from '@/types';
import { cn } from '@/lib/utils';
import { conversationPreview, formatListTime } from '@/lib/time';
import { Button } from '@/components/ui/button';
import { useChatStore, useConversationsStore, useSettingsStore } from '@/features';

interface SidebarProps {
  /** 删除动作交给上层统一弹确认框，避免每个列表项各带一个弹窗 */
  onRequestDelete: (conversation: Conversation) => void;
}

export function Sidebar({ onRequestDelete }: SidebarProps) {
  const conversations = useConversationsStore((state) => state.conversations);
  const activeId = useConversationsStore((state) => state.activeId);
  const messages = useConversationsStore((state) => state.messages);
  const select = useConversationsStore((state) => state.select);
  const createConversation = useConversationsStore((state) => state.createConversation);
  const renameConversation = useConversationsStore((state) => state.renameConversation);
  const conversationsLoaded = useConversationsStore((state) => state.loaded);
  const switchingConversation = useConversationsStore((state) => state.switchingConversation);
  const sending = useChatStore((state) => state.sending);
  const streaming = useChatStore((state) => state.streaming);
  const toolRequest = useChatStore((state) => state.toolRequest);
  const busy = sending || streaming || toolRequest !== null;
  const controlsDisabled = !conversationsLoaded || busy || switchingConversation;

  const driverName = useSettingsStore((state) => state.driverName);
  const credentialStorage = useSettingsStore((state) => state.credentialStorage);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editingId) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editingId]);

  function startRename(conversation: Conversation) {
    setEditingId(conversation.id);
    setDraft(conversation.title);
  }

  async function commitRename() {
    const id = editingId;
    if (!id || controlsDisabled) return;
    setEditingId(null);
    const current = conversations.find((item) => item.id === id);
    if (!current || current.title === draft.trim()) return;
    const result = await renameConversation(id, draft);
    if (result.ok) toast.success('会话已重命名');
    else toast.error(result.message);
  }

  async function handleSelect(id: string) {
    if (switchingConversation) return;
    if (toolRequest) {
      toast.info('请先处理模型的访问请求，再切换会话');
      return;
    }
    if (busy) {
      toast.info('正在发送或生成回复，请先停止再切换会话');
      return;
    }
    try {
      await select(id);
    } catch {
      toast.error('读取会话失败，请重试。');
    }
  }

  return (
    <aside
      data-testid="sidebar"
      className="flex w-[264px] shrink-0 flex-col border-r border-border bg-sidebar"
    >
      <div className="p-2.5">
        <Button
          variant="primary"
          className="w-full"
          data-testid="new-conversation"
          disabled={controlsDisabled}
          onClick={async () => {
            try {
              await createConversation();
              toast.success('已新建会话');
            } catch {
              toast.error('新建会话失败，请重试。');
            }
          }}
        >
          <Plus className="size-3.5" aria-hidden />
          新建会话
        </Button>
      </div>

      <div className="px-3.5 pb-1.5 text-[11px] tracking-wide text-muted-foreground">
        历史会话
      </div>

      <div data-testid="conversation-list" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {conversations.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs leading-relaxed text-muted-foreground">
            还没有会话
            <br />
            点上方「新建会话」开始
          </p>
        ) : (
          conversations.map((conversation) => {
            const isActive = conversation.id === activeId;
            const preview = isActive
              ? conversationPreview(messages.map((message) => message.content))
              : '（切换查看）';

            return (
              <div
                key={conversation.id}
                data-testid="conversation-item"
                data-conversation-id={conversation.id}
                data-active={isActive ? 'true' : 'false'}
                className={cn(
                  'group relative mb-0.5 cursor-pointer rounded-md px-2.5 py-2 transition-colors',
                  isActive ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60'
                )}
                onClick={() => void handleSelect(conversation.id)}
              >
                {editingId === conversation.id ? (
                  <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
                    <input
                      ref={inputRef}
                      data-testid="rename-input"
                      value={draft}
                      maxLength={40}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void commitRename();
                        if (event.key === 'Escape') setEditingId(null);
                      }}
                      className="h-6 min-w-0 flex-1 rounded border border-border bg-input px-1.5 text-[13px] outline-none focus-visible:border-primary"
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="确认"
                      data-testid="rename-confirm"
                      disabled={controlsDisabled}
                      onClick={() => void commitRename()}
                    >
                      <Check className="size-3.5" aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="取消"
                      onClick={() => setEditingId(null)}
                    >
                      <X className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-sidebar-foreground">
                        {conversation.title}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {preview}
                      </div>
                    </div>
                    <div
                      className="flex shrink-0 flex-col items-end gap-1"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <span className="text-[10px] text-muted-foreground">
                        {formatListTime(conversation.updatedAt)}
                      </span>
                      <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="重命名"
                          data-testid="rename-conversation"
                          disabled={controlsDisabled}
                          onClick={() => startRename(conversation)}
                        >
                          <Pencil className="size-3.5" aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="删除"
                          data-testid="delete-conversation"
                          className="hover:text-destructive"
                          disabled={controlsDisabled}
                          onClick={() => onRequestDelete(conversation)}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <footer className="border-t border-border px-3.5 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="size-3" aria-hidden />
          <span>数据只存在本机</span>
        </div>
        {/* 存储实现和 Key 去向都问服务层，不写死「阶段 X：浏览器本地存储」——
            桌面模式下那句话是错的 */}
        <div data-testid="sidebar-storage" className="mt-0.5">
          {driverName}
          {credentialStorage.kind === 'os-keychain'
            ? ' · Key 在系统凭据管理器'
            : ' · Key 仅存内存'}
        </div>
      </footer>
    </aside>
  );
}
