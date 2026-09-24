/**
 * interaction-mode — per-session interaction mode, injected after the system prompt.
 *
 * - scope: what the agent may deliver. stance: what the agent may say.
 *
 * No prompts. Each session starts with the configured default (wide + advise), stored
 * in interaction-mode.json next to this file.
 *   /mode <scope> <stance>         change the mode for this session only, allowed only
 *                                  before the session's first user message is sent
 *   /mode-default <scope> <stance> change the persisted default (future sessions)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Scope = "narrow" | "wide";
type Stance = "silent" | "advise" | "critique";
type Mode = { scope: Scope; stance: Stance };

const SCOPES: readonly Scope[] = ["narrow", "wide"];
const STANCES: readonly Stance[] = ["silent", "advise", "critique"];

const SCOPE_RULES: Record<Scope, string> = {
  narrow: [
    "### Scope=narrow",
    "Produce only the single thing that was explicitly requested. Do not change any code or content that was not named, even if it is obviously broken. Do not add unrequested error handling, logging, comments, tests, or type annotations.",
    "Output contains only the deliverable itself.",
  ].join("\n"),
  wide: "### Scope=wide\nPerform as normal.",
};

const STANCE_RULES: Record<Stance, string> = {
  silent: [
    "### Stance=silent",
    "Do not question about anything the user says. Do not give suggestions or opinions. Do not push back even if there is an obvious problem. Answer only what the user directly asks for.",
  ].join("\n"),
  advise: [
    "### Stance=advise",
    "Give suggestions and opinions if you find obvious problems in what the user is trying to (let you) do.",
  ].join("\n"),
  critique: [
    "### Stance=critique",
    "Verify, and question **everything** the user says and **every** assumption the user makes, including whether the requirement is really necessary and reasonable. Do not perform any other operation unless all problems have been addressed.",
  ].join("\n"),
};

const DEFAULT_MODE: Mode = { scope: "wide", stance: "advise" };
const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "interaction-mode.json");
const ENTRY_TYPE = "interaction_mode";

function buildBlock(mode: Mode): string {
  return [
    "## Interaction Mode",
    `Scope: ${mode.scope} - what you may deliver`,
    `Stance: ${mode.stance} - what you may say`,
    "",
    SCOPE_RULES[mode.scope],
    "",
    STANCE_RULES[mode.stance],
  ].join("\n");
}

function describe(mode: Mode): string {
  return `scope=${mode.scope} stance=${mode.stance}`;
}

function parseMode(raw: string): Mode | undefined {
  const parts = raw.split(/[\s:]+/);
  if (parts.length !== 2) return undefined;
  const scope = SCOPES.find((s) => s === parts[0].toLowerCase());
  const stance = STANCES.find((t) => t === parts[1].toLowerCase());
  return scope && stance ? { scope, stance } : undefined;
}

function readConfig(): Mode {
  try {
    const data = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { scope?: string; stance?: string };
    return parseMode(`${data.scope ?? ""} ${data.stance ?? ""}`) ?? DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

function writeConfig(mode: Mode): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(mode, null, 2) + "\n");
}

function restoreEntry(ctx: ExtensionContext): Mode | undefined {
  for (const entry of ctx.sessionManager.getEntries().reverse()) {
    if (entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.data) return entry.data as Mode;
  }
  return undefined;
}

function hasUserMessage(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "user");
}

export default function (pi: ExtensionAPI) {
  let mode: Mode | undefined;

  const usage = (name: string, current: string) =>
    `Usage: /${name} <scope> <stance>\nCurrent: ${current}\nAllowed: ${SCOPES.join(" | ")} x ${STANCES.join(" | ")}`;

  const annotate = (rule: string, active: boolean) => (active ? rule.replace("### ", "### [current] ") : rule);

  pi.on("session_start", (_event, ctx) => {
    mode = restoreEntry(ctx) ?? readConfig();
    ctx.ui.setStatus(ENTRY_TYPE, `mode ${describe(mode)}`);
  });

  pi.on("before_agent_start", (event) => {
    if (!mode) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${buildBlock(mode)}` };
  });

  pi.on("session_shutdown", () => {
    mode = undefined;
  });

  pi.registerCommand("mode", {
    description: "Set the interaction mode for this session (before the first user message)",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(usage("mode", describe(mode ?? readConfig())), "info");
        return;
      }
      const next = parseMode(trimmed);
      if (!next) {
        ctx.ui.notify(usage("mode", describe(mode ?? readConfig())), "warning");
        return;
      }
      if (hasUserMessage(ctx)) {
        ctx.ui.notify(`This session is locked (${describe(mode ?? readConfig())}). /mode works only before the first user message; use /mode-default to change the default.`, "warning");
        return;
      }
      mode = next;
      pi.appendEntry(ENTRY_TYPE, next);
      ctx.ui.setStatus(ENTRY_TYPE, `mode ${describe(next)}`);
      ctx.ui.notify(`Session mode: ${describe(next)}`, "info");
    },
  });

  pi.registerCommand("mode-default", {
    description: "Set the persisted default interaction mode (future sessions)",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(usage("mode-default", describe(readConfig())), "info");
        return;
      }
      const next = parseMode(trimmed);
      if (!next) {
        ctx.ui.notify(usage("mode-default", describe(readConfig())), "warning");
        return;
      }
      writeConfig(next);
      ctx.ui.notify(`Default mode: ${describe(next)}`, "info");
      if (!hasUserMessage(ctx)) {
        mode = next;
        ctx.ui.setStatus(ENTRY_TYPE, `mode ${describe(next)}`);
      }
    },
  });

  pi.registerCommand("modes", {
    description: "Explain the interaction modes",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const current = mode ?? readConfig();
      ctx.ui.notify(
        [
          `Current: ${describe(current)}${hasUserMessage(ctx) ? " (locked for this session)" : ""}`,
          "",
          "Scope - what you may deliver:",
          ...SCOPES.map((s) => annotate(SCOPE_RULES[s], s === current.scope)),
          "",
          "Stance - what you may say:",
          ...STANCES.map((t) => annotate(STANCE_RULES[t], t === current.stance)),
        ].join("\n"),
        "info",
      );
    },
  });
}
