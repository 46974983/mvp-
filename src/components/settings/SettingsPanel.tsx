import { ModelConfigForm } from './ModelConfigForm';
import { PersonaForm } from './PersonaForm';
import { TraySettings } from './TraySettings';
import { NotificationSettings } from './NotificationSettings';
import { AutostartSettings } from './AutostartSettings';
import { ShortcutSettings } from './ShortcutSettings';
import { FileAccessSettings } from './FileAccessSettings';
import { ScreenshotSettings } from './ScreenshotSettings';
import { AutomationSettings } from './AutomationSettings';
import { DataPanel } from './DataPanel';

interface SettingsPanelProps {
  onRequestReset: () => void;
}

export function SettingsPanel({ onRequestReset }: SettingsPanelProps) {
  return (
    <main data-testid="settings-panel" className="min-h-0 flex-1 overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-6">
        <div>
          <h1 className="text-base font-semibold text-foreground">设置</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            模型配置、人格配置、托盘与窗口、通知、开机自启、全局快捷键、本地文件、截屏、自动化、数据去向。改完即生效，不需要重启。
          </p>
        </div>

        <ModelConfigForm />
        <ScreenshotSettings />
        <AutomationSettings />
        <PersonaForm />
        <TraySettings />
        <NotificationSettings />
        <AutostartSettings />
        <ShortcutSettings />
        <FileAccessSettings />
        <DataPanel onRequestReset={onRequestReset} />
      </div>
    </main>
  );
}
