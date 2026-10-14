import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { Conversation } from '@/types';
import { Titlebar, type AppPage } from '@/components/layout/Titlebar';
import { Sidebar } from '@/components/layout/Sidebar';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { AppToaster } from '@/components/feedback/AppToaster';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import { useChatStore, useConversationsStore, useSettingsStore } from '@/features';

export default function App() {
  const [page, setPage] = useState<AppPage>('chat');
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);
  const [pendingReset, setPendingReset] = useState(false);
  const [booted, setBooted] = useState(false);

  const loadConversations = useConversationsStore((state) => state.load);
  const deleteConversation = useConversationsStore((state) => state.deleteConversation);
  const activeId = useConversationsStore((state) => state.activeId);
  const activeMessageCount = useConversationsStore((state) => state.messages.length);

  const loadSettings = useSettingsStore((state) => state.load);
  const resetAll = useSettingsStore((state) => state.resetAll);

  const streaming = useChatStore((state) => state.streaming);

  // 启动：把配置和会话一起拉起来。两者互不依赖，并行拿。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await Promise.all([loadSettings(), loadConversations()]);
      } finally {
        if (!cancelled) setBooted(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadSettings, loadConversations]);

  async function confirmDelete() {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    await deleteConversation(target.id);
    toast.success('会话已删除');
  }

  async function confirmReset() {
    setPendingReset(false);
    await resetAll();
    await loadConversations();
    toast.success('本地数据已重置');
  }

  const deleteDescription = (() => {
    if (!pendingDelete) return null;
    const isActive = pendingDelete.id === activeId;
    return (
      <>
        确定要删除会话「<strong>{pendingDelete.title}</strong>」吗？
        <br />
        {isActive
          ? `该会话的 ${activeMessageCount} 条消息将一并删除，`
          : '该会话的全部消息将一并删除，'}
        且无法恢复。
      </>
    );
  })();

  return (
    <div data-page={page} className="grid h-full grid-rows-[48px_1fr]">
      <Titlebar
        page={page}
        onNavigate={setPage}
        navigationLocked={streaming}
        onNavigateBlocked={() => toast.info('正在生成回复，请先停止再切换页面')}
      />

      <div className="flex min-h-0">
        {page === 'chat' ? (
          <>
            <Sidebar onRequestDelete={setPendingDelete} />
            {booted ? (
              <ChatPanel />
            ) : (
              <main className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
                正在读取本地数据…
              </main>
            )}
          </>
        ) : (
          <SettingsPanel onRequestReset={() => setPendingReset(true)} />
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title="删除会话"
        description={deleteDescription}
        confirmText="删除"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={pendingReset}
        danger
        title="重置本地数据"
        description="这会清空全部会话记录、消息和人格配置，且无法恢复。确定继续吗？"
        confirmText="确定重置"
        onConfirm={() => void confirmReset()}
        onCancel={() => setPendingReset(false)}
      />

      <AppToaster />
    </div>
  );
}
