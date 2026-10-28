/**
 * Getting-started steps, ticked by what is true in the workspace, never by clicking a box. The facts
 * come from the database (guide.service.ts); this file only turns them into steps, so it's pure and
 * tested. Every surface that shows progress (the bar, its steps panel, later the guide's status
 * tool) reads the same list, so they can't disagree.
 */

export type Goal = "customers" | "places" | "ads" | "creators" | "rival" | "client" | "team" | "sample";
export const GOALS: readonly Goal[] = ["customers", "places", "ads", "creators", "rival", "client", "team", "sample"];

export type StepId = "map" | "read-map" | "plays" | "ad" | "team" | "client" | "client-map" | "access";

export type Step = {
  id: StepId;
  title: string;
  hint: string;
  minutes: number;
  /** Page inside the workspace ("" is the overview). */
  page: string;
  /** The scripted walk-through that teaches it, when there is one. */
  journey: string | null;
  done: boolean;
  /** Who did it, when that wasn't this person's own team: the agency's name. */
  by: string | null;
  /** Under way without the person: the map is building. The bar waits instead of offering a button. */
  busy?: boolean;
};

export type WorkspaceFacts = {
  kind: "WORKSPACE";
  mapReady: boolean;
  mapBuilding: boolean;
  mapBy: string | null;
  seenMap: boolean;
  seenPlays: boolean;
  adRead: boolean;
  adBy: string | null;
  teammates: boolean;
};
export type AgencyFacts = { kind: "AGENCY"; clients: boolean; seenClientMap: boolean; teammates: boolean; access: boolean };
export type Facts = WorkspaceFacts | AgencyFacts;

const GOAL_STEP: Partial<Record<Goal, StepId>> = { customers: "read-map", places: "read-map", rival: "read-map", ads: "ad", creators: "plays", client: "client", team: "team", sample: "client-map" };

export function stepsFor(facts: Facts): Step[] {
  if (facts.kind === "AGENCY")
    return [
      { id: "client", title: "Add your first client", hint: "Create a workspace for them, or connect to theirs with its code.", minutes: 2, page: "settings/clients", journey: null, done: facts.clients, by: null },
      { id: "client-map", title: "Open a client’s Culture Map", hint: "Each client’s map, plays and ad checks live under Clients in the sidebar.", minutes: 2, page: "", journey: null, done: facts.seenClientMap, by: null },
      { id: "team", title: "Invite your team", hint: "Strategists work on the clients you choose; viewers read but don’t change anything.", minutes: 2, page: "settings/members", journey: null, done: facts.teammates, by: null },
      { id: "access", title: "Choose who sees which client", hint: "By default everyone sees every client. Narrow it per person in Members.", minutes: 2, page: "settings/members", journey: null, done: facts.access, by: null },
    ];
  return [
    facts.mapBuilding && !facts.mapReady
      ? { id: "map", title: "Your Culture Map is building", hint: "Usually about a minute. You can leave this page; it keeps going, and this ticks itself when it’s ready.", minutes: 1, page: "", journey: null, done: false, by: null, busy: true }
      : { id: "map", title: "Build your Culture Map", hint: "What your customers watch, listen to, follow and visit, against your rivals.", minutes: 3, page: "", journey: null, done: facts.mapReady, by: facts.mapBy },
    { id: "read-map", title: "Read your Culture Map", hint: "What’s only yours, what you share with rivals, and what’s theirs, in two minutes.", minutes: 2, page: "map", journey: "map", done: facts.seenMap, by: null },
    { id: "plays", title: "Look at your plays", hint: "Moves the map backs, each with why and who to work with.", minutes: 2, page: "plays", journey: "plays", done: facts.seenPlays, by: null },
    { id: "ad", title: "Check an ad before it runs", hint: "Upload a draft and say where it’ll run. You’ll see whose culture it speaks to and what to fix before you spend.", minutes: 4, page: "ad-check", journey: "ad", done: facts.adRead, by: facts.adBy },
    { id: "team", title: "Invite your team", hint: "Bring in the people who plan and make your marketing.", minutes: 2, page: "settings/members", journey: null, done: facts.teammates, by: null },
  ];
}

/** The one step the bar offers: the goal they picked in the welcome room first, if it's still open. */
export function nextStep(steps: Step[], goal: Goal | null): Step | null {
  const wanted = goal ? GOAL_STEP[goal] : undefined;
  const open = steps.filter((s) => !s.done);
  // A map has to exist before anything that reads it.
  const blocked = (s: Step) => s.id !== "map" && open.some((o) => o.id === "map");
  return open.find((s) => s.id === wanted && !blocked(s)) ?? open[0] ?? null;
}
