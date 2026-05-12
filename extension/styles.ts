export const extensionStyles = `
:host,
:root {
  --v2v-ink: #f4eadb;
  --v2v-panel: rgba(12, 12, 12, 0.92);
  --v2v-line: rgba(244, 234, 219, 0.24);
  --v2v-muted: rgba(244, 234, 219, 0.64);
  --v2v-accent: #ff5a1f;
  --v2v-ok: #69f0a5;
  color: var(--v2v-ink);
  font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}

body {
  width: 380px;
  min-height: 560px;
  margin: 0;
  background: #080808;
  color: var(--v2v-ink, #f4eadb);
  font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}

* { box-sizing: border-box; }

.v2v-popup {
  width: 380px;
  min-height: 560px;
  background: linear-gradient(180deg, rgba(16, 16, 16, 0.98), rgba(7, 7, 7, 0.96));
  color: var(--v2v-ink);
}

.v2v-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--v2v-line);
  padding: 14px;
}

.v2v-kicker {
  color: var(--v2v-accent);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.14em;
}

.v2v-title {
  margin-top: 4px;
  font-family: Impact, "Arial Narrow", sans-serif;
  font-size: 28px;
  line-height: 0.9;
  letter-spacing: 0;
}

.v2v-close {
  border: 1px solid var(--v2v-line);
  background: transparent;
  color: var(--v2v-muted);
  width: 28px;
  height: 28px;
  font-size: 18px;
  line-height: 1;
}

.v2v-body {
  display: grid;
  gap: 12px;
  padding: 14px;
}

.v2v-row,
.v2v-grid {
  display: grid;
  gap: 8px;
}

.v2v-grid.two {
  grid-template-columns: 1fr 1fr;
}

.v2v-label {
  color: var(--v2v-muted);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.v2v-input,
.v2v-select {
  width: 100%;
  border: 1px solid var(--v2v-line);
  background: rgba(255, 255, 255, 0.045);
  color: var(--v2v-ink);
  padding: 9px 10px;
  font: 600 11px/1.2 "JetBrains Mono", ui-monospace, monospace;
  outline: none;
}

.v2v-input:focus,
.v2v-select:focus {
  border-color: rgba(255, 90, 31, 0.75);
}

.v2v-segment {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border: 1px solid var(--v2v-line);
}

.v2v-segment button {
  border: 0;
  background: transparent;
  color: var(--v2v-muted);
  padding: 9px;
  font: 800 10px/1 "JetBrains Mono", ui-monospace, monospace;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.v2v-segment button.active {
  background: var(--v2v-ink);
  color: #090909;
}

.v2v-actions {
  display: flex;
  gap: 8px;
}

.v2v-button {
  flex: 1;
  border: 1px solid var(--v2v-line);
  background: var(--v2v-ink);
  color: #090909;
  padding: 10px;
  font: 900 10px/1 "JetBrains Mono", ui-monospace, monospace;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.v2v-button.secondary {
  background: transparent;
  color: var(--v2v-ink);
}

.v2v-button:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.v2v-status {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  border-top: 1px solid var(--v2v-line);
  padding-top: 10px;
  color: var(--v2v-muted);
  font-size: 10px;
}

.v2v-status.compact {
  border-top: 0;
  padding-top: 0;
  font-size: 9px;
}

.v2v-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  background: var(--v2v-muted);
}

.v2v-dot.live {
  background: var(--v2v-ok);
  box-shadow: 0 0 18px rgba(105, 240, 165, 0.8);
}

.v2v-results {
  display: grid;
  gap: 6px;
}

.v2v-result {
  border: 1px solid var(--v2v-line);
  background: transparent;
  color: var(--v2v-ink);
  padding: 8px;
  text-align: left;
  font: 700 10px/1.35 "JetBrains Mono", ui-monospace, monospace;
}

.v2v-history {
  display: grid;
  max-height: 180px;
  gap: 8px;
  overflow: auto;
}

.v2v-caption-row {
  border-left: 2px solid var(--v2v-accent);
  padding-left: 8px;
}

.v2v-caption-meta {
  color: var(--v2v-muted);
  font-size: 9px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.v2v-caption-text {
  margin-top: 2px;
  font: 600 12px/1.35 "JetBrains Mono", ui-monospace, monospace;
}

.v2v-error {
  border: 1px solid rgba(255, 90, 31, 0.6);
  color: #ffb093;
  padding: 8px;
  font-size: 10px;
  line-height: 1.35;
}

.v2v-empty {
  border: 1px solid var(--v2v-line);
  color: var(--v2v-muted);
  padding: 10px;
  font-size: 10px;
  line-height: 1.4;
}

@media (max-width: 720px) {
  .v2v-grid.two {
    grid-template-columns: 1fr;
  }
}
`;
