import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

/**
 * 确认弹窗（组合件）
 * ----------------------------------------------------------------------------
 * 产品设计第 5 节：「删除会话前进行确认」。这里是那条要求落地的地方，
 * 全应用所有破坏性操作都走这一个组件，避免「有的地方确认、有的地方直接删」。
 *
 * 两个刻意的设定：
 *   1. 危险操作的确认按钮用 danger 变体（红），和普通确认在视觉上区分开；
 *   2. 取消按钮永远排在左边、确认按钮在右边 —— 保持一致，用户才不会误点。
 */

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmText?: string;
  cancelText?: string;
  confirmDisabled?: boolean;
  /** 破坏性操作传 true，确认按钮转为危险样式 */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = '确定',
  cancelText = '取消',
  confirmDisabled = false,
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent data-testid="confirm-dialog">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" data-testid="confirm-cancel" onClick={onCancel}>
            {cancelText}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            data-testid="confirm-accept"
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmText}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
