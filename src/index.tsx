// Entry point: discover CLI agents, then mount the ink app.
import { render } from "ink";
import App from "./App";
import { discoverAgents, getAvailableAgents } from "./utils/resolveAgent";

await discoverAgents();

// Log discovery summary for now; spawn/dispatch will use getAvailableAgents() later.
const available = getAvailableAgents();
if (available.length > 0) {
  console.error(
    `[tblang] ${available.length} CLI agent(s): ${available.map((a) => a.id).join(", ")}`,
  );
} else {
  console.error("[tblang] No CLI agents detected on PATH");
}

render(<App />);
