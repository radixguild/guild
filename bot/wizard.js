// Proposal creation wizard — guided step-by-step flow
const { InlineKeyboard } = require("grammy");
const { checkContent } = require("./services/content-filter");

// Everything a person types into the wizard goes through the same blocklist /poll and
// /temp use. Until 2026-09-24 the wizard — which is what /propose and /new actually run —
// skipped it, so its title, description and options were the one unfiltered path.
function refuseBlocked(ctx, text) {
  if (!checkContent(text).blocked) return false;
  ctx.reply("Content not allowed. Please rephrase.");
  return true;
}

// Pending proposal data per user (in-memory during creation flow)
const pendingProposals = new Map();

function setupWizard(bot, db, requireBadge, buildYesNoKeyboard, buildPollKeyboard, endsLabel, queueXpReward) {

  // Step 1: /propose or /new starts the wizard
  async function startWizard(ctx) {
    const user = await requireBadge(ctx);
    if (!user) return;

    const kb = new InlineKeyboard()
      .text("Yes / No", "wizard_type_yesno")
      .text("Multi-choice", "wizard_type_poll")
      .row()
      .text("Temp Check", "wizard_type_temp")
      .text("Cancel", "wizard_cancel");

    await ctx.reply(
      "Create a Proposal\n\n" +
      "Step 1/4: What type?",
      { reply_markup: kb }
    );
  }
  bot.command("propose", startWizard);
  bot.command("new", startWizard);

  // Step 1 "Cancel". The button has always sent "wizard_cancel", and until 2026-09-24 nothing
  // handled it: the tap spun and the wizard stayed open. (The old `type === "cancel"` branch
  // below only ever matched a "wizard_type_cancel" no button sends; it is kept for safety.)
  async function cancelWizard(ctx) {
    pendingProposals.delete(ctx.from.id);
    await ctx.editMessageText("Proposal cancelled.");
    await ctx.answerCallbackQuery();
  }
  bot.callbackQuery("wizard_cancel", cancelWizard);

  // Step 1 callback: type selected
  bot.callbackQuery(/^wizard_type_(.+)$/, async (ctx) => {
    const type = ctx.match[1];
    if (type === "cancel") return cancelWizard(ctx);

    pendingProposals.set(ctx.from.id, { type, step: "title" });

    const typeLabel = type === "yesno" ? "Yes/No/Amend" : type === "poll" ? "Multi-choice" : "Temperature Check";
    await ctx.editMessageText(
      "Create a Proposal (" + typeLabel + ")\n\n" +
      "Step 2/4: Enter the title.\n" +
      "Just type it as a message."
    );
    await ctx.answerCallbackQuery();
  });

  // Step 2: User types the title (caught by text handler)
  // Step 3: User types description
  // These are handled in the text handler below

  // Duration selection callback
  bot.callbackQuery(/^wizard_duration_(.+)$/, async (ctx) => {
    const hours = parseInt(ctx.match[1]);
    const pending = pendingProposals.get(ctx.from.id);
    if (!pending || pending.step !== "duration") {
      return ctx.answerCallbackQuery({ text: "No active wizard. Start with /propose", show_alert: true });
    }

    pending.duration = hours;
    pending.step = "confirm";

    const typeLabel = pending.type === "yesno" ? "Yes/No/Amend" : pending.type === "poll" ? "Multi-choice" : "Temperature Check";
    const durationLabel = hours + " hours";

    let preview = "Create a Proposal — Confirm\n\n";
    preview += "Type: " + typeLabel + "\n";
    preview += "Title: " + pending.title + "\n";
    if (pending.description) preview += "Description: " + pending.description + "\n";
    if (pending.options) preview += "Options: " + pending.options.join(" | ") + "\n";
    preview += "Duration: " + durationLabel + "\n";
    preview += "Min votes: 3\n";

    const kb = new InlineKeyboard()
      .text("Submit", "wizard_submit")
      .text("Cancel", "wizard_cancel_final");

    await ctx.editMessageText(preview, { reply_markup: kb });
    await ctx.answerCallbackQuery();
  });

  // Cancel during wizard
  bot.callbackQuery("wizard_cancel_final", async (ctx) => {
    pendingProposals.delete(ctx.from.id);
    await ctx.editMessageText("Proposal cancelled.");
    await ctx.answerCallbackQuery();
  });

  // Submit proposal
  bot.callbackQuery("wizard_submit", async (ctx) => {
    const pending = pendingProposals.get(ctx.from.id);
    if (!pending) {
      return ctx.answerCallbackQuery({ text: "No active wizard.", show_alert: true });
    }

    // Gate the submit itself, not just /propose: the type buttons work for anyone who can
    // see a wizard message, so until 2026-10-06 a registered member with no badge could
    // tap through someone else's wizard and create a proposal.
    const user = await requireBadge(ctx);
    if (!user) {
      pendingProposals.delete(ctx.from.id);
      return ctx.answerCallbackQuery();
    }

    const daysActive = pending.duration / 24;
    const fullTitle = pending.description
      ? pending.title + "\n\n" + pending.description
      : pending.title;

    const id = db.createProposal(fullTitle, ctx.from.id, {
      type: pending.type === "temp" ? "temp" : pending.type,
      options: pending.options || null,
      daysActive: daysActive,
      minVotes: pending.type === "temp" ? 1 : 3,
    });

    const counts = db.getVoteCounts(id);
    const endsDate = new Date(Date.now() + pending.duration * 3600000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
    const typeLabel = pending.type === "yesno" ? "Yes/No/Amend" : pending.type === "poll" ? "Multi-choice" : "Temperature Check";

    let keyboard;
    if (pending.type === "yesno") {
      keyboard = buildYesNoKeyboard(id, counts);
    } else if (pending.type === "poll") {
      keyboard = buildPollKeyboard(id, pending.options, counts);
    } else {
      keyboard = buildPollKeyboard(id, ["Yes!", "Maybe", "No"], counts);
    }

    let text = "Proposal #" + id + " [" + typeLabel + "]\n\n";
    text += pending.title + "\n";
    if (pending.description) text += "\n" + pending.description + "\n";
    text += "\nBy: @" + (ctx.from.username || ctx.from.first_name) + "\n";
    text += "Ends: " + endsDate + " (" + pending.duration + "h)\n";
    text += "Min votes: " + (pending.type === "temp" ? 1 : 3);
    if (pending.type === "temp") text += "\nNon-binding — gauging interest";

    // Delete the wizard message
    try { await ctx.deleteMessage(); } catch(e) {}

    const msg = await ctx.reply(text, { reply_markup: keyboard });
    db.updateProposalMessage(id, msg.message_id, ctx.chat.id);
    queueXpReward(user.radix_address, pending.type === "temp" ? "temp" : "propose");

    pendingProposals.delete(ctx.from.id);
    await ctx.answerCallbackQuery({ text: "Proposal #" + id + " created!" });
  });

  // Text handler for wizard steps (title, description, poll options)
  return function handleWizardText(ctx) {
    const pending = pendingProposals.get(ctx.from.id);
    if (!pending) return false; // not in wizard

    const text = ctx.message.text.trim();
    if ((pending.step === "title" || pending.step === "options" || pending.step === "description") && refuseBlocked(ctx, text)) {
      return true; // stay on the same step
    }

    if (pending.step === "title") {
      pending.title = text;

      if (pending.type === "poll") {
        pending.step = "options";
        ctx.reply(
          "Step 3/4: Enter the options (separated by | )\n\n" +
          "Example: Option A | Option B | Option C"
        );
      } else {
        pending.step = "description";
        const kb = new InlineKeyboard().text("Skip description", "wizard_skip_desc");
        ctx.reply(
          "Step 3/4: Add a description (or skip)\n\n" +
          "Give context — why should people vote yes?",
          { reply_markup: kb }
        );
      }
      return true;
    }

    if (pending.step === "options") {
      const options = text.split("|").map(s => s.trim()).filter(Boolean);
      if (options.length < 2) {
        ctx.reply("Need at least 2 options separated by |");
        return true;
      }
      if (options.length > 6) {
        ctx.reply("Maximum 6 options.");
        return true;
      }
      pending.options = options;
      pending.step = "duration";

      const kb = new InlineKeyboard()
        .text("24h", "wizard_duration_24")
        .text("48h", "wizard_duration_48")
        .text("72h", "wizard_duration_72")
        .text("7 days", "wizard_duration_168");

      ctx.reply("Step 4/4: How long should voting last?", { reply_markup: kb });
      return true;
    }

    if (pending.step === "description") {
      pending.description = text;
      pending.step = "duration";

      const kb = new InlineKeyboard()
        .text("24h", "wizard_duration_24")
        .text("48h", "wizard_duration_48")
        .text("72h", "wizard_duration_72")
        .text("7 days", "wizard_duration_168");

      ctx.reply("Step 4/4: How long should voting last?", { reply_markup: kb });
      return true;
    }

    return false;
  };
}

// Skip description callback. index.js passes the Map exported below, which is now the
// wizard's own (until 2026-09-24 the export was a fresh `new Map()`, so Skip never found the
// proposal and its tap just spun).
function setupSkipDesc(bot, pendingProposals) {
  bot.callbackQuery("wizard_skip_desc", async (ctx) => {
    const pending = pendingProposals.get(ctx.from.id);
    if (!pending || pending.step !== "description") {
      return ctx.answerCallbackQuery({ text: "Nothing to skip. Start a new one with /propose", show_alert: true });
    }

    pending.description = null;
    pending.step = "duration";

    const kb = new InlineKeyboard()
      .text("24h", "wizard_duration_24")
      .text("48h", "wizard_duration_48")
      .text("72h", "wizard_duration_72")
      .text("7 days", "wizard_duration_168");

    await ctx.editMessageText("Step 4/4: How long should voting last?", { reply_markup: kb });
    await ctx.answerCallbackQuery();
  });
}

module.exports = { setupWizard, setupSkipDesc, pendingProposals };
