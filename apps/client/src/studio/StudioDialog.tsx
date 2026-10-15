import * as Dialog from "@radix-ui/react-dialog";
import { useRef, type ReactNode } from "react";

/** Shared modal layer for prepared-project decisions and full workspace forms. */
export function StudioDialog({title, titleId, description, screen = false, onClose, children}: {
  title: string;
  titleId?: string;
  description: string;
  screen?: boolean;
  onClose(): void;
  children: ReactNode;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return <Dialog.Root open onOpenChange={open => {if (!open) onClose();}}>
    <Dialog.Portal>
      <Dialog.Overlay className="studio-modal-overlay" />
      <Dialog.Content
        role={screen ? "dialog" : "alertdialog"}
        {...(titleId ? {"aria-labelledby": titleId} : {})}
        className={screen ? "studio-fullscreen-screen" : "studio-decision-dialog"}
        onOpenAutoFocus={() => {
          returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          const opener = returnFocus.current;
          if (opener?.isConnected) opener.focus({preventScroll: true});
          else document.querySelector<HTMLButtonElement>('button[aria-label="File"]')?.focus();
        }}
        onEscapeKeyDown={event => event.stopPropagation()}
      >
        <Dialog.Title {...(titleId ? {id:titleId} : {})} className={screen ? "studio-sr-only" : undefined}>{title}</Dialog.Title>
        <Dialog.Description className={screen ? "studio-sr-only" : undefined}>{description}</Dialog.Description>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
