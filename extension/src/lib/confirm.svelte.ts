// Shared confirmation dialog for the side panel. Replaces native
// window.confirm (a silent no-op inside Chrome side panels) AND the various
// inline confirm bars with ONE modal. Call `confirmDialog(opts)` and await the
// boolean; the modal is rendered once at the App root by ConfirmModal.svelte.

export type ConfirmOpts = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button for destructive actions (delete / end day). */
  danger?: boolean;
};

type Pending = ConfirmOpts & { resolve: (ok: boolean) => void };

class ConfirmService {
  pending = $state<Pending | null>(null);

  confirm(opts: ConfirmOpts): Promise<boolean> {
    // Never stack — if one is somehow open, resolve it false first.
    this.pending?.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.pending = { ...opts, resolve };
    });
  }

  answer(ok: boolean): void {
    const p = this.pending;
    this.pending = null;
    p?.resolve(ok);
  }
}

export const confirmService = new ConfirmService();

/** Await a yes/no confirmation rendered as a modal inside the side panel. */
export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return confirmService.confirm(opts);
}
