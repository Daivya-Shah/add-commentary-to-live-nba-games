import { useCallback, useState } from "react";
import { Link2, Search, Upload, Users } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { searchLiveGames } from "@/lib/live";
import { cn } from "@/lib/utils";

const NBA_TEAMS = [
  { code: "ATL", name: "Atlanta Hawks", id: 1610612737 },
  { code: "BOS", name: "Boston Celtics", id: 1610612738 },
  { code: "BKN", name: "Brooklyn Nets", id: 1610612751 },
  { code: "CHA", name: "Charlotte Hornets", id: 1610612766 },
  { code: "CHI", name: "Chicago Bulls", id: 1610612741 },
  { code: "CLE", name: "Cleveland Cavaliers", id: 1610612739 },
  { code: "DAL", name: "Dallas Mavericks", id: 1610612742 },
  { code: "DEN", name: "Denver Nuggets", id: 1610612743 },
  { code: "DET", name: "Detroit Pistons", id: 1610612765 },
  { code: "GSW", name: "Golden State Warriors", id: 1610612744 },
  { code: "HOU", name: "Houston Rockets", id: 1610612745 },
  { code: "IND", name: "Indiana Pacers", id: 1610612754 },
  { code: "LAC", name: "Los Angeles Clippers", id: 1610612746 },
  { code: "LAL", name: "Los Angeles Lakers", id: 1610612747 },
  { code: "MEM", name: "Memphis Grizzlies", id: 1610612763 },
  { code: "MIA", name: "Miami Heat", id: 1610612748 },
  { code: "MIL", name: "Milwaukee Bucks", id: 1610612749 },
  { code: "MIN", name: "Minnesota Timberwolves", id: 1610612750 },
  { code: "NOP", name: "New Orleans Pelicans", id: 1610612740 },
  { code: "NYK", name: "New York Knicks", id: 1610612752 },
  { code: "OKC", name: "Oklahoma City Thunder", id: 1610612760 },
  { code: "ORL", name: "Orlando Magic", id: 1610612753 },
  { code: "PHI", name: "Philadelphia 76ers", id: 1610612755 },
  { code: "PHX", name: "Phoenix Suns", id: 1610612756 },
  { code: "POR", name: "Portland Trail Blazers", id: 1610612757 },
  { code: "SAC", name: "Sacramento Kings", id: 1610612758 },
  { code: "SAS", name: "San Antonio Spurs", id: 1610612759 },
  { code: "TOR", name: "Toronto Raptors", id: 1610612761 },
  { code: "UTA", name: "Utah Jazz", id: 1610612762 },
  { code: "WAS", name: "Washington Wizards", id: 1610612764 },
];

const teamLogoUrl = (id: number) => `https://cdn.nba.com/logos/nba/${id}/global/L/logo.svg`;
const NBA_SEASONS = [
  "2026-27",
  "2025-26",
  "2024-25",
  "2023-24",
  "2022-23",
  "2021-22",
  "2020-21",
  "2019-20",
  "2018-19",
];

interface UploadZoneProps {
  onFileSelect: (file: File) => void;
  onUrlSubmit: (url: string) => Promise<void> | void;
  isProcessing: boolean;
}

interface MatchupGame {
  gameId: string;
  matchup: string;
  gameDate: string;
  seasonType: string;
  score: string;
}

const UploadZone = ({ onFileSelect, onUrlSubmit, isProcessing }: UploadZoneProps) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [hover, setHover] = useState(false);
  const [mode, setMode] = useState<"drop" | "url" | "matchup" | "live">("drop");
  const [urlValue, setUrlValue] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [isSubmittingUrl, setIsSubmittingUrl] = useState(false);
  const [teamQuery, setTeamQuery] = useState("LAL");
  const [opponentQuery, setOpponentQuery] = useState("DEN");
  const [seasonQuery, setSeasonQuery] = useState(defaultNbaSeason());
  const [seasonType, setSeasonType] = useState<"Regular Season" | "Playoffs">("Regular Season");
  const [matchupResults, setMatchupResults] = useState<MatchupGame[]>([]);
  const [searchingGames, setSearchingGames] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [replayVideoUrl, setReplayVideoUrl] = useState("");
  const [selectedGameId, setSelectedGameId] = useState("");
  const [selectedGameMeta, setSelectedGameMeta] = useState<MatchupGame | null>(null);
  const [manualGameId, setManualGameId] = useState("");
  const [startPeriod, setStartPeriod] = useState("1");
  const [startClock, setStartClock] = useState("12:00");
  const [endPeriod, setEndPeriod] = useState("4");
  const [endClock, setEndClock] = useState("00:00");
  const [matchupError, setMatchupError] = useState<string | null>(null);
  const [isStartingReplay, setIsStartingReplay] = useState(false);
  const selectedTeam = NBA_TEAMS.find((team) => team.code === teamQuery) ?? NBA_TEAMS[0];
  const selectedOpponent = NBA_TEAMS.find((team) => team.code === opponentQuery) ?? NBA_TEAMS[1];

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith("video/")) {
        onFileSelect(file);
      }
    },
    [onFileSelect],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) onFileSelect(file);
    },
    [onFileSelect],
  );

  const handleUrlSubmit = useCallback(async () => {
    const trimmed = urlValue.trim();
    if (!trimmed) {
      setUrlError("Please enter a replay video URL.");
      return;
    }

    try {
      const parsed = new URL(trimmed);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        setUrlError("Please use a valid http(s) URL.");
        return;
      }
    } catch {
      setUrlError("Please enter a valid URL.");
      return;
    }

    setUrlError(null);
    setIsSubmittingUrl(true);
    try {
      await onUrlSubmit(trimmed);
    } finally {
      setIsSubmittingUrl(false);
    }
  }, [onUrlSubmit, urlValue]);

  const handleGameSearch = useCallback(async () => {
    if (!teamQuery.trim() || !opponentQuery.trim() || !seasonQuery.trim()) {
      setSearchError("Enter team, opponent, and season.");
      return;
    }

    setSearchingGames(true);
    setSearchError(null);
    try {
      const results = await searchLiveGames({
        team: teamQuery.trim(),
        opponent: opponentQuery.trim(),
        season: seasonQuery.trim(),
        season_type: seasonType,
        limit: 20,
      });

      const mapped: MatchupGame[] = results.map((result) => ({
        gameId: result.game_id,
        matchup: result.matchup || `${result.team_abbreviation} vs. ${result.opponent_abbreviation}`,
        gameDate: result.game_date,
        seasonType: result.season_type || seasonType,
        score: result.score || result.result || "—",
      }));

      setMatchupResults(mapped);
      if (mapped.length > 0) {
        setSelectedGameId(mapped[0].gameId);
        setSelectedGameMeta(mapped[0]);
        setManualGameId(mapped[0].gameId);
      } else {
        setSelectedGameMeta(null);
        setSearchError("No matching games found.");
      }
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "Game search failed.");
    } finally {
      setSearchingGames(false);
    }
  }, [opponentQuery, seasonQuery, seasonType, teamQuery]);

  const handleStartReplay = useCallback(async () => {
    const trimmed = replayVideoUrl.trim();
    if (!trimmed) {
      setMatchupError("Enter a replay video URL.");
      return;
    }
    try {
      const parsed = new URL(trimmed);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        setMatchupError("Please use a valid http(s) URL.");
        return;
      }
    } catch {
      setMatchupError("Please enter a valid URL.");
      return;
    }
    if (!manualGameId.trim() || !startClock.trim()) {
      setMatchupError("Requires source, game id, and start clock.");
      return;
    }

    setMatchupError(null);
    setIsStartingReplay(true);
    try {
      await onUrlSubmit(trimmed);
    } finally {
      setIsStartingReplay(false);
    }
  }, [manualGameId, onUrlSubmit, replayVideoUrl, startClock]);

  if (isProcessing) return null;

  return (
    <div className="mx-auto w-full max-w-[1080px] select-none">
      <div className="mb-6 grid w-full grid-cols-2 gap-x-4 gap-y-3 sm:mb-8 sm:grid-cols-4 sm:gap-x-6 sm:gap-y-0">
        {[
          { key: "drop", label: "Drop", icon: Upload },
          { key: "url", label: "Upload Through URL", icon: Link2 },
          { key: "matchup", label: "Search by Matchup", icon: Users },
          { key: "live", label: "Live", icon: null },
        ].map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setMode(item.key as "drop" | "url" | "matchup" | "live")}
            className={cn(
              "btn-grad btn-grad-eq relative inline-flex items-center justify-center whitespace-nowrap font-mono text-[10px] leading-none tracked-tight sm:text-[11px]",
              mode === item.key && "btn-grad-active",
            )}
          >
            {item.icon ? (
              <item.icon
                className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2"
                strokeWidth={2.1}
                aria-hidden
              />
            ) : (
              <span
                className="pointer-events-none absolute left-[18px] top-1/2 h-2 w-2 -translate-y-1/2 animate-live-blink bg-white"
                aria-hidden
              />
            )}
            <span className="leading-none">{item.label}</span>
          </button>
        ))}
      </div>

      <div
        className={cn(
          "upload-glass-zone group relative rounded-[10px] bg-transparent transition-all duration-300",
          mode === "drop" ? "cursor-pointer" : "cursor-default",
          isDragOver
            ? "shadow-[0_0_34px_rgba(224,184,248,0.52),0_0_74px_rgba(150,210,255,0.36)]"
            : hover
              ? "shadow-[0_0_28px_rgba(218,174,248,0.46),0_0_60px_rgba(150,210,255,0.3)]"
              : "shadow-[0_0_22px_rgba(196,152,244,0.34)]",
        )}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onDragOver={(e) => {
          if (mode !== "drop") return;
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => mode === "drop" && setIsDragOver(false)}
        onDrop={handleDrop}
      >
      <input
        id="file-input"
        type="file"
        accept="video/mp4,video/*"
        className="hidden"
        onChange={handleFileInput}
      />

      <div className="px-6 pb-10 pt-6 sm:px-8 sm:pb-12 sm:pt-7">
        {mode === "drop" ? (
          <div
            className="flex min-h-[190px] flex-col items-center justify-center gap-3 rounded-[8px] border border-white/25 px-6 py-10 text-center sm:min-h-[220px]"
            onClick={() => document.getElementById("file-input")?.click()}
          >
            <div className="inline-flex items-center justify-center rounded-full border border-white/70 p-5">
              <Upload className="h-14 w-14 text-foreground" strokeWidth={2.1} />
            </div>
            <p className="font-body text-xs text-white sm:text-sm">UPLOAD THE CLIP</p>
            <p className="font-mono text-[9px] uppercase tracked text-white/90 sm:text-[10px]">
              Supported formats: MP4, MOV, WEBM
            </p>
          </div>
        ) : mode === "url" ? (
          <div className="flex min-h-[190px] flex-col justify-center gap-4 rounded-[8px] border border-white/25 px-5 py-8 sm:min-h-[220px] sm:px-7">
            <p className="font-mono text-[10px] uppercase tracked text-white/90">Replay Video URL</p>
            <div className="flex items-center rounded-[10px] border border-white/60 bg-[#0d173f]/45 p-1.5 shadow-[0_0_18px_rgba(122,154,255,0.2)]">
              <input
                type="url"
                value={urlValue}
                onChange={(e) => setUrlValue(e.target.value)}
                placeholder="https://..."
                className="h-11 flex-1 bg-transparent px-3 font-body text-sm text-white placeholder:text-white/55 focus:outline-none"
              />
              <button
                type="button"
                onClick={handleUrlSubmit}
                disabled={isSubmittingUrl}
                className="h-11 rounded-[8px] border border-white/70 bg-white px-6 font-mono text-[11px] uppercase tracked text-[#1D2B64] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmittingUrl ? "Submitting..." : "Search"}
              </button>
            </div>
            {urlError && <p className="font-body text-xs text-red-200">{urlError}</p>}
          </div>
        ) : mode === "matchup" ? (
          <div className="min-h-[260px] rounded-[8px] border border-white/25 bg-[#050a20]/35 p-4 text-white sm:p-5">
            <div className="rounded-[6px] border border-white/20 p-4">
              <div className="mb-5 pb-3">
                <label className="mb-1 block font-mono text-[10px] uppercase tracked text-white/65">Replay Video URL</label>
                <input
                  value={replayVideoUrl}
                  onChange={(e) => setReplayVideoUrl(e.target.value)}
                  placeholder="https://..."
                  className="h-10 w-full border border-white/25 bg-transparent px-3 font-mono text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/40"
                />
              </div>
              <p className="mb-4 font-mono text-[10px] uppercase tracked text-white/80">Search by Matchup</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-mono text-[10px] uppercase tracked text-white/65">Team</label>
                  <Select value={teamQuery} onValueChange={setTeamQuery}>
                    <SelectTrigger
                      className="h-10 border border-white/25 bg-[#050a20]/60 px-3 font-mono text-xs uppercase text-white focus:ring-1 focus:ring-white/40"
                      aria-label="Team"
                    >
                      <div className="flex items-center gap-2 leading-none">
                        <img src={teamLogoUrl(selectedTeam.id)} alt="" className="h-5 w-5 shrink-0 translate-y-[1px]" />
                        <span className="truncate leading-none">{selectedTeam.code} · {selectedTeam.name}</span>
                      </div>
                    </SelectTrigger>
                    <SelectContent
                      side="bottom"
                      align="start"
                      avoidCollisions={false}
                      className="max-h-72 border-white/20 bg-[#0b1129] text-white [&_[role=option]]:border-b [&_[role=option]]:border-white/10 [&_[role=option]:last-child]:border-b-0"
                    >
                      {NBA_TEAMS.map((team) => (
                        <SelectItem
                          key={team.code}
                          value={team.code}
                          className="pl-2 font-mono text-[10px] uppercase tracking-[0.08em] text-white focus:bg-white/10 focus:text-white [&>span.absolute]:hidden"
                        >
                          <span className="flex items-center gap-3 py-1 leading-none">
                            <img src={teamLogoUrl(team.id)} alt="" className="h-5 w-5 shrink-0 translate-y-[1px]" />
                            <span className="leading-none">{team.code} · {team.name}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="mb-1 block font-mono text-[10px] uppercase tracked text-white/65">Opponent</label>
                  <Select value={opponentQuery} onValueChange={setOpponentQuery}>
                    <SelectTrigger
                      className="h-10 border border-white/25 bg-[#050a20]/60 px-3 font-mono text-xs uppercase text-white focus:ring-1 focus:ring-white/40"
                      aria-label="Opponent"
                    >
                      <div className="flex items-center gap-2 leading-none">
                        <img src={teamLogoUrl(selectedOpponent.id)} alt="" className="h-5 w-5 shrink-0 translate-y-[1px]" />
                        <span className="truncate leading-none">{selectedOpponent.code} · {selectedOpponent.name}</span>
                      </div>
                    </SelectTrigger>
                    <SelectContent
                      side="bottom"
                      align="start"
                      avoidCollisions={false}
                      className="max-h-72 border-white/20 bg-[#0b1129] text-white [&_[role=option]]:border-b [&_[role=option]]:border-white/10 [&_[role=option]:last-child]:border-b-0"
                    >
                      {NBA_TEAMS.map((team) => (
                        <SelectItem
                          key={team.code}
                          value={team.code}
                          className="pl-2 font-mono text-[10px] uppercase tracking-[0.08em] text-white focus:bg-white/10 focus:text-white [&>span.absolute]:hidden"
                        >
                          <span className="flex items-center gap-3 py-1 leading-none">
                            <img src={teamLogoUrl(team.id)} alt="" className="h-5 w-5 shrink-0 translate-y-[1px]" />
                            <span className="leading-none">{team.code} · {team.name}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
                <div>
                  <label className="mb-1 block font-mono text-[10px] uppercase tracked text-white/65">NBA Season</label>
                  <Select value={seasonQuery} onValueChange={setSeasonQuery}>
                    <SelectTrigger
                      className="h-10 border border-white/25 bg-transparent px-3 font-mono text-sm text-white focus:ring-1 focus:ring-white/40"
                      aria-label="NBA Season"
                    >
                      <span className="truncate">{seasonQuery}</span>
                    </SelectTrigger>
                    <SelectContent
                      side="bottom"
                      align="start"
                      avoidCollisions={false}
                      className="max-h-72 border-white/20 bg-[#0b1129] text-white [&_[role=option]]:border-b [&_[role=option]]:border-white/10 [&_[role=option]:last-child]:border-b-0"
                    >
                      {NBA_SEASONS.map((season) => (
                        <SelectItem
                          key={season}
                          value={season}
                          className="pl-2 font-mono text-[10px] uppercase tracking-[0.08em] text-white focus:bg-white/10 focus:text-white [&>span.absolute]:hidden"
                        >
                          <span className="py-1 leading-none">{season}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <button
                  type="button"
                  onClick={handleGameSearch}
                  disabled={searchingGames}
                  className="mt-[18px] inline-flex h-10 items-center justify-center gap-2 border border-white/30 bg-white/5 px-4 font-mono text-[10px] uppercase tracked text-white transition-colors hover:bg-white/10"
                >
                  <Search className="h-3.5 w-3.5" />
                  {searchingGames ? "Searching" : "Search"}
                </button>
              </div>
              {searchError && <p className="mt-2 font-mono text-[10px] uppercase tracked text-white/70">{searchError} !</p>}

              <div className="mt-3 grid grid-cols-2 overflow-hidden border border-white/25">
                {(["Regular Season", "Playoffs"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setSeasonType(option)}
                    className={cn(
                      "h-8 font-mono text-[10px] uppercase tracked transition-colors",
                      seasonType === option ? "bg-white text-[#0d173f]" : "bg-transparent text-white/80 hover:bg-white/10",
                    )}
                  >
                    {option}
                  </button>
                ))}
              </div>

              <div className="mt-3 space-y-1 border border-white/20">
                {matchupResults.map((game) => (
                  <button
                    key={game.gameId}
                    type="button"
                    onClick={() => {
                      setSelectedGameId(game.gameId);
                      setSelectedGameMeta(game);
                      setManualGameId(game.gameId);
                    }}
                    className={cn(
                      "flex w-full items-start justify-between border-b border-white/15 px-3 py-2 text-left transition-colors last:border-b-0",
                      selectedGameId === game.gameId ? "bg-[#9aa3b2]/30" : "hover:bg-white/5",
                    )}
                  >
                    <div>
                      <p
                        className={cn(
                          "font-mono text-[11px] uppercase tracked-tight",
                          selectedGameId === game.gameId ? "text-white" : "text-white",
                        )}
                      >
                        {game.matchup}
                      </p>
                      <p
                        className={cn(
                          "mt-1 font-mono text-[10px]",
                          selectedGameId === game.gameId ? "text-white/75" : "text-white/60",
                        )}
                      >
                        {game.gameDate} · {game.seasonType}
                      </p>
                    </div>
                    <div className="text-right">
                      <p
                        className={cn(
                          "font-mono text-[10px]",
                          selectedGameId === game.gameId ? "text-white/90" : "text-white/85",
                        )}
                      >
                        {game.gameId}
                      </p>
                      <p
                        className={cn(
                          "mt-1 font-mono text-[10px]",
                          selectedGameId === game.gameId ? "text-white/75" : "text-white/65",
                        )}
                      >
                        {game.score}
                      </p>
                    </div>
                  </button>
                ))}
              </div>

              <div className="mt-5 rounded-[6px] border border-white/20 p-4">
                <label className="mb-1 block font-mono text-[10px] uppercase tracked text-white/65">NBA Game ID</label>
                <input
                  value={manualGameId}
                  readOnly
                  className="h-10 w-full cursor-not-allowed border border-white/25 bg-transparent px-3 font-mono text-sm text-white/90 focus:outline-none focus:ring-1 focus:ring-white/40"
                />

                <p className="mt-2 font-mono text-[10px] uppercase tracked text-white/55">
                  Selected · {selectedGameMeta?.matchup || `${teamQuery || "LAL"} vs. ${opponentQuery || "DEN"}`} · {selectedGameMeta?.gameDate || "—"}
                </p>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block font-mono text-[10px] uppercase tracked text-white/65">Start Period</label>
                    <input
                      value={startPeriod}
                      onChange={(e) => setStartPeriod(e.target.value)}
                      className="h-10 w-full border border-white/25 bg-transparent px-3 font-mono text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/40"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block font-mono text-[10px] uppercase tracked text-white/65">Start Clock</label>
                    <input
                      value={startClock}
                      onChange={(e) => setStartClock(e.target.value)}
                      className="h-10 w-full border border-white/25 bg-transparent px-3 font-mono text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/40"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block font-mono text-[10px] uppercase tracked text-white/65">End Period</label>
                    <input
                      value={endPeriod}
                      onChange={(e) => setEndPeriod(e.target.value)}
                      className="h-10 w-full border border-white/25 bg-transparent px-3 font-mono text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/40"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block font-mono text-[10px] uppercase tracked text-white/65">End Clock</label>
                    <input
                      value={endClock}
                      onChange={(e) => setEndClock(e.target.value)}
                      className="h-10 w-full border border-white/25 bg-transparent px-3 font-mono text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/40"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleStartReplay}
                  disabled={isStartingReplay}
                  className="mt-4 h-10 w-full border border-white/30 bg-white/50 font-mono text-[11px] uppercase tracked text-[#0d173f] transition-colors hover:bg-white/70"
                >
                  {isStartingReplay ? "Starting..." : "Start Replay"}
                </button>
                {matchupError && (
                  <p className="mt-2 text-center font-mono text-[10px] uppercase tracked text-red-200">
                    {matchupError}
                  </p>
                )}
                <p className="mt-2 text-center font-mono text-[10px] uppercase tracked text-white/55">
                  — Requires source, game id, and start clock —
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex min-h-[190px] flex-col items-center justify-center gap-3 rounded-[8px] border border-white/25 px-6 py-10 text-center sm:min-h-[220px]">
            <p className="font-mono text-[11px] uppercase tracked text-white">Live</p>
            <p className="font-body text-xs text-white/85 sm:text-sm">
              Live mode is reserved for the replay desk flow.
            </p>
          </div>
        )}
      </div>
      </div>
    </div>
  );
};

export default UploadZone;

const defaultNbaSeason = (): string => {
  const now = new Date();
  const startYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
};
