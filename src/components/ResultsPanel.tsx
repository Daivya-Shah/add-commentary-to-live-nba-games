import { Copy, Download, Loader2, Mic, RefreshCw, Save } from "lucide-react";
import { useEffect, useMemo, useState, type SyntheticEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { DataTable, Marker, Stage } from "@/components/almanac";

import {
  exportCommentaryVideo,
  getBackendBaseUrl,
  type AnalysisResult,
  type PossessionSegment,
} from "@/lib/analysis";

function activeSegmentIndex(segs: PossessionSegment[], normalizedT: number): number {
  const x = Math.min(1, Math.max(0, normalizedT));
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const end = i === segs.length - 1 ? 1 + 1e-6 : s.t1;
    if (x >= s.t0 && x < end) return i;
  }
  return Math.max(0, segs.length - 1);
}

interface ResultsPanelProps {
  clipId: string;
  fileUrl: string;
  result: AnalysisResult;
  onRegenerate: () => void;
  isRegenerating: boolean;
}

const formatStatLabel = (key: string) => key.replace(/_/g, " ").toUpperCase();

const RatingInput = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) => (
  <div className="flex flex-col gap-2">
    <span className="font-mono text-[10px] uppercase tracked text-foreground/55">{label}</span>
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          className={cn(
            "flex h-6 w-6 items-center justify-center border font-mono text-[11px] tabular leading-none transition-colors",
            n <= value
              ? "border-foreground bg-foreground text-background"
              : "border-foreground/30 text-foreground/35 hover:border-foreground/70 hover:text-foreground",
          )}
          aria-label={`${label} ${n}`}
        >
          {n}
        </button>
      ))}
    </div>
  </div>
);

const ResultsPanel = ({
  clipId,
  fileUrl,
  result,
  onRegenerate,
  isRegenerating,
}: ResultsPanelProps) => {
  const [fluency, setFluency] = useState(0);
  const [factual, setFactual] = useState(0);
  const [style, setStyle] = useState(0);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [voiceoverUrl, setVoiceoverUrl] = useState<string | null>(null);
  const [voiceoverBusy, setVoiceoverBusy] = useState(false);
  const [voiceoverStage, setVoiceoverStage] = useState(0);
  const [videoTab, setVideoTab] = useState<"original" | "voiceover">("original");
  const [playheadNorm, setPlayheadNorm] = useState(0);
  const [originalVideoReady, setOriginalVideoReady] = useState(false);
  const [voiceoverVideoReady, setVoiceoverVideoReady] = useState(false);

  const backendUrl = getBackendBaseUrl();
  const timeline = result.possession_timeline;
  const segIdx =
    timeline && timeline.length > 0 ? activeSegmentIndex(timeline, playheadNorm) : -1;
  const seg = segIdx >= 0 && timeline ? timeline[segIdx] : null;
  const displayEvent = seg?.event_type ?? result.event_type;
  const displayPlayer = seg?.player_name ?? result.player_name;
  const displayTeam = seg?.team_name ?? result.team_name;
  const liveLine =
    segIdx >= 0 && result.segment_commentary_lines && result.segment_commentary_lines[segIdx]
      ? result.segment_commentary_lines[segIdx]
      : null;

  const onVideoTime = (e: SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    const d = v.duration;
    if (d && Number.isFinite(d) && d > 0) {
      setPlayheadNorm(v.currentTime / d);
    }
  };

  useEffect(() => {
    return () => {
      if (voiceoverUrl) URL.revokeObjectURL(voiceoverUrl);
    };
  }, [voiceoverUrl]);

  useEffect(() => {
    setVoiceoverUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setVideoTab("original");
    setPlayheadNorm(0);
  }, [fileUrl, result.commentary_text, result.possession_timeline, result.segment_commentary_lines]);

  useEffect(() => {
    setOriginalVideoReady(false);
  }, [fileUrl]);

  useEffect(() => {
    setVoiceoverVideoReady(false);
  }, [voiceoverUrl]);

  useEffect(() => {
    if (!voiceoverBusy) {
      setVoiceoverStage(0);
      return;
    }
    const start = Date.now();
    const tick = () => {
      const elapsed = (Date.now() - start) / 1000;
      if (elapsed > 14) setVoiceoverStage(2);
      else if (elapsed > 6) setVoiceoverStage(1);
      else setVoiceoverStage(0);
    };
    tick();
    const interval = window.setInterval(tick, 500);
    return () => window.clearInterval(interval);
  }, [voiceoverBusy]);

  const handleBuildVoiceover = async () => {
    if (!backendUrl) {
      toast.error("Add VITE_BACKEND_URL in .env and restart the dev server.");
      return;
    }
    setVoiceoverBusy(true);
    try {
      const blob = await exportCommentaryVideo(fileUrl, result.commentary_text, {
        possession_timeline: result.possession_timeline,
        segment_commentary_lines: result.segment_commentary_lines,
      });
      const url = URL.createObjectURL(blob);
      if (voiceoverUrl) URL.revokeObjectURL(voiceoverUrl);
      setVoiceoverUrl(url);
      setVideoTab("voiceover");
      toast.success("Voiceover ready — switch to the voiceover tab.");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Voiceover export failed");
    } finally {
      setVoiceoverBusy(false);
    }
  };

  const handleDownloadVoiceover = () => {
    if (!voiceoverUrl) return;
    const a = document.createElement("a");
    a.href = voiceoverUrl;
    a.download = `vision2voice-voiceover-${clipId.slice(0, 8)}.mp4`;
    a.click();
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(result.commentary_text);
    toast.success("Commentary copied");
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const { error } = await supabase.from("evaluations").insert({
        clip_id: clipId,
        fluency_score: fluency,
        factual_score: factual,
        style_score: style,
        notes: notes || null,
      });
      if (error) throw error;
      toast.success("Evaluation logged");
    } catch {
      toast.error("Failed to save evaluation");
    } finally {
      setSaving(false);
    }
  };

  const playerStats = result.retrieved_context?.player_stats;
  const teamStats = result.retrieved_context?.team_stats;

  type StatRow = { metric: string; value: string | number };
  const playerRows: StatRow[] = useMemo(
    () =>
      playerStats
        ? Object.entries(playerStats)
            .map(([k, v]) => ({ metric: formatStatLabel(k), value: v as string | number }))
            .sort((a, b) => a.metric.localeCompare(b.metric))
        : [],
    [playerStats],
  );
  const teamRows: StatRow[] = useMemo(
    () =>
      teamStats
        ? Object.entries(teamStats)
            .map(([k, v]) => ({ metric: formatStatLabel(k), value: v as string | number }))
            .sort((a, b) => a.metric.localeCompare(b.metric))
        : [],
    [teamStats],
  );

  const confidencePct = (result.confidence * 100).toFixed(1);
  const shortClipId = clipId.slice(0, 8).toUpperCase();

  return (
    <article className="space-y-12">
      <section>
        <Tabs
          value={videoTab}
          onValueChange={(v) => setVideoTab(v as "original" | "voiceover")}
          className="mt-0"
        >
          <div className="flex flex-wrap items-end justify-between gap-4">
            <TabsList>
              <TabsTrigger value="original">Original</TabsTrigger>
              <TabsTrigger value="voiceover" disabled={!voiceoverUrl}>
                AI Voiceover
              </TabsTrigger>
            </TabsList>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={voiceoverBusy || !backendUrl}
                onClick={handleBuildVoiceover}
                title={
                  backendUrl
                    ? "Synthesize speech and mux onto the video."
                    : "Set VITE_BACKEND_URL for voiceover."
                }
              >
                {voiceoverBusy ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Mic />
                )}
                {voiceoverBusy ? "Building" : "Build voiceover"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!voiceoverUrl}
                onClick={handleDownloadVoiceover}
              >
                <Download />
                MP4
              </Button>
            </div>
          </div>

          {voiceoverBusy && (
            <div
              className="mt-3 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracked tabular"
              role="status"
              aria-live="polite"
              data-testid="voiceover-stage-indicator"
            >
              {(["SYNTHESIZING AUDIO", "MUXING VIDEO", "FINALIZING"] as const).map((label, idx) => (
                <span key={label} className="flex items-center gap-2">
                  <span
                    className={cn(
                      idx < voiceoverStage && "text-foreground/35 line-through",
                      idx === voiceoverStage && "text-foreground",
                      idx > voiceoverStage && "text-foreground/30",
                    )}
                  >
                    {label}
                  </span>
                  {idx < 2 && <span className="text-foreground/25">→</span>}
                </span>
              ))}
            </div>
          )}

          {!backendUrl && (
            <p className="mt-3 font-mono text-[10px] uppercase tracked text-foreground/50">
              VOICEOVER NEEDS THE PYTHON API · SET VITE_BACKEND_URL · RUN <span className="text-foreground">npm run dev:full</span>
            </p>
          )}

          <TabsContent value="original" className="m-0 mt-4">
            <Stage
              topLeft={<Marker>FRAME · {String(Math.round(playheadNorm * 100)).padStart(2, "0")}%</Marker>}
              topRight={<Marker tone="accent">● ANALYZING</Marker>}
              bottomLeft={<Marker tone="muted">{displayEvent?.toUpperCase() || "EVENT"}</Marker>}
              bottomRight={<Marker tone="muted">{displayTeam?.toUpperCase() || "—"}</Marker>}
            >
              <video
                key={fileUrl}
                src={fileUrl}
                controls
                playsInline
                className="absolute inset-0 h-full w-full object-contain"
                onTimeUpdate={onVideoTime}
                onSeeked={onVideoTime}
                onLoadedMetadata={onVideoTime}
                onCanPlay={() => setOriginalVideoReady(true)}
                onWaiting={() => setOriginalVideoReady(false)}
              />
              {!originalVideoReady && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/85"
                >
                  <Loader2 className="h-8 w-8 animate-spin text-foreground/40" />
                </div>
              )}
            </Stage>
          </TabsContent>
          <TabsContent value="voiceover" className="m-0 mt-4">
            {voiceoverUrl ? (
              <Stage
                topLeft={<Marker tone="accent">● VOICEOVER</Marker>}
                topRight={<Marker>{shortClipId}</Marker>}
              >
                <video
                  key={voiceoverUrl}
                  src={voiceoverUrl}
                  controls
                  playsInline
                  className="absolute inset-0 h-full w-full object-contain"
                  onTimeUpdate={onVideoTime}
                  onSeeked={onVideoTime}
                  onLoadedMetadata={onVideoTime}
                  onCanPlay={() => setVoiceoverVideoReady(true)}
                  onWaiting={() => setVoiceoverVideoReady(false)}
                />
                {!voiceoverVideoReady && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/85"
                  >
                    <Loader2 className="h-8 w-8 animate-spin text-foreground/40" />
                  </div>
                )}
              </Stage>
            ) : (
              <p className="border border-foreground/[var(--rule-alpha,0.18)] px-6 py-12 text-center font-mono text-[11px] uppercase tracked text-foreground/50">
                — BUILD VOICEOVER TO POPULATE THIS FRAME —
              </p>
            )}
          </TabsContent>
        </Tabs>
      </section>

      <section>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
          <MetaCell label="EVENT" value={displayEvent} />
          <MetaCell label="PLAYER" value={displayPlayer} />
          <MetaCell label="TEAM" value={displayTeam} />
          <MetaCell label="CONF" value={`${confidencePct}%`} />
        </dl>
        {result.visual_summary && (
          <p className="mt-6 max-w-3xl border-l border-white/25 pl-4 font-body text-base italic leading-relaxed text-foreground/85">
            {result.visual_summary}
          </p>
        )}
      </section>

      <section>
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <h2 className="font-mono text-xs uppercase tracking-[0.16em] text-foreground/70 sm:text-sm">
            COMMENTARY
          </h2>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onRegenerate} disabled={isRegenerating}>
              <RefreshCw className={isRegenerating ? "animate-spin" : ""} />
              Regenerate
            </Button>
            <Button variant="ghost" size="sm" onClick={handleCopy}>
              <Copy />
              Copy
            </Button>
          </div>
        </div>

        <blockquote className="w-full max-w-none">
          <p className="w-full text-pretty font-body text-2xl leading-[1.45] text-foreground sm:text-3xl">
            {result.commentary_text}
          </p>
        </blockquote>

        {liveLine && (
          <div className="mt-8 flex w-full max-w-none flex-col gap-3 border-t border-foreground/[var(--rule-alpha,0.18)] pt-6 sm:flex-row sm:items-baseline sm:gap-6">
            <Marker tone="muted" className="shrink-0 text-xs uppercase tracking-[0.16em] sm:text-sm">
              AT PLAYHEAD
            </Marker>
            <p className="flex-1 font-body text-base italic leading-relaxed text-foreground/85 sm:text-lg md:text-xl">
              {liveLine}
            </p>
          </div>
        )}
      </section>

      {(playerRows.length > 0 || teamRows.length > 0) && (
        <section>
          <div className="grid gap-10 lg:grid-cols-2">
            {playerRows.length > 0 && (
              <DataTable
                rows={playerRows}
                caption={`PLAYER · ${displayPlayer?.toUpperCase() || "—"}`}
                columns={[
                  { key: "metric", header: "METRIC" },
                  { key: "value", header: "VALUE", align: "right" },
                ]}
              />
            )}
            {teamRows.length > 0 && (
              <DataTable
                rows={teamRows}
                caption={`TEAM · ${displayTeam?.toUpperCase() || "—"}`}
                columns={[
                  { key: "metric", header: "METRIC" },
                  { key: "value", header: "VALUE", align: "right" },
                ]}
              />
            )}
          </div>
        </section>
      )}

      <section>
        <div className="rounded-[10px] border border-white/15 bg-[#0a1020]/45 p-5 sm:p-6">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <h2 className="font-mono text-xs uppercase tracking-[0.16em] text-foreground/70 sm:text-sm">
              EVALUATION
            </h2>
            <Marker tone="muted">HUMAN GRADE</Marker>
          </div>
          <div className="flex flex-wrap items-end gap-x-10 gap-y-6">
            <RatingInput label="FLUENCY" value={fluency} onChange={setFluency} />
            <RatingInput label="FACTUAL" value={factual} onChange={setFactual} />
            <RatingInput label="STYLE" value={style} onChange={setStyle} />
          </div>
          <Textarea
            placeholder="Marginalia - what worked, what missed, what would a real broadcaster have said..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-6"
          />
          <div className="mt-4">
            <Button
              variant="default"
              onClick={handleSave}
              disabled={saving || (fluency === 0 && factual === 0 && style === 0)}
            >
              <Save />
              {saving ? "Logging" : "Log evaluation"}
            </Button>
          </div>
        </div>
      </section>
    </article>
  );
};

const MetaCell = ({
  label,
  value,
}: {
  label: string;
  value?: string | number | null;
}) => (
  <div className="flex min-h-[128px] flex-col justify-between rounded-[10px] border border-white/15 bg-[#0a1020]/55 px-4 py-4 sm:min-h-[144px] sm:px-5 sm:py-5">
    <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/65">{label}</dt>
    <dd className="mt-3 break-words font-display text-xl leading-[1.15] text-white sm:text-2xl lg:text-[1.65rem]">
      {value ?? "—"}
    </dd>
  </div>
);

export default ResultsPanel;
