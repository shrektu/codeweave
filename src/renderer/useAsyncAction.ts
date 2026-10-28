import { useState } from "react";

import { errorMessage } from "./errorMessage";

export interface AsyncAction {
  pending: boolean;
  error: string | null;
  run(action: () => Promise<unknown>): Promise<boolean>;
  setError(message: string | null): void;
}

export function useAsyncAction(): AsyncAction {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setPending(false);
    }
  };

  return { pending, error, run, setError };
}
