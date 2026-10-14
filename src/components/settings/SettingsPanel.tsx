import { ModelConfigForm } from './ModelConfigForm';
import { PersonaForm } from './PersonaForm';
import { TraySettings } from './TraySettings';
import { NotificationSettings } from './NotificationSettings';
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
            模型配置、人格配置、托盘与窗口、通知、数据去向。改完即生效，不需要重启。
          </p>
        </div>

        <ModelConfigForm />
        <PersonaForm />
        <TraySettings />
        <NotificationSettings />
        <DataPanel onRequestReset={onRequestReset} />
      </div>
    </main>
  );
}
