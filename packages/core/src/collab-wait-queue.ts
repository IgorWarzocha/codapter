import { randomUUID } from "node:crypto";
import type {
  CollabAgent,
  CollabAgentStatus,
  CollabConfig,
  CollabWaitResponse,
} from "./collab-types.js";

interface CollabWaiter {
  ids: readonly string[];
  resolve(response: CollabWaitResponse): void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class CollabWaitQueue {
  private readonly waiters = new Map<string, CollabWaiter>();
  constructor(
    private readonly getAgent: (agentId: string) => CollabAgent | undefined,
    private readonly config: Pick<
      CollabConfig,
      "defaultTimeoutMs" | "minTimeoutMs" | "maxTimeoutMs"
    >
  ) {}
  wait(ids: readonly string[], timeoutMs?: number): Promise<CollabWaitResponse> {
    const status = this.collectFinalStatuses(ids);
    if (Object.keys(status).length > 0)
      return Promise.resolve({
        status,
        messages: this.collectFinalMessages(ids),
        timed_out: false,
      });
    return new Promise((resolve) => {
      const waiterId = randomUUID();
      const waiter: CollabWaiter = {
        ids: [...ids],
        timer: null,
        resolve: (result) => {
          if (waiter.timer) clearTimeout(waiter.timer);
          this.waiters.delete(waiterId);
          resolve(result);
        },
      };
      waiter.timer = setTimeout(() => {
        waiter.resolve({
          status: this.collectFinalStatuses(ids),
          messages: this.collectFinalMessages(ids),
          timed_out: true,
        });
      }, this.normalizeTimeout(timeoutMs));
      this.waiters.set(waiterId, waiter);
    });
  }
  dispose(): void {
    for (const waiter of this.waiters.values())
      waiter.resolve({ status: {}, messages: {}, timed_out: true });
    this.waiters.clear();
  }
  settled(agentId: string): void {
    const agent = this.getAgent(agentId);
    if (!agent || !this.isFinalStatus(agent.status)) {
      return;
    }

    for (const waiter of this.waiters.values()) {
      if (!waiter.ids.includes(agentId)) {
        continue;
      }
      waiter.resolve({
        status: this.collectFinalStatuses(waiter.ids),
        messages: this.collectFinalMessages(waiter.ids),
        timed_out: false,
      });
    }
  }
  private isFinalStatus(status: CollabAgentStatus): boolean {
    return (
      status === "completed" ||
      status === "errored" ||
      status === "shutdown" ||
      status === "notFound"
    );
  }
  private normalizeTimeout(timeoutMs: number | undefined): number {
    const requested = timeoutMs ?? this.config.defaultTimeoutMs;
    return Math.min(this.config.maxTimeoutMs, Math.max(this.config.minTimeoutMs, requested));
  }
  private collectFinalStatuses(agentIds: readonly string[]): Record<string, CollabAgentStatus> {
    const states: Record<string, CollabAgentStatus> = {};
    for (const agentId of agentIds) {
      const agent = this.getAgent(agentId);
      if (!agent) {
        states[agentId] = "notFound";
        continue;
      }
      if (this.isFinalStatus(agent.status)) {
        states[agentId] = agent.status;
      }
    }
    return states;
  }
  private collectFinalMessages(agentIds: readonly string[]): Record<string, string | null> {
    const messages: Record<string, string | null> = {};
    for (const agentId of agentIds) {
      const agent = this.getAgent(agentId);
      if (!agent) {
        messages[agentId] = null;
        continue;
      }
      if (this.isFinalStatus(agent.status)) {
        messages[agentId] = agent.completionMessage;
      }
    }
    return messages;
  }
}
