import type { AgentEvent } from "../../domain/events";

export type Listener = (event: AgentEvent) => void;

export class ListenerSet {
  private readonly listeners = new Set<Listener>();
  private readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  add(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error(`agy event listener failed: ${this.label}`, error);
      }
    }
  }
}
