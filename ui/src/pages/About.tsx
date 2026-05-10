import { Link } from "react-router-dom";

const ABOUT_LINES: Array<{ text: string; kind?: "title" | "subtitle" | "section" | "body" | "team" }> = [
  { text: "ABOUT VISION2VOICE", kind: "title" },
  {
    text: "Vision2Voice is an AI sports commentary system that turns basketball video clips into structured play analysis, generated commentary, and voiceover video. Instead of only showing a clip, the app helps explain what is happening in the play and turns it into a broadcast-style moment. The system starts by reading sampled frames from an uploaded basketball clip. It looks for key play information such as the event type, player, team, jersey details, confidence score, and a short visual summary. Then, it adds player and team context from structured basketball data, including statistics such as scoring averages, shooting percentages, team record, and offensive rating. Finally, a language model uses the visual result and the retrieved context to generate smooth basketball commentary. Our goal is to explore how computer vision, retrieval, and language generation can work together to create commentary that is accurate, fluent, and useful for basketball highlights.",
    kind: "body",
  },
  { text: "WHAT IT DOES", kind: "section" },
  { text: "Vision2Voice reads each uploaded clip to identify the core basketball action, such as a shot, rebound, or turnover. It then connects that action to player and team context so the output is informative, not just descriptive. After analyzing the play, the system generates broadcast-style commentary and can also produce an AI voiceover version of the clip.", kind: "body" },
  { text: "HOW IT WORKS", kind: "section" },
  { text: "The workflow begins when a user uploads a basketball clip through the web app. The system samples frames, detects visual events, and identifies key entities such as players and teams. It then retrieves supporting statistics from structured basketball data and combines everything into generated play-by-play commentary, with optional AI voiceover export.", kind: "body" },
  { text: "WHY IT MATTERS", kind: "section" },
  { text: "Sports commentary is challenging because it requires more than describing what appears on screen. A strong commentator must interpret fast-paced action, recognize players and teams, apply basketball knowledge, and explain the moment naturally. Vision2Voice brings these elements together in one AI pipeline to explore how automated systems can support real-time sports analysis, video understanding, and storytelling.", kind: "body" },
  { text: "CURRENT FEATURES", kind: "section" },
  { text: "Current features include video upload, event detection, player and team recognition, visual summaries, player and team stat panels, generated commentary, regenerate and copy controls, AI voiceover export, and human rating and evaluation tools.", kind: "body" },
  { text: "LIMITATIONS AND FUTURE WORK", kind: "section" },
  { text: "Vision2Voice is still a prototype and performs best on clear clips where players, jerseys, and actions are easy to identify. Performance can drop when footage is blurry, camera angles are difficult, or players block each other. Future work includes reducing latency, expanding event coverage, integrating richer live statistics, improving voiceover expressiveness, and strengthening evaluation methods.", kind: "body" },
  { text: "TEAM", kind: "section" },
  { text: "Boren Zheng\nDaivya Shah\nAnthony Lu", kind: "team" },
];

const About = () => (
  <div className="local-minima-bg min-h-screen text-foreground">
    <main className="mx-auto w-full max-w-[1200px] px-6 pb-14 pt-10 sm:px-10 sm:pt-12">
      <div className="mb-6">
        <Link
          to="/"
          className="inline-flex items-center gap-2 border border-foreground/40 px-5 py-3 font-mono text-[11px] uppercase tracked tabular text-foreground transition-colors hover:bg-foreground hover:text-background"
        >
          Back
        </Link>
      </div>
      <div className="space-y-4">
        {ABOUT_LINES.map((line, index) => (
          <p
            key={`${line.text}-${index}`}
            className={[
              "about-line",
              line.kind === "title" ? "text-center font-display text-4xl font-extrabold sm:text-6xl" : "",
              line.kind === "subtitle" ? "font-body text-base italic text-foreground/90" : "",
              line.kind === "section" ? "pt-2 text-center font-display text-xl font-extrabold sm:text-2xl" : "",
              line.kind === "body" ? "font-body text-sm leading-7 text-foreground/85" : "",
              line.kind === "team" ? "whitespace-pre-line text-center font-body text-sm leading-8 text-foreground/85" : "",
            ].join(" ")}
            style={{ animationDelay: `${index * 130}ms` }}
          >
            {line.text}
          </p>
        ))}
      </div>
    </main>
  </div>
);

export default About;
