import type {
  MigrationConfirmationPresenter,
  MigrationConfirmationRequest,
} from './types';

export class MigrationConfirmationAdapter {
  private pending: ((confirmed: boolean) => void) | null = null;

  constructor(
    private readonly presenter: MigrationConfirmationPresenter,
  ) {}

  request(request: MigrationConfirmationRequest): Promise<boolean> {
    this.cancelPending();
    return new Promise<boolean>((resolve) => {
      this.pending = (confirmed) => {
        this.pending = null;
        resolve(confirmed);
      };
      this.presenter.show(request);
    });
  }

  complete(confirmed: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.presenter.clear();
    pending(confirmed);
  }

  cancelPending(): void {
    this.complete(false);
  }
}
