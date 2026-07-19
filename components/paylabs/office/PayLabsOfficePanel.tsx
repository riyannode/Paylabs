"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { OFFICE_DESIGN_HEIGHT, OFFICE_DESIGN_WIDTH } from "@/lib/paylabs/office/constants";
import { createInitialOfficeState, reduceOfficeEvent, reduceReturnToIdle } from "@/lib/paylabs/office/reducer";
import type { OfficeState } from "@/lib/paylabs/office/reducer";
import type { OfficeRunSummary, PayLabsOfficeEvent } from "@/lib/paylabs/office/types";
import { PayLabsOfficeCanvas } from "./PayLabsOfficeCanvas";
import { PayLabsOfficeDashboard } from "./PayLabsOfficeDashboard";
import { mergeOfficeEvents } from "@/lib/paylabs/office/selectors";

const OFFICE_VISIT_DWELL_MS = 1500;

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
  const visitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onVisibility = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const visitReturn = officeState.creator_payout_router.visitingReturn;
  const visitReturnSig = visitReturn ? `${visitReturn.x}:${visitReturn.y}` : "";

  useEffect(() => {
    if (visitReturnSig) {
      visitTimerRef.current = setTimeout(() => {
        setOfficeState((prev) => reduceReturnToIdle(prev, "creator_payout_router"));
        visitTimerRef.current = null;
      }, OFFICE_VISIT_DWELL_MS);
    } else if (visitTimerRef.current) {
      clearTimeout(visitTimerRef.current);
      visitTimerRef.current = null;
    }
    return () => {
      if (visitTimerRef.current) {
        clearTimeout(visitTimerRef.current);
        visitTimerRef.current = null;
      }
    };
  }, [visitReturnSig]);

  useEffect(() => {
    return () => {
      if (visitTimerRef.current) {
        clearTimeout(visitTimerRef.current);
        visitTimerRef.current = null;
      }
    };
  }, [run.runId]);

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
    setOfficeState(createInitialOfficeState());
    setEvents([]);

    if (!run.runId || !supabase) {
      return;
    }

    let cancelled = false;

    const channel = supabase
      .channel(`paylabs-office:${run.runId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "paylabs_office_events", filter: `run_id=eq.${run.runId}` },
        ({ new: row }) => {
          const event = mapRow(row);
          setOfficeState((previous) => reduceOfficeEvent(previous, event));
          setEvents((previous) => mergeOfficeEvents(previous, [event]));
        },
      )
      .subscribe();

    void supabase
      .from("paylabs_office_events")
      .select("*")
      .eq("run_id", run.runId)
      .order("sequence", { ascending: true })
      .limit(500)
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        const mapped = data.map((row) => mapRow(row as Record<string, unknown>));
        for (const event of mapped) {
          setOfficeState((previous) => reduceOfficeEvent(previous, event));
        }
        setEvents((previous) => mergeOfficeEvents(previous, mapped));
      });

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [run.runId, supabase]);

  const scale = Math.min(
    viewportSize.width / OFFICE_DESIGN_WIDTH,
    viewportSize.height / OFFICE_DESIGN_HEIGHT,
  );
  const scaledWidth = OFFICE_DESIGN_WIDTH * scale;
  const scaledHeight = OFFICE_DESIGN_HEIGHT * scale;
  const offsetX = Math.max(0, (viewportSize.width - scaledWidth) / 2);
  const offsetY = Math.max(0, (viewportSize.height - scaledHeight) / 2);
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

        <div className="po-stage-viewport" ref={viewportRef}>
          <PayLabsOfficeCanvas agents={agents} paused={paused} stageStyle={stageStyle} />
        </div>
      </div>

      <PayLabsOfficeDashboard agents={agents} events={events} run={run} />
    </section>
  );
}
