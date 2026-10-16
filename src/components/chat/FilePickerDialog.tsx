import { useCallback, useEffect, useState } from 'react';
import { FileText, Folder, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useSettingsStore } from '@/features';
import type { FileEntry } from '@/features';

/** 把字节数说成人话 */
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface FilePickerDialogProps {
  open: boolean;
  onPick: (relativePath: string) => void;
  onClose: () => void;
}

/**
 * 从授权目录里挑一个文件
 * ----------------------------------------------------------------------------
 * 只能在这个已经授权过的目录里走 —— 这里**没有**任何输入路径的地方，
 * 用户能做的选择就是「在授权范围里点哪个文件」。
 * 路径检查全在 Rust 侧，这个界面只是把它呈现出来。
 */
export function FilePickerDialog({ open, onPick, onClose }: FilePickerDialogProps) {
  const directory = useSettingsStore((state) => state.fileAccessDirectory);
  const listAuthorizedDirectory = useSettingsStore((state) => state.listAuthorizedDirectory);

  const [currentDir, setCurrentDir] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback(
    async (relativeDir: string) => {
      setLoading(true);
      setError(null);
      try {
        setEntries(await listAuthorizedDirectory(relativeDir));
        setCurrentDir(relativeDir);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [listAuthorizedDirectory]
  );

  // 每次打开都从根目录重新开始 —— 记住上次的位置反而容易让人搞不清自己在哪
  useEffect(() => {
    if (open) void browse('');
  }, [open, browse]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent data-testid="file-picker">
        <DialogTitle>选一个文件加进对话</DialogTitle>
        <DialogDescription>
          只能选已授权目录里的文件。选中的文件内容会随这条消息一起发给模型。
        </DialogDescription>

        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Folder className="size-3" aria-hidden />
            <span className="truncate font-mono">{directory}</span>
            {currentDir.length > 0 && (
              <>
                <span aria-hidden>/</span>
                <span className="truncate">{currentDir}</span>
                <button
                  type="button"
                  data-testid="picker-parent"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() => void browse(currentDir.split('/').slice(0, -1).join('/'))}
                >
                  返回上一级
                </button>
              </>
            )}
            {loading && <Loader2 className="size-3 animate-spin" aria-hidden />}
          </div>

          {error && (
            <p role="alert" data-testid="picker-error" className="text-[11px] text-warning">
              {error}
            </p>
          )}

          {!loading && entries.length === 0 && !error && (
            <p className="py-4 text-center text-[11px] text-muted-foreground">
              这个文件夹里没有可显示的内容。
            </p>
          )}

          <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {entries.map((entry) => (
              <li key={entry.relativePath}>
                <button
                  type="button"
                  data-testid="picker-entry"
                  data-kind={entry.isDirectory ? 'directory' : 'file'}
                  data-path={entry.relativePath}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-accent"
                  onClick={() => {
                    if (entry.isDirectory) void browse(entry.relativePath);
                    else onPick(entry.relativePath);
                  }}
                >
                  {entry.isDirectory ? (
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 truncate text-foreground">{entry.name}</span>
                  {!entry.isDirectory && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {formatBytes(entry.size)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-5 flex justify-end">
          <Button variant="outline" data-testid="picker-cancel" onClick={onClose}>
            取消
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
