import { useCallback, useEffect, useState } from "react";

export const FEEDBACK_MS = 1600;

export const Feedback = {
  idle: "idle",
  done: "done",
  failed: "failed",
} as const;
export type Feedback = (typeof Feedback)[keyof typeof Feedback];

export function useActionFeedback(
  action: () => Promise<void>,
  failureMessage: string,
): { feedback: Feedback; run: () => void } {
  const [feedback, setFeedback] = useState<Feedback>(Feedback.idle);

  useEffect(() => {
    if (feedback === Feedback.idle) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setFeedback(Feedback.idle);
    }, FEEDBACK_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [feedback]);

  const run = useCallback((): void => {
    action()
      .then(() => {
        setFeedback(Feedback.done);
      })
      .catch((error: unknown) => {
        console.error(failureMessage, error);
        setFeedback(Feedback.failed);
      });
  }, [action, failureMessage]);

  return { feedback, run };
}
