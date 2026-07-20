import type {
  ObservableActor,
  ObservableAgentEvent,
  ObservableSource,
  RiskClass,
} from './contracts';

export interface ObservableStateSnapshot {
  totalEvents: number;
  lastEventAt?: string;
  lastEventId?: string;
  countsByActor: Partial<Record<ObservableActor, number>>;
  countsBySource: Partial<Record<ObservableSource, number>>;
  countsByRisk: Partial<Record<RiskClass, number>>;
  lastEventBySource: Partial<Record<ObservableSource, ObservableAgentEvent>>;
  recentEventIds: string[];
}

export interface ObservableStateProjector {
  apply(event: ObservableAgentEvent): void;
  snapshot(): ObservableStateSnapshot;
}

export function createObservableStateProjector(maxRecentEvents = 100): ObservableStateProjector {
  if (!Number.isInteger(maxRecentEvents) || maxRecentEvents <= 0) {
    throw new Error('maxRecentEvents must be a positive integer');
  }

  let totalEvents = 0;
  let lastEventAt: string | undefined;
  let lastEventId: string | undefined;
  const countsByActor: Partial<Record<ObservableActor, number>> = {};
  const countsBySource: Partial<Record<ObservableSource, number>> = {};
  const countsByRisk: Partial<Record<RiskClass, number>> = {};
  const lastEventBySource: Partial<Record<ObservableSource, ObservableAgentEvent>> = {};
  const recentEventIds: string[] = [];

  return {
    apply(event) {
      totalEvents += 1;
      lastEventAt = event.timestamp;
      lastEventId = event.eventId;
      countsByActor[event.actor] = (countsByActor[event.actor] ?? 0) + 1;
      countsBySource[event.source] = (countsBySource[event.source] ?? 0) + 1;
      countsByRisk[event.riskClass] = (countsByRisk[event.riskClass] ?? 0) + 1;
      lastEventBySource[event.source] = structuredClone(event);
      recentEventIds.push(event.eventId);
      if (recentEventIds.length > maxRecentEvents) recentEventIds.shift();
    },
    snapshot() {
      return {
        totalEvents,
        lastEventAt,
        lastEventId,
        countsByActor: { ...countsByActor },
        countsBySource: { ...countsBySource },
        countsByRisk: { ...countsByRisk },
        lastEventBySource: structuredClone(lastEventBySource),
        recentEventIds: [...recentEventIds],
      };
    },
  };
}
