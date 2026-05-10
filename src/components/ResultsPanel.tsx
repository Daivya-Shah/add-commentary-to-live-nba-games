import {
  Activity, AlertCircle, AlertTriangle, ArrowRight, CheckCircle2,
  Clock, Copy, Loader2, RefreshCw, RotateCcw, Shield, Target, Tv2,
  Volume2, VolumeX, Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  analyzeFrame,
  exportCommentaryVideo,
  getBackendBaseUrl,
  runAnalysisPipeline,
  type AnalysisResult,
  type FrameResult,
  type OnScreenText,
  type PlayerContext,
  type PossessionSegment,
  type ScoreboardInfo,
} from "@/lib/analysis";

// ─── event config ─────────────────────────────────────────────────────────
const EVT: Record<string, { icon: React.ElementType; color: string; pill: string; short: string }> = {
  "Three-Point Shot": { icon: Target,        color: "text-blue-400",    pill: "bg-blue-500/15 border-blue-500/25",    short: "3PT"     },
  "Two-Point Shot":   { icon: CheckCircle2,  color: "text-emerald-400", pill: "bg-emerald-500/15 border-emerald-500/25", short: "2PT"  },
  "Layup or Dunk":    { icon: Zap,           color: "text-yellow-300",  pill: "bg-yellow-500/15 border-yellow-500/25", short: "DNK"    },
  "Free Throw":       { icon: Target,        color: "text-sky-400",     pill: "bg-sky-500/15 border-sky-500/25",      short: "FT"      },
  "Assist":           { icon: ArrowRight,    color: "text-purple-400",  pill: "bg-purple-500/15 border-purple-500/25", short: "AST"    },
  "Rebound":          { icon: RotateCcw,     color: "text-orange-400",  pill: "bg-orange-500/15 border-orange-500/25", short: "REB"   },
  "Turnover":         { icon: AlertCircle,   color: "text-red-400",     pill: "bg-red-500/15 border-red-500/25",      short: "TOV"     },
  "Block":            { icon: Shield,        color: "text-teal-400",    pill: "bg-teal-500/15 border-teal-500/25",    short: "BLK"     },
  "Foul":             { icon: AlertTriangle, color: "text-amber-400",   pill: "bg-amber-500/15 border-amber-500/25",  short: "FOUL"   },
  "Other":            { icon: Activity,      color: "text-white/35",    pill: "bg-white/5 border-white/10",           short: "PLAY"    },
};
const getE = (e: string) => EVT[e] ?? EVT["Other"];

// Distinct segment colors for the timeline bar
const SEG_COLORS = [
  "bg-primary", "bg-accent", "bg-blue-500", "bg-purple-500",
  "bg-rose-500", "bg-cyan-500", "bg-emerald-400", "bg-yellow-400",
];

// ─── stat labels ──────────────────────────────────────────────────────────
const SL: Record<string, string> = {
  ppg:"Pts/G", season_avg_ppg:"Pts/G", rpg:"Reb/G", season_avg_rpg:"Reb/G",
  apg:"Ast/G", season_avg_apg:"Ast/G", spg:"Stl/G", season_avg_spg:"Stl/G",
  bpg:"Blk/G", season_avg_bpg:"Blk/G", fg_pct:"FG%", season_avg_fg_pct:"FG%",
  three_p_pct:"3P%","season_avg_3p_pct":"3P%", ft_pct:"FT%", season_avg_ft_pct:"FT%",
  win_loss:"Record", wins:"W", losses:"L", conference:"Conf", conference_rank:"Rank",
  gp:"GP", position:"Pos", age:"Age", experience:"Yrs",
};
const sl = (k: string) => SL[k.toLowerCase()] ?? k.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
const sv = (k: string, v: unknown) => {
  if (v == null) return "—";
  const s = String(v);
  if ((k.includes("pct") || k.includes("percent")) && !s.includes("%")) {
    const n = parseFloat(s); return isNaN(n) ? s : `${(n * 100).toFixed(1)}%`;
  }
  return s;
};

// ─── helpers ──────────────────────────────────────────────────────────────
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function activeSegIdx(segs: PossessionSegment[], t: number) {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 0; i < segs.length; i++) {
    const end = i === segs.length - 1 ? 1 + 1e-6 : segs[i].t1;
    if (x >= segs[i].t0 && x < end) return i;
  }
  return -1;
}

// ─── atoms ────────────────────────────────────────────────────────────────
const Sk = ({ cls = "" }: { cls?: string }) => <div className={`animate-pulse rounded bg-white/[0.07] ${cls}`} />;
const Divider = () => <div className="h-px bg-white/[0.05] w-full" />;

const EventPill = ({ event }: { event: string }) => {
  const e = getE(event);
  const Icon = e.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold ${e.pill} ${e.color}`}>
      <Icon className="h-3 w-3" />{event}
    </span>
  );
};

const ConfBar = ({ v }: { v: number }) => (
  <div>
    <div className="flex justify-between mb-1">
      <span className="text-[11px] text-white/30">
        {v >= 0.8 ? "High confidence" : v >= 0.5 ? "Medium confidence" : "Low confidence"}
      </span>
      <span className="text-[11px] text-white/40 tabular-nums">{Math.round(v * 100)}%</span>
    </div>
    <div className="h-[3px] w-full rounded-full bg-white/[0.08]">
      <div className={`h-full rounded-full transition-all duration-500 ${v >= 0.8 ? "bg-emerald-500" : v >= 0.5 ? "bg-amber-500" : "bg-red-500"}`}
        style={{ width: `${Math.round(v * 100)}%` }} />
    </div>
  </div>
);

// ─── PlayerCard ───────────────────────────────────────────────────────────
const PlayerCard = ({ p }: { p: PlayerContext }) => {
  const ps = Object.entries(p.player_stats ?? {}).filter(([k]) => k !== "name");
  const ts = Object.entries(p.team_stats   ?? {}).filter(([k]) => k !== "name");
  return (
    <div className="rounded-2xl bg-[#13131a] border border-white/[0.06] overflow-hidden flex flex-col">
      <div className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-white/[0.05]">
        {p.jersey_number && (
          <div className="w-12 h-12 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center flex-shrink-0">
            <span className="font-display text-xl font-black text-primary">#{p.jersey_number}</span>
          </div>
        )}
        <div className="min-w-0">
          <p className="font-display text-sm font-bold text-white truncate">{p.player_name}</p>
          <p className="text-[11px] text-white/40 truncate mt-0.5">{p.team_name}</p>
        </div>
      </div>
      <div className="px-4 py-3 flex-1">
        {(ps.length > 0 || ts.length > 0) ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
            {[...ps, ...ts].map(([k, v]) => (
              <div key={k}>
                <p className="text-[10px] text-white/25">{sl(k)}</p>
                <p className="text-sm font-bold text-white/80 tabular-nums">{sv(k, v)}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-white/20 italic">Stats not in knowledge base</p>
        )}
      </div>
    </div>
  );
};

// ─── PossessionBar ────────────────────────────────────────────────────────
const PossessionBar = ({
  segments, playhead, lines, duration,
}: {
  segments: PossessionSegment[];
  playhead: number;
  lines: string[];
  duration: number;
}) => {
  if (!segments.length) return null;
  const ai = activeSegIdx(segments, playhead);
  const active = segments[ai];
  return (
    <div>
      {/* Bar */}
      <div className="relative flex h-8 overflow-hidden rounded-xl border border-white/[0.05]">
        {segments.map((s, i) => {
          const w = Math.max(0, (s.t1 - s.t0) * 100);
          const segOpacity = ai === -1 ? "opacity-60" : i === ai ? "opacity-100" : "opacity-20";
          return (
            <div key={i}
              className={`relative flex items-center justify-center overflow-hidden transition-opacity duration-200 ${SEG_COLORS[i % SEG_COLORS.length]} ${segOpacity}`}
              style={{ width: `${w}%` }}
              title={`${s.player_name} — ${s.event_type}`}>
              {w > 6 && (
                <span className="text-[10px] font-bold text-black/70 truncate px-1 select-none">
                  {s.player_name.split(" ").pop()}
                </span>
              )}
            </div>
          );
        })}
        {/* Playhead */}
        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]"
          style={{ left: `${playhead * 100}%` }} />
      </div>
      {/* Active segment info */}
      {active && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
          <div className={`h-2 w-2 rounded-full flex-shrink-0 ${SEG_COLORS[ai % SEG_COLORS.length]}`} />
          <span className="text-xs font-semibold text-white/80">{active.player_name}</span>
          {active.jersey_number_primary && (
            <span className="text-xs text-primary font-bold">#{active.jersey_number_primary}</span>
          )}
          <span className="text-xs text-white/40">{active.event_type}</span>
          <span className="text-xs text-white/30">&middot;</span>
          <span className="text-xs text-white/40">{active.team_name}</span>
          {duration > 0 && (
            <span className="text-xs text-white/25 ml-auto tabular-nums">
              {fmt(active.t0 * duration)}–{fmt(active.t1 * duration)}
            </span>
          )}
          {lines[ai] && (
            <p className="w-full text-xs italic text-white/50 mt-1">&ldquo;{lines[ai]}&rdquo;</p>
          )}
        </div>
      )}
    </div>
  );
};

// ─── SegmentTable ─────────────────────────────────────────────────────────
const SegmentTable = ({
  segments, lines, duration,
}: {
  segments: PossessionSegment[];
  lines: string[];
  duration: number;
}) => {
  if (!segments.length) return null;
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/[0.05] bg-[#111118]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/[0.05]">
            {["Time", "Event", "Player", "#", "Team", "Commentary"].map(h => (
              <th key={h} className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-white/25">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {segments.map((s, i) => {
            const e = getE(s.event_type);
            const Icon = e.icon;
            return (
              <tr key={i} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] transition-colors">
                <td className="px-4 py-2.5 text-[11px] text-white/30 tabular-nums whitespace-nowrap">
                  {duration > 0 ? `${fmt(s.t0 * duration)}–${fmt(s.t1 * duration)}` : `${Math.round(s.t0 * 100)}%`}
                </td>
                <td className="px-4 py-2.5">
                  <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-bold border ${e.pill} ${e.color}`}>
                    <Icon className="h-3 w-3" />{e.short}
                  </span>
                </td>
                <td className="px-4 py-2.5 font-medium text-white/80 whitespace-nowrap">{s.player_name}</td>
                <td className="px-4 py-2.5 font-bold text-primary text-xs">
                  {s.jersey_number_primary ? `#${s.jersey_number_primary}` : "—"}
                </td>
                <td className="px-4 py-2.5 text-white/40 whitespace-nowrap text-xs">{s.team_name}</td>
                <td className="px-4 py-2.5 text-white/55 italic text-xs max-w-xs">
                  {lines[i] || (lines.length === 0 ? <span className="text-white/20">Generating…</span> : "—")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// ─── ResultsPanel ─────────────────────────────────────────────────────────

interface Props {
  localUrl:     string;
  cloudUrl:     string | null;
  result:       AnalysisResult | null;
  isStreaming:  boolean;
  statusMessage: string;
  error?:        string;
  phase:         string;
  onReset:       () => void;
}

export default function ResultsPanel({
  localUrl, cloudUrl, result, isStreaming, statusMessage, error, phase, onReset,
}: Props) {
  const vidRef = useRef<HTMLVideoElement>(null);
  const voiRef = useRef<HTMLVideoElement>(null);

  const [playheadNorm, setPlayheadNorm] = useState(0);
  const [videoDur,     setVideoDur]     = useState(0);
  const [isPlaying,    setIsPlaying]    = useState(false);
  const [voiUrl,       setVoiUrl]       = useState<string | null>(null);
  const [voiBusy,      setVoiBusy]      = useState(false);
  const [voiOn,        setVoiOn]        = useState(false);
  const [isRegen,      setIsRegen]      = useState(false);

  // Real-time frame analysis
  const canvasRef      = useRef<HTMLCanvasElement>(null);
  const liveFrameRef   = useRef<FrameResult | null>(null);
  const analyzingRef   = useRef(false);
  const [liveFrame, setLiveFrame] = useState<FrameResult | null>(null);

  const backendUrl = getBackendBaseUrl();
  const timeline   = result?.possession_timeline   ?? [];
  const segLines   = result?.segment_commentary_lines ?? [];
  const dur        = result?.duration ?? videoDur;

  const ai      = timeline.length > 0 ? activeSegIdx(timeline, playheadNorm) : -1;
  const activeSeg = ai >= 0 ? timeline[ai] : null;

  const displayEvent  = activeSeg?.event_type  ?? "";
  const displayPlayer = activeSeg?.player_name ?? "";
  const displayTeam   = activeSeg?.team_name   ?? "";
  const displayJersey = activeSeg?.jersey_number_primary ?? null;
  const displayLine   = (ai >= 0 && segLines[ai]) ? segLines[ai] : null;
  const evtCfg  = getE(displayEvent);
  const EIcon   = evtCfg.icon;

  // Live frame wins when playing; pre-computed segment is the fallback when paused/scrubbing
  const bh = (liveFrame && backendUrl)
    ? { player: liveFrame.player_name, jersey: liveFrame.jersey_number, team: liveFrame.team_name, event: liveFrame.event_type, conf: liveFrame.confidence, isLive: true }
    : activeSeg
    ? { player: displayPlayer, jersey: displayJersey, team: displayTeam, event: displayEvent, conf: result?.confidence ?? null, isLive: false }
    : null;

  const scoreboard   = result?.scoreboard    ?? null;
  const onScreenText = result?.on_screen_text ?? null;
  const players      = result?.players_stats  ?? [];
  const isComplete   = phase === "complete";

  // ── Video time tracking ────────────────────────────────────────────────
  const onTimeUpdate = (e: SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    if (v.duration && isFinite(v.duration) && v.duration > 0) {
      setPlayheadNorm(v.currentTime / v.duration);
      setVideoDur(v.duration);
    }
  };

  // ── Voiceover sync ─────────────────────────────────────────────────────
  useEffect(() => {
    const main = vidRef.current; const vo = voiRef.current;
    if (!main) return;
    if (!voiUrl || !vo || !voiOn) { if (vo) vo.pause(); main.muted = false; return; }
    main.muted = true; vo.currentTime = main.currentTime;
    if (!main.paused) vo.play().catch(() => {});
    const p = () => { vo.currentTime = main.currentTime; vo.play().catch(() => {}); };
    const pa = () => vo.pause();
    const s  = () => { vo.currentTime = main.currentTime; };
    main.addEventListener("play", p); main.addEventListener("pause", pa); main.addEventListener("seeked", s);
    return () => {
      main.removeEventListener("play", p); main.removeEventListener("pause", pa); main.removeEventListener("seeked", s);
      vo.pause(); main.muted = false;
    };
  }, [voiOn, voiUrl]);

  useEffect(() => () => { if (voiUrl) URL.revokeObjectURL(voiUrl); }, [voiUrl]);

  // ── Live frame analysis ────────────────────────────────────────────────────
  const captureAndAnalyze = useCallback(async () => {
    const vid    = vidRef.current;
    const canvas = canvasRef.current;
    if (!vid || !canvas || analyzingRef.current || !backendUrl || vid.paused || vid.ended) return;
    analyzingRef.current = true;
    const ctx = canvas.getContext("2d");
    if (!ctx) { analyzingRef.current = false; return; }
    canvas.width  = 640;
    canvas.height = 360;
    try { ctx.drawImage(vid, 0, 0, 640, 360); }
    catch { analyzingRef.current = false; return; }
    const frameData = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
    const prev = liveFrameRef.current;
    try {
      const r = await analyzeFrame({
        frame_data:  frameData,
        timestamp:   vid.currentTime,
        duration:    vid.duration,
        prev_player: prev?.player_name   ?? null,
        prev_jersey: prev?.jersey_number ?? null,
        prev_team:   prev?.team_name     ?? null,
      });
      liveFrameRef.current = r;
      setLiveFrame(r);
    } catch { /* silently fail — don't interrupt playback */ }
    finally { analyzingRef.current = false; }
  }, [backendUrl]);

  // Poll every 2 s while playing (matches ~200k token budget for a 6-min video)
  useEffect(() => {
    if (!isPlaying || !backendUrl) return;
    const id = setInterval(captureAndAnalyze, 2000);
    return () => clearInterval(id);
  }, [isPlaying, backendUrl, captureAndAnalyze]);

  const toggleVoiceover = async () => {
    if (voiBusy || !cloudUrl || !result) return;
    if (!voiUrl) {
      if (!backendUrl) { toast.error("Backend required for voiceover."); return; }
      setVoiBusy(true);
      try {
        const blob = await exportCommentaryVideo(cloudUrl, result.commentary_text, {
          possession_timeline: result.possession_timeline,
          segment_commentary_lines: result.segment_commentary_lines,
        });
        setVoiUrl(URL.createObjectURL(blob)); setVoiOn(true);
        toast.success("Voiceover ready.");
      } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); }
      finally { setVoiBusy(false); }
    } else setVoiOn(p => !p);
  };

  const handleCopy = () => {
    if (!result?.commentary_text) return;
    navigator.clipboard.writeText(result.commentary_text);
    toast.success("Copied");
  };

  const handleRegen = async () => {
    if (!cloudUrl || !result || isRegen) return;
    setIsRegen(true);
    try {
      const r = await runAnalysisPipeline("regen", cloudUrl, "regenerate");
      toast.success("Commentary regenerated");
      // Update only the commentary text
      result.commentary_text = r.commentary_text;
    } catch { toast.error("Regeneration failed"); }
    finally { setIsRegen(false); }
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#09090b] text-white flex flex-col">

      {/* Hidden voiceover */}
      <video ref={voiRef} src={voiUrl || undefined} preload={voiUrl ? "auto" : "none"}
        style={{ position: "fixed", width: 0, height: 0, opacity: 0, pointerEvents: "none" }} />
      {/* Hidden canvas for live frame capture */}
      <canvas ref={canvasRef} style={{ display: "none" }} />

      {/* ── Header ── */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-white/[0.05] flex-shrink-0">
        <span className="font-display text-xl font-bold">Vision<span className="text-primary">2</span>Voice</span>
        <div className="flex items-center gap-5">
          {isStreaming && (
            <span className="flex items-center gap-2 text-[11px] text-white/30">
              <Loader2 className="h-3 w-3 animate-spin" />{statusMessage}
            </span>
          )}
          {error && <span className="text-xs text-red-400">{error}</span>}
          <button onClick={onReset} className="text-sm text-white/30 hover:text-white transition-colors">← New clip</button>
        </div>
      </header>

      {/* ── Main grid: video + live panel ── */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] border-b border-white/[0.05]">

        {/* Video */}
        <div className="bg-black flex items-center justify-center lg:border-r border-white/[0.05]" style={{ maxHeight: 500 }}>
          <video ref={vidRef} key={localUrl} src={localUrl} controls playsInline
            className="w-full h-full" style={{ maxHeight: 500, objectFit: "contain" }}
            onTimeUpdate={onTimeUpdate} onSeeked={onTimeUpdate}
            onLoadedMetadata={onTimeUpdate}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => { setIsPlaying(false); setLiveFrame(null); liveFrameRef.current = null; }}
            onSeeked={e => { onTimeUpdate(e as SyntheticEvent<HTMLVideoElement>); setLiveFrame(null); liveFrameRef.current = null; }} />
        </div>

        {/* Live panel */}
        <div className="bg-[#0d0d0f] flex flex-col overflow-y-auto" style={{ maxHeight: 500 }}>

          {/* Status bar */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/[0.04] bg-black/20 flex-shrink-0">
            <span className={`h-2 w-2 rounded-full flex-shrink-0 ${isPlaying && !isStreaming ? "bg-red-500 animate-pulse" : isStreaming ? "bg-amber-400 animate-pulse" : "bg-white/15"}`} />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-white/30 truncate">
              {isStreaming
                ? statusMessage || "Analyzing…"
                : result
                ? isPlaying ? "Live" : "Ready — press play"
                : "Waiting for analysis…"}
            </span>
          </div>

          {/* Ball handler */}
          <div className="px-4 py-4 border-b border-white/[0.04]">
            <div className="flex items-center gap-2 mb-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/20">Ball Handler</p>
              {bh?.isLive && (
                <span className="flex items-center gap-1 text-[10px] font-bold text-red-400 uppercase tracking-wider">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />Live
                </span>
              )}
            </div>

            {result && bh ? (
              <div key={`${bh.player}-${bh.isLive ? liveFrame?.timestamp : ai}`} className="animate-fade-in-up space-y-3">
                {/* Jersey box + name */}
                <div className="flex items-center gap-3">
                  {bh.jersey ? (
                    <div className="w-14 h-14 rounded-2xl bg-primary/15 border border-primary/25 flex items-center justify-center flex-shrink-0">
                      <span className="font-display text-2xl font-black text-primary leading-none">#{bh.jersey}</span>
                    </div>
                  ) : (
                    <div className="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center flex-shrink-0">
                      <EIcon className={`h-6 w-6 ${evtCfg.color}`} />
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="font-display text-xl font-bold text-white leading-tight truncate">{bh.player || "—"}</p>
                    <p className="text-sm text-white/40 truncate mt-0.5">{bh.team}</p>
                  </div>
                </div>
                {bh.event && <EventPill event={bh.event} />}
                {bh.conf != null && <ConfBar v={bh.conf} />}
              </div>
            ) : result ? (
              <p className="text-xs text-white/20 italic">
                {backendUrl ? "Play the video to see live tracking" : "Backend required for live tracking"}
              </p>
            ) : (
              <div className="space-y-3">
                <div className="flex gap-3"><Sk cls="h-14 w-14 rounded-2xl" /><div className="flex-1 space-y-2 pt-1"><Sk cls="h-5 w-40" /><Sk cls="h-4 w-28" /></div></div>
                <Sk cls="h-6 w-32 rounded-full" /><Sk cls="h-2 w-full rounded-full" />
              </div>
            )}
          </div>

          {/* Live commentary line */}
          <div className="px-4 py-4 border-b border-white/[0.04]">
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/20 mb-2">Commentary</p>
            {displayLine ? (
              <p key={`line-${ai}`} className="text-sm leading-relaxed text-white/75 italic animate-fade-in-up">
                &ldquo;{displayLine}&rdquo;
              </p>
            ) : result?.commentary_text ? (
              <p className="text-sm leading-relaxed text-white/50 italic line-clamp-3">
                &ldquo;{result.commentary_text}&rdquo;
              </p>
            ) : isStreaming ? (
              <div className="space-y-2"><Sk cls="h-4 w-full" /><Sk cls="h-4 w-4/5" /></div>
            ) : (
              <p className="text-xs text-white/20 italic">Commentary will appear here as the video plays</p>
            )}
          </div>

          {/* Score */}
          {scoreboard && Object.values(scoreboard).some(v => v != null) && (
            <div className="px-4 py-4 border-b border-white/[0.04]">
              <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/20 mb-3">Score</p>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-white/65 truncate flex-1 text-right">{scoreboard.home_team ?? "Home"}</span>
                <div className="flex items-center gap-1 flex-shrink-0 px-2">
                  <span className="font-display text-3xl font-black text-white tabular-nums">{scoreboard.home_score ?? "–"}</span>
                  <span className="text-white/20 mx-1 text-lg">–</span>
                  <span className="font-display text-3xl font-black text-white tabular-nums">{scoreboard.away_score ?? "–"}</span>
                </div>
                <span className="text-sm font-bold text-white/65 truncate flex-1">{scoreboard.away_team ?? "Away"}</span>
              </div>
              {(scoreboard.quarter || scoreboard.game_clock || scoreboard.shot_clock != null) && (
                <div className="flex items-center gap-3 mt-2 text-xs text-white/30">
                  {scoreboard.quarter    && <span className="flex items-center gap-1"><Clock className="h-3 w-3" />Q{scoreboard.quarter}</span>}
                  {scoreboard.game_clock && <span>{scoreboard.game_clock}</span>}
                  {scoreboard.shot_clock != null && <span className="ml-auto font-semibold text-amber-400">{scoreboard.shot_clock}s</span>}
                </div>
              )}
            </div>
          )}

          {/* Broadcast / on-screen text */}
          {onScreenText && (onScreenText.game_title || onScreenText.broadcaster || onScreenText.player_stat_overlay || onScreenText.other?.length) && (
            <div className="px-4 py-4 border-b border-white/[0.04]">
              <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/20 mb-2 flex items-center gap-1.5">
                <Tv2 className="h-3 w-3" /> On Screen
              </p>
              <div className="space-y-1.5 text-xs">
                {onScreenText.game_title          && <p><span className="text-white/25 mr-2">Game</span><span className="text-white/65">{onScreenText.game_title}</span></p>}
                {onScreenText.broadcaster         && <p><span className="text-white/25 mr-2">Network</span><span className="text-white/65">{onScreenText.broadcaster}</span></p>}
                {onScreenText.player_stat_overlay && <p><span className="text-white/25 mr-2">Graphic</span><span className="text-white/65">{onScreenText.player_stat_overlay}</span></p>}
                {onScreenText.other?.map((t, i)  => <p key={i}><span className="text-white/25 mr-2">Text</span><span className="text-white/65">{t}</span></p>)}
              </div>
            </div>
          )}

          {/* Voiceover */}
          <div className="px-4 py-3 mt-auto border-t border-white/[0.04] flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-white/50">Voiceover</p>
              <p className="text-[11px] text-white/25">
                {voiBusy ? "Building audio…" : !isComplete ? "Available after analysis" : !voiUrl ? "Click to generate" : voiOn ? "Playing" : "Off"}
              </p>
            </div>
            <Button size="sm" onClick={toggleVoiceover}
              disabled={voiBusy || !isComplete || !cloudUrl || !backendUrl}
              variant={voiOn ? "default" : "outline"}
              className={voiOn ? "bg-primary text-black h-8" : "border-white/10 text-white/40 hover:text-white h-8"}>
              {voiBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : voiOn ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
      </div>

      {/* ── Possession timeline bar ── */}
      {timeline.length > 0 && (
        <div className="px-6 py-5 border-b border-white/[0.05] bg-[#0a0a0e]">
          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/20 mb-3">
            Possession Timeline — {timeline.length} segments
          </p>
          <PossessionBar segments={timeline} playhead={playheadNorm} lines={segLines} duration={dur} />
        </div>
      )}

      {/* ── Below fold ── */}
      <div className="w-full max-w-7xl mx-auto px-6 py-10 space-y-12">

        {/* Players */}
        {players.length > 0 && (
          <section>
            <h2 className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/25 mb-4">
              Players in This Clip — {players.length} identified
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {players.map(p => <PlayerCard key={p.player_name} p={p} />)}
            </div>
          </section>
        )}

        {/* Segment breakdown table */}
        {timeline.length > 0 && (
          <section>
            <h2 className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/25 mb-4">
              Play-by-Play Breakdown — every possession
            </h2>
            <SegmentTable segments={timeline} lines={segLines} duration={dur} />
          </section>
        )}

        {/* Full commentary */}
        {(result?.commentary_text || isStreaming) && (
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/25">Full Commentary Script</h2>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handleRegen} disabled={isRegen || isStreaming}
                  className="border-white/10 text-white/40 hover:text-white text-xs h-7 px-2">
                  <RefreshCw className={`mr-1 h-3 w-3 ${isRegen ? "animate-spin" : ""}`} />Regenerate
                </Button>
                <Button variant="outline" size="sm" onClick={handleCopy}
                  className="border-white/10 text-white/40 hover:text-white text-xs h-7 px-2">
                  <Copy className="mr-1 h-3 w-3" />Copy
                </Button>
              </div>
            </div>
            <div className="rounded-2xl bg-[#111118] border border-white/[0.04] p-6">
              {result?.commentary_text ? (
                <p className="text-base leading-8 text-white/70 italic">&ldquo;{result.commentary_text}&rdquo;</p>
              ) : (
                <div className="space-y-3"><Sk cls="h-4 w-full" /><Sk cls="h-4 w-5/6" /><Sk cls="h-4 w-4/6" /></div>
              )}
            </div>
          </section>
        )}

        {/* Visual summary */}
        {result?.visual_summary && (
          <section>
            <h2 className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/25 mb-4">What the Model Observed</h2>
            <div className="rounded-2xl bg-[#111118] border border-white/[0.04] p-6">
              <p className="text-sm leading-7 text-white/55">{result.visual_summary}</p>
            </div>
          </section>
        )}

        {/* Model info */}
        {result?.model_name && isComplete && (
          <p className="text-xs text-white/15 text-center">
            Model: {result.model_name}
            {result.chunks_processed && result.chunks_processed > 1 ? ` · ${result.chunks_processed} chunks` : ""}
            {dur > 0 ? ` · ${fmt(dur)} video` : ""}
          </p>
        )}
      </div>
    </div>
  );
}
