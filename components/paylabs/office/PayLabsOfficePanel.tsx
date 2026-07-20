"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { OFFICE_DESIGN_HEIGHT, OFFICE_DESIGN_WIDTH } from "@/lib/paylabs/office/constants";
import { createInitialOfficeState, reduceOfficeEvent, reduceReturnToIdle } from "@/lib/paylabs/office/reducer";
import type { OfficeState } from "@/lib/paylabs/office/reducer";
import type { OfficeAgentId, OfficeRunSummary, PayLabsOfficeEvent } from "@/lib/paylabs/office/types";
import { PayLabsOfficeCanvas } from "./PayLabsOfficeCanvas";
import { PayLabsOfficeDashboard } from "./PayLabsOfficeDashboard";
import { mergeOfficeEvents } from "@/lib/paylabs/office/selectors";

const OFFICE_VISIT_DWELL_MS = 1500;
const OFFICE_AGENT_TRAVEL_MS = 680;
const OFFICE_DESK_VISIBLE_MS = 1200;
const OFFICE_DESK_RETURN_DELAY_MS = OFFICE_AGENT_TRAVEL_MS + OFFICE_DESK_VISIBLE_MS;

function getDwellMs(agentId: OfficeAgentId): number {
  return agentId === "creator_payout_router" ? OFFICE_VISIT_DWELL_MS : OFFICE_DESK_RETURN_DELAY_MS;
}

function createBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function mapRow(row: Record<string, unknown>): PayLabsOfficeEvent {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    sequence: Number(row.sequence),
    type: row.event_type as PayLabsOfficeEvent["type"],
    agentId: row.agent_id == null ? undefined : (String(row.agent_id) as PayLabsOfficeEvent["agentId"]),
    phase: row.phase == null ? undefined : (String(row.phase) as PayLabsOfficeEvent["phase"]),
    status: row.status == null ? undefined : (String(row.status) as PayLabsOfficeEvent["status"]),
    title: String(row.title),
    message: row.message == null ? null : String(row.message),
    payment: row.payment == null ? null : (row.payment as PayLabsOfficeEvent["payment"]),
    metadata: row.metadata == null ? null : (row.metadata as PayLabsOfficeEvent["metadata"]),
    createdAt: String(row.created_at),
  };
}

export function PayLabsOfficePanel({ run }: { run: OfficeRunSummary }) {
  const [officeState, setOfficeState] = useState<OfficeState>(() => createInitialOfficeState());
  const [events, setEvents] = useState<PayLabsOfficeEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: OFFICE_DESIGN_WIDTH, height: OFFICE_DESIGN_HEIGHT });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const supabase = useMemo(createBrowserClient, []);
  const visitTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const onVisibility = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Build a signature of all agents with visitingReturn for the effect dependency
  const visitingAgentsSig = Object.values(officeState)
    .filter((a) => a.visitingReturn)
    .map((a) => `${a.id}:${a.visitingReturn!.x}:${a.visitingReturn!.y}`)
    .join("|");

  useEffect(() => {
    const timers = visitTimersRef.current;
    const currentVisiting = new Set<string>();

    // Start timers for agents with visitingReturn that don't have one yet
    for (const agent of Object.values(officeState)) {
      if (agent.visitingReturn) {
        currentVisiting.add(agent.id);
        if (!timers.has(agent.id)) {
          const dwellMs = getDwellMs(agent.id);
          const timer = setTimeout(() => {
            setOfficeState((prev) => reduceReturnToIdle(prev, agent.id));
            timers.delete(agent.id);
          }, dwellMs);
          timers.set(agent.id, timer);
        }
      }
    }

    // Clear timers for agents that no longer have visitingReturn
    for (const [agentId, timer] of timers.entries()) {
      if (!currentVisiting.has(agentId)) {
        clearTimeout(timer);
        timers.delete(agentId);
      }
    }
  }, [visitingAgentsSig]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const update = () => {
      const rect = el.getBoundingClientRect();
      setViewportSize({ width: rect.width, height: rect.height });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // Clear all dwell timers on run change
    for (const timer of visitTimersRef.current.values()) clearTimeout(timer);
    visitTimersRef.current.clear();

    setOfficeState(createInitialOfficeState());
    setEvents([]);

    if (!run.runId || !supabase) {
      return;
    }

    let cancelled = false;
    let historyFetched = false;
    let realtimeEventsDuringSubscribe: PayLabsOfficeEvent[] = [];

    async function fetchHistory() {
      const { data, error } = await supabase!
        .from("paylabs_office_events")
        .select("*")
        .eq("run_id", run.runId)
        .order("sequence", { ascending: true })
        .limit(500);
      if (cancelled || error || !data) return;
      const mapped = data.map((row) => mapRow(row as Record<string, unknown>));
      setOfficeState((previous) => {
        let s = previous;
        for (const evt of mapped) s = reduceOfficeEvent(s, evt);
        return s;
      });
      setEvents((previous) => mergeOfficeEvents(previous, mapped));
    }

    const channel = supabase
      .channel(`paylabs-office:${run.runId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "paylabs_office_events", filter: `run_id=eq.${run.runId}` },
        ({ new: row }) => {
          const evt = mapRow(row);
          if (!historyFetched) {
            // History hasn't been fetched yet — buffer Realtime events
            // so they aren't lost if they arrive before the fetch completes
            realtimeEventsDuringSubscribe.push(evt);
            return;
          }
          setOfficeState((previous) => reduceOfficeEvent(previous, evt));
          setEvents((previous) => mergeOfficeEvents(previous, [evt]));
        },
      )
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED" && !cancelled) {
          historyFetched = true;
          // Fetch complete ordered history AFTER subscription is live
          await fetchHistory();
          // Flush any Realtime events that arrived during the subscribe window
          if (realtimeEventsDuringSubscribe.length > 0) {
            const buffered = [...realtimeEventsDuringSubscribe];
            realtimeEventsDuringSubscribe = [];
            setOfficeState((previous) => {
              let s = previous;
              for (const evt of buffered) s = reduceOfficeEvent(s, evt);
              return s;
            });
            setEvents((previous) => mergeOfficeEvents(previous, buffered));
          }
        }
      });

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
      // Clear all dwell timers on unmount
      for (const timer of visitTimersRef.current.values()) clearTimeout(timer);
      visitTimersRef.current.clear();
    };
  }, [run.runId, supabase]);

  const scale = viewportSize.width / OFFICE_DESIGN_WIDTH;
  const scaledHeight = OFFICE_DESIGN_HEIGHT * scale;
  const offsetX = 0;
  const offsetY = 0;
  const stageStyle = {
    width: OFFICE_DESIGN_WIDTH,
    height: OFFICE_DESIGN_HEIGHT,
    left: offsetX,
    top: offsetY,
    transform: `scale(${scale})`,
  };

  const agents = Object.values(officeState);

  return (
    <section className="po-shell">
      <div className="po-office-column">
        <div className="po-office-visual-block">
          <header className="po-header">
            <div>
              <strong>PAYLABS VIRTUAL OFFICE</strong>
              <span>{run.runId ? `RUN ${run.runId.slice(0, 12)}` : "IDLE"}</span>
            </div>
            <div className="po-header-metrics">
              <span>24 FPS</span>
              <span>{run.tier ?? "AUTO"}</span>
            </div>
          </header>

          <div className="po-stage-viewport" ref={viewportRef} style={{ height: scaledHeight }}>
            <PayLabsOfficeCanvas agents={agents} paused={paused} stageStyle={stageStyle} />
          </div>
        </div>
      </div>

      <PayLabsOfficeDashboard agents={agents} events={events} run={run} />
    </section>
  );
}
