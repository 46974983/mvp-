import { useCallback, useEffect, useState } from 'react';
import { FileText, Folder, FolderOpen, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardActions,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PLATFORM_CAPABILITY_SPECS, useSettingsStore } from '@/features';
import type { FileContent, FileEntry } from '@/features';

/** 把字节数说成人话 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 本地文件访问
 * ----------------------------------------------------------------------------
 * 这是全项目权限最重的一项，所以界面要把**三件事都摆出来**：
 *
 * 1. **授权了什么** —— 精确到路径。用户不该猜「它到底能看哪儿」。
 * 2. **分两步走**：先选/填目录，再点「授权读取」。中间那一步是给用户
 *    看清楚「将要授权哪个目录」的机会，而不是点一下就生效。
 * 3. **它读了什么** —— 最近读取列表。这一条最容易被忽略，但它才是
 *    让授权变得可放心的东西：有疑问时能立刻回头看。
 *
 * 撤销之后立刻读不到任何文件，读取记录也一并清掉。
 */
export function FileAccessSettings() {
  const capabilities = useSettingsStore((state) => state.platformCapabilities);
  const loaded = useSettingsStore((state) => state.loaded);
  const directory = useSettingsStore((state) => state.fileAccessDirectory);
  const available = useSettingsStore((state) => state.fileAccessAvailable);
  const recentReads = useSettingsStore((state) => state.recentReads);
  const pickDirectory = useSettingsStore((state) => state.pickDirectory);
  const authorizeDirectory = useSettingsStore((state) => state.authorizeDirectory);
  const revokeDirectory = useSettingsStore((state) => state.revokeDirectory);
  const readFile = useSettingsStore((state) => state.readFile);
  const listAuthorizedDirectory = useSettingsStore((state) => state.listAuthorizedDirectory);

  const [pendingPath, setPendingPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [currentDir, setCurrentDir] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [preview, setPreview] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const supported = capabilities.includes('file-read');
  const spec = PLATFORM_CAPABILITY_SPECS['file-read'];

  const browse = useCallback(async (relativeDir: string) => {
    const list = await listAuthorizedDirectory(relativeDir);
    setEntries(list);
    setCurrentDir(relativeDir);
  }, [listAuthorizedDirectory]);

  // 授权之后自动列一层，让用户马上看到「读得到什么」，而不是只有一个路径
  useEffect(() => {
    if (!supported || !available) {
      setEntries([]);
      setPreview(null);
      return;
    }

    void (async () => {
      try {
        await browse('');
      } catch (cause) {
        setError(String(cause));
      }
    })();
  }, [supported, available, browse]);

  async function handlePick() {
    setBusy(true);
    setError(null);
    try {
      const picked = await pickDirectory();
      if (picked) setPendingPath(picked);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleAuthorize() {
    setBusy(true);
    setError(null);
    try {
      const result = await authorizeDirectory(pendingPath);
      if (result.ok) {
        toast.success(result.message);
        setPendingPath('');
      } else {
        setError(result.message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke() {
    setBusy(true);
    try {
      const result = await revokeDirectory();
      if (result.ok) toast.success(result.message);
      else setError(result.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleOpen(entry: FileEntry) {
    setError(null);
    if (entry.isDirectory) {
      try {
        await browse(entry.relativePath);
      } catch (cause) {
        setError(String(cause));
      }
      return;
    }

    try {
      setPreview(await readFile(entry.relativePath));
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>本地文件</CardTitle>
        <CardDescription>
          授权一个文件夹之后，你可以在设置页浏览、预览里面的文本文件，
          也可以在聊天中允许模型按需读取；只能读这一个文件夹，读不了别处。
        </CardDescription>
      </CardHeader>

      <CardContent>
        {!supported && (
          <div
            data-testid="file-access-unavailable"
            className="rounded-lg border border-border bg-muted/50 p-3.5 text-[12px] leading-relaxed text-muted-foreground"
          >
            {loaded
              ? '浏览器读不了本地文件 —— 网页只能拿到你主动拖进来的东西。桌面版本里这一项可用。'
              : '正在探测当前环境的平台能力…'}
          </div>
        )}

        {supported && (
          <div className="space-y-3">
            {/* 当前授权范围：精确到路径，不让用户猜它能看到哪儿 */}
            <div className="rounded-lg border border-border bg-muted/50 p-3">
              {directory.length === 0 ? (
                <p
                  data-testid="file-access-status"
                  data-authorized="false"
                  className="text-[12px] leading-relaxed text-muted-foreground"
                >
                  还没有授权任何文件夹。设置页当前不能读取本地文件。
                </p>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <ShieldCheck className="size-3" aria-hidden />
                    已授权的文件夹
                  </div>
                  <p
                    data-testid="file-access-status"
                    data-authorized="true"
                    className="mt-1 break-all font-mono text-[11px] leading-relaxed text-foreground/80"
                  >
                    {directory}
                  </p>
                  {!available && (
                    <p
                      data-testid="file-access-broken"
                      className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-warning"
                    >
                      <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                      这个文件夹现在打不开了，可能被删掉或改名了。重新授权一个吧。
                    </p>
                  )}
                </>
              )}
            </div>

            {/* 授权流程：先选/填，再明确点一下「授权」 */}
            <div className="space-y-1.5">
              <Label htmlFor="file-access-path">要授权的文件夹</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="pick-directory"
                  disabled={busy}
                  onClick={() => void handlePick()}
                >
                  <FolderOpen className="size-3.5" aria-hidden />
                  选择文件夹…
                </Button>
                <Input
                  id="file-access-path"
                  data-testid="directory-input"
                  className="h-8 min-w-[16rem] flex-1 font-mono text-[11px]"
                  placeholder="也可以直接粘贴一个绝对路径，例如 D:\笔记"
                  value={pendingPath}
                  onChange={(event) => setPendingPath(event.target.value)}
                />
                <Button
                  size="sm"
                  data-testid="authorize-directory"
                  disabled={busy || pendingPath.trim().length === 0}
                  onClick={() => void handleAuthorize()}
                >
                  授权读取
                </Button>
                {directory.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="revoke-directory"
                    disabled={busy}
                    onClick={() => void handleRevoke()}
                  >
                    撤销授权
                  </Button>
                )}
                {busy && (
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
                )}
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                选中之后还要点「授权读取」才生效 —— 中间这一步是给你看清楚授权范围的机会。
              </p>
            </div>

            {error && (
              <p
                role="alert"
                data-testid="file-access-error"
                className="text-[11px] leading-relaxed text-warning"
              >
                {error}
              </p>
            )}

            {/* 授权之后能读到什么 */}
            {directory.length > 0 && available && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Folder className="size-3" aria-hidden />
                  {currentDir.length === 0 ? '文件夹内容' : `文件夹内容 / ${currentDir}`}
                  {currentDir.length > 0 && (
                    <button
                      type="button"
                      data-testid="browse-parent"
                      className="underline underline-offset-2 hover:text-foreground"
                      onClick={() => {
                        const parent = currentDir.split('/').slice(0, -1).join('/');
                        void browse(parent);
                        setPreview(null);
                      }}
                    >
                      返回上一级
                    </button>
                  )}
                </div>

                {entries.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">这个文件夹里没有可显示的内容。</p>
                ) : (
                  <ul
                    data-testid="file-list"
                    className="max-h-52 divide-y divide-border overflow-y-auto rounded-lg border border-border"
                  >
                    {entries.map((entry) => (
                      <li key={entry.relativePath}>
                        <button
                          type="button"
                          data-testid="file-entry"
                          data-kind={entry.isDirectory ? 'directory' : 'file'}
                          data-path={entry.relativePath}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-accent"
                          onClick={() => void handleOpen(entry)}
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
                )}

                {preview && (
                  <div className="rounded-lg border border-border bg-muted/50 p-3">
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <FileText className="size-3" aria-hidden />
                      试读 {preview.relativePath}（{formatBytes(preview.bytes)}）
                    </div>
                    {preview.truncated && (
                      <p className="mt-1 text-[11px] leading-relaxed text-warning">
                        这个文件比较大，只读了开头一部分。
                      </p>
                    )}
                    <pre
                      data-testid="file-preview"
                      className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground/80"
                    >
                      {preview.content.slice(0, 800)}
                      {preview.content.length > 800 ? '\n…' : ''}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* 它读了什么 —— 这一条才是让授权变得可放心的东西 */}
            {recentReads.length > 0 && (
              <div className="rounded-lg border border-border bg-muted/50 p-3">
                <div className="text-[11px] text-muted-foreground">最近读取</div>
                <ul data-testid="recent-reads" className="mt-1 space-y-0.5">
                  {recentReads.slice(0, 5).map((read) => (
                    <li
                      key={`${read.relativePath}-${read.at}`}
                      className="flex items-center gap-2 text-[11px] leading-relaxed"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-foreground/80">
                        {read.relativePath}
                      </span>
                      <span className="shrink-0 text-muted-foreground">{formatBytes(read.bytes)}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  只记在内存里，重启就没有了 —— 阅读记录不该落到磁盘上长期留着。
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>

      <CardActions>
        <span className="text-[11px] leading-relaxed text-muted-foreground">
          {supported
            ? '当前仅用于设置页浏览、预览；助手拿不到授权目录之外的路径，文件夹里的符号链接也不会跟着走。'
            : spec.description}
        </span>
      </CardActions>
    </Card>
  );
}
