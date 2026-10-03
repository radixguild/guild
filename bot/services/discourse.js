// RadixTalk (Discourse) integration — ready for API key
// Set DISCOURSE_API_KEY and DISCOURSE_API_USER in .env when ready

const DISCOURSE_URL = process.env.DISCOURSE_URL || "https://radixtalk.com";
const DISCOURSE_API_KEY = process.env.DISCOURSE_API_KEY || "";
const DISCOURSE_API_USER = process.env.DISCOURSE_API_USER || "system";
const DISCOURSE_CATEGORY = parseInt(process.env.DISCOURSE_CATEGORY || "5"); // default category ID

async function postToRadixTalk(title, body) {
  if (!DISCOURSE_API_KEY) {
    console.log("[Discourse] No API key set — skipping post to RadixTalk");
    return null;
  }

  try {
    const resp = await fetch(DISCOURSE_URL + "/posts.json", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": DISCOURSE_API_KEY,
        "Api-Username": DISCOURSE_API_USER,
      },
      body: JSON.stringify({
        title: title,
        raw: body,
        category: DISCOURSE_CATEGORY,
      }),
    });

    if (!resp.ok) {
      console.error("[Discourse] Post failed:", resp.status, await resp.text());
      return null;
    }

    const data = await resp.json();
    console.log("[Discourse] Posted topic:", data.topic_id);
    return {
      topicId: data.topic_id,
      url: DISCOURSE_URL + "/t/" + data.topic_slug + "/" + data.topic_id,
    };
  } catch (e) {
    console.error("[Discourse] Error:", e.message);
    return null;
  }
}

// Until 2026-09-24 the footer said "Badge-gated governance" and linked a GitHub repo that
// is private (a 404 for every reader), and "Status" printed the row as read BEFORE it was
// closed — so every result posted as "active". The headline is the Telegram one.
const { pollClosedHeadline } = require("./copy");

function formatProposalForRT(proposal, counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  let body = "## Poll #" + proposal.id + "\n\n";
  body += proposal.title + "\n\n";
  body += pollClosedHeadline({ id: proposal.id, counts }) + "\n\n";
  body += "**Type:** " + proposal.type + "\n";
  body += "**Total votes:** " + total + "\n\n";
  body += "### Results\n\n";

  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([option, count]) => {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    body += "- **" + option + "**: " + count + " votes (" + pct + "%)\n";
  });

  body += "\n---\n";
  body += "*Non-binding community poll from the Radix Guild Telegram bot.*\n";

  return body;
}

module.exports = { postToRadixTalk, formatProposalForRT };
