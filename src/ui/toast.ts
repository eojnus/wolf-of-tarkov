/** 轻量提示条。只用于反馈命令结果，不承载业务状态。 */

export type ToastKind = 'info' | 'success' | 'error';

export class ToastHost {
  constructor(private readonly root: HTMLElement) {}

  show(kind: ToastKind, message: string): void {
    const toast = document.createElement('div');
    toast.className = `toast ${kind}`;
    toast.textContent = message;
    this.root.appendChild(toast);

    while (this.root.childElementCount > 3) {
      this.root.removeChild(this.root.firstElementChild as Element);
    }

    window.setTimeout(() => {
      toast.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(6px)';
      window.setTimeout(() => toast.remove(), 260);
    }, kind === 'error' ? 3600 : 2400);
  }
}
