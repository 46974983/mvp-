import { useCallback, useEffect, useRef, useState } from 'react';
import { SendHorizontal, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useChatStore, useSettingsStore } from '@/features';

const MAX_TEXTAREA_HEIGHT_PX = 180;

export function Composer() {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const streaming = useChatStore((state) => state.streaming);
  const send = useChatStore((state) => state.send);
  const stop = useChatStore((state) => state.stop);

  const modelName = useSettingsStore((state) => state.modelConfig.modelName);
  const performsNetworkRequest = useSettingsStore((state) => state.performsNetworkRequest);

  const resize = useCallback(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, []);

  useEffect(resize, [text, resize]);

  async function handleSend() {
    const value = text.trim();
    if (value.length === 0 || streaming) return;
    setText('');
    await send(value);
    textareaRef.current?.focus();
  }

  return (
    <div className="shrink-0 border-t border-border bg-card px-6 py-3">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex items-end gap-2 rounded-xl border border-border bg-input p-2 transition-colors focus-within:border-primary">
          <textarea
            ref={textareaRef}
            data-testid="composer-input"
            rows={1}
            value={text}
            disabled={streaming}
            placeholder="输入消息，回车发送，Shift + 回车换行"
            aria-label="消息输入框"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // isComposing：中文输入法选字时的回车不能当发送
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void handleSend();
              }
            }}
            className="max-h-[180px] min-h-[30px] flex-1 resize-none bg-transparent px-1.5 py-1 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-60"
          />

          {streaming ? (
            <Button
              variant="outline"
              data-testid="stop-button"
              title="停止生成，已生成的部分会保留"
              onClick={stop}
            >
              <Square className="size-3.5" aria-hidden />
              停止
            </Button>
          ) : (
            <Button
              variant="primary"
              data-testid="send-button"
              disabled={text.trim().length === 0}
              onClick={() => void handleSend()}
            >
              <SendHorizontal className="size-3.5" aria-hidden />
              发送
            </Button>
          )}
        </div>

        {/* 这行提示必须如实：桌面版会真的发请求，浏览器版不会。
            判断依据来自服务层的 performsNetworkRequest，不是写死的文案。 */}
        <p data-testid="composer-hint" className="mt-1.5 px-1 text-[11px] text-muted-foreground">
          {performsNetworkRequest
            ? `回答由桌面端（Rust）发起真实请求，模型「${modelName}」。API Key 读取自系统凭据管理器。`
            : `浏览器模式：回答来自本地模拟，不联网、不调用真实模型。「${modelName}」只是记录下来的配置项。桌面版会接通真实请求。`}
        </p>
      </div>
    </div>
  );
}
