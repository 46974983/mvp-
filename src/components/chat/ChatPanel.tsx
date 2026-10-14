import { AlertCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/features';
import { MessageList } from './MessageList';
import { Composer } from './Composer';

export function ChatPanel() {
  const error = useChatStore((state) => state.error);
  const clearError = useChatStore((state) => state.clearError);

  return (
    <main data-testid="chat-panel" className="flex min-w-0 flex-1 flex-col bg-background">
      {error && (
        <div
          role="alert"
          data-testid="chat-error"
          className="flex items-start gap-2 border-b border-border bg-destructive/10 px-6 py-2.5 text-[13px] text-foreground"
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
          <p className="min-w-0 flex-1">{error}</p>
          <Button variant="ghost" size="icon-sm" title="关闭" onClick={clearError}>
            <X className="size-3.5" aria-hidden />
          </Button>
        </div>
      )}

      <MessageList />
      <Composer />
    </main>
  );
}
