"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, api } from "@/lib/api";
import type { Session } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  onUnlocked: (key: string, session: Session) => void;
}

export function KeyDialog({ open, onClose, onUnlocked }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setValue("");
      setError(null);
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const key = value.trim();
    if (!key) return setError("Enter a key.");
    setBusy(true);
    setError(null);
    try {
      const session = await api<Session>("/api/v1/session", { key });
      if (!session.role) setError("That key was not recognised.");
      else onUnlocked(key, session);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "That key was not recognised."
          : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="key-dialog" aria-labelledby="key-title" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <h2 id="key-title" className="card-title">
          Unlock
        </h2>
        <p className="card-sub">
          The control key runs matches. The team key manages webhooks. Keys stay in this browser tab
          only.
        </p>
        <label className="field">
          <span>Access key</span>
          <input
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Checking" : "Unlock"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
