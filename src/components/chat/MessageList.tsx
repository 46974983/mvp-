import { useEffect, useRef } from 'react';
import { MessageSquarePlus, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useChatStore, useConversationsStore, useSettingsStore } from '@/features';
import { MessageBubble } from './MessageBubble';

/** 距离底部多少像素以内算「还贴着底」 */
const STICK_THRESHOLD_PX = 60;

export function MessageList() {
  const conversations = useConversationsStore((state) => state.conversations);
  const activeId = useConversationsStore((state) => state.activeId);
  const messages = useConversationsStore((state) => state.messages);
  const loaded = useConversationsStore((state) => state.loaded);
  const createConversation = useConversationsStore((state) => state.createConversation);

  const persona = useSettingsStore((state) => state.settings.persona);

  const streamingMessageId = useChatStore((state) => state.streamingMessageId);
  const streamingText = useChatStore((state) => state.streamingText);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const activeConversation = conversations.find((item) => item.id === activeId) ?? null;

  function handleScroll() {
    const node = scrollRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickToBottom.current = distance <= STICK_THRESHOLD_PX;
  }

  // 消息变化或流式追加时贴底。用户手动往上翻时不打扰他。
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !stickToBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, streamingText, activeId]);

  if (loaded && !activeConversation) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <MessageSquarePlus className="size-8 text-muted-foreground/60" aria-hidden />
        <p className="text-[13px] text-muted-foreground">还没有选中会话</p>
        <Button variant="primary" onClick={() => void createConversation()}>
          新建一个会话
        </Button>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      data-testid="message-list"
      className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
    >
      {activeConversation && messages.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
          <Sparkles className="size-6 text-muted-foreground/60" aria-hidden />
          <p className="text-[13px] text-foreground">这是「{activeConversation.title}」的第一条消息</p>
          <p className="text-xs text-muted-foreground">在下面输入点什么，试试流式输出的手感</p>
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          {messages.map((message) => {
            const isStreamingMessage = message.id === streamingMessageId;
            return (
              <MessageBubble
                key={message.id}
                message={message}
                content={isStreamingMessage ? streamingText : message.content}
                streaming={isStreamingMessage}
                avatarLabel={
                  message.role === 'user'
                    ? (persona.userName || '我').slice(0, 1)
                    : (persona.assistantName || 'AI').slice(0, 1)
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
