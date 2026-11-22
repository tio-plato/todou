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
 * No type-the-name confirmation of its own. That was written when the trash
 * (T-145) was the only caller and every action behind it was reversible;
 * deleting a comment (T-281) is not, and takes this same gate because the
 * reversible thing a reader almost always wants is `Hide`, which the wording
 * points at. A destructive action with no such alternative deserves more: its
 * caller puts the box to type into in `children`, holds the confirm button
 * with `confirmDisabled` until it matches, and checks the match again in the
 * box's own submit, which Enter reaches without the button. Deleting a
 * project does.
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
  confirmDisabled = false,
  onConfirm,
  container,
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
  /** Holds the confirm button for a caller's own gate, a typed name say. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  /** Mount point other than this page's body — a floating window's (T-530). */
  container?: HTMLElement;
  /** Block content below the description, which is a paragraph. */
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent container={container}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
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
            disabled={pending || confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
