export type DecisionStatus = "proposed" | "confirmed" | "active" | "superseded" | "revoked";

const TRANSITIONS: Record<DecisionStatus, DecisionStatus[]> = {
  proposed: ["confirmed", "active", "superseded", "revoked"],
  confirmed: ["active", "superseded", "revoked"],
  active: ["superseded", "revoked"],
  superseded: [],
  revoked: [],
};

export function canTransition(from: DecisionStatus, to: DecisionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: DecisionStatus, to: DecisionStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid decision transition: ${from} -> ${to}`);
  }
}

export type GoalStatus = "active" | "completed" | "abandoned";
