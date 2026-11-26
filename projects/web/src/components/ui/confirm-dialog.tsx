import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * "Are you sure?" over the shared Dialog primitives. Controlled, because the
 * action that opens it usually lives in a menu that closes on select — there
 * is no trigger element left to own the open state by the time the dialog
 * appears.
 *
 * No type-the-name confirmation. That was written when the trash (T-145) was
 * the only caller and every action behind it was reversible; deleting a
 * comment (T-281) is not, and takes this same gate because the reversible
 * thing a reader almost always wants is `Hide`, which the wording points at.
 * A destructive action with no such alternative would deserve more than this.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  pending = false,
  onConfirm,
  container,
  onCloseAutoFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  /** Mount point other than this page's body — a floating window's (T-530). */
  container?: HTMLElement;
  /**
   * As it closes. With no trigger to hand focus back to, it leaves focus on
   * the page's body unless this prevents that and moves it.
   */
  onCloseAutoFocus?: (event: Event) => void;
  /** Block content below the description, which is a paragraph. */
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid-cols-1"
        container={container}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader className="min-w-0 pr-7">
          <DialogTitle className="min-w-0 leading-normal wrap-anywhere">
            {title}
          </DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={pending}>
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
