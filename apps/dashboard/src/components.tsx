import { useState, useCallback, useRef, type ReactNode } from "react";

export function Panel({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="panel">
      {(title || actions) && (
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          {title && <div className="panel-title" style={{ margin: 0 }}>{title}</div>}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "ok" || status === "success" || status === "connected"
      ? "badge ok"
      : status === "error" || status === "failed"
        ? "badge err"
        : status === "untested" || status === "unknown" || status === "pending"
          ? "badge unknown"
          : status === "awaiting_approval"
            ? "badge warn"
            : "badge info";
  return <span className={cls}>{status}</span>;
}

export function Spinner() {
  return <span className="spinner" aria-label="loading" />;
}

export function useToastState() {
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const show = useCallback((message: string, opts?: { error?: boolean }) => {
    setToast({ message, error: opts?.error });
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setToast(null), 4200);
  }, []);
  const node = toast ? <div className={`toast${toast.error ? " error" : ""}`}>{toast.message}</div> : null;
  return { show, node };
}

export function EmptyState({ title, sub, action }: { title: string; sub: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">◇</div>
      <div className="empty-title">{title}</div>
      <div className="empty-sub">{sub}</div>
      {action}
    </div>
  );
}

export function ConfirmButton({ label, confirmLabel, onConfirm, className }: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      className={className ?? "btn btn-small btn-danger"}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
          window.setTimeout(() => setArmed(false), 3000);
        }
      }}
    >
      {armed ? confirmLabel ?? "Confirm?" : label}
    </button>
  );
}
