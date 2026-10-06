// Guided wizards for onboarding, bounties, and registration
const { InlineKeyboard } = require("grammy");
const { legacyBountyBoardEnabled } = require("./services/feature-flags");
const { getBadgeResult } = require("./services/gateway");
const copy = require("./services/copy");

const wizardStates = new Map();

function setupGuidedWizards(bot, db, PORTAL, requireBadge, queueXpReward, checkClaim) {

  // ═══════════════════════════════════════════════════════
  // ONBOARDING WIZARD (/start in private chat)
  // ═══════════════════════════════════════════════════════

  bot.callbackQuery("onboard_register", async (ctx) => {
    await ctx.editMessageText(
      "Step 1: Link Your Wallet\n\n" +
      "Paste your Radix account address below.\n" +
      "It starts with account_rdx1...\n\n" +
      "Find it in your Radix Wallet app → copy address."
    );
    wizardStates.set(ctx.from.id, { wizard: "onboard", step: "register" });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("onboard_mint", async (ctx) => {
    const user = db.getUser(ctx.from.id);
    if (!user) {
      await ctx.answerCallbackQuery({ text: "Register first! Paste your account_rdx1... address.", show_alert: true });
      return;
    }
    const kb = new InlineKeyboard()
      .url("Open Mint Page", PORTAL + "/mint")
      .row()
      .text("I've minted → check my badge", "onboard_check_badge");

    await ctx.editMessageText(copy.mintStep(), { reply_markup: kb });
    await ctx.answerCallbackQuery();
  });

  // "I've minted → check my badge". Until 2026-09-24 a found badge was printed as bare
  // "Tier:" / "XP:" lines, then "You're ready to participate in governance" and a
  // "View Proposals" button. It is now the /badge card and the task board.
  async function checkBadgeStep(ctx) {
    const user = db.getUser(ctx.from.id);
    if (!user) {
      await ctx.answerCallbackQuery({ text: "Register first!", show_alert: true });
      return;
    }
    // A Gateway outage is not "no badge" (2026-10-06): no mint button, just a retry.
    const badgeRead = await getBadgeResult(user.radix_address).catch(() => ({ error: true }));
    const badge = badgeRead.error ? null : badgeRead.data;
    // A second "Check again" with the same answer edits to identical text, which Telegram
    // refuses ("message is not modified"); unhandled, that skipped answerCallbackQuery and
    // surfaced as "Something went wrong" with the button still spinning.
    const edit = (text, other) => ctx.editMessageText(text, other).catch((e) => {
      if (!/message is not modified/i.test(String((e && (e.description || e.message)) || ""))) throw e;
    });

    if (badgeRead.error) {
      const kb = new InlineKeyboard().text("Check again", "onboard_check_badge");
      await edit(copy.badgeCheckUnavailable(), { reply_markup: kb });
      await ctx.answerCallbackQuery({ text: "Still can't reach the Radix Gateway. Try again in a minute." });
      return;
    } else if (badge) {
      const kb = new InlineKeyboard().url("Browse open tasks", PORTAL + "/tasks");
      await edit(
        copy.badgeFound({ badge, trust: db.getTrustScore(ctx.from.id) }),
        { reply_markup: kb }
      );
      wizardStates.delete(ctx.from.id);
    } else {
      const kb = new InlineKeyboard()
        .url("Open Mint Page", PORTAL + "/mint")
        .row()
        .text("Check again", "onboard_check_badge");
      await edit(
        "No badge found yet.\n\n" +
        "If you just minted, wait ~30 seconds and check again.",
        { reply_markup: kb }
      );
    }
    await ctx.answerCallbackQuery();
  }
  bot.callbackQuery("onboard_check_badge", checkBadgeStep);
  // "View Proposals" buttons already sitting in people's chats (the "Step 3: Vote!" page)
  // land on the same answer as the badge check.
  bot.callbackQuery("onboard_proposals", checkBadgeStep);

  // ═══════════════════════════════════════════════════════
  // BOUNTY WIZARD (/bounty in guided mode)
  // ═══════════════════════════════════════════════════════

  bot.callbackQuery("bounty_create_start", async (ctx) => {
    if (!legacyBountyBoardEnabled()) {
      await ctx.answerCallbackQuery({ text: "Tasks live on the web app now: radixguild.com/tasks", show_alert: true });
      return;
    }
    const user = await requireBadge(ctx);
    if (!user) return;
    // Keep the wallet the gate checked: creatorAddress is what escrow funding matches deposits against.
    wizardStates.set(ctx.from.id, { wizard: "bounty_create", step: "amount", category: "general", difficulty: "medium", deadline: null, address: user.radix_address });
    await ctx.editMessageText(
      "Create a Task\n\n" +
      "Step 1/5: How much XRD reward?\n\n" +
      "Type the amount (e.g. 50)\n" +
      "A 2.5% platform fee supports the guild."
    );
    await ctx.answerCallbackQuery();
  });

  // Category selection
  bot.callbackQuery(/^bounty_cat_(.+)$/, async (ctx) => {
    const state = wizardStates.get(ctx.from.id);
    if (!state || state.step !== "category") return ctx.answerCallbackQuery();
    state.category = ctx.match[1];
    state.step = "difficulty";
    const kb = new InlineKeyboard()
      .text("Easy", "bounty_diff_easy").text("Medium", "bounty_diff_medium").row()
      .text("Hard", "bounty_diff_hard").text("Expert", "bounty_diff_expert");
    await ctx.editMessageText(
      "Step 4/5: Difficulty level?\n\n" +
      "Category: " + state.category
    );
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
    await ctx.answerCallbackQuery();
  });

  // Difficulty selection
  bot.callbackQuery(/^bounty_diff_(.+)$/, async (ctx) => {
    const state = wizardStates.get(ctx.from.id);
    if (!state || state.step !== "difficulty") return ctx.answerCallbackQuery();
    state.difficulty = ctx.match[1];
    state.step = "deadline";
    const kb = new InlineKeyboard()
      .text("1 week", "bounty_dl_7").text("2 weeks", "bounty_dl_14").row()
      .text("1 month", "bounty_dl_30").text("No deadline", "bounty_dl_0");
    await ctx.editMessageText("Step 5/5: Deadline?");
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
    await ctx.answerCallbackQuery();
  });

  // Deadline selection → confirm
  bot.callbackQuery(/^bounty_dl_(\d+)$/, async (ctx) => {
    const state = wizardStates.get(ctx.from.id);
    if (!state || state.step !== "deadline") return ctx.answerCallbackQuery();
    const days = parseInt(ctx.match[1]);
    state.deadline = days > 0 ? Math.floor(Date.now() / 1000) + days * 86400 : null;
    state.deadlineDays = days;
    state.step = "confirm";

    const fee = (state.amount * 0.025).toFixed(1);
    const net = (state.amount - parseFloat(fee)).toFixed(1);
    const dlStr = days > 0 ? days + " days" : "None";

    const kb = new InlineKeyboard()
      .text("Create Task", "bounty_create_confirm")
      .text("Cancel", "bounty_cancel");
    await ctx.editMessageText(
      "Create Task — Confirm\n\n" +
      "Title: " + state.title + "\n" +
      "Reward: " + state.amount + " XRD\n" +
      "Category: " + state.category + "\n" +
      "Difficulty: " + state.difficulty + "\n" +
      "Deadline: " + dlStr + "\n\n" +
      "Platform fee (2.5%): " + fee + " XRD\n" +
      "Worker receives: " + net + " XRD\n\n" +
      "Submit?"
    );
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("bounty_claim_start", async (ctx) => {
    if (!legacyBountyBoardEnabled()) {
      await ctx.answerCallbackQuery({ text: "Tasks live on the web app now: radixguild.com/tasks", show_alert: true });
      return;
    }
    const bounties = db.getOpenBounties();
    const open = bounties.filter(b => b.status === "open");
    if (open.length === 0) {
      await ctx.answerCallbackQuery({ text: "No open bounties to claim.", show_alert: true });
      return;
    }
    const kb = new InlineKeyboard();
    open.slice(0, 5).forEach(b => {
      kb.text("#" + b.id + " " + b.reward_xrd + " XRD — " + b.title.slice(0, 25), "bounty_claim_" + b.id).row();
    });
    kb.text("Cancel", "bounty_cancel");
    await ctx.editMessageText("Claim a Bounty\n\nSelect one:", { reply_markup: kb });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^bounty_claim_(\d+)$/, async (ctx) => {
    if (!legacyBountyBoardEnabled()) {
      await ctx.answerCallbackQuery({ text: "Tasks live on the web app now: radixguild.com/tasks", show_alert: true });
      return;
    }
    const id = parseInt(ctx.match[1]);
    // Same gate as /bounty claim (until 2026-10-06 this button had none).
    const user = await requireBadge(ctx);
    if (!user) {
      await ctx.answerCallbackQuery();
      return;
    }
    const result = db.assignBounty(id, ctx.from.id, user.radix_address);
    if (result.changes === 0) {
      await ctx.answerCallbackQuery({ text: "Bounty not available.", show_alert: true });
      return;
    }
    await ctx.editMessageText(
      "Bounty #" + id + " claimed!\n\n" +
      "When you're done, submit your work:\n" +
      "/bounty submit " + id + " <github_pr_url>"
    );
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("bounty_view_start", async (ctx) => {
    const bounties = db.getOpenBounties();
    if (bounties.length === 0) {
      await ctx.editMessageText("No open bounties right now.");
    } else {
      let text = "Open Bounties:\n\n";
      bounties.forEach(b => {
        text += "#" + b.id + " [" + b.status + "] " + b.reward_xrd + " XRD — " + b.title + "\n";
      });
      await ctx.editMessageText(text);
    }
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("bounty_cancel", async (ctx) => {
    wizardStates.delete(ctx.from.id);
    await ctx.editMessageText("Cancelled.");
    await ctx.answerCallbackQuery();
  });

  // ═══════════════════════════════════════════════════════
  // TEXT HANDLER for wizard steps
  // ═══════════════════════════════════════════════════════

  function handleGuidedWizardText(ctx) {
    const state = wizardStates.get(ctx.from.id);
    if (!state) return false;

    const text = ctx.message.text.trim();

    // Onboarding: register step
    if (state.wizard === "onboard" && state.step === "register") {
      if (!/^account_rdx1[a-z0-9]{40,60}$/.test(text)) {
        ctx.reply("That doesn't look right. Paste your full Radix address starting with account_rdx1...");
        return true;
      }
      const claim = checkClaim(ctx.from.id, text);
      wizardStates.delete(ctx.from.id);
      if (!claim.ok) {
        ctx.reply(claim.reason === "taken" ? copy.registerAddressTaken() : copy.registerKeepsProven({ last8: claim.last8 }));
        return true;
      }
      db.registerUser(ctx.from.id, text, ctx.from.username || ctx.from.first_name);
      // Look before offering to mint, as /register does. Until 2026-09-24 this said
      // "Voting is FREE — no XRD needed. Next step: mint your badge." to every wallet,
      // including ones that already held a badge.
      // A Gateway outage is not "no badge" either (2026-10-06): a retry button, not the mint one.
      getBadgeResult(text)
        .catch(() => ({ error: true }))
        .then((badgeRead) => ctx.reply(copy.registered({ portal: PORTAL, hasBadge: !badgeRead.error && !!badgeRead.data,
          badgeUnknown: !!badgeRead.error, mustLink: claim.mustLink }), {
          reply_markup: badgeRead.error
            ? new InlineKeyboard().text("Check my badge", "onboard_check_badge")
            : badgeRead.data
              ? new InlineKeyboard().url("Browse open tasks", PORTAL + "/tasks")
              : new InlineKeyboard().text("Next: Mint Badge", "onboard_mint"),
        }))
        .catch((e) => console.error("[Onboard] register reply failed:", e.message));
      return true;
    }

    // Bounty create: amount step
    if (state.wizard === "bounty_create" && state.step === "amount") {
      const amount = parseInt(text);
      if (!amount || amount <= 0) {
        ctx.reply("Enter a positive number (e.g. 50)");
        return true;
      }
      if (amount < 5) {
        ctx.reply("Minimum 5 XRD per task.");
        return true;
      }
      state.amount = amount;
      state.step = "title";
      ctx.reply("Step 2/5: What's the task title?\n\nDescribe the work in one line.");
      return true;
    }

    // Bounty create: title step → category selection (inline keyboard)
    if (state.wizard === "bounty_create" && state.step === "title") {
      if (text.length > 500) {
        ctx.reply("Too long (max 500 chars). Try shorter.");
        return true;
      }
      state.title = text;
      state.step = "category";

      const kb = new InlineKeyboard()
        .text("Development", "bounty_cat_development").text("Design", "bounty_cat_design").row()
        .text("Content", "bounty_cat_content").text("Marketing", "bounty_cat_marketing").row()
        .text("Testing", "bounty_cat_testing").text("General", "bounty_cat_general");
      ctx.reply("Step 3/5: Category?", { reply_markup: kb });
      return true;
    }

    return false;
  }

  // Bounty create confirm
  bot.callbackQuery("bounty_create_confirm", async (ctx) => {
    if (!legacyBountyBoardEnabled()) {
      await ctx.answerCallbackQuery({ text: "Tasks live on the web app now: radixguild.com/tasks", show_alert: true });
      return;
    }
    const state = wizardStates.get(ctx.from.id);
    if (!state || state.wizard !== "bounty_create") {
      await ctx.answerCallbackQuery({ text: "No active task wizard.", show_alert: true });
      return;
    }
    const id = db.createBounty(state.title, state.amount, ctx.from.id, {
      category: state.category || "general",
      difficulty: state.difficulty || "medium",
      deadline: state.deadline || null,
      creatorAddress: state.address || null,
    });
    if (state.address) queueXpReward(state.address, "propose");
    wizardStates.delete(ctx.from.id);

    const fee = (state.amount * 0.025).toFixed(1);
    const net = (state.amount - parseFloat(fee)).toFixed(1);
    const dlStr = state.deadlineDays > 0 ? state.deadlineDays + " days" : "No deadline";

    await ctx.editMessageText(
      "Task #" + id + " created!\n\n" +
      state.title + "\n" +
      "Reward: " + state.amount + " XRD (" + net + " to worker, " + fee + " fee)\n" +
      "Category: " + (state.category || "general") + "\n" +
      "Difficulty: " + (state.difficulty || "medium") + "\n" +
      "Deadline: " + dlStr + "\n\n" +
      "Others can claim it with /bounty\n" +
      "View: " + PORTAL + "/bounties/" + id
    );
    await ctx.answerCallbackQuery();
  });

  return handleGuidedWizardText;
}

module.exports = { setupGuidedWizards, wizardStates };
