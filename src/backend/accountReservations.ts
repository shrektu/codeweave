export interface AccountReservations {
  reserve(accountId: string): () => void;
  has(accountId: string): boolean;
}

export function createAccountReservations(): AccountReservations {
  const counts = new Map<string, number>();
  return {
    reserve: (accountId) => {
      counts.set(accountId, (counts.get(accountId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        const remaining = (counts.get(accountId) ?? 0) - 1;
        if (remaining > 0) {
          counts.set(accountId, remaining);
        } else {
          counts.delete(accountId);
        }
      };
    },
    has: (accountId) => counts.has(accountId),
  };
}
